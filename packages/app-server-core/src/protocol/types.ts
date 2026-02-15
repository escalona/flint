/**
 * Codex App Server Protocol Types
 * Matches the Codex app-server-protocol v2 shapes exactly
 */

// Approval & Sandbox policies
export type ApprovalPolicy = "never" | "unlessTrusted" | "always";

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | { type: "workspaceWrite"; writableRoots?: string[]; networkAccess?: boolean }
  | { type: "externalSandbox"; networkAccess?: "restricted" | "enabled" };

// Thread
export interface Thread {
  id: string;
  preview: string;
  model: string;
  modelProvider: string;
  createdAt: number; // Unix timestamp (seconds)
  updatedAt: number;
  cwd: string;
  cliVersion: string;
  source: string;
  turns: Turn[];
}

// Turn
export interface Turn {
  id: string; // UUID
  items: ThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: TurnError;
}

export interface TurnError {
  message: string;
  errorInfo?: string;
  httpStatusCode?: number;
}

// ThreadItem — tagged union
export type ThreadItem =
  | AgentMessageItem
  | UserMessageItem
  | CommandExecutionItem
  | FileChangeItem
  | ReasoningItem
  | McpToolCallItem
  | WebSearchItem
  | PlanItem;

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
}

export interface UserMessageItem {
  type: "userMessage";
  id: string;
  content: UserInput[];
}

export interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: FileUpdateChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
}

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; movePath?: string };

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
}

export interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments: unknown;
  result?: McpToolCallResult;
  error?: McpToolCallError;
  durationMs?: number;
}

export interface McpToolCallResult {
  content: unknown[];
}

export interface McpToolCallError {
  message: string;
}

export interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
}

export interface PlanItem {
  type: "plan";
  id: string;
  text: string;
  entries?: PlanEntry[];
}

export interface PlanEntry {
  step: string;
  status: "pending" | "inProgress" | "completed" | "failed";
}

// UserInput
export type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

// Config option types
export interface ConfigOption {
  type: "select";
  id: string;
  name: string;
  description?: string;
  group?: string;
  options: ConfigSelectOption[];
  value: string;
  modelIds?: string[];
}

export interface ConfigSelectOption {
  id: string;
  name: string;
  description?: string;
}

// Config
export interface Config {
  model: string;
  cwd: string;
  modelProvider: string;
  approvalPolicy: ApprovalPolicy;
  sandboxPolicy: SandboxPolicy;
  options: ConfigOption[];
}

// Model
export interface Model {
  id: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  meta?: Record<string, unknown>;
}
