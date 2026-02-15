import type {
  ThreadItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
} from "@flint-dev/app-server-core";
import { createNotification, type JsonRpcNotification } from "@flint-dev/app-server-core";
import type { PiRpcEvent } from "./pi-rpc-client.ts";

export interface AdapterContext {
  threadId: string;
  turnId: string;
  cwd: string;
}

interface PendingItemState {
  item: ThreadItem;
  startedAt: number;
  lastOutput: string;
}

let itemCounter = 0;

function nextItemId(): string {
  return `item-${++itemCounter}`;
}

export class PiEventAdapter {
  private readonly pendingItems = new Map<string, PendingItemState>();
  private accumulatedText = "";
  private accumulatedReasoning = "";
  private interrupted = false;
  private errorMessage: string | undefined;

  constructor(private readonly ctx: AdapterContext) {}

  translateEvent(event: PiRpcEvent): JsonRpcNotification[] {
    const notifications: JsonRpcNotification[] = [];

    switch (event.type) {
      case "message_update": {
        const update = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
        const updateType = String(update.type ?? "");

        if (updateType === "text_delta" && typeof update.delta === "string") {
          this.accumulatedText += update.delta;
          notifications.push(
            createNotification("item/agentMessage/delta", {
              threadId: this.ctx.threadId,
              turnId: this.ctx.turnId,
              itemId: "text",
              delta: update.delta,
            }),
          );
        }

        if (updateType === "thinking_delta" && typeof update.delta === "string") {
          this.accumulatedReasoning += update.delta;
          notifications.push(
            createNotification("item/reasoning/textDelta", {
              threadId: this.ctx.threadId,
              turnId: this.ctx.turnId,
              itemId: "reasoning",
              delta: update.delta,
              contentIndex: 0,
            }),
          );
        }

        if (updateType === "error") {
          const reason = String(update.reason ?? "");
          if (reason === "aborted") {
            this.interrupted = true;
          }

          const errorObj = (update.error ?? {}) as Record<string, unknown>;
          const errorText =
            typeof errorObj.errorMessage === "string"
              ? errorObj.errorMessage
              : typeof update.error === "string"
                ? update.error
                : "pi agent error";
          this.errorMessage = errorText;
        }

        break;
      }

      case "tool_execution_start": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : nextItemId();
        const toolName = String(event.toolName ?? "tool");
        const item = createToolStartItem(toolName, event.args, this.ctx.cwd);
        this.pendingItems.set(toolCallId, {
          item,
          startedAt: Date.now(),
          lastOutput: "",
        });

        notifications.push(
          createNotification("item/started", {
            threadId: this.ctx.threadId,
            turnId: this.ctx.turnId,
            item,
          }),
        );
        break;
      }

      case "tool_execution_update": {
        const toolCallId = String(event.toolCallId ?? "");
        const pending = this.pendingItems.get(toolCallId);
        if (!pending) break;

        if (pending.item.type === "commandExecution") {
          const output = extractToolText(event.partialResult);
          if (output === undefined) break;

          const delta = computeDelta(pending.lastOutput, output);
          pending.lastOutput = output;

          if (delta) {
            notifications.push(
              createNotification("item/commandExecution/outputDelta", {
                threadId: this.ctx.threadId,
                turnId: this.ctx.turnId,
                itemId: pending.item.id,
                delta,
              }),
            );
          }
        }

        break;
      }

      case "tool_execution_end": {
        const toolCallId = String(event.toolCallId ?? "");
        const pending = this.pendingItems.get(toolCallId);
        if (!pending) break;

        this.pendingItems.delete(toolCallId);

        const completed = completeItem(
          pending.item,
          event.result,
          Boolean(event.isError),
          pending.lastOutput,
          Date.now() - pending.startedAt,
        );

        notifications.push(
          createNotification("item/completed", {
            threadId: this.ctx.threadId,
            turnId: this.ctx.turnId,
            item: completed,
          }),
        );
        break;
      }

      case "extension_error": {
        const message = typeof event.error === "string" ? event.error : "pi extension error";
        notifications.push(
          createNotification("error", {
            error: { message },
            willRetry: false,
            threadId: this.ctx.threadId,
            turnId: this.ctx.turnId,
          }),
        );
        break;
      }

      case "turn_end": {
        const message = (event.message ?? {}) as Record<string, unknown>;
        if (String(message.stopReason ?? "") === "error") {
          const errorMessage =
            typeof message.errorMessage === "string" ? message.errorMessage : "pi agent error";
          this.errorMessage = errorMessage;
        }
        if (String(message.stopReason ?? "") === "aborted") {
          this.interrupted = true;
        }
        break;
      }
    }

