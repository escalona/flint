import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESET_GREETING_PROMPT,
  evaluateSessionReset,
  parseResetCommand,
  resolveLatestDailyBoundary,
  resolveSessionLifecycleConfig,
  resolveSessionResetPolicy,
} from "./session-lifecycle.ts";

describe("resolveSessionLifecycleConfig", () => {
  test("defaults to daily reset at 4am with default triggers", () => {
    const resolved = resolveSessionLifecycleConfig(undefined);
    expect(resolved.defaultPolicy).toEqual({ dailyAtHour: 4 });
    expect(resolved.resetTriggers).toEqual(["/new", "/reset"]);
    expect(resolved.greetingPrompt).toBe(DEFAULT_RESET_GREETING_PROMPT);
  });

  test("uses legacy idle-only mode when idleMinutes is set without modern reset config", () => {
    const resolved = resolveSessionLifecycleConfig({ idleMinutes: 90 });
    expect(resolved.defaultPolicy).toEqual({ idleMinutes: 90 });
  });

  test("supports per-type and per-channel overrides", () => {
    const resolved = resolveSessionLifecycleConfig({
      reset: { mode: "daily", atHour: 6, idleMinutes: 120 },
      resetByType: {
        direct: { mode: "idle", idleMinutes: 30 },
      },
      resetByChannel: {
        telegram: { mode: "off" },
        slack: { mode: "daily", atHour: 1 },
      },
    });

    expect(
      resolveSessionResetPolicy(resolved, { sessionType: "direct", channel: "telegram" }),
    ).toEqual({});
    expect(
      resolveSessionResetPolicy(resolved, { sessionType: "direct", channel: "slack" }),
    ).toEqual({
      dailyAtHour: 1,
    });
    expect(
      resolveSessionResetPolicy(resolved, { sessionType: "direct", channel: "discord" }),
    ).toEqual({
      idleMinutes: 30,
    });
    expect(
      resolveSessionResetPolicy(resolved, { sessionType: "group", channel: "discord" }),
    ).toEqual({
      dailyAtHour: 6,
      idleMinutes: 120,
    });
  });
});

describe("evaluateSessionReset", () => {
  test("expires sessions that are older than the latest daily boundary", () => {
    const nowMs = Date.parse("2026-02-18T16:00:00.000Z");
    const boundary = resolveLatestDailyBoundary(nowMs, 4);
    const stale = evaluateSessionReset(new Date(boundary - 1_000).toISOString(), nowMs, {
      dailyAtHour: 4,
    });
    const fresh = evaluateSessionReset(new Date(boundary + 1_000).toISOString(), nowMs, {
      dailyAtHour: 4,
    });

    expect(stale).toEqual({ expired: true, reason: "daily" });
    expect(fresh).toEqual({ expired: false });
  });

  test("expires sessions when idle boundary is reached", () => {
    const nowMs = Date.parse("2026-02-18T16:00:00.000Z");
    const stale = evaluateSessionReset(new Date(nowMs - 31 * 60_000).toISOString(), nowMs, {
      idleMinutes: 30,
    });
    const fresh = evaluateSessionReset(new Date(nowMs - 29 * 60_000).toISOString(), nowMs, {
      idleMinutes: 30,
    });

    expect(stale).toEqual({ expired: true, reason: "idle" });
    expect(fresh).toEqual({ expired: false });
  });
});

describe("parseResetCommand", () => {
  const providerHints = ["claude", "pi", "codex"];

  test("passes through non-trigger text", () => {
    const parsed = parseResetCommand({
      text: "hello there",
      resetTriggers: ["/new", "/reset"],
      greetingPrompt: "hi",
      providerHints,
    });
    expect(parsed).toEqual({
      triggered: false,
      nextText: "hello there",
    });
  });

  test("uses greeting prompt for standalone reset triggers", () => {
    const parsed = parseResetCommand({
      text: " /reset ",
      resetTriggers: ["/new", "/reset"],
      greetingPrompt: "hello reset",
      providerHints,
    });

    expect(parsed).toEqual({
      triggered: true,
      trigger: "/reset",
      nextText: "hello reset",
    });
  });

  test("parses provider/model target for /new commands", () => {
    const parsed = parseResetCommand({
      text: "/new claude/sonnet continue with the migration",
      resetTriggers: ["/new", "/reset"],
      greetingPrompt: "hello reset",
      providerHints,
    });

    expect(parsed).toEqual({
      triggered: true,
      trigger: "/new",
      providerOverride: "claude",
      modelOverride: "sonnet",
      nextText: "continue with the migration",
    });
  });

  test("treats /new token as model alias when it is not a known provider alias", () => {
    const parsed = parseResetCommand({
      text: "/new gpt-5-mini summarize open tasks",
      resetTriggers: ["/new", "/reset"],
      greetingPrompt: "hello reset",
      providerHints,
    });

    expect(parsed).toEqual({
      triggered: true,
      trigger: "/new",
      modelOverride: "gpt-5-mini",
      nextText: "summarize open tasks",
    });
  });

  test("keeps free-form /new follow-up text when first token is not model-like", () => {
    const parsed = parseResetCommand({
      text: "/new continue from the prior summary",
      resetTriggers: ["/new", "/reset"],
      greetingPrompt: "hello reset",
      providerHints,
    });

    expect(parsed).toEqual({
      triggered: true,
      trigger: "/new",
      nextText: "continue from the prior summary",
    });
  });
});
