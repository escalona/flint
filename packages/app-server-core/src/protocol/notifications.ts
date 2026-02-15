/**
 * Codex App Server Protocol - Notification Types
 * JSON-RPC lite notifications (no id, no response expected)
 */

import type { Turn, ThreadItem, TurnError, PlanEntry } from "./types.ts";

// JSON-RPC notification (no id field)
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

// Turn notifications
export interface TurnStartedParams {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: Turn;
}

// Item notifications
export interface ItemStartedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

// Delta notifications (separate methods)
export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ReasoningTextDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex: number;
}

export interface CommandExecutionOutputDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface FileChangeOutputDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// Error notification
export interface ErrorNotificationParams {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

// Token usage notification
export interface TokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

// Plan notifications
export interface PlanDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnPlanUpdatedParams {
  threadId: string;
  turnId: string;
  explanation: string;
  plan: PlanEntry[];
}

// Notification method mapping
export type NotificationMethods = {
  "turn/started": TurnStartedParams;
  "turn/completed": TurnCompletedParams;
  "item/started": ItemStartedParams;
  "item/completed": ItemCompletedParams;
  "item/agentMessage/delta": AgentMessageDeltaParams;
  "item/reasoning/textDelta": ReasoningTextDeltaParams;
  "item/commandExecution/outputDelta": CommandExecutionOutputDeltaParams;
  "item/fileChange/outputDelta": FileChangeOutputDeltaParams;
  error: ErrorNotificationParams;
  "thread/tokenUsage/updated": TokenUsageUpdatedParams;
  "item/plan/delta": PlanDeltaParams;
  "turn/plan/updated": TurnPlanUpdatedParams;
};

// Helper to create a notification
export function createNotification<K extends keyof NotificationMethods>(
  method: K,
  params: NotificationMethods[K],
): JsonRpcNotification {
  return {
    method,
    params,
  };
}
