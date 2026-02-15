/**
 * Claude SDK Event → Codex Protocol Item Adapter
 * Translates Claude Agent SDK messages to Codex-style items and notifications
 */

import type {
  ThreadItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  AgentMessageItem,
  ReasoningItem,
} from "@flint-dev/app-server-core";
import { createNotification, type JsonRpcNotification } from "@flint-dev/app-server-core";

export interface AdapterContext {
  threadId: string;
  turnId: string;
}

// Track in-progress items by tool call ID
const pendingItems = new Map<string, ThreadItem>();
let itemCounter = 0;

function nextItemId(): string {
  return `item-${++itemCounter}`;
}

/** Translate a Claude SDK message to Codex-style notifications */
export function translateSdkMessage(
  msg: Record<string, unknown>,
  ctx: AdapterContext,
): JsonRpcNotification[] {
  const notifications: JsonRpcNotification[] = [];
  const { threadId, turnId } = ctx;

  switch (msg.type) {
    case "system": {
      // init message - no item needed
      break;
    }

    case "result": {
      const r = msg as {
        is_error?: boolean;
        result?: string;
      };

      if (r.is_error) {
        // Emit error notification + turn/completed with failed status
        notifications.push(
          createNotification("error", {
            error: { message: String(r.result ?? "Unknown error") },
            willRetry: false,
            threadId,
            turnId,
          }),
        );
      }
      // turn/completed is emitted by the Thread, not here
      break;
    }

    case "assistant": {
      const content =
        (
          msg as {
            message?: {
              content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
            };
          }
        ).message?.content ?? [];

      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) {
          const item = createToolStartItem(block.name, block.input, ctx);
          if (item) {
            pendingItems.set(block.id, item);
            notifications.push(
              createNotification("item/started", {
                threadId,
                turnId,
                item,
              }),
            );
          }
        }
      }
      break;
    }

    case "user": {
      const content =
        (
          msg as {
            message?: {
              content?: Array<{
                type: string;
                tool_use_id?: string;
                content?: unknown;
                is_error?: boolean;
              }>;
            };
          }
        ).message?.content ?? [];

      const result = msg.tool_use_result as unknown;

      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const pending = pendingItems.get(block.tool_use_id);
          if (pending) {
            const completedItem = completeItem(pending, result ?? block.content, block.is_error);
            pendingItems.delete(block.tool_use_id);

            notifications.push(
              createNotification("item/completed", {
                threadId,
                turnId,
                item: completedItem,
              }),
            );
          }
        }
      }
      break;
    }

    case "stream_event": {
      const event = msg.event as Record<string, unknown>;
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === "text_delta" && delta.text) {
          notifications.push(
            createNotification("item/agentMessage/delta", {
              threadId,
              turnId,
              itemId: "text",
              delta: String(delta.text),
            }),
          );
        }
        if (delta?.type === "thinking_delta" && delta.thinking) {
          notifications.push(
            createNotification("item/reasoning/textDelta", {
              threadId,
              turnId,
              itemId: "reasoning",
              delta: String(delta.thinking),
              contentIndex: 0,
            }),
          );
        }
      }
      break;
    }
  }

  return notifications;
}

function createToolStartItem(
  toolName: string,
  input: unknown,
  _ctx: AdapterContext,
): ThreadItem | null {
  const id = nextItemId();
  const params = (input as Record<string, unknown>) ?? {};

  switch (toolName) {
    case "Bash":
      return {
        type: "commandExecution",
        id,
        command: String(params.command ?? ""),
        cwd: String(params.cwd ?? process.cwd()),
        status: "inProgress",
      } satisfies CommandExecutionItem;

    case "Write":
      return {
        type: "fileChange",
        id,
        changes: [
          {
            path: String(params.file_path ?? params.path ?? ""),
            kind: { type: "add" },
            diff: "",
          },
        ],
        status: "inProgress",
      } satisfies FileChangeItem;

    case "Edit":
      return {
        type: "fileChange",
        id,
        changes: [
          {
            path: String(params.file_path ?? params.path ?? ""),
            kind: { type: "update" },
            diff: "",
          },
        ],
        status: "inProgress",
      } satisfies FileChangeItem;

    default:
      return {
        type: "mcpToolCall",
        id,
        server: "claude",
        tool: toolName,
        arguments: params,
        status: "inProgress",
      } satisfies McpToolCallItem;
  }
}

function completeItem(pending: ThreadItem, result: unknown, isError?: boolean): ThreadItem {
  switch (pending.type) {
    case "commandExecution": {
      return {
        ...pending,
        status: "completed",
        exitCode: isError ? 1 : 0,
        aggregatedOutput: formatResult(result),
      } satisfies CommandExecutionItem;
    }

    case "fileChange": {
      return {
        ...pending,
        status: "completed",
      } satisfies FileChangeItem;
    }

    case "mcpToolCall": {
      return {
        ...pending,
        status: "completed",
        result: { content: Array.isArray(result) ? result : [result] },
      } satisfies McpToolCallItem;
    }

    default:
      return pending;
  }
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  return JSON.stringify(result, null, 2);
}

/** Create an agent message item from accumulated text */
export function createAgentMessageItem(text: string): AgentMessageItem {
  return {
    id: nextItemId(),
    type: "agentMessage",
    text,
  };
}

/** Create a reasoning item from accumulated thinking */
export function createReasoningItem(text: string): ReasoningItem {
  return {
    id: nextItemId(),
    type: "reasoning",
    summary: [],
    content: [text],
  };
}

/** Reset adapter state (call between turns) */
export function resetAdapter(): void {
  pendingItems.clear();
}

/** Reset adapter state completely (for testing) */
export function resetAdapterForTesting(): void {
  pendingItems.clear();
  itemCounter = 0;
}
