/**
 * App Server Client
 *
 * Spawns an app-server-compatible child process and communicates
 * over stdio using JSON-RPC 2.0. Translates app-server notifications
 * to AgentEvent for TUI consumption.
 */

import type { AgentEvent } from "./types";
import type { CodexApprovalPolicy, CodexSandboxMode } from "./codex-execution";
export type { CodexApprovalPolicy, CodexSandboxMode } from "./codex-execution";

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;
export type ApprovalResponseDecision = "accept" | "decline";

export interface AppServerClientOptions {
  /** Provider name (used for provider-specific request mapping) */
  provider?: string;
  /** Command to spawn the app server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Working directory for the app server and Claude SDK */
  cwd: string;
  /** Environment variables for the app server process */
  env?: Record<string, string>;
  /** How to respond to server-side approval requests */
  approvalResponseDecision?: ApprovalResponseDecision;
}

export interface CreateThreadOptions {
  /** Model to use for the thread (e.g. "claude-sonnet-4-5-20250929") */
  model?: string;
  /** Optional provider-specific system prompt override */
  systemPrompt?: string;
  /** Optional provider-agnostic context to append to system/developer instructions */
  systemPromptAppend?: string;
  /** Optional MCP server config (provider-specific) */
  mcpServers?: Record<string, unknown>;
  /** Codex-only: default approval policy for the thread */
  approvalPolicy?: CodexApprovalPolicy;
  /** Codex-only: default sandbox mode for the thread */
  sandboxMode?: CodexSandboxMode;
}

export interface PromptOptions {
  /** Model override for this turn */
  model?: string;
}

export interface ResumeThreadOptions {
  /** Override working directory when resuming */
  cwd?: string;
  /** Override model when resuming */
  model?: string;
  /** Optional provider-specific system prompt override */
  systemPrompt?: string;
  /** Optional provider-agnostic context to append to system/developer instructions */
  systemPromptAppend?: string;
  /** Optional MCP server config (provider-specific) */
  mcpServers?: Record<string, unknown>;
  /** Codex-only: default approval policy for the thread */
  approvalPolicy?: CodexApprovalPolicy;
  /** Codex-only: default sandbox mode for the thread */
  sandboxMode?: CodexSandboxMode;
}

export class AppServerClient {
  private stdin: import("bun").FileSink | null = null;
  private stdout: ReadableStream<Uint8Array> | null = null;
  private stderr: ReadableStream<Uint8Array> | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private notificationListeners: Array<(notification: JsonRpcNotification) => void> = [];
  private buffer = "";
  private stderrBuffer = "";
  private stderrHistory: string[] = [];
  private isClosing = false;
  private initialized = false;
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string> | undefined;
  private readonly provider: string;
  private readonly approvalResponseDecision: ApprovalResponseDecision;

  constructor(options: AppServerClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.provider = (options.provider ?? "").trim().toLowerCase();
    this.approvalResponseDecision = options.approvalResponseDecision ?? "accept";
  }

