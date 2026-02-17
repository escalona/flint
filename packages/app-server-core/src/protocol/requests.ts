/**
 * Codex App Server Protocol - Request/Response Types
 * JSON-RPC lite (no "jsonrpc" field on the wire)
 */

import type {
  Thread,
  Turn,
  Model,
  Config,
  ConfigOption,
  UserInput,
  ApprovalPolicy,
  SandboxPolicy,
} from "./types.ts";

// JSON-RPC base types
export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard error codes
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Custom codes
  ThreadNotFound: -32000,
  TurnInProgress: -32001,
  NotRunning: -32002,
} as const;

// Initialize
export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
  };
}

export interface InitializeResult {
  agentInfo: {
    name: string;
    version: string;
    provider: string;
  };
  capabilities: {
    streaming: boolean;
    configOptions: boolean;
    reasoning: boolean;
    plans: boolean;
    review: boolean;
  };
}

// Thread management
export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  systemPrompt?: string;
  systemPromptAppend?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  config?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxPolicy;
}

export interface ThreadStartResult {
  thread: Thread;
  modelProvider: string;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string;
  cwd?: string;
  systemPrompt?: string;
  systemPromptAppend?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  config?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
}

export interface ThreadResumeResult {
  thread: Thread;
  model: string;
  cwd: string;
}

export interface ThreadListParams {
  cursor?: string;
  limit?: number;
  archived?: boolean;
}

export interface ThreadListResult {
  data: Thread[];
  nextCursor?: string;
}

export interface ThreadArchiveParams {
  threadId: string;
}

export interface ThreadArchiveResult {}

// Turn execution
export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  config?: Record<string, string>;
}

export interface TurnStartResult {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptResult {}

// Configuration
export interface ModelListResult {
  data: Model[];
}

export interface ConfigReadResult {
  config: Config;
}

export interface ConfigListResult {
  options: ConfigOption[];
}

export interface ConfigSetParams {
  id: string;
  value: string;
}

export interface ConfigSetResult {
  options: ConfigOption[];
}

// Method type mapping
export type RequestMethods = {
  initialize: { params: InitializeParams; result: InitializeResult };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResult };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResult };
  "thread/list": { params: ThreadListParams; result: ThreadListResult };
  "thread/archive": { params: ThreadArchiveParams; result: ThreadArchiveResult };
  "turn/start": { params: TurnStartParams; result: TurnStartResult };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResult };
  "model/list": { params: undefined; result: ModelListResult };
  "config/read": { params: undefined; result: ConfigReadResult };
  "config/list": { params: undefined; result: ConfigListResult };
  "config/set": { params: ConfigSetParams; result: ConfigSetResult };
};