    return notifications;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getAccumulatedReasoning(): string {
    return this.accumulatedReasoning;
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  getErrorMessage(): string | undefined {
    return this.errorMessage;
  }
}

function createToolStartItem(toolName: string, args: unknown, cwd: string): ThreadItem {
  const id = nextItemId();
  const normalized = toolName.toLowerCase();
  const params = (args ?? {}) as Record<string, unknown>;

  if (normalized === "bash") {
    return {
      type: "commandExecution",
      id,
      command: String(params.command ?? ""),
      cwd,
      status: "inProgress",
    } satisfies CommandExecutionItem;
  }

  if (normalized === "write") {
    return {
      type: "fileChange",
      id,
      changes: [{ path: extractPath(params), kind: { type: "add" }, diff: "" }],
      status: "inProgress",
    } satisfies FileChangeItem;
  }

  if (normalized === "edit") {
    return {
      type: "fileChange",
      id,
      changes: [{ path: extractPath(params), kind: { type: "update" }, diff: "" }],
      status: "inProgress",
    } satisfies FileChangeItem;
  }

  return {
    type: "mcpToolCall",
    id,
    server: "pi",
    tool: toolName,
    arguments: params,
    status: "inProgress",
  } satisfies McpToolCallItem;
}

function completeItem(
  pending: ThreadItem,
  result: unknown,
  isError: boolean,
  streamedOutput: string,
  durationMs: number,
): ThreadItem {
  if (pending.type === "commandExecution") {
    const finalOutput = extractToolText(result) ?? streamedOutput;
    return {
      ...pending,
      status: isError ? "failed" : "completed",
      exitCode: isError ? 1 : 0,
      aggregatedOutput: finalOutput,
      durationMs,
    } satisfies CommandExecutionItem;
  }

  if (pending.type === "fileChange") {
    const diff = extractDiff(result);
    const changes = pending.changes.map((change, index) =>
      index === 0 && diff
        ? {
            ...change,
            diff,
          }
        : change,
    );

    return {
      ...pending,
      status: isError ? "failed" : "completed",
      changes,
    } satisfies FileChangeItem;
  }

  if (pending.type === "mcpToolCall") {
    if (isError) {
      return {
        ...pending,
        status: "failed",
        error: {
          message: extractErrorMessage(result),
        },
        durationMs,
      } satisfies McpToolCallItem;
    }

    return {
      ...pending,
      status: "completed",
      result: {
        content: normalizeResultContent(result),
      },
      durationMs,
    } satisfies McpToolCallItem;
  }

  return pending;
}

function extractPath(args: Record<string, unknown>): string {
  const value = args.path ?? args.filePath ?? args.file_path;
  return typeof value === "string" ? value : "";
}

function extractToolText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const maybeText = (block as { text?: unknown; type?: unknown }).text;
      return typeof maybeText === "string" ? maybeText : "";
    })
    .filter(Boolean)
    .join("\n");

  return text || undefined;
}

function extractDiff(result: unknown): string {
  if (!result || typeof result !== "object") return "";

  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return "";

  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : "";
}

function extractErrorMessage(result: unknown): string {
  if (typeof result === "string" && result.trim()) return result;

  const text = extractToolText(result);
  if (text) return text;

  if (result && typeof result === "object" && "message" in result) {
    const message = (result as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return "Tool execution failed";
}

function normalizeResultContent(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;

  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) return content;
    return [result];
  }

  return result === undefined ? [] : [result];
}

function computeDelta(previous: string, next: string): string {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
}

export function createAgentMessageItem(text: string): AgentMessageItem {
  return {
    id: nextItemId(),
    type: "agentMessage",
    text,
  };
}

export function createReasoningItem(text: string): ReasoningItem {
  return {
    id: nextItemId(),
    type: "reasoning",
    summary: [],
    content: [text],
  };
}

export function resetAdapterForTesting(): void {
  itemCounter = 0;
}
