export interface PiCommandConfig {
  command: string;
  args: string[];
}

export function getPiCommandConfigFromEnv(): PiCommandConfig {
  const command = process.env["PI_APP_SERVER_COMMAND"]?.trim() || "pi";
  const rawArgs = process.env["PI_APP_SERVER_ARGS"]?.trim();
  const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
  return { command, args };
}

export interface PiRpcClientOptions {
  command: string;
  commandArgs?: string[];
  cwd: string;
  env?: Record<string, string>;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PiRpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface PiRpcModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface PiRpcState {
  sessionFile?: string;
  model?: {
    provider: string;
    id: string;
  };
}

export type PiRpcEvent = Record<string, unknown> & { type: string };

type EventListener = (event: PiRpcEvent) => void;

export class PiRpcClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stdin: import("bun").FileSink | null = null;
  private stdout: ReadableStream<Uint8Array> | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private listeners: EventListener[] = [];
  private stderrBuffer = "";

  constructor(private readonly options: PiRpcClientOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;

    const args = [
      ...(this.options.commandArgs ?? []),
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ];

    if (this.options.sessionFile) {
      args.push("--session", this.options.sessionFile);
    }

    if (this.options.provider && this.options.modelId) {
      args.push("--provider", this.options.provider, "--model", this.options.modelId);
    }

    const proc = Bun.spawn([this.options.command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.options.cwd,
      ...(this.options.env && { env: { ...process.env, ...this.options.env } }),
    });

    this.proc = proc;
    this.stdin = proc.stdin as import("bun").FileSink;
    this.stdout = proc.stdout as ReadableStream<Uint8Array>;

    this.readStdout();
    this.readStderr(proc.stderr as ReadableStream<Uint8Array>);

    void proc.exited.then((code) => {
      const error = new Error(
        `pi RPC process exited with code ${code}. ${this.stderrBuffer}`.trim(),
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
      this.proc = null;
      this.stdin = null;
      this.stdout = null;
    });

    // Validate startup by sending a cheap command.
    await this.requestStarted({ type: "get_state" }, 10_000);
  }

  close(): void {
    if (!this.proc) return;

    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("pi RPC client closed"));
    }
    this.pending.clear();

    try {
      this.stdin?.end();
    } catch {
      // Ignore already-closed stream.
    }

    this.proc.kill();
    this.proc = null;
    this.stdin = null;
    this.stdout = null;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  async prompt(message: string): Promise<void> {
    await this.request({ type: "prompt", message }, 15_000);
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" }, 10_000);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.request({ type: "set_model", provider, modelId }, 15_000);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: "set_thinking_level", level }, 15_000);
  }

  async getState(): Promise<PiRpcState> {
    return (await this.request({ type: "get_state" }, 10_000)) as PiRpcState;
  }

  async getAvailableModels(): Promise<PiRpcModel[]> {
    const data = (await this.request({ type: "get_available_models" }, 20_000)) as {
      models?: PiRpcModel[];
    };
    return data.models ?? [];
  }

  private async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    await this.start();
    return this.requestStarted(command, timeoutMs);
  }

  private async requestStarted(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (!this.stdin) {
      throw new Error("pi RPC client not started");
    }

    const id = `req-${this.nextId++}`;
    const payload = { id, ...command };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for pi RPC response: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.stdin!.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async readStdout(): Promise<void> {
    if (!this.stdout) return;

    const reader = this.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newlineIndex);
          this.buffer = this.buffer.slice(newlineIndex + 1);

          if (line.trim()) {
            this.handleStdoutLine(line);
          }
        }
      }
    } catch {
      // Process closed.
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.stderrBuffer += decoder.decode(value, { stream: true });
        if (this.stderrBuffer.length > 8_000) {
          this.stderrBuffer = this.stderrBuffer.slice(-8_000);
        }
      }
    } catch {
      // Process closed.
    }
  }

  private handleStdoutLine(line: string): void {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof message.type === "string" ? message.type : "";

    if (type === "response") {
      this.handleResponse(message as unknown as PiRpcResponse);
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(message);
      return;
    }

    for (const listener of this.listeners) {
      listener(message as PiRpcEvent);
    }
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = response.id;
    if (!id) return;

    const request = this.pending.get(id);
    if (!request) return;

    clearTimeout(request.timeout);
    this.pending.delete(id);

    if (!response.success) {
      request.reject(new Error(response.error ?? `pi RPC command failed: ${response.command}`));
      return;
    }

    request.resolve(response.data);
  }

  private handleExtensionUiRequest(message: Record<string, unknown>): void {
    const requestId = message.id;
    const method = message.method;

    if (typeof requestId !== "string" || typeof method !== "string") {
      return;
    }

    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      try {
        this.stdin?.write(
          JSON.stringify({ type: "extension_ui_response", id: requestId, cancelled: true }) + "\n",
        );
      } catch {
        // Ignore write failures while shutting down.
      }
    }
  }
}
