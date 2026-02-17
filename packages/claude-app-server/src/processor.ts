/**
 * JSON-RPC Request Processor
 * Routes requests to appropriate handlers
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadListParams,
  ThreadListResult,
  ThreadArchiveParams,
  ThreadArchiveResult,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
  TurnInterruptResult,
  ModelListResult,
  ConfigReadResult,
  ConfigListResult,
  ConfigSetParams,
  ConfigSetResult,
} from "@flint-dev/app-server-core";
import { ErrorCodes } from "@flint-dev/app-server-core";
import { threadManager } from "./thread-manager.ts";
import { stdio } from "@flint-dev/app-server-core";
import type { Model, Config, ConfigOption, UserInput } from "@flint-dev/app-server-core";
import type { ThreadOptions } from "./thread.ts";

const SERVER_NAME = "claude-app-server";
const SERVER_VERSION = "0.1.0";

// Available Claude models
const MODELS: Model[] = [
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Most capable model",
    isDefault: true,
  },
  {
    id: "claude-opus-4-5-20251101",
    displayName: "Claude Opus 4.5",
    description: "Previous generation Opus",
    isDefault: false,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4.5",
    description: "Balanced performance",
    isDefault: false,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fast and efficient",
    isDefault: false,
  },
];

// Server state
let initialized = false;
let defaultCwd = process.cwd();
let defaultModel = "claude-opus-4-6";

// Config options state
let configOptions: ConfigOption[] = [
  {
    type: "select",
    id: "max_thinking_tokens",
    name: "Max Thinking Tokens",
    description: "Maximum tokens for extended thinking",
    group: "model_settings",
    options: [
      { id: "8000", name: "8K" },
      { id: "16000", name: "16K" },
      { id: "31999", name: "32K", description: "Maximum" },
    ],
    value: "31999",
  },
];

/** Process a JSON-RPC request and return a response */
export async function processRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  try {
    const result = await routeMethod(method, params);
    return successResponse(id, result);
  } catch (error) {
    if (error instanceof RpcError) {
      return errorResponse(id, error.code, error.message, error.data);
    }
    return errorResponse(
      id,
      ErrorCodes.InternalError,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function routeMethod(method: string, params: unknown): Promise<unknown> {
  // Initialize must be called first
  if (method !== "initialize" && !initialized) {
    throw new RpcError(ErrorCodes.InvalidRequest, "Server not initialized");
  }

  switch (method) {
    case "initialize":
      return handleInitialize(params as InitializeParams);

    case "thread/start":
      return handleThreadStart(params as ThreadStartParams);

    case "thread/resume":
      return handleThreadResume(params as ThreadResumeParams);

    case "thread/list":
      return handleThreadList(params as ThreadListParams);

    case "thread/archive":
      return handleThreadArchive(params as ThreadArchiveParams);

    case "turn/start":
      return handleTurnStart(params as TurnStartParams);

    case "turn/interrupt":
      return handleTurnInterrupt(params as TurnInterruptParams);

    case "model/list":
      return handleModelList();

    case "config/read":
      return handleConfigRead();

    case "config/list":
      return handleConfigList();

    case "config/set":
      return handleConfigSet(params as ConfigSetParams);

    default:
      throw new RpcError(ErrorCodes.MethodNotFound, `Unknown method: ${method}`);
  }
}

// Handler implementations

async function handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
  if (initialized) {
    throw new RpcError(ErrorCodes.InvalidRequest, "Server already initialized");
  }

  initialized = true;

  return {
    agentInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      provider: "anthropic",
    },
    capabilities: {
      streaming: true,
      configOptions: true,
      reasoning: true,
      plans: false,
      review: false,
    },
  };
}

async function handleThreadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
  const model = params.model ?? defaultModel;
  const cwd = params.cwd ?? defaultCwd;
  const mcpServers = params.mcpServers as ThreadOptions["mcpServers"];
  const systemPromptAppend =
    (params.systemPromptAppend ?? params.developerInstructions)?.trim() || undefined;
  const thread = await threadManager.create({
    model,
    cwd,
    mcpServers,
    systemPrompt: params.systemPrompt,
    systemPromptAppend,
  });

  return {
    thread: thread.getInfoWithoutTurns(),
    modelProvider: "anthropic",
  };
}

