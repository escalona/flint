export type SessionType = "direct" | "group" | "thread";
export type SessionResetMode = "daily" | "idle" | "off";

export interface SessionResetConfig {
  mode?: SessionResetMode;
  atHour?: number;
  idleMinutes?: number;
}

export interface ResolvedSessionResetPolicy {
  dailyAtHour?: number;
  idleMinutes?: number;
}

export interface ResolvedSessionLifecycleConfig {
  defaultPolicy: ResolvedSessionResetPolicy;
  resetByType: Partial<Record<SessionType, ResolvedSessionResetPolicy>>;
  resetByChannel: Record<string, ResolvedSessionResetPolicy>;
  resetTriggers: string[];
  greetingPrompt: string;
}

export interface SessionResetEvaluation {
  expired: boolean;
  reason?: "daily" | "idle";
}

export interface SessionResetCommandResult {
  triggered: boolean;
  trigger?: string;
  nextText: string;
  providerOverride?: string;
  modelOverride?: string;
}

interface NewSessionTarget {
  consumed: boolean;
  provider?: string;
  model?: string;
}

const DEFAULT_DAILY_RESET_AT_HOUR = 4;
const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_RESET_GREETING_PROMPT =
  "This session was reset. Greet briefly and ask what to work on next.";
const KNOWN_SESSION_TYPES: readonly SessionType[] = ["direct", "group", "thread"] as const;

export function resolveSessionLifecycleConfig(
  rawValue: unknown,
): ResolvedSessionLifecycleConfig {
  const raw = asRecord(rawValue);
  const reset = readResetConfig(raw?.reset);
  const resetByTypeRaw = asRecord(raw?.resetByType);
  const resetByChannelRaw = asRecord(raw?.resetByChannel);
  const hasModernConfig = Boolean(reset || resetByTypeRaw || resetByChannelRaw);
  const legacyIdleMinutes = readPositiveInt(raw?.idleMinutes);

  const defaultPolicy = hasModernConfig
    ? (resolvePolicyFromConfig(reset) ?? { dailyAtHour: DEFAULT_DAILY_RESET_AT_HOUR })
    : resolveLegacyOrDefaultPolicy(legacyIdleMinutes);

  const resetByType: Partial<Record<SessionType, ResolvedSessionResetPolicy>> = {};
  if (resetByTypeRaw) {
    for (const type of KNOWN_SESSION_TYPES) {
      const policy = resolvePolicyFromConfig(readResetConfig(resetByTypeRaw[type]));
      if (policy) {
        resetByType[type] = policy;
      }
    }
  }

  const resetByChannel: Record<string, ResolvedSessionResetPolicy> = {};
  if (resetByChannelRaw) {
    for (const [rawChannel, rawPolicy] of Object.entries(resetByChannelRaw)) {
      const channel = normalizeToken(rawChannel);
      if (!channel) continue;
      const policy = resolvePolicyFromConfig(readResetConfig(rawPolicy));
      if (policy) {
        resetByChannel[channel] = policy;
      }
    }
  }

  const resetTriggers = normalizeResetTriggers(raw?.resetTriggers);
  const greetingPrompt = readNonEmptyString(raw?.greetingPrompt) ?? DEFAULT_RESET_GREETING_PROMPT;

  return {
    defaultPolicy,
    resetByType,
    resetByChannel,
    resetTriggers,
    greetingPrompt,
  };
}

function resolveLegacyOrDefaultPolicy(
  legacyIdleMinutes: number | undefined,
): ResolvedSessionResetPolicy {
  if (legacyIdleMinutes) {
    return { idleMinutes: legacyIdleMinutes };
  }
  return { dailyAtHour: DEFAULT_DAILY_RESET_AT_HOUR };
}

function readResetConfig(value: unknown): SessionResetConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mode = readResetMode(record.mode);
  const atHour = readHour(record.atHour);
  const idleMinutes = readPositiveInt(record.idleMinutes);
  if (!mode && atHour === undefined && idleMinutes === undefined) {
    return undefined;
  }
  return {
    ...(mode && { mode }),
    ...(atHour !== undefined && { atHour }),
    ...(idleMinutes !== undefined && { idleMinutes }),
  };
}

function resolvePolicyFromConfig(
  config: SessionResetConfig | undefined,
): ResolvedSessionResetPolicy | undefined {
  if (!config) return undefined;
  const mode = config.mode ?? "daily";
  if (mode === "off") {
    return {};
  }

  const policy: ResolvedSessionResetPolicy = {};
  if (mode === "daily") {
    policy.dailyAtHour = config.atHour ?? DEFAULT_DAILY_RESET_AT_HOUR;
  }
  if (config.idleMinutes !== undefined) {
    policy.idleMinutes = config.idleMinutes;
  }
  if (mode === "idle") {
    delete policy.dailyAtHour;
  }
  return policy;
}

export function resolveSessionType(params: {
  chatType: "direct" | "group" | "channel";
  channelThreadId?: string;
}): SessionType {
  if (normalizeToken(params.channelThreadId)) {
    return "thread";
  }
  if (params.chatType === "direct") {
    return "direct";
  }
  return "group";
}

