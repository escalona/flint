import { SlackAdapter, createWebhookHandler } from "@flint-dev/channels";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  createClient,
  type AgentEvent,
  type AppServerClient,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "@flint-dev/sdk";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  buildMemoryFileSystemPromptSection,
  buildMemorySystemPromptSection,
  loadMemoryRootFile,
} from "./memory.ts";
import {
  parseResetCommand,
  resolveSessionLifecycleConfig,
  resolveSessionResetPolicy,
  resolveSessionType,
  evaluateSessionReset,
  type ResolvedSessionLifecycleConfig,
} from "./session-lifecycle.ts";
import { composeSystemPromptAppend } from "./system-context.ts";

export type RoutingMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type ChatType = "direct" | "group" | "channel";
export type { CodexApprovalPolicy, CodexSandboxMode };

export interface CodexExecutionConfig {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
}

const USER_SETTINGS_PATH_ENV = "FLINT_GATEWAY_USER_SETTINGS_PATH";
const ENV_VAR_REF_REGEX = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_ENV_VAR_REF_REGEX = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_ENV_VAR_SENTINEL = "__FLINT_ESCAPED_ENV_VAR__";
const MEMORY_MCP_DEFAULT_ALIAS = "flint_memory";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
const BUILTIN_PROVIDER_HINTS = ["claude", "pi", "codex"];
const DEFAULT_CODEX_EXECUTION: Readonly<CodexExecutionConfig> = Object.freeze({
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
});
const CODEX_APPROVAL_POLICY_SET = new Set<string>(CODEX_APPROVAL_POLICIES);
const CODEX_SANDBOX_MODE_SET = new Set<string>(CODEX_SANDBOX_MODES);

interface McpProfileDefinition {
  profiles?: string[];
  servers?: Record<string, Record<string, unknown>>;
}

interface GatewaySettings {
  gateway?: {
    mcpProfiles?: Record<string, McpProfileDefinition>;
    defaultMcpProfileIds?: string[];
    session?: unknown;
    codex?: unknown;
  };
}

export interface InboundMessage {
  channel: string;
  userId: string;
  text: string;
  mcpProfileIds?: string[];
  provider?: string;
  chatType?: ChatType;
  peerId?: string;
  accountId?: string;
  identityId?: string;
  channelThreadId?: string;
  routingMode?: RoutingMode;
  idempotencyKey?: string;
}

export interface ThreadRecord {
  threadId: string;
  routingMode: RoutingMode;
  provider: string;
  providerThreadId: string;
  model?: string;
  mcpProfileIds?: string[];
  channel: string;
  userId: string;
  chatType: ChatType;
  peerId: string;
  accountId?: string;
  identityId?: string;
  channelThreadId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ThreadStoreData {
  threads: Record<string, ThreadRecord>;
}

interface ThreadRuntime {
  client: AppServerClient;
  providerThreadId: string;
  provider: string;
  model?: string;
  mcpProfileIds: string[];
}

interface GatewayMemoryMcpServer {
  alias: string;
  server: Record<string, unknown>;
}

export interface GatewayOptions {
  cwd: string;
  defaultRoutingMode: RoutingMode;
  defaultProvider: string;
  model?: string;
  storePath: string;
  identityLinks: Record<string, string[]>;
  mcpProfiles: Record<string, McpProfileDefinition>;
  defaultMcpProfileIds: string[];
  memoryMcpServer?: GatewayMemoryMcpServer;
  sessionLifecycle: ResolvedSessionLifecycleConfig;
  codexExecution?: CodexExecutionConfig;
  codexExecutionError?: string;
}

export interface GatewayReply {
  threadId: string;
  routingMode: RoutingMode;
  provider: string;
  reply: string;
}

interface IdempotentResult {
  status: number;
  body: Record<string, unknown>;
}

interface IdempotencyEntry {
  ts: number;
  fingerprint: string;
  result: IdempotentResult;
}

class ThreadStore {
  private data: ThreadStoreData = { threads: {} };
  private readonly file: ReturnType<typeof Bun.file>;

  constructor(private readonly path: string) {
    this.file = Bun.file(path);
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (!(await this.file.exists())) {
      await this.persist();
      return;
    }

    try {
      const raw = await this.file.text();
      const parsed = JSON.parse(raw) as ThreadStoreData;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.threads &&
        typeof parsed.threads === "object"
      ) {
        this.data = parsed;
      }
    } catch {
      this.data = { threads: {} };
      await this.persist();
    }
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.data.threads[threadId];
  }

  list(): ThreadRecord[] {
    return Object.values(this.data.threads).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsert(record: ThreadRecord): Promise<void> {
    this.data.threads[record.threadId] = record;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await Bun.write(this.path, JSON.stringify(this.data, null, 2));
  }
}

class PerKeyQueue {
  private queues = new Map<string, Array<() => Promise<void>>>();
  private running = new Set<string>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrapped = async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };

      const queue = this.queues.get(key) ?? [];
      queue.push(wrapped);
      this.queues.set(key, queue);
      void this.drain(key);
    });
  }

  private async drain(key: string): Promise<void> {
    if (this.running.has(key)) return;
    this.running.add(key);

    try {
      const queue = this.queues.get(key);
      while (queue && queue.length > 0) {
        const job = queue.shift();
        if (!job) continue;
        await job();
      }
    } finally {
      this.running.delete(key);
      const queue = this.queues.get(key);
      if (!queue || queue.length === 0) {
        this.queues.delete(key);
      }
    }
  }
}

export class IdempotencyStore {
  private readonly done = new Map<string, IdempotencyEntry>();
  private readonly inflight = new Map<string, Promise<IdempotentResult>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  async execute(
    key: string,
    fingerprint: string,
    task: () => Promise<IdempotentResult>,
  ): Promise<{ result: IdempotentResult; cached: boolean }> {
    this.cleanup();

    const completed = this.done.get(key);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return {
          cached: true,
          result: {
            status: 409,
            body: {
              error: "Idempotency key conflict.",
              details: "This idempotency key was already used with a different payload.",
            },
          },
        };
      }
      return { cached: true, result: completed.result };
    }

    const active = this.inflight.get(key);
    if (active) {
      const result = await active;
      return { cached: true, result };
    }

    const promise = (async () => {
      const result = await task();
      this.done.set(key, {
        ts: Date.now(),
        fingerprint,
        result,
      });
      return result;
    })();

    this.inflight.set(key, promise);
    try {
      const result = await promise;
      return { cached: false, result };
    } finally {
      this.inflight.delete(key);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.done.entries()) {
      if (now - entry.ts > this.ttlMs) {
        this.done.delete(key);
      }
    }
  }
}

