/**
 * Thread - wraps a Claude SDK session
 * Manages turns, items, and streaming
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Thread as ThreadType, Turn, ThreadItem } from "@flint-dev/app-server-core";
import {
  translateSdkMessage,
  resetAdapter,
  createAgentMessageItem,
  createReasoningItem,
} from "./adapter.ts";
import type { JsonRpcNotification } from "@flint-dev/app-server-core";
import { createNotification } from "@flint-dev/app-server-core";
import { storage } from "./storage.ts";

type McpServersConfig = NonNullable<SDKOptions["mcpServers"]>;
type SystemPromptConfig = NonNullable<SDKOptions["systemPrompt"]>;

const DEFAULT_SYSTEM_PROMPT: SystemPromptConfig = {
  type: "preset",
  preset: "claude_code",
};

export interface ThreadOptions {
  model: string;
  cwd: string;
  mcpServers?: McpServersConfig;
  systemPrompt?: string;
}

export interface TurnOverrides {
  model?: string;
  cwd?: string;
  config?: Record<string, string>;
}

export class Thread {
  readonly info: ThreadType;
  private turns: Turn[] = [];
  private sdkSessionId?: string;
  private mcpServers?: McpServersConfig;
  private systemPrompt?: string;
  private abortController?: AbortController;
  private currentTurnId?: string;

  // Accumulated text for current turn
  private accumulatedText = "";
  private accumulatedReasoning = "";

  constructor(options: ThreadOptions) {
    const now = Math.floor(Date.now() / 1000);
    this.info = {
      id: crypto.randomUUID(),
      preview: "",
      model: options.model,
      modelProvider: "claude",
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd,
      cliVersion: "0.1.0",
      source: "appServer",
      turns: [],
    };
    this.mcpServers = options.mcpServers;
    this.systemPrompt = normalizeSystemPrompt(options.systemPrompt);
  }

  static async load(threadId: string): Promise<Thread | null> {
    const data = await storage.loadThread(threadId);
    if (!data) return null;

    const thread = new Thread({
      model: data.info.model ?? "claude-opus-4-6",
      cwd: data.info.cwd,
    });

    // Restore state
    (thread as { info: ThreadType }).info = data.info;
    thread.turns = data.turns;
    thread.sdkSessionId = data.sdkSessionId;
    thread.systemPrompt = normalizeSystemPrompt(data.systemPrompt);

    return thread;
  }

  async save(): Promise<void> {
    await storage.saveThread({
      info: this.info,
      turns: this.turns,
      sdkSessionId: this.sdkSessionId,
      systemPrompt: this.systemPrompt,
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

  setMcpServers(mcpServers: McpServersConfig | undefined): void {
    this.mcpServers = mcpServers;
  }

  /**
   * Execute a turn (prompt + response cycle)
   * Yields notifications as they occur
   */
  async *executeTurn(
    prompt: string,
    turnId?: string,
    overrides?: TurnOverrides,
  ): AsyncGenerator<JsonRpcNotification> {
    if (this.isRunning()) {
      throw new Error("Turn already in progress");
    }

    // Reset adapter state
    resetAdapter();
    this.accumulatedText = "";
    this.accumulatedReasoning = "";

    // Create new turn with UUID
    turnId = turnId ?? crypto.randomUUID();
    this.currentTurnId = turnId;
    const turnItems: ThreadItem[] = [];

    const turn: Turn = {
      id: turnId,
      items: turnItems,
      status: "inProgress",
    };
    this.turns.push(turn);

    // Update thread
    this.info.updatedAt = Math.floor(Date.now() / 1000);
    await this.save();

    // Emit turn started
    yield createNotification("turn/started", {
      threadId: this.info.id,
      turn: { ...turn },
    });

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    try {
      // Resolve model: per-turn override → thread default
      const model = overrides?.model ?? this.info.model;

      // If model override provided, update thread default for future turns
      if (overrides?.model) {
        this.info.model = overrides.model;
      }

      const maxThinkingTokens = overrides?.config?.max_thinking_tokens
        ? parseInt(overrides.config.max_thinking_tokens)
        : 31999;

      const sdkOptions: SDKOptions = {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model,
        maxTurns: 50,
        cwd: overrides?.cwd ?? this.info.cwd,
        includePartialMessages: true,
        maxThinkingTokens,
        systemPrompt: this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        ...(this.sdkSessionId && { resume: this.sdkSessionId }),
      };
      if (this.mcpServers) {
        sdkOptions.mcpServers = this.mcpServers;
      }
      sdkOptions.settingSources = ["user", "project"];

      const ctx = { threadId: this.info.id, turnId };

      for await (const msg of query({ prompt, options: sdkOptions })) {
        // Check for abort
        if (this.abortController.signal.aborted) {
          turn.status = "interrupted";
          break;
        }

        // Capture SDK session ID from init
        if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          this.sdkSessionId = String((msg as { session_id?: string }).session_id ?? "");
          await storage.setSdkSessionId(this.info.id, this.sdkSessionId);
        }

        // Track accumulated text for turn summary
        if (msg.type === "stream_event") {
          const event = (msg as { event?: Record<string, unknown> }).event;
          if (event?.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown>;
            if (delta?.type === "text_delta" && delta.text) {
              this.accumulatedText += String(delta.text);
            }
            if (delta?.type === "thinking_delta" && delta.thinking) {
              this.accumulatedReasoning += String(delta.thinking);
            }
          }
        }

        // Check for result to detect errors
        let isResultError = false;
        if (msg.type === "result") {
          const r = msg as { is_error?: boolean };
          isResultError = !!r.is_error;
        }

        // Translate and yield notifications
        const notifications = translateSdkMessage(msg as Record<string, unknown>, ctx);
        for (const notification of notifications) {
          yield notification;
        }

        // Update turn status on result
        if (msg.type === "result") {
          if (isResultError) {
            const r = msg as { result?: string };
            turn.status = "failed";
            turn.error = { message: String(r.result ?? "Unknown error") };
          } else if (turn.status === "inProgress") {
            turn.status = "completed";
          }
        }
      }

      // If still in progress after loop (e.g. stream ended without result), mark completed
      if (turn.status === "inProgress") {
        turn.status = "completed";
      }

      // Create final items from accumulated content
      if (this.accumulatedReasoning) {
        const reasoningItem = createReasoningItem(this.accumulatedReasoning);
        turnItems.push(reasoningItem);
      }
      if (this.accumulatedText) {
        const messageItem = createAgentMessageItem(this.accumulatedText);
        turnItems.push(messageItem);

        // Update thread preview
        this.info.preview = this.accumulatedText.slice(0, 200);
      }

      // Emit turn/completed with the full turn
      yield createNotification("turn/completed", {
        threadId: this.info.id,
        turn: { ...turn, items: [...turnItems] },
      });
    } catch (error) {
      turn.status = "failed";
      turn.error = { message: error instanceof Error ? error.message : String(error) };

      // Emit error notification
      yield createNotification("error", {
        error: turn.error,
        willRetry: false,
        threadId: this.info.id,
        turnId,
      });

      // Emit turn/completed with failed status
      yield createNotification("turn/completed", {
        threadId: this.info.id,
        turn: { ...turn, items: [...turnItems] },
      });
    } finally {
      this.abortController = undefined;
      this.currentTurnId = undefined;
      this.info.updatedAt = Math.floor(Date.now() / 1000);
      await this.save();
    }
  }

  interrupt(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async archive(): Promise<void> {
    this.info.source = "archived";
    this.info.updatedAt = Math.floor(Date.now() / 1000);
    await this.save();
  }
}

function normalizeSystemPrompt(systemPrompt: string | undefined): string | undefined {
  const normalized = systemPrompt?.trim();
  return normalized ? normalized : undefined;
}