export function resolveSessionResetPolicy(
  config: ResolvedSessionLifecycleConfig,
  params: { sessionType: SessionType; channel: string },
): ResolvedSessionResetPolicy {
  const channelPolicy = config.resetByChannel[normalizeToken(params.channel)];
  if (channelPolicy) {
    return channelPolicy;
  }
  const typePolicy = config.resetByType[params.sessionType];
  if (typePolicy) {
    return typePolicy;
  }
  return config.defaultPolicy;
}

export function evaluateSessionReset(
  updatedAtIso: string | undefined,
  nowMs: number,
  policy: ResolvedSessionResetPolicy,
): SessionResetEvaluation {
  if (!updatedAtIso) {
    return { expired: false };
  }

  const updatedAtMs = Date.parse(updatedAtIso);
  if (!Number.isFinite(updatedAtMs)) {
    return { expired: true, reason: "daily" };
  }

  if (policy.dailyAtHour !== undefined) {
    const boundary = resolveLatestDailyBoundary(nowMs, policy.dailyAtHour);
    if (updatedAtMs < boundary) {
      return { expired: true, reason: "daily" };
    }
  }

  if (policy.idleMinutes !== undefined) {
    const idleBoundary = nowMs - policy.idleMinutes * 60_000;
    if (updatedAtMs < idleBoundary) {
      return { expired: true, reason: "idle" };
    }
  }

  return { expired: false };
}

export function resolveLatestDailyBoundary(nowMs: number, atHour: number): number {
  const now = new Date(nowMs);
  const boundary = new Date(nowMs);
  boundary.setHours(atHour, 0, 0, 0);
  if (now < boundary) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

export function parseResetCommand(params: {
  text: string;
  resetTriggers: string[];
  greetingPrompt: string;
  providerHints?: string[];
}): SessionResetCommandResult {
  const trimmed = params.text.trim();
  if (!trimmed.startsWith("/")) {
    return {
      triggered: false,
      nextText: params.text,
    };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = normalizeToken(spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx));
  if (!params.resetTriggers.includes(command)) {
    return {
      triggered: false,
      nextText: params.text,
    };
  }

  let remainder = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  let providerOverride: string | undefined;
  let modelOverride: string | undefined;

  if (command === "/new" && remainder) {
    const tokens = remainder.split(/\s+/).filter(Boolean);
    const firstToken = tokens[0];
    if (firstToken) {
      const selection = parseNewSessionTarget(firstToken, params.providerHints ?? [], {
        hasTrailingPrompt: tokens.length > 1,
      });
      if (selection.consumed) {
        providerOverride = selection.provider;
        modelOverride = selection.model;
        remainder = tokens.slice(1).join(" ").trim();
      }
    }
  }

  if (!remainder) {
    return {
      triggered: true,
      trigger: command,
      nextText: params.greetingPrompt,
      ...(providerOverride && { providerOverride }),
      ...(modelOverride && { modelOverride }),
    };
  }

  return {
    triggered: true,
    trigger: command,
    nextText: remainder,
    ...(providerOverride && { providerOverride }),
    ...(modelOverride && { modelOverride }),
  };
}

function parseNewSessionTarget(
  token: string,
  providerHints: string[],
  options: { hasTrailingPrompt: boolean },
): NewSessionTarget {
  const cleaned = token.trim();
  if (!cleaned) {
    return { consumed: false };
  }

  const slashIdx = cleaned.indexOf("/");
  if (slashIdx > 0 && slashIdx < cleaned.length - 1) {
    const provider = resolveProviderAlias(cleaned.slice(0, slashIdx), providerHints);
    const model = cleaned.slice(slashIdx + 1).trim();
    if (provider) {
      return { consumed: true, provider, ...(model && { model }) };
    }
    return { consumed: true, model: cleaned };
  }

  const providerOnly = resolveProviderAlias(cleaned, providerHints);
  if (providerOnly) {
    return { consumed: true, provider: providerOnly };
  }

  if (options.hasTrailingPrompt && !looksLikeModelToken(cleaned)) {
    return { consumed: false };
  }

  return { consumed: true, model: cleaned };
}

function looksLikeModelToken(value: string): boolean {
  return /[0-9\-_:./]/.test(value);
}

function resolveProviderAlias(value: string, providerHints: string[]): string | undefined {
  const candidate = normalizeToken(value);
  if (!candidate) return undefined;
  const normalizedHints = Array.from(
    new Set(
      providerHints
        .map((provider) => normalizeToken(provider))
        .filter((provider): provider is string => provider.length > 0),
    ),
  );
  if (normalizedHints.includes(candidate)) {
    return candidate;
  }
  const prefixMatches = normalizedHints.filter((provider) => provider.startsWith(candidate));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  return undefined;
}

function normalizeResetTriggers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_RESET_TRIGGERS];
  }
  const deduped = new Set<string>();
  for (const trigger of value) {
    if (typeof trigger !== "string") continue;
    const normalized = normalizeToken(trigger);
    if (!normalized || !normalized.startsWith("/")) continue;
    deduped.add(normalized);
  }
  if (deduped.size === 0) {
    return [...DEFAULT_RESET_TRIGGERS];
  }
  return Array.from(deduped);
}

function readResetMode(value: unknown): SessionResetMode | undefined {
  if (value === "daily" || value === "idle" || value === "off") {
    return value;
  }
  return undefined;
}

function readHour(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  if (rounded < 0 || rounded > 23) {
    return undefined;
  }
  return rounded;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return undefined;
  }
  return rounded;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}
