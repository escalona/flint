/**
 * Thread - wraps a pi coding agent RPC session
 * Manages turns, items, and streaming
 */

import type { Thread as ThreadType, Turn, ThreadItem } from "@flint-dev/app-server-core";
import { createAgentMessageItem, createReasoningItem, PiEventAdapter } from "./adapter.ts";
import type { JsonRpcNotification } from "@flint-dev/app-server-core";
import { createNotification } from "@flint-dev/app-server-core";
import { storage } from "./storage.ts";
import { PiRpcClient, type PiRpcEvent, getPiCommandConfigFromEnv } from "./pi-rpc-client.ts";
import { parsePiModel } from "./pi-model.ts";

export interface ThreadOptions {
  model: string;
  cwd: string;
}

export interface TurnOverrides {
  model?: string;
  cwd?: string;
  config?: Record<string, string>;
}

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const SUPPORTED_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export class Thread {
  readonly info: ThreadType;
  private turns: Turn[] = [];
  private piSessionFile?: string;
  private rpcClient: PiRpcClient | null = null;
  private rpcCwd?: string;
  private abortController?: AbortController;
  private currentTurnId?: string;

  constructor(options: ThreadOptions) {
    const now = Math.floor(Date.now() / 1000);
    this.info = {
      id: crypto.randomUUID(),
      preview: "",
      model: options.model,
      modelProvider: "pi",
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd,
      cliVersion: "0.1.0",
      source: "appServer",
      turns: [],
    };
  }

  static async load(threadId: string): Promise<Thread | null> {
    const data = await storage.loadThread(threadId);
    if (!data) return null;

    const thread = new Thread({
      model: data.info.model ?? DEFAULT_MODEL,
      cwd: data.info.cwd,
    });

    (thread as { info: ThreadType }).info = data.info;
    thread.turns = data.turns;
    thread.piSessionFile = data.piSessionFile;

    return thread;
  }

  async save(): Promise<void> {
    await storage.saveThread({
      info: this.info,
      turns: this.turns,
      piSessionFile: this.piSessionFile,
    });
  }

  getInfo(): ThreadType {
    return { ...this.info, turns: [...this.turns] };
  }

  getInfoWithoutTurns(): ThreadType {
    return { ...this.info, turns: [] };
  }

  getTurns(): Turn[] {
    return [...this.turns];
  }

  isRunning(): boolean {
    return this.currentTurnId !== undefined && this.abortController !== undefined;
  }

  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  async *executeTurn(
    prompt: string,
    turnId?: string,
    overrides?: TurnOverrides,
  ): AsyncGenerator<JsonRpcNotification> {
    if (this.isRunning()) {
      throw new Error("Turn already in progress");
    }

    turnId = turnId ?? crypto.randomUUID();
    this.currentTurnId = turnId;

    const turnItems: ThreadItem[] = [];
    const turn: Turn = {
      id: turnId,
      items: turnItems,
      status: "inProgress",
    };
    this.turns.push(turn);

    this.info.updatedAt = Math.floor(Date.now() / 1000);
    await this.save();

    yield createNotification("turn/started", {
      threadId: this.info.id,
      turn: { ...turn },
    });

    this.abortController = new AbortController();

    const cwd = overrides?.cwd ?? this.info.cwd;
    const model = overrides?.model ?? this.info.model;

    if (overrides?.cwd) {
      this.info.cwd = overrides.cwd;
    }
    if (overrides?.model) {
      this.info.model = overrides.model;
    }

    let adapter: PiEventAdapter | null = null;
    let unsubscribe: (() => void) | null = null;

    try {
      const rpc = await this.ensureRpcClient(cwd, model);
      adapter = new PiEventAdapter({
        threadId: this.info.id,
        turnId,
        cwd,
      });

      if (overrides?.model) {
        const parsedModel = parsePiModel(overrides.model);
        if (parsedModel) {
          await rpc.setModel(parsedModel.provider, parsedModel.modelId);
        }
      }

      const thinkingLevel = overrides?.config?.thinking_level;
      if (thinkingLevel && SUPPORTED_THINKING_LEVELS.has(thinkingLevel)) {
        await rpc.setThinkingLevel(thinkingLevel);
      }

      const events: PiRpcEvent[] = [];
      let notifyEvents: (() => void) | null = null;
      let sawAgentEnd = false;

      unsubscribe = rpc.onEvent((event) => {
        events.push(event);
        notifyEvents?.();
      });

      await rpc.prompt(prompt);

      while (!sawAgentEnd || events.length > 0) {
        if (events.length === 0) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              notifyEvents = null;
              reject(new Error("Timed out waiting for pi RPC events"));
            }, 120_000);

            notifyEvents = () => {
              clearTimeout(timeout);
              notifyEvents = null;
              resolve();
            };
          });
        }

        const event = events.shift();
        if (!event) continue;

        if (event.type === "agent_end") {
          sawAgentEnd = true;
        }

        const notifications = adapter.translateEvent(event);
        for (const notification of notifications) {
          yield notification;
        }
      }

      const accumulatedReasoning = adapter.getAccumulatedReasoning();
      if (accumulatedReasoning) {
        turnItems.push(createReasoningItem(accumulatedReasoning));
      }

      const accumulatedText = adapter.getAccumulatedText();
      if (accumulatedText) {
        turnItems.push(createAgentMessageItem(accumulatedText));
        this.info.preview = accumulatedText.slice(0, 200);
      }

      if (this.abortController.signal.aborted || adapter.isInterrupted()) {
        turn.status = "interrupted";
      } else {
        const adapterError = adapter.getErrorMessage();
        if (adapterError) {
          turn.status = "failed";
          turn.error = { message: adapterError };
        } else {
          turn.status = "completed";
        }
      }

      if (turn.status === "failed" && turn.error) {
        yield createNotification("error", {
          error: turn.error,
          willRetry: false,
          threadId: this.info.id,
          turnId,
        });
      }

      yield createNotification("turn/completed", {
        threadId: this.info.id,
        turn: { ...turn, items: [...turnItems] },
      });
    } catch (error) {
      if (this.abortController.signal.aborted) {
        turn.status = "interrupted";
      } else {
        turn.status = "failed";
        turn.error = { message: error instanceof Error ? error.message : String(error) };
      }

      if (turn.status === "failed" && turn.error) {
        yield createNotification("error", {
          error: turn.error,
          willRetry: false,
          threadId: this.info.id,
          turnId,
        });
      }

      yield createNotification("turn/completed", {
        threadId: this.info.id,
        turn: { ...turn, items: [...turnItems] },
      });
    } finally {
      unsubscribe?.();
      this.abortController = undefined;
      this.currentTurnId = undefined;
      this.info.updatedAt = Math.floor(Date.now() / 1000);
      await this.save();
    }
  }

  interrupt(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    void this.rpcClient?.abort().catch(() => {
      // ignore abort race conditions
    });
    return true;
  }

  async archive(): Promise<void> {
    this.info.source = "archived";
    this.info.updatedAt = Math.floor(Date.now() / 1000);
    this.closeRpcClient();
    await this.save();
  }

  private async ensureRpcClient(cwd: string, model: string): Promise<PiRpcClient> {
    if (this.rpcClient && this.rpcCwd === cwd) {
      return this.rpcClient;
    }

    this.closeRpcClient();

    const parsedModel = parsePiModel(model);
    const commandConfig = getPiCommandConfigFromEnv();

    const client = new PiRpcClient({
      command: commandConfig.command,
      commandArgs: commandConfig.args,
      cwd,
      sessionFile: this.piSessionFile,
      ...(parsedModel && {
        provider: parsedModel.provider,
        modelId: parsedModel.modelId,
      }),
    });

    await client.start();

    this.rpcClient = client;
    this.rpcCwd = cwd;

    const state = await client.getState();
    if (state.sessionFile && state.sessionFile !== this.piSessionFile) {
      this.piSessionFile = state.sessionFile;
      await storage.setPiSessionFile(this.info.id, state.sessionFile);
    }

    if (state.model?.provider && state.model.id) {
      this.info.model = `${state.model.provider}/${state.model.id}`;
    }

    return client;
  }

  private closeRpcClient(): void {
    this.rpcClient?.close();
    this.rpcClient = null;
    this.rpcCwd = undefined;
  }
}
