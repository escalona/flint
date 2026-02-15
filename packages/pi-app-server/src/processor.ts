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
import { PiRpcClient, getPiCommandConfigFromEnv } from "./pi-rpc-client.ts";
import { formatPiModel } from "./pi-model.ts";

const SERVER_NAME = "pi-app-server";
const SERVER_VERSION = "0.1.0";
const MODEL_CACHE_TTL_MS = 30_000;
const DEFAULT_MODEL =
  process.env["PI_APP_SERVER_DEFAULT_MODEL"]?.trim() || "google/gemini-2.5-flash";

let modelsCache: { at: number; models: Model[] } | null = null;

let initialized = false;
let defaultCwd = process.cwd();
let defaultModel = DEFAULT_MODEL;

let configOptions: ConfigOption[] = [
  {
    type: "select",
    id: "thinking_level",
    name: "Thinking Level",
    description: "Reasoning intensity for supported models",
    group: "model_settings",
    options: [
      { id: "off", name: "Off" },
      { id: "minimal", name: "Minimal" },
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "XHigh" },
    ],
    value: "medium",
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

async function handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
  if (initialized) {
    throw new RpcError(ErrorCodes.InvalidRequest, "Server already initialized");
  }

  initialized = true;

  return {
    agentInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      provider: "pi",
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
  const thread = await threadManager.create({ model, cwd });

  return {
    thread: thread.getInfoWithoutTurns(),
    modelProvider: "pi",
  };
}

async function handleThreadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
  const result = await threadManager.getWithTurns(params.threadId);
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

  const textInput = params.input?.find((input: UserInput) => input.type === "text");
  const prompt = textInput && "text" in textInput ? textInput.text : "";

  const turnId = crypto.randomUUID();
  const turn: { id: string; items: []; status: "inProgress" } = {
    id: turnId,
    items: [],
    status: "inProgress",
  };

  const persistedConfig = Object.fromEntries(
    configOptions.map((option) => [option.id, option.value]),
  );
  const mergedConfig = {
    ...persistedConfig,
    ...params.config,
  };

  const overrides = {
    model: params.model,
    cwd: params.cwd,
    config: Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined,
  };

  (async () => {
    try {
      for await (const notification of thread.executeTurn(prompt, turnId, overrides)) {
        stdio.send(notification);
      }
    } catch (error) {
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
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < MODEL_CACHE_TTL_MS) {
    return { data: modelsCache.models };
  }

  const models = await fetchPiModels(defaultCwd);
  modelsCache = { at: now, models };
  return { data: models };
}

async function handleConfigRead(): Promise<ConfigReadResult> {
  const config: Config = {
    model: defaultModel,
    cwd: defaultCwd,
    modelProvider: "pi",
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

async function fetchPiModels(cwd: string): Promise<Model[]> {
  const commandConfig = getPiCommandConfigFromEnv();
  const client = new PiRpcClient({
    command: commandConfig.command,
    commandArgs: commandConfig.args,
    cwd,
  });

  try {
    await client.start();
    const models = await client.getAvailableModels();

    if (models.length === 0) {
      return fallbackModels();
    }

    return models.map((model) => {
      const id = formatPiModel(model.provider, model.id);
      return {
        id,
        displayName: model.name ?? id,
        description: model.contextWindow ? `Context window: ${model.contextWindow}` : undefined,
        isDefault: id === defaultModel,
        meta: {
          provider: model.provider,
          modelId: model.id,
          reasoning: model.reasoning ?? false,
        },
      } satisfies Model;
    });
  } catch {
    return fallbackModels();
  } finally {
    client.close();
  }
}

function fallbackModels(): Model[] {
  return [
    {
      id: defaultModel,
      displayName: defaultModel,
      description: "Default pi model",
      isDefault: true,
    },
  ];
}

/**
 * Reset processor state (for testing only)
 */
export function resetProcessorForTesting(): void {
  initialized = false;
  defaultCwd = process.cwd();
  defaultModel = DEFAULT_MODEL;
  modelsCache = null;
  configOptions = [
    {
      type: "select",
      id: "thinking_level",
      name: "Thinking Level",
      description: "Reasoning intensity for supported models",
      group: "model_settings",
      options: [
        { id: "off", name: "Off" },
        { id: "minimal", name: "Minimal" },
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
        { id: "xhigh", name: "XHigh" },
      ],
      value: "medium",
    },
  ];
}