  /** Start the app server process and initialize it. */
  async start(): Promise<void> {
    this.isClosing = false;
    const proc = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd,
      ...(this.env && { env: { ...process.env, ...this.env } }),
    });
    this.proc = proc;
    this.stdin = proc.stdin as import("bun").FileSink;
    this.stdout = proc.stdout as ReadableStream<Uint8Array>;
    this.stderr = proc.stderr as ReadableStream<Uint8Array>;

    // Read stdout in background
    this.readStdout();
    this.readStderr();
    this.watchProcessExit(proc);

    // Initialize the server
    await this.request("initialize", {
      clientInfo: {
        name: "flint-tui",
        version: "0.1.0",
      },
    });

    // Send initialized notification (Codex protocol)
    this.notify("initialized");
    this.initialized = true;
  }

  /** Create a new thread. Returns the thread ID. */
  async createThread(options?: CreateThreadOptions): Promise<string> {
    const result = (await this.request("thread/start", this.buildThreadStartParams(options))) as {
      thread: { id: string };
    };
    this.threadId = result.thread.id;
    return this.threadId;
  }

  /** Resume an existing thread. Returns the thread ID. */
  async resumeThread(threadId: string, options?: ResumeThreadOptions): Promise<string> {
    const result = (await this.request(
      "thread/resume",
      this.buildThreadResumeParams(threadId, options),
    )) as { thread: { id: string } };
    this.threadId = result.thread.id;
    return this.threadId;
  }

  /** Get the active thread ID (if any). */
  getThreadId(): string | null {
    return this.threadId;
  }

  /** Send a prompt and yield AgentEvents as they stream in. */
  async *prompt(prompt: string, options?: PromptOptions): AsyncGenerator<AgentEvent> {
    if (!this.threadId) {
      await this.createThread();
    }

    // Set up notification listener before sending request
    const events: AgentEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const listener = (notification: JsonRpcNotification) => {
      const translated = this.translateNotification(notification);
      for (const event of translated) {
        events.push(event);
        resolve?.();
      }

      // Check for terminal notifications
      if (notification.method === "turn/completed") {
        done = true;
        resolve?.();
      }
    };

    this.notificationListeners.push(listener);

    try {
      // Start the turn
      await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        ...(options?.model && { model: options.model }),
      });

      // Yield events as they come in
      while (!done) {
        if (events.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
      // Drain remaining
      while (events.length > 0) {
        yield events.shift()!;
      }
    } finally {
      const idx = this.notificationListeners.indexOf(listener);
      if (idx !== -1) this.notificationListeners.splice(idx, 1);
    }
  }

  /** Interrupt the current turn. */
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;
    try {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch {
      // May fail if no turn in progress
    }
  }

  /** Stop the app server process. */
  close(): void {
    this.isClosing = true;
    if (this.proc) {
      try {
        this.stdin?.end();
      } catch {
        // Already closed
      }
      this.proc.kill();
      this.proc = null;
      this.stdin = null;
      this.stdout = null;
      this.stderr = null;
    }
    this.initialized = false;
    this.threadId = null;
    this.currentTurnId = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private buildThreadStartParams(options?: CreateThreadOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: this.cwd,
      ...(options?.model && { model: options.model }),
    };
    this.applyInstructionParams(params, options?.systemPrompt, options?.systemPromptAppend);
    this.applyMcpParams(params, options?.mcpServers);
    this.applyCodexExecutionParams(params, options?.approvalPolicy, options?.sandboxMode);
    return params;
  }

  private buildThreadResumeParams(
    threadId: string,
    options?: ResumeThreadOptions,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId,
      ...(options?.cwd && { cwd: options.cwd }),
      ...(options?.model && { model: options.model }),
    };
    this.applyInstructionParams(params, options?.systemPrompt, options?.systemPromptAppend);
    this.applyMcpParams(params, options?.mcpServers);
    this.applyCodexExecutionParams(params, options?.approvalPolicy, options?.sandboxMode);
    return params;
  }

  private applyInstructionParams(
    params: Record<string, unknown>,
    systemPrompt: string | undefined,
    systemPromptAppend: string | undefined,
  ): void {
    if (systemPrompt) {
      if (this.provider === "codex") {
        params.baseInstructions = systemPrompt;
      } else {
        params.systemPrompt = systemPrompt;
      }
    }
    if (systemPromptAppend) {
      if (this.provider === "codex") {
        params.developerInstructions = systemPromptAppend;
      } else {
        params.systemPromptAppend = systemPromptAppend;
      }
    }
  }

  private applyMcpParams(
    params: Record<string, unknown>,
    mcpServers: Record<string, unknown> | undefined,
  ): void {
    if (!mcpServers) {
      return;
    }
    if (this.provider === "codex") {
      params.config = normalizeMcpServersForCodexConfigOverrides(mcpServers);
    } else {
      params.mcpServers = mcpServers;
    }
  }

  private applyCodexExecutionParams(
    params: Record<string, unknown>,
    approvalPolicy: CodexApprovalPolicy | undefined,
    sandboxMode: CodexSandboxMode | undefined,
  ): void {
    if (this.provider !== "codex") {
      return;
    }
    if (approvalPolicy) {
      params.approvalPolicy = approvalPolicy;
    }
    if (sandboxMode) {
      params.sandbox = sandboxMode;
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.stdin) throw new Error("App server not started");

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      id,
      method,
      ...(params !== undefined && { params }),
    };

    if (process.env.DEBUG) {
      console.error(`[sdk] → ${method}`, params ? JSON.stringify(params) : "");
    }

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.stdin) throw new Error("App server not started");
    const notification: JsonRpcNotification = {
      method,
      ...(params !== undefined && { params }),
    };
    this.stdin.write(JSON.stringify(notification) + "\n");
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

        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newlineIdx);
          this.buffer = this.buffer.slice(newlineIdx + 1);

          if (line.trim()) {
            this.handleMessage(line);
          }
        }
      }
    } catch {
      // Process exited
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.stderr) return;

    const reader = this.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.stderrBuffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = this.stderrBuffer.indexOf("\n")) !== -1) {
          const line = this.stderrBuffer.slice(0, newlineIdx);
          this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1);
          this.pushStderrLine(line);
        }
      }
    } catch {
      // Process exited
    }

    if (this.stderrBuffer.trim()) {
      this.pushStderrLine(this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  private pushStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    this.stderrHistory.push(trimmed);
    if (this.stderrHistory.length > 60) {
      this.stderrHistory.shift();
    }

    if (process.env.DEBUG) {
      console.error(`[sdk][${this.command} stderr] ${trimmed}`);
    }
  }

  private stderrTail(maxLines = 8): string {
    return this.stderrHistory.slice(-maxLines).join("\n");
  }

  private async watchProcessExit(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const exitCode = await proc.exited;
    if (this.proc !== proc || this.isClosing) return;

    const tail = this.stderrTail();
    const message = tail
      ? `App server exited with code ${exitCode}\nRecent stderr:\n${tail}`
      : `App server exited with code ${exitCode}`;

    const error = new Error(message);
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const hasId = "id" in msg && msg.id != null;
    const hasMethod = "method" in msg && typeof msg.method === "string";

    // Server→client request (has both id and method).
    // e.g. item/commandExecution/requestApproval, item/fileChange/requestApproval
    if (hasId && hasMethod) {
      this.handleServerRequest(msg as unknown as JsonRpcRequest);
      return;
    }

    // Response to our request (has id, no method)
    if (hasId) {
      const response = msg as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Notification (no id)
    const notification = msg as unknown as JsonRpcNotification;
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  /**
   * Handle a server→client JSON-RPC request (requires a response).
   * Auto-responds to requestApproval requests since there is no interactive UI.
   */
  private handleServerRequest(request: JsonRpcRequest): void {
    const { method, id } = request;

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      const params = request.params as Record<string, unknown> | undefined;
      const label =
        (params?.command as string) ??
        (params?.reason as string) ??
        method;
      const decision = this.approvalResponseDecision;
      console.warn(`[sdk] auto-${decision === "accept" ? "approving" : "declining"}: ${label}`);
      this.sendJsonRpcResponse(id, { decision });

      // Forward as a notification so listeners receive an event (resets
      // the gateway inactivity timer and lets channel adapters show status).
      for (const listener of this.notificationListeners) {
        listener({ method, params: request.params as Record<string, unknown> });
      }
      return;
    }

    // Unknown server request — reject gracefully
    console.warn(`[sdk] unhandled server request: ${method}`);
    this.sendJsonRpcResponse(id, undefined, {
      code: -32601,
      message: `Method not supported: ${method}`,
    });
  }

  private sendJsonRpcResponse(
    id: number,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    if (!this.stdin) return;
    const response: Record<string, unknown> = { id };
    if (error) {
      response.error = error;
    } else {
      response.result = result ?? {};
    }
    this.stdin.write(JSON.stringify(response) + "\n");
  }

  /** Translate app-server JSON-RPC notifications to AgentEvents. */
  private translateNotification(notification: JsonRpcNotification): AgentEvent[] {
    const events: AgentEvent[] = [];
    const params = (notification.params ?? {}) as Record<string, unknown>;

    switch (notification.method) {
      case "item/agentMessage/delta": {
        events.push({ type: "text", delta: params.delta as string });
        break;
      }

      case "item/reasoning/textDelta": {
        events.push({ type: "reasoning", delta: params.delta as string });
        break;
      }

      case "item/started": {
        const item = params.item as Record<string, unknown>;
        if (!item) break;

        const itemType = item.type as string;
        const itemId = item.id as string;

        if (itemType === "commandExecution") {
          events.push({
            type: "tool_start",
            id: itemId,
            name: "Bash",
            input: { command: item.command, cwd: item.cwd },
          });
        } else if (itemType === "fileChange") {
          const changes = item.changes as Array<{ path: string; kind: { type: string } }>;
          const firstChange = changes?.[0];
          const kindType = firstChange?.kind?.type;
          const toolName = kindType === "add" ? "Write" : "Edit";
          events.push({
            type: "tool_start",
            id: itemId,
            name: toolName,
            input: { file_path: firstChange?.path },
          });
        } else if (itemType === "mcpToolCall") {
          events.push({
            type: "tool_start",
            id: itemId,
            name: String(item.tool ?? "tool"),
            input: item.arguments,
          });
        }
        break;
      }

      case "item/completed": {
        const item = params.item as Record<string, unknown>;
        if (!item) break;

        const itemId = item.id as string;
        const itemType = item.type as string;

        if (itemType === "commandExecution") {
          const exitCode = item.exitCode as number | undefined;
          events.push({
            type: "tool_end",
            id: itemId,
            result: item.aggregatedOutput,
            isError: (exitCode ?? 0) !== 0,
          });
        } else if (itemType === "fileChange") {
          events.push({
            type: "tool_end",
            id: itemId,
            result: undefined,
            isError: false,
          });
        } else if (itemType === "mcpToolCall") {
          events.push({
            type: "tool_end",
            id: itemId,
            result: item.result,
            isError: false,
          });
        }
        break;
      }

      case "turn/started": {
        const turn = params.turn as Record<string, unknown>;
        if (turn) {
          this.currentTurnId = turn.id as string;
        }
        break;
      }

      case "turn/completed": {
        const turn = params.turn as Record<string, unknown>;
        if (turn) {
          const status = turn.status as string;
          if (status === "failed") {
            const error = turn.error as { message: string } | undefined;
            events.push({
              type: "error",
              message: error?.message ?? "Unknown error",
            });
          } else {
            events.push({ type: "done" });
          }
        } else {
          events.push({ type: "done" });
        }
        this.currentTurnId = null;
        break;
      }

      case "error": {
        // Separate error notification — already handled via turn/completed
        break;
      }

      // Approval requests are control-plane activity, not tool lifecycle events.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        events.push({ type: "activity" });
        break;
      }

      // Ignored delta notifications that we don't translate to AgentEvent
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        break;
    }

    return events;
  }
}