export class FlintGateway {
  private readonly store: ThreadStore;
  private readonly queue = new PerKeyQueue();
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly codexExecution: CodexExecutionConfig;
  private readonly codexExecutionError: string | undefined;

  constructor(private readonly options: GatewayOptions) {
    this.store = new ThreadStore(options.storePath);
    this.codexExecution = options.codexExecution
      ? { ...options.codexExecution }
      : copyDefaultCodexExecution();
    this.codexExecutionError = options.codexExecutionError;
  }

  async start(): Promise<void> {
    await this.store.init();
  }

  listThreads(): ThreadRecord[] {
    return this.store.list();
  }

  getThread(threadId: string): ThreadRecord | undefined {
    return this.store.get(threadId);
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.client.close();
    }
    this.runtimes.clear();
  }

  async handleMessage(
    message: InboundMessage,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<GatewayReply> {
    const routingMode = message.routingMode ?? this.options.defaultRoutingMode;
    const threadId = resolveThreadId(message, routingMode, this.options.identityLinks);
    return this.processMessage(threadId, routingMode, message, onEvent);
  }

  async handleThreadMessage(
    threadId: string,
    text: string,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<GatewayReply> {
    const record = this.store.get(threadId);
    if (!record) {
      throw new Error("Thread not found.");
    }
    const message = messageFromThreadRecord(record, text);
    return this.processMessage(threadId, record.routingMode, message, onEvent);
  }

  async interruptThread(threadId: string): Promise<boolean> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return false;
    await runtime.client.interrupt();
    return true;
  }

  private async processMessage(
    threadId: string,
    routingMode: RoutingMode,
    message: InboundMessage,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<GatewayReply> {
    return this.queue.enqueue(threadId, async () => {
      const existing = this.store.get(threadId);
      const command = parseResetCommand({
        text: message.text,
        resetTriggers: this.options.sessionLifecycle.resetTriggers,
        greetingPrompt: this.options.sessionLifecycle.greetingPrompt,
        providerHints: this.resolveProviderHints(existing, message),
      });

      let resetReason: string | undefined;
      if (command.triggered) {
        resetReason = `trigger:${command.trigger ?? "unknown"}`;
      } else if (existing) {
        const sessionType = resolveSessionType({
          chatType: normalizeChatType(message.chatType ?? existing.chatType),
          channelThreadId: message.channelThreadId ?? existing.channelThreadId,
        });
        const policy = resolveSessionResetPolicy(this.options.sessionLifecycle, {
          sessionType,
          channel: normalizeToken(message.channel) || existing.channel,
        });
        const resetCheck = evaluateSessionReset(existing.updatedAt, Date.now(), policy);
        if (resetCheck.expired) {
          resetReason = `${resetCheck.reason ?? "daily"}_expiry`;
        }
      }

      if (resetReason) {
        await this.resetRuntimeForFreshSession(threadId);
      }

      let runtime: ThreadRuntime;
      let reply: string;
      let fallbackWarning: string | undefined;
      try {
        runtime = await this.ensureThreadRuntime(message, routingMode, threadId, {
          forceNewSession: Boolean(resetReason),
          providerOverride: command.providerOverride,
          modelOverride: command.modelOverride,
        });
        reply = await this.runTurn(runtime.client, command.nextText, runtime.model, onEvent);
      } catch (error) {
        if (!this.shouldFallbackToDefaultModel(error, command.modelOverride ?? existing?.model)) {
          throw error;
        }
        await this.resetRuntimeForFreshSession(threadId);
        runtime = await this.ensureThreadRuntime(message, routingMode, threadId, {
          forceNewSession: true,
          providerOverride: command.providerOverride,
          forceDefaultModel: true,
        });
        reply = await this.runTurn(runtime.client, command.nextText, runtime.model, onEvent);
        fallbackWarning = this.buildModelFallbackWarning(
          command.modelOverride ?? existing?.model ?? "requested model",
          runtime.provider,
        );
      }
      const replyWithWarning = fallbackWarning ? `${fallbackWarning}\n\n${reply}` : reply;
      const now = new Date().toISOString();
      const chatType = normalizeChatType(message.chatType);
      const peerId = resolvePeerId(message);
      const accountId = normalizeOptionalToken(message.accountId);

      await this.store.upsert({
        threadId,
        routingMode,
        provider: runtime.provider,
        providerThreadId: runtime.providerThreadId,
        ...(runtime.model && { model: runtime.model }),
        ...(runtime.mcpProfileIds.length > 0 && { mcpProfileIds: runtime.mcpProfileIds }),
        channel: normalizeToken(message.channel) || "unknown",
        userId: message.userId.trim(),
        chatType,
        peerId,
        ...(accountId && { accountId }),
        ...(message.identityId && { identityId: message.identityId.trim() }),
        ...(message.channelThreadId && { channelThreadId: message.channelThreadId.trim() }),
        createdAt: resetReason ? now : (existing?.createdAt ?? now),
        updatedAt: now,
      });

      return {
        threadId,
        routingMode,
        provider: runtime.provider,
        reply: replyWithWarning,
      };
    });
  }

  private async ensureThreadRuntime(
    message: InboundMessage,
    routingMode: RoutingMode,
    threadId: string,
    options?: {
      forceNewSession?: boolean;
      providerOverride?: string;
      modelOverride?: string;
      forceDefaultModel?: boolean;
    },
  ): Promise<ThreadRuntime> {
    const forceNewSession = options?.forceNewSession ?? false;
    const record = this.store.get(threadId);
    const providerOverride = normalizeToken(options?.providerOverride);
    const requestedProvider = normalizeToken(message.provider);
    const recordProvider = normalizeToken(record?.provider);
    const provider =
      providerOverride ||
      recordProvider ||
      requestedProvider ||
      normalizeToken(this.options.defaultProvider) ||
      "claude";
    if (provider === "codex" && this.codexExecutionError) {
      throw new Error(this.codexExecutionError);
    }
    const requestedModel = options?.forceDefaultModel
      ? this.options.model
      : options?.modelOverride?.trim() || record?.model || this.options.model;
    const requestedMcpProfileIds = normalizeMcpProfileIds(
      message.mcpProfileIds ?? record?.mcpProfileIds ?? this.options.defaultMcpProfileIds,
    );
    const existingRuntime = this.runtimes.get(threadId);
    if (existingRuntime) {
      if (forceNewSession) {
        existingRuntime.client.close();
        this.runtimes.delete(threadId);
      } else if (provider !== normalizeToken(existingRuntime.provider)) {
        console.warn(
          `[gateway] provider mismatch for ${threadId}: requested=${provider}, active=${existingRuntime.provider}; keeping active runtime`,
        );
        return existingRuntime;
      } else if (!mcpProfileIdsEqual(requestedMcpProfileIds, existingRuntime.mcpProfileIds)) {
        console.warn(`[gateway] mcp profile mismatch for ${threadId}; recycling runtime`);
        existingRuntime.client.close();
        this.runtimes.delete(threadId);
      } else {
        return existingRuntime;
      }
    }

    const profileMcpServers = resolveMcpServersFromProfiles(
      requestedMcpProfileIds,
      this.options.mcpProfiles,
    );
    const requestedMcpServers = mergeMemoryMcpServer(
      profileMcpServers,
      this.options.memoryMcpServer,
    );
    const codexThreadOptions =
      provider === "codex"
        ? {
            approvalPolicy: this.codexExecution.approvalPolicy,
            sandboxMode: this.codexExecution.sandboxMode,
          }
        : undefined;

    const client = createClient({
      provider,
      cwd: this.options.cwd,
      env: process.env as Record<string, string>,
    });
    await client.start();
    const systemPromptAppend = await this.resolveSystemPromptAppend();

    let providerThreadId: string;
    if (record?.providerThreadId && !forceNewSession) {
      try {
        providerThreadId = await client.resumeThread(record.providerThreadId, {
          cwd: this.options.cwd,
          ...(requestedModel && { model: requestedModel }),
          ...(codexThreadOptions ?? {}),
          ...(systemPromptAppend && { systemPromptAppend }),
          ...(requestedMcpServers && { mcpServers: requestedMcpServers }),
        });
      } catch (error) {
        console.warn(
          `[gateway] failed to resume provider thread ${record.providerThreadId} for ${threadId}: ${formatError(error)}; creating a new thread`,
        );
        providerThreadId = await client.createThread({
          ...(requestedModel && { model: requestedModel }),
          ...(codexThreadOptions ?? {}),
          ...(systemPromptAppend && { systemPromptAppend }),
          ...(requestedMcpServers && { mcpServers: requestedMcpServers }),
        });
      }
    } else {
      providerThreadId = await client.createThread({
        ...(requestedModel && { model: requestedModel }),
        ...(codexThreadOptions ?? {}),
        ...(systemPromptAppend && { systemPromptAppend }),
        ...(requestedMcpServers && { mcpServers: requestedMcpServers }),
      });
      const now = new Date().toISOString();
      const chatType = normalizeChatType(message.chatType);
      const peerId = resolvePeerId(message);
      const accountId = normalizeOptionalToken(message.accountId);

      await this.store.upsert({
        threadId,
        routingMode,
        provider,
        providerThreadId,
        ...(requestedModel && { model: requestedModel }),
        ...(requestedMcpProfileIds.length > 0 && { mcpProfileIds: requestedMcpProfileIds }),
        channel: normalizeToken(message.channel) || "unknown",
        userId: message.userId.trim(),
        chatType,
        peerId,
        ...(accountId && { accountId }),
        ...(message.identityId && { identityId: message.identityId.trim() }),
        ...(message.channelThreadId && { channelThreadId: message.channelThreadId.trim() }),
        createdAt: now,
        updatedAt: now,
      });
    }

    const runtime = {
      client,
      providerThreadId,
      provider,
      ...(requestedModel && { model: requestedModel }),
      mcpProfileIds: requestedMcpProfileIds,
    };
    this.runtimes.set(threadId, runtime);
    return runtime;
  }

  private async resolveSystemPromptAppend(): Promise<string | undefined> {
    if (!this.options.memoryMcpServer) {
      return undefined;
    }
    return loadGatewaySystemPromptAppend(this.options.cwd);
  }

  private async runTurn(
    client: AppServerClient,
    inputText: string,
    model: string | undefined,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<string> {
    const promptOptions = model ? { model } : undefined;
    let responseText = "";
    let terminalError: string | null = null;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Interrupt the agent if no events arrive for 2 minutes (matches Claude Code CLI default).
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timedOut = true;
        console.warn("[gateway] turn inactive for 120s, interrupting agent");
        await client.interrupt();
      }, 120_000);
    };

    resetTimer();
    try {
      for await (const event of client.prompt(inputText, promptOptions)) {
        resetTimer();
        if (onEvent) await onEvent(event);
        switch (event.type) {
          case "text":
            responseText += event.delta;
            break;
          case "tool_start":
          case "tool_end":
            break;
          case "error":
            terminalError = event.message;
            break;
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (timedOut) {
      throw new Error("Turn interrupted: no agent activity for 120s.");
    }

    if (terminalError) {
      throw new Error(terminalError);
    }

    return responseText.trim() || "(no response)";
  }

  private resolveProviderHints(
    record: ThreadRecord | undefined,
    message: InboundMessage,
  ): string[] {
    const hints = new Set<string>(BUILTIN_PROVIDER_HINTS);
    if (this.options.defaultProvider) hints.add(this.options.defaultProvider);
    if (record?.provider) hints.add(record.provider);
    if (message.provider) hints.add(message.provider);
    return Array.from(hints);
  }

  private async resetRuntimeForFreshSession(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.client.close();
    this.runtimes.delete(threadId);
  }

  private shouldFallbackToDefaultModel(error: unknown, requestedModel: string | undefined): boolean {
    const requested = requestedModel?.trim().toLowerCase();
    const defaultModel = this.options.model?.trim().toLowerCase();
    if (!requested) {
      return false;
    }
    if (requested === defaultModel) {
      return false;
    }
    return this.isInvalidModelError(error, requested);
  }

  private isInvalidModelError(error: unknown, requestedModel: string): boolean {
    const message = formatError(error).toLowerCase();
    if (!message.includes(requestedModel)) {
      return false;
    }
    return (
      message.includes("model") &&
      (message.includes("not supported") ||
        message.includes("unsupported") ||
        message.includes("unknown model") ||
        message.includes("invalid model"))
    );
  }

  private buildModelFallbackWarning(requestedModel: string, provider: string): string {
    return `Warning: Model "${requestedModel}" is unavailable for provider "${provider}". Using the default model instead.`;
  }
}

export function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeMcpProfileIds(ids: string[] | undefined): string[] {
  if (!ids) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mcpProfileIdsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function normalizeOptionalToken(value: string | undefined | null): string | undefined {
  const normalized = normalizeToken(value);
  return normalized || undefined;
}

function normalizeChatType(value: unknown): ChatType {
  if (value === "group" || value === "channel") return value;
  return "direct";
}

function resolvePeerId(message: InboundMessage): string {
  const peerId = normalizeToken(message.peerId) || normalizeToken(message.userId);
  return peerId || "unknown";
}

function resolveLinkedIdentity(params: {
  channel: string;
  peerId: string;
  identityLinks: Record<string, string[]>;
}): string | undefined {
  if (!params.peerId) return undefined;
  const candidates = new Set<string>([params.peerId, `${params.channel}:${params.peerId}`]);
  for (const [canonicalRaw, ids] of Object.entries(params.identityLinks)) {
    const canonical = normalizeToken(canonicalRaw);
    if (!canonical || !Array.isArray(ids)) continue;
    for (const id of ids) {
      const candidate = normalizeToken(id);
      if (candidate && candidates.has(candidate)) {
        return canonical;
      }
    }
  }
  return undefined;
}

function maybeWithThreadSuffix(baseThreadId: string, channelThreadId: string | undefined): string {
  const thread = normalizeOptionalToken(channelThreadId);
  if (!thread) return baseThreadId;
  return `${baseThreadId}:thread:${thread}`;
}

function messageFromThreadRecord(record: ThreadRecord, text: string): InboundMessage {
  return {
    channel: record.channel,
    userId: record.userId,
    text,
    provider: record.provider,
    chatType: record.chatType,
    peerId: record.peerId,
    ...(record.accountId && { accountId: record.accountId }),
    ...(record.identityId && { identityId: record.identityId }),
    ...(record.channelThreadId && { channelThreadId: record.channelThreadId }),
    ...(record.mcpProfileIds && { mcpProfileIds: record.mcpProfileIds }),
    routingMode: record.routingMode,
  };
}

export function resolveThreadId(
  message: InboundMessage,
  routingMode: RoutingMode,
  identityLinks: Record<string, string[]>,
): string {
  const channel = normalizeToken(message.channel) || "unknown";
  const accountId = normalizeToken(message.accountId) || "default";
  const chatType = normalizeChatType(message.chatType);
  const peerId = resolvePeerId(message);
  const identityId = normalizeOptionalToken(message.identityId);

  if (chatType !== "direct") {
    const base = `agent:main:${channel}:${chatType}:${peerId}`;
    return maybeWithThreadSuffix(base, message.channelThreadId);
  }

  const linkedIdentity = resolveLinkedIdentity({
    channel,
    peerId,
    identityLinks,
  });
  const principal = identityId || linkedIdentity || peerId;

  switch (routingMode) {
    case "main":
      return "agent:main:main";
    case "per-peer":
      return `agent:main:direct:${principal}`;
    case "per-channel-peer":
      return maybeWithThreadSuffix(
        `agent:main:${channel}:direct:${principal}`,
        message.channelThreadId,
      );
    case "per-account-channel-peer":
      return maybeWithThreadSuffix(
        `agent:main:${channel}:${accountId}:direct:${principal}`,
        message.channelThreadId,
      );
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseRoutingMode(value: unknown): RoutingMode | undefined {
  if (
    value === "main" ||
    value === "per-peer" ||
    value === "per-channel-peer" ||
    value === "per-account-channel-peer"
  ) {
    return value;
  }
  return undefined;
}

function parseChatType(value: unknown): ChatType | undefined {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return undefined;
}

export function parseInboundMessage(
  payload: unknown,
): { ok: true; message: InboundMessage } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }

  const body = payload as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? body.channel.trim() : "";
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  const routingMode = parseRoutingMode(body.routingMode);
  const chatType = parseChatType(body.chatType);

  if (!channel) return { ok: false, error: "channel is required." };
  if (!userId) return { ok: false, error: "userId is required." };
  if (!text.trim()) return { ok: false, error: "text is required." };
  if (body.routingMode !== undefined && !routingMode) {
    return {
      ok: false,
      error:
        "routingMode must be one of: main, per-peer, per-channel-peer, per-account-channel-peer.",
    };
  }
  if (body.chatType !== undefined && !chatType) {
    return { ok: false, error: "chatType must be one of: direct, group, channel." };
  }

  const provider =
    typeof body.provider === "string" && body.provider.trim()
      ? normalizeToken(body.provider)
      : undefined;
  const peerId =
    typeof body.peerId === "string" && body.peerId.trim() ? normalizeToken(body.peerId) : undefined;
  const accountId =
    typeof body.accountId === "string" && body.accountId.trim()
      ? normalizeToken(body.accountId)
      : undefined;
  const identityId =
    typeof body.identityId === "string" && body.identityId.trim()
      ? normalizeToken(body.identityId)
      : undefined;
  const channelThreadId =
    typeof body.channelThreadId === "string" && body.channelThreadId.trim()
      ? normalizeToken(body.channelThreadId)
      : undefined;
  if (body.mcpServers !== undefined) {
    return {
      ok: false,
      error: "mcpServers is not accepted; use mcpProfileIds instead.",
    };
  }
  let mcpProfileIds: string[] | undefined;
  if (Array.isArray(body.mcpProfileIds)) {
    if (
      body.mcpProfileIds.length === 0 ||
      !body.mcpProfileIds.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      return { ok: false, error: "mcpProfileIds must be a non-empty string array when provided." };
    }
    mcpProfileIds = body.mcpProfileIds.map((id) => id.trim());
  } else if (body.mcpProfileIds !== undefined) {
    return { ok: false, error: "mcpProfileIds must be a non-empty string array when provided." };
  }
  const normalizedMcpProfileIds = normalizeMcpProfileIds(mcpProfileIds);
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : undefined;

  return {
    ok: true,
    message: {
      channel: normalizeToken(channel),
      userId,
      text,
      ...(provider && { provider }),
      ...(chatType && { chatType }),
      ...(peerId && { peerId }),
      ...(accountId && { accountId }),
      ...(identityId && { identityId }),
      ...(channelThreadId && { channelThreadId }),
      ...(normalizedMcpProfileIds.length > 0 && { mcpProfileIds: normalizedMcpProfileIds }),
      ...(routingMode && { routingMode }),
      ...(idempotencyKey && { idempotencyKey }),
    },
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseIdentityLinks(value: string | undefined): Record<string, string[]> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const output: Record<string, string[]> = {};
    for (const [canonical, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) continue;
      const cleaned = ids
        .map((id) => (typeof id === "string" ? normalizeToken(id) : ""))
        .filter(Boolean);
      if (cleaned.length > 0) {
        output[normalizeToken(canonical)] = cleaned;
      }
    }
    return output;
  } catch {
    console.warn("[gateway] invalid FLINT_GATEWAY_IDENTITY_LINKS JSON; ignoring");
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveGatewaySettingsPath(env: Record<string, string | undefined>): string {
  const userPath =
    env[USER_SETTINGS_PATH_ENV]?.trim() ||
    join(env["HOME"] ?? Bun.env["HOME"] ?? homedir(), ".flint", "settings.json");
  return userPath;
}

function parseGatewaySettingsJson(value: string, source = "settings.json"): GatewaySettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`[gateway] invalid JSON in ${source}: ${formatError(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`[gateway] ${source} must contain a JSON object`);
  }

  return parsed as GatewaySettings;
}

function resolveEnvVarsInString(
  value: string,
  env: Record<string, string | undefined>,
  location: string,
): string {
  const escapedTokens: string[] = [];
  const withEscapesMasked = value.replace(ESCAPED_ENV_VAR_REF_REGEX, (_match, name: string) => {
    const token = `${ESCAPED_ENV_VAR_SENTINEL}${escapedTokens.length}__`;
    escapedTokens.push(`\${${name}}`);
    return token;
  });

  const substituted = withEscapesMasked.replace(ENV_VAR_REF_REGEX, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved.length === 0) {
      throw new Error(`[gateway] missing or empty env var "${name}" at ${location}`);
    }
    return resolved;
  });

  return substituted.replace(
    new RegExp(`${ESCAPED_ENV_VAR_SENTINEL}(\\d+)__`, "g"),
    (_match, index: string) => escapedTokens[Number(index)] ?? "",
  );
}

function resolveEnvVarsInConfig(
  value: unknown,
  env: Record<string, string | undefined>,
  location = "settings",
): unknown {
  if (typeof value === "string") {
    return resolveEnvVarsInString(value, env, location);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnvVarsInConfig(item, env, `${location}[${index}]`));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = resolveEnvVarsInConfig(nested, env, `${location}.${key}`);
    }
    return output;
  }
  return value;
}

async function readGatewaySettingsFile(path: string): Promise<GatewaySettings | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return undefined;
  }

  const raw = await file.text();
  return parseGatewaySettingsJson(raw, path);
}

async function readGatewaySettings(
  env: Record<string, string | undefined>,
): Promise<GatewaySettings> {
  const userPath = resolveGatewaySettingsPath(env);
  const userSettings = await readGatewaySettingsFile(userPath);
  return userSettings ?? {};
}

function isMissingEnvVarError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("[gateway] missing or empty env var");
}

function parseMcpProfilesFromSettings(
  settings: GatewaySettings,
  env: Record<string, string | undefined>,
): Record<string, McpProfileDefinition> {
  const rawProfiles = settings.gateway?.mcpProfiles;
  if (rawProfiles === undefined) {
    return {};
  }
  if (!isPlainObject(rawProfiles)) {
    throw new Error("[gateway] settings.gateway.mcpProfiles must be an object");
  }

  const output: Record<string, McpProfileDefinition> = {};
  for (const [profileId, rawDefinition] of Object.entries(rawProfiles)) {
    if (!isPlainObject(rawDefinition)) {
      throw new Error(`[gateway] invalid MCP profile "${profileId}"; expected an object`);
    }

    const rawRefs = rawDefinition.profiles;
    if (rawRefs !== undefined && !Array.isArray(rawRefs)) {
      throw new Error(`[gateway] invalid profiles list in MCP profile "${profileId}"`);
    }
    const profiles = (rawRefs ?? []).map((ref, index) => {
      if (typeof ref !== "string" || ref.trim().length === 0) {
        throw new Error(
          `[gateway] invalid profile reference at gateway.mcpProfiles.${profileId}.profiles[${index}]`,
        );
      }
      return ref.trim();
    });

    const rawServers = rawDefinition.servers;
    if (rawServers !== undefined && !isPlainObject(rawServers)) {
      throw new Error(`[gateway] invalid servers object in MCP profile "${profileId}"`);
    }
    const servers: Record<string, Record<string, unknown>> = {};
    for (const [alias, rawConfig] of Object.entries(rawServers ?? {})) {
      if (!isPlainObject(rawConfig)) {
        throw new Error(
          `[gateway] invalid server config at gateway.mcpProfiles.${profileId}.servers.${alias}`,
        );
      }
      const location = `gateway.mcpProfiles.${profileId}.servers.${alias}`;
      try {
        const resolved = resolveEnvVarsInConfig(rawConfig, env, location);
        if (!isPlainObject(resolved)) {
          throw new Error(`[gateway] invalid server config at ${location}`);
        }
        servers[alias] = resolved;
      } catch (error) {
        if (isMissingEnvVarError(error)) {
          console.warn(
            `${formatError(error)}; skipping MCP server "${alias}" in profile "${profileId}"`,
          );
          continue;
        }
        throw error;
      }
    }

    output[profileId] = {
      ...(profiles.length > 0 && { profiles }),
      ...(Object.keys(servers).length > 0 && { servers }),
    };
  }

  return output;
}

function parseDefaultMcpProfileIdsFromSettings(
  settings: GatewaySettings,
  mcpProfiles: Record<string, McpProfileDefinition>,
): string[] {
  const rawDefaultMcpProfileIds = settings.gateway?.defaultMcpProfileIds;
  if (rawDefaultMcpProfileIds === undefined) {
    return [];
  }
  if (!Array.isArray(rawDefaultMcpProfileIds)) {
    throw new Error("[gateway] settings.gateway.defaultMcpProfileIds must be a string array");
  }
  if (!rawDefaultMcpProfileIds.every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw new Error("[gateway] settings.gateway.defaultMcpProfileIds must be a string array");
  }

  const normalized = normalizeMcpProfileIds(rawDefaultMcpProfileIds);
  for (const profileId of normalized) {
    if (!mcpProfiles[profileId]) {
      throw new Error(`[gateway] unknown default MCP profile: ${profileId}`);
    }
  }

  return normalized;
}

interface ParsedCodexExecutionConfig {
  config: CodexExecutionConfig;
  invalidConfigError?: string;
}

function copyDefaultCodexExecution(): CodexExecutionConfig {
  return {
    approvalPolicy: DEFAULT_CODEX_EXECUTION.approvalPolicy,
    sandboxMode: DEFAULT_CODEX_EXECUTION.sandboxMode,
  };
}

function parseCodexExecutionFromSettings(settings: GatewaySettings): ParsedCodexExecutionConfig {
  const rawCodex = settings.gateway?.codex;
  if (rawCodex === undefined) {
    return { config: copyDefaultCodexExecution() };
  }
  if (!isPlainObject(rawCodex)) {
    return {
      config: copyDefaultCodexExecution(),
      invalidConfigError: "[gateway] settings.gateway.codex must be an object",
    };
  }

  const rawApprovalPolicy = rawCodex.approvalPolicy;
  const approvalPolicy = parseCodexApprovalPolicy(rawApprovalPolicy);
  if (rawApprovalPolicy !== undefined && !approvalPolicy) {
    return {
      config: copyDefaultCodexExecution(),
      invalidConfigError: `[gateway] settings.gateway.codex.approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(", ")}`,
    };
  }

  const rawSandboxMode = rawCodex.sandboxMode;
  const sandboxMode = parseCodexSandboxMode(rawSandboxMode);
  if (rawSandboxMode !== undefined && !sandboxMode) {
    return {
      config: copyDefaultCodexExecution(),
      invalidConfigError: `[gateway] settings.gateway.codex.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`,
    };
  }

  return {
    config: {
      approvalPolicy: approvalPolicy ?? DEFAULT_CODEX_EXECUTION.approvalPolicy,
      sandboxMode: sandboxMode ?? DEFAULT_CODEX_EXECUTION.sandboxMode,
    },
  };
}

function parseCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return CODEX_APPROVAL_POLICY_SET.has(normalized)
    ? (normalized as CodexApprovalPolicy)
    : undefined;
}

function parseCodexSandboxMode(value: unknown): CodexSandboxMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return CODEX_SANDBOX_MODE_SET.has(normalized) ? (normalized as CodexSandboxMode) : undefined;
}

function resolveMcpServersFromProfiles(
  profileIds: string[],
  profiles: Record<string, McpProfileDefinition>,
): Record<string, unknown> | undefined {
  if (profileIds.length === 0) return undefined;

  const result: Record<string, unknown> = {};
  const stack = new Set<string>();
  const visited = new Set<string>();

  const applyProfile = (profileId: string) => {
    if (visited.has(profileId)) return;
    if (stack.has(profileId)) {
      throw new Error(`[gateway] circular MCP profile dependency detected: ${profileId}`);
    }

    const profile = profiles[profileId];
    if (!profile) {
      throw new Error(`[gateway] unknown MCP profile: ${profileId}`);
    }

    stack.add(profileId);
    for (const nested of profile.profiles ?? []) {
      applyProfile(nested);
    }

    for (const [serverName, serverConfig] of Object.entries(profile.servers ?? {})) {
      if (result[serverName]) {
        throw new Error(
          `[gateway] MCP server alias collision for "${serverName}" while composing profiles`,
        );
      }
      result[serverName] = serverConfig;
    }

    stack.delete(profileId);
    visited.add(profileId);
  };

  for (const profileId of profileIds) {
    applyProfile(profileId);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeMemoryMcpServer(
  mcpServers: Record<string, unknown> | undefined,
  memoryMcpServer: GatewayMemoryMcpServer | undefined,
): Record<string, unknown> | undefined {
  if (!memoryMcpServer) {
    return mcpServers;
  }

  const merged: Record<string, unknown> = {};
  if (mcpServers) {
    Object.assign(merged, mcpServers);
  }

  const baseAlias = memoryMcpServer.alias.trim() || MEMORY_MCP_DEFAULT_ALIAS;
  let alias = baseAlias;
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(merged, alias)) {
    alias = `${baseAlias}_${suffix}`;
    suffix += 1;
  }

  merged[alias] = memoryMcpServer.server;
  return merged;
}

export function readRoutingModeFromEnv(env: Record<string, string | undefined>): RoutingMode {
  const mode = parseRoutingMode(env["FLINT_GATEWAY_ROUTING_MODE"]);
  return mode ?? "per-peer";
}

function readGatewayIdleTimeoutSeconds(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IDLE_TIMEOUT_SECONDS;
  }
  return Math.max(5, Math.floor(parsed));
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export interface GatewayLike {
  listThreads(): ThreadRecord[];
  getThread(threadId: string): ThreadRecord | undefined;
  handleMessage(
    message: InboundMessage,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<GatewayReply>;
  handleThreadMessage(
    threadId: string,
    text: string,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<GatewayReply>;
  interruptThread(threadId: string): Promise<boolean>;
}

export interface GatewayAppOptions {
  gateway: GatewayLike;
  idempotency: IdempotencyStore;
  defaultProvider: string;
  routingMode: RoutingMode;
  webhookHandlers?: Map<string, (req: Request) => Promise<Response>>;
}

type PublicThreadRecord = Omit<ThreadRecord, "providerThreadId">;

function toPublicThreadRecord(record: ThreadRecord): PublicThreadRecord {
  const { providerThreadId: _providerThreadId, ...publicRecord } = record;
  return publicRecord;
}

function streamGatewaySSE(
  c: Context,
  run: (onEvent: (event: AgentEvent) => Promise<void>) => Promise<GatewayReply>,
) {
  return streamSSE(c, async (stream) => {
    const started = Date.now();
    try {
      const result = await run(async (event) => {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      await stream.writeSSE({
        event: "result",
        data: JSON.stringify({ ...result, durationMs: Date.now() - started }),
      });
    } catch (error) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ type: "error", message: formatError(error) }),
      });
    }
  });
}

export function createGatewayApp(options: GatewayAppOptions): Hono {
  const app = new Hono();
  const healthBody = {
    ok: true,
    provider: options.defaultProvider,
    defaultRoutingMode: options.routingMode,
  };

  app.get("/v1/health", () => json(200, healthBody));

  app.get("/v1/threads", () =>
    json(200, {
      data: options.gateway.listThreads().map(toPublicThreadRecord),
    }),
  );

  app.get("/v1/threads/:threadId", (context) => {
    const threadId = context.req.param("threadId");
    const thread = options.gateway.getThread(threadId);
    if (!thread) {
      return json(404, { error: "Thread not found." });
    }
    return json(200, { data: toPublicThreadRecord(thread) });
  });

  app.post("/v1/threads/:threadId/interrupt", async (context) => {
    const threadId = context.req.param("threadId");
    const thread = options.gateway.getThread(threadId);
    if (!thread) {
      return json(404, { error: "Thread not found." });
    }

    const interrupted = await options.gateway.interruptThread(threadId);
    if (!interrupted) {
      return json(409, {
        error: "No active runtime for this thread.",
      });
    }

    return json(200, {
      ok: true,
      threadId,
      interrupted: true,
    });
  });

  app.post("/v1/threads/:threadId", async (context) => {
    const threadId = context.req.param("threadId");
    if (!options.gateway.getThread(threadId)) {
      return json(404, { error: "Thread not found." });
    }

    let rawBody = "";
    let payload: unknown;
    try {
      rawBody = await context.req.text();
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { error: "Invalid JSON body." });
    }

    const body = payload as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return json(400, { error: "text is required." });
    }

    if (context.req.header("accept")?.includes("text/event-stream")) {
      return streamGatewaySSE(context, (onEvent) =>
        options.gateway.handleThreadMessage(threadId, text, onEvent),
      );
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() ||
      (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : undefined);

    const runMessage = async (): Promise<IdempotentResult> => {
      try {
        const started = Date.now();
        const result = await options.gateway.handleThreadMessage(threadId, text);
        const durationMs = Date.now() - started;
        return {
          status: 200,
          body: {
            ...result,
            durationMs,
          },
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: "Failed to process message.",
            details: formatError(error),
          },
        };
      }
    };

    if (!idempotencyKey) {
      const result = await runMessage();
      return json(result.status, result.body);
    }

    const { result, cached } = await options.idempotency.execute(
      idempotencyKey,
      `${threadId}:${rawBody}`,
      runMessage,
    );
    return json(result.status, {
      ...result.body,
      ...(cached ? { cached: true, idempotencyKey } : { idempotencyKey }),
    });
  });

  app.post("/webhooks/:channelName", async (context) => {
    const channelName = context.req.param("channelName");
    const handler = options.webhookHandlers?.get(channelName);
    if (!handler) {
      return json(404, { error: "Not found." });
    }
    return handler(context.req.raw);
  });

  app.post("/v1/threads", async (context) => {
    let rawBody = "";
    let payload: unknown;
    try {
      rawBody = await context.req.text();
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { error: "Invalid JSON body." });
    }

    const parsed = parseInboundMessage(payload);
    if (!parsed.ok) {
      return json(400, { error: parsed.error });
    }

    if (context.req.header("accept")?.includes("text/event-stream")) {
      return streamGatewaySSE(context, (onEvent) =>
        options.gateway.handleMessage(parsed.message, onEvent),
      );
    }

    const idempotencyKey =
      context.req.header("idempotency-key")?.trim() || parsed.message.idempotencyKey;

    const runMessage = async (): Promise<IdempotentResult> => {
      try {
        const started = Date.now();
        const result = await options.gateway.handleMessage(parsed.message);
        const durationMs = Date.now() - started;
        return {
          status: 200,
          body: {
            ...result,
            durationMs,
          },
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: "Failed to process message.",
            details: formatError(error),
          },
        };
      }
    };

    if (!idempotencyKey) {
      const result = await runMessage();
      return json(result.status, result.body);
    }

    const { result, cached } = await options.idempotency.execute(
      idempotencyKey,
      `/v1/threads:${rawBody}`,
      runMessage,
    );
    return json(result.status, {
      ...result.body,
      ...(cached ? { cached: true, idempotencyKey } : { idempotencyKey }),
    });
  });

  app.notFound(() => json(404, { error: "Not found." }));

  return app;
}

export interface GatewayRuntime {
  gateway: FlintGateway;
  idempotency: IdempotencyStore;
  webhookHandlers: Map<string, (req: Request) => Promise<Response>>;
  cwd: string;
  port: number;
  model?: string;
  defaultProvider: string;
  routingMode: RoutingMode;
  storePath: string;
  idempotencyTtlMs: number;
  idleTimeoutSeconds: number;
  mcpProfileCount: number;
  memoryEnabled: boolean;
  sessionLifecycle: ResolvedSessionLifecycleConfig;
  codexExecution: CodexExecutionConfig;
  codexExecutionError?: string;
}

export async function createGatewayRuntime(
  env: Record<string, string | undefined> = process.env,
): Promise<GatewayRuntime> {
  const cwd = env["FLINT_GATEWAY_CWD"] ?? process.cwd();
  const port = Number(env["PORT"] ?? 8788);
  const model = env["FLINT_GATEWAY_MODEL"]?.trim() || undefined;
  const defaultProvider = normalizeToken(env["FLINT_GATEWAY_PROVIDER"]) || "claude";
  const routingMode = readRoutingModeFromEnv(env);
  const storePath =
    env["FLINT_GATEWAY_STORE_PATH"] ??
    join(Bun.env["HOME"] ?? env["HOME"] ?? ".", ".flint", "gateway", "threads.json");
  const identityLinks = parseIdentityLinks(env["FLINT_GATEWAY_IDENTITY_LINKS"]);
  const idempotencyTtlMs = Math.max(
    1_000,
    Number(env["FLINT_GATEWAY_IDEMPOTENCY_TTL_MS"] ?? 300_000),
  );
  const idleTimeoutSeconds = readGatewayIdleTimeoutSeconds(
    env["FLINT_GATEWAY_IDLE_TIMEOUT_SECONDS"],
  );
  const memoryEnabled = readBooleanEnv(env["FLINT_GATEWAY_MEMORY_ENABLED"], true);
  const settings = await readGatewaySettings(env);
  const mcpProfiles = parseMcpProfilesFromSettings(settings, env);
  const defaultMcpProfileIds = parseDefaultMcpProfileIdsFromSettings(settings, mcpProfiles);
  const sessionLifecycle = resolveSessionLifecycleConfig(settings.gateway?.session);
  const { config: codexExecution, invalidConfigError: codexExecutionError } =
    parseCodexExecutionFromSettings(settings);
  if (codexExecutionError) {
    console.warn(
      `${codexExecutionError}; ignoring codex config until provider "codex" is used`,
    );
  }
  const memoryWorkspaceDir = resolve(cwd);
  const memoryMcpServer = memoryEnabled ? createMemoryMcpServer(memoryWorkspaceDir) : undefined;

  const gateway = new FlintGateway({
    cwd,
    defaultRoutingMode: routingMode,
    defaultProvider,
    model,
    storePath,
    identityLinks,
    mcpProfiles,
    defaultMcpProfileIds,
    memoryMcpServer,
    sessionLifecycle,
    codexExecution,
    codexExecutionError,
  });
  await gateway.start();

  const idempotency = new IdempotencyStore(idempotencyTtlMs);

  const webhookHandlers = new Map<string, (req: Request) => Promise<Response>>();
  const slackBotToken = env["SLACK_BOT_TOKEN"]?.trim();
  const slackSigningSecret = env["SLACK_SIGNING_SECRET"]?.trim();
  if (slackBotToken && slackSigningSecret) {
    const slackAdapter = new SlackAdapter({
      botToken: slackBotToken,
      signingSecret: slackSigningSecret,
      botUserId: env["SLACK_BOT_USER_ID"]?.trim() || undefined,
    });
    webhookHandlers.set("slack", createWebhookHandler(slackAdapter, gateway));
    console.log("[gateway] slack adapter enabled");
  }

  return {
    gateway,
    idempotency,
    webhookHandlers,
    cwd,
    port,
    model,
    defaultProvider,
    routingMode,
    storePath,
    idempotencyTtlMs,
    idleTimeoutSeconds,
    mcpProfileCount: Object.keys(mcpProfiles).length,
    memoryEnabled,
    sessionLifecycle,
    codexExecution,
    codexExecutionError,
  };
}

async function loadGatewaySystemPromptAppend(workspaceDir: string): Promise<string | undefined> {
  const memoryRootFile = await loadMemoryRootFile(workspaceDir);
  return composeSystemPromptAppend([
    {
      title: "Memory Recall",
      content: buildMemorySystemPromptSection(),
    },
    ...(memoryRootFile
      ? [
          {
            title: memoryRootFile.path,
            content: buildMemoryFileSystemPromptSection(memoryRootFile),
          },
        ]
      : []),
  ]);
}

function createMemoryMcpServer(workspaceDir: string): GatewayMemoryMcpServer {
  const gatewaySrcDir = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(gatewaySrcDir, "memory-mcp-server.ts");

  return {
    alias: MEMORY_MCP_DEFAULT_ALIAS,
    server: {
      type: "stdio",
      command: "bun",
      args: [entryPath, "--workspace", workspaceDir],
    },
  };
}

export interface StartedGatewayServer {
  server: Bun.Server<unknown>;
  runtime: GatewayRuntime;
  shutdown(signal: string, exitProcess?: boolean): Promise<void>;
  attachSignalHandlers(): void;
}

export async function startGatewayServer(
  env: Record<string, string | undefined> = process.env,
): Promise<StartedGatewayServer> {
  const runtime = await createGatewayRuntime(env);
  const app = createGatewayApp({
    gateway: runtime.gateway,
    idempotency: runtime.idempotency,
    defaultProvider: runtime.defaultProvider,
    routingMode: runtime.routingMode,
    webhookHandlers: runtime.webhookHandlers,
  });
  const server = Bun.serve({
    port: runtime.port,
    fetch: app.fetch,
    idleTimeout: runtime.idleTimeoutSeconds,
  });

  console.log(`[gateway] listening on http://127.0.0.1:${server.port}`);
  console.log(`[gateway] provider: ${runtime.defaultProvider}`);
  console.log(`[gateway] routing mode: ${runtime.routingMode}`);
  console.log(`[gateway] cwd: ${runtime.cwd}`);
  if (runtime.model) {
    console.log(`[gateway] model: ${runtime.model}`);
  }
  console.log(`[gateway] store: ${runtime.storePath}`);
  console.log(`[gateway] idempotency ttl ms: ${runtime.idempotencyTtlMs}`);
  console.log(`[gateway] idle timeout sec: ${runtime.idleTimeoutSeconds}`);
  console.log(`[gateway] mcp profiles: ${runtime.mcpProfileCount}`);
  console.log(`[gateway] memory: ${runtime.memoryEnabled ? "enabled" : "disabled"}`);
  console.log(`[gateway] codex approval: ${runtime.codexExecution.approvalPolicy}`);
  console.log(`[gateway] codex sandbox: ${runtime.codexExecution.sandboxMode}`);
  if (runtime.codexExecutionError) {
    console.warn(`${runtime.codexExecutionError}; codex requests will fail until this is fixed`);
  }
  const defaultPolicy = runtime.sessionLifecycle.defaultPolicy;
  const resetParts: string[] = [];
  if (defaultPolicy.dailyAtHour !== undefined) {
    resetParts.push(`daily@${defaultPolicy.dailyAtHour}:00`);
  }
  if (defaultPolicy.idleMinutes !== undefined) {
    resetParts.push(`idle=${defaultPolicy.idleMinutes}m`);
  }
  if (resetParts.length === 0) {
    resetParts.push("off");
  }
  console.log(`[gateway] session reset: ${resetParts.join(", ")}`);

  const shutdown = async (signal: string, exitProcess = false) => {
    console.log(`\n[gateway] received ${signal}, shutting down`);
    server.stop(true);
    await runtime.gateway.close();
    if (exitProcess) {
      process.exit(0);
    }
  };

  const attachSignalHandlers = () => {
    process.on("SIGINT", () => {
      void shutdown("SIGINT", true);
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM", true);
    });
  };

  return {
    server,
    runtime,
    shutdown,
    attachSignalHandlers,
  };
}

function printHelp(): void {
  console.log("flint gateway");
  console.log("");
  console.log("Start the Flint HTTP gateway server.");
  console.log("");
  console.log("Usage:");
  console.log("  flint gateway [options]");
  console.log("");
  console.log("Options:");
  console.log("  --help, -h    Show this help message");
  console.log("");
  console.log("Environment variables:");
  console.log("  ANTHROPIC_API_KEY                  Required for Claude-backed runs");
  console.log("  PORT                               Listen port (default: 8788)");
  console.log("  FLINT_GATEWAY_CWD                  Working directory (default: cwd)");
  console.log("  FLINT_GATEWAY_PROVIDER             Provider name (default: claude)");
  console.log("  FLINT_GATEWAY_MODEL                Model override");
  console.log(
    "  FLINT_GATEWAY_ROUTING_MODE         Thread routing: main, per-peer, per-channel-peer,",
  );
  console.log("                                     per-account-channel-peer (default: per-peer)");
  console.log(
    "  FLINT_GATEWAY_STORE_PATH           Thread store path (default: ~/.flint/gateway/threads.json)",
  );
  console.log("  FLINT_GATEWAY_IDEMPOTENCY_TTL_MS   Idempotency cache TTL in ms (default: 300000)");
  console.log("  FLINT_GATEWAY_IDLE_TIMEOUT_SECONDS HTTP idle timeout in seconds (default: 120)");
  console.log(
    "  FLINT_GATEWAY_MEMORY_ENABLED       Enable memory tools and memory recall guidance (default: true)",
  );
  console.log(
    "  FLINT_GATEWAY_USER_SETTINGS_PATH   Settings file path (default: ~/.flint/settings.json)",
  );
  console.log("                                     gateway.session.* controls reset lifecycle");
  console.log("  FLINT_GATEWAY_IDENTITY_LINKS       JSON map for cross-channel identity linking");
  console.log("  SLACK_BOT_TOKEN                    Slack bot token (enables Slack adapter)");
  console.log("  SLACK_SIGNING_SECRET               Slack webhook verification secret");
  console.log("  SLACK_BOT_USER_ID                  Slack bot user ID");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const started = await startGatewayServer();
  started.attachSignalHandlers();
}
