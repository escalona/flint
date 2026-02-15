import { SlackAdapter, createWebhookHandler } from "@flint-dev/channels";
import { createClient, type AppServerClient } from "@flint-dev/sdk";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";

export type RoutingMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type ChatType = "direct" | "group" | "channel";
const USER_SETTINGS_PATH_ENV = "FLINT_GATEWAY_USER_SETTINGS_PATH";
const ENV_VAR_REF_REGEX = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_ENV_VAR_REF_REGEX = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_ENV_VAR_SENTINEL = "__FLINT_ESCAPED_ENV_VAR__";

interface McpProfileDefinition {
  profiles?: string[];
  servers?: Record<string, Record<string, unknown>>;
}

interface GatewaySettings {
  gateway?: {
    mcpProfiles?: Record<string, McpProfileDefinition>;
    defaultMcpProfileIds?: string[];
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
  mcpProfileIds: string[];
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

  constructor(private readonly options: GatewayOptions) {
    this.store = new ThreadStore(options.storePath);
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

  async handleMessage(message: InboundMessage): Promise<GatewayReply> {
    const routingMode = message.routingMode ?? this.options.defaultRoutingMode;
    const threadId = resolveThreadId(message, routingMode, this.options.identityLinks);
    return this.processMessage(threadId, routingMode, message);
  }

  async handleThreadMessage(threadId: string, text: string): Promise<GatewayReply> {
    const record = this.store.get(threadId);
    if (!record) {
      throw new Error("Thread not found.");
    }
    const message = messageFromThreadRecord(record, text);
    return this.processMessage(threadId, record.routingMode, message);
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
  ): Promise<GatewayReply> {
    return this.queue.enqueue(threadId, async () => {
      const runtime = await this.ensureThreadRuntime(message, routingMode, threadId);
      const reply = await this.runTurn(runtime.client, message.text);
      const now = new Date().toISOString();
      const existing = this.store.get(threadId);
      const chatType = normalizeChatType(message.chatType);
      const peerId = resolvePeerId(message);
      const accountId = normalizeOptionalToken(message.accountId);

      await this.store.upsert({
        threadId,
        routingMode,
        provider: runtime.provider,
        providerThreadId: runtime.providerThreadId,
        ...(runtime.mcpProfileIds.length > 0 && { mcpProfileIds: runtime.mcpProfileIds }),
        channel: normalizeToken(message.channel) || "unknown",
        userId: message.userId.trim(),
        chatType,
        peerId,
        ...(accountId && { accountId }),
        ...(message.identityId && { identityId: message.identityId.trim() }),
        ...(message.channelThreadId && { channelThreadId: message.channelThreadId.trim() }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      return {
        threadId,
        routingMode,
        provider: runtime.provider,
        reply,
      };
    });
  }

  private async ensureThreadRuntime(
    message: InboundMessage,
    routingMode: RoutingMode,
    threadId: string,
  ): Promise<ThreadRuntime> {
    const record = this.store.get(threadId);
    const requestedMcpProfileIds = normalizeMcpProfileIds(
      message.mcpProfileIds ?? record?.mcpProfileIds ?? this.options.defaultMcpProfileIds,
    );
    const existingRuntime = this.runtimes.get(threadId);
    if (existingRuntime) {
      if (
        message.provider &&
        normalizeToken(message.provider) &&
        normalizeToken(message.provider) !== normalizeToken(existingRuntime.provider)
      ) {
        console.warn(
          `[gateway] provider mismatch for ${threadId}: requested=${message.provider}, active=${existingRuntime.provider}; keeping active runtime`,
        );
      }
      if (!mcpProfileIdsEqual(requestedMcpProfileIds, existingRuntime.mcpProfileIds)) {
        console.warn(`[gateway] mcp profile mismatch for ${threadId}; recycling runtime`);
        existingRuntime.client.close();
        this.runtimes.delete(threadId);
      } else {
        return existingRuntime;
      }
    }

    const requestedProvider =
      normalizeToken(message.provider) || normalizeToken(this.options.defaultProvider);
    const provider = normalizeToken(record?.provider) || requestedProvider || "claude";
    const requestedMcpServers =
      provider === "claude"
        ? resolveMcpServersFromProfiles(requestedMcpProfileIds, this.options.mcpProfiles)
        : undefined;

    const client = createClient({
      provider,
      cwd: this.options.cwd,
      env: process.env as Record<string, string>,
    });
    await client.start();

    let providerThreadId: string;
    if (record?.providerThreadId) {
      try {
        providerThreadId = await client.resumeThread(record.providerThreadId, {
          cwd: this.options.cwd,
          ...(requestedMcpServers && { mcpServers: requestedMcpServers }),
        });
      } catch (error) {
        console.warn(
          `[gateway] failed to resume provider thread ${record.providerThreadId} for ${threadId}: ${formatError(error)}; creating a new thread`,
        );
        providerThreadId = await client.createThread({
          ...(this.options.model && { model: this.options.model }),
          ...(requestedMcpServers && { mcpServers: requestedMcpServers }),
        });
      }
    } else {
      providerThreadId = await client.createThread({
        ...(this.options.model && { model: this.options.model }),
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

    const runtime = { client, providerThreadId, provider, mcpProfileIds: requestedMcpProfileIds };
    this.runtimes.set(threadId, runtime);
    return runtime;
  }

  private async runTurn(client: AppServerClient, inputText: string): Promise<string> {
    const promptOptions = this.options.model ? { model: this.options.model } : undefined;
    let responseText = "";
    let terminalError: string | null = null;

    for await (const event of client.prompt(inputText, promptOptions)) {
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

    if (terminalError) {
      throw new Error(terminalError);
    }

    return responseText.trim() || "(no response)";
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

export function readRoutingModeFromEnv(env: Record<string, string | undefined>): RoutingMode {
  const mode = parseRoutingMode(env["FLINT_GATEWAY_ROUTING_MODE"]);
  return mode ?? "per-peer";
}

export interface GatewayLike {
  listThreads(): ThreadRecord[];
  getThread(threadId: string): ThreadRecord | undefined;
  handleMessage(message: InboundMessage): Promise<GatewayReply>;
  handleThreadMessage(threadId: string, text: string): Promise<GatewayReply>;
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
  mcpProfileCount: number;
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
  const settings = await readGatewaySettings(env);
  const mcpProfiles = parseMcpProfilesFromSettings(settings, env);
  const defaultMcpProfileIds = parseDefaultMcpProfileIdsFromSettings(settings, mcpProfiles);

  const gateway = new FlintGateway({
    cwd,
    defaultRoutingMode: routingMode,
    defaultProvider,
    model,
    storePath,
    identityLinks,
    mcpProfiles,
    defaultMcpProfileIds,
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
    mcpProfileCount: Object.keys(mcpProfiles).length,
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
  console.log(`[gateway] mcp profiles: ${runtime.mcpProfileCount}`);

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

if (import.meta.main) {
  const started = await startGatewayServer();
  started.attachSignalHandlers();
}