async function handleThreadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
  const mcpServers = params.mcpServers as ThreadOptions["mcpServers"];
  const systemPromptAppend =
    (params.systemPromptAppend ?? params.developerInstructions)?.trim() || undefined;
  const result = await threadManager.getWithTurns(params.threadId, {
    mcpServers,
    systemPrompt: params.systemPrompt,
    systemPromptAppend,
  });
  if (!result) {
    throw new RpcError(ErrorCodes.ThreadNotFound, `Thread not found: ${params.threadId}`);
  }

  return result;
}

async function handleThreadList(params: ThreadListParams): Promise<ThreadListResult> {
  return threadManager.list(params.archived, params.limit, params.cursor);
}

async function handleThreadArchive(params: ThreadArchiveParams): Promise<ThreadArchiveResult> {
  const success = await threadManager.archive(params.threadId);
  if (!success) {
    throw new RpcError(ErrorCodes.ThreadNotFound, `Thread not found: ${params.threadId}`);
  }
  return {};
}

async function handleTurnStart(params: TurnStartParams): Promise<TurnStartResult> {
  const thread = await threadManager.get(params.threadId);
  if (!thread) {
    throw new RpcError(ErrorCodes.ThreadNotFound, `Thread not found: ${params.threadId}`);
  }

  if (thread.isRunning()) {
    throw new RpcError(ErrorCodes.TurnInProgress, "Turn already in progress");
  }

  // Extract text from input array
  const textInput = params.input?.find((i: UserInput) => i.type === "text");
  const prompt = textInput && "text" in textInput ? textInput.text : "";

  // Generate turn ID upfront so response and notifications use the same one
  const turnId = crypto.randomUUID();
  const turn: { id: string; items: []; status: "inProgress" } = {
    id: turnId,
    items: [],
    status: "inProgress",
  };

  // Build per-turn overrides
  const overrides = {
    model: params.model,
    cwd: params.cwd,
    config: params.config,
  };

  // Run turn in background and stream notifications
  (async () => {
    try {
      for await (const notification of thread.executeTurn(prompt, turnId, overrides)) {
        stdio.send(notification);
      }
    } catch (error) {
      // Error should have been handled and emitted as turn/completed with failed status
      console.error("Turn execution error:", error);
    }
  })();

  return { turn };
}

async function handleTurnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult> {
  const thread = await threadManager.get(params.threadId);
  if (!thread) {
    throw new RpcError(ErrorCodes.ThreadNotFound, `Thread not found: ${params.threadId}`);
  }

  if (!thread.isRunning()) {
    throw new RpcError(ErrorCodes.NotRunning, "No turn in progress");
  }

  thread.interrupt();
  return {};
}

async function handleModelList(): Promise<ModelListResult> {
  return { data: MODELS };
}

async function handleConfigRead(): Promise<ConfigReadResult> {
  const config: Config = {
    model: defaultModel,
    cwd: defaultCwd,
    modelProvider: "anthropic",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    options: configOptions,
  };
  return { config };
}

async function handleConfigList(): Promise<ConfigListResult> {
  return { options: configOptions };
}

async function handleConfigSet(params: ConfigSetParams): Promise<ConfigSetResult> {
  const option = configOptions.find((o) => o.id === params.id);
  if (!option) {
    throw new RpcError(ErrorCodes.InvalidParams, `Unknown config option: ${params.id}`);
  }

  const validValue = option.options.find((o) => o.id === params.value);
  if (!validValue) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      `Invalid value "${params.value}" for option "${params.id}"`,
    );
  }

  option.value = params.value;
  return { options: configOptions };
}

// Helpers

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

function successResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { id, result };
}

function errorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}

/**
 * Reset processor state (for testing only)
 */
export function resetProcessorForTesting(): void {
  initialized = false;
  defaultCwd = process.cwd();
  defaultModel = "claude-opus-4-5-20251101";
  configOptions = [
    {
      type: "select",
      id: "max_thinking_tokens",
      name: "Max Thinking Tokens",
      description: "Maximum tokens for extended thinking",
      group: "model_settings",
      options: [
        { id: "8000", name: "8K" },
        { id: "16000", name: "16K" },
        { id: "31999", name: "32K", description: "Maximum" },
      ],
      value: "31999",
    },
  ];
}