function normalizeMcpServersForCodex(mcpServers: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    const cfg = isRecord(rawConfig) ? rawConfig : {};
    const type = typeof cfg.type === "string" ? cfg.type.toLowerCase() : undefined;

    if (type === "stdio") {
      normalized[name] = {
        ...(typeof cfg.command === "string" ? { command: cfg.command } : {}),
        ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
        ...(isRecord(cfg.env) ? { env: cfg.env } : {}),
        ...(typeof cfg.cwd === "string" ? { cwd: cfg.cwd } : {}),
      };
      continue;
    }

    if (type === "http" || type === "streamable_http") {
      normalized[name] = {
        ...(typeof cfg.url === "string" ? { url: cfg.url } : {}),
        ...(isRecord(cfg.headers) ? { http_headers: cfg.headers } : {}),
        ...(isRecord(cfg.envHeaders) ? { env_http_headers: cfg.envHeaders } : {}),
        ...(typeof cfg.bearerTokenEnvVar === "string"
          ? { bearer_token_env_var: cfg.bearerTokenEnvVar }
          : {}),
      };
      continue;
    }

    normalized[name] = cfg;
  }
  return normalized;
}

function normalizeMcpServersForCodexConfigOverrides(
  mcpServers: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeMcpServersForCodex(mcpServers);
  const configOverrides: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(normalized)) {
    if (!isRecord(config)) {
      continue;
    }
    for (const [key, value] of Object.entries(config)) {
      configOverrides[`mcp_servers.${name}.${key}`] = value;
    }
  }
  return configOverrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
