import { describe, expect, test } from "bun:test";
import type { GatewayReply, InboundMessage } from "./contracts.ts";
import { SlackAdapter, splitMessage } from "./slack.ts";
import { createWebhookHandler, type MessageGateway } from "./handler.ts";

const SIGNING_SECRET = "test-signing-secret";
const BOT_TOKEN = "xoxb-test-token";
const BOT_USER_ID = "U_BOT";

function createAdapter(overrides?: { botUserId?: string }): SlackAdapter {
  return new SlackAdapter({
    botToken: BOT_TOKEN,
    signingSecret: SIGNING_SECRET,
    botUserId: overrides?.botUserId ?? BOT_USER_ID,
  });
}

async function sign(body: string, secret: string, timestamp?: number): Promise<Headers> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const baseString = `v0:${ts}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const headers = new Headers();
  headers.set("x-slack-request-timestamp", String(ts));
  headers.set("x-slack-signature", `v0=${hex}`);
  return headers;
}

function makeSlackRequest(body: string, headers: Headers): Request {
  return new Request("http://localhost/webhooks/slack", {
    method: "POST",
    headers,
    body,
  });
}

function appMentionPayload(overrides?: {
  text?: string;
  user?: string;
  botId?: string;
  channel?: string;
  threadTs?: string;
  ts?: string;
  eventId?: string;
  channelType?: string;
}) {
  return {
    type: "event_callback",
    event_id: overrides?.eventId ?? "Ev01",
    event: {
      type: "app_mention",
      user: overrides?.user ?? "U_USER",
      text: overrides?.text ?? `<@${BOT_USER_ID}> hello`,
      channel: overrides?.channel ?? "C_CHAN",
      channel_type: overrides?.channelType ?? "channel",
      ts: overrides?.ts ?? "1234567890.123456",
      ...(overrides?.botId && { bot_id: overrides.botId }),
      ...(overrides?.threadTs && { thread_ts: overrides.threadTs }),
    },
  };
}

describe("SlackAdapter.verifyRequest", () => {
  const adapter = createAdapter();

  test("accepts valid signature", async () => {
    const body = '{"test":true}';
    const headers = await sign(body, SIGNING_SECRET);
    const req = makeSlackRequest(body, headers);
    expect(await adapter.verifyRequest(req, body)).toBe(true);
  });

  test("rejects invalid signature", async () => {
    const body = '{"test":true}';
    const headers = await sign(body, "wrong-secret");
    const req = makeSlackRequest(body, headers);
    expect(await adapter.verifyRequest(req, body)).toBe(false);
  });

  test("rejects expired timestamp", async () => {
    const body = '{"test":true}';
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const headers = await sign(body, SIGNING_SECRET, staleTs);
    const req = makeSlackRequest(body, headers);
    expect(await adapter.verifyRequest(req, body)).toBe(false);
  });
});

describe("SlackAdapter.parseWebhook", () => {
  const adapter = createAdapter();

  test("handles url_verification challenge", () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("challenge");
    if (result.type !== "challenge") throw new Error("Expected challenge");
    expect(result.response.status).toBe(200);
  });

  test("parses app_mention event", () => {
    const body = JSON.stringify(appMentionPayload());
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.channel).toBe("slack");
    expect(result.message.userId).toBe("U_USER");
    expect(result.message.text).toBe("hello");
    expect(result.message.chatType).toBe("channel");
    expect(result.message.peerId).toBe("C_CHAN");
    expect(result.message.routingMode).toBe("per-channel-peer");
    expect(result.message.idempotencyKey).toBe("C_CHAN:1234567890.123456");
    expect(result.message.channelThreadId).toBe("1234567890.123456");
  });

  test("parses message event", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev02",
      event: {
        type: "message",
        user: "U_USER",
        text: "direct message",
        channel: "D_DM",
        channel_type: "im",
        ts: "1234567890.100000",
      },
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.chatType).toBe("direct");
    expect(result.message.text).toBe("direct message");
    expect(result.message.channelThreadId).toBeUndefined();
  });

  test("strips @mention from text", () => {
    const body = JSON.stringify(appMentionPayload({ text: `<@${BOT_USER_ID}> what is 2+2` }));
    const result = adapter.parseWebhook(body, new Headers());
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.text).toBe("what is 2+2");
  });

  test("ignores bot messages", () => {
    const body = JSON.stringify(appMentionPayload({ botId: "B_BOT" }));
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("ignore");
  });

  test("ignores empty text after mention strip", () => {
    const body = JSON.stringify(appMentionPayload({ text: `<@${BOT_USER_ID}>` }));
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("ignore");
  });

  test("uses thread_ts for channelThreadId when present", () => {
    const body = JSON.stringify(
      appMentionPayload({ threadTs: "1234567890.000001", ts: "1234567890.000002" }),
    );
    const result = adapter.parseWebhook(body, new Headers());
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.channelThreadId).toBe("1234567890.000001");
  });

  test("falls back to ts for channelThreadId in channel mentions", () => {
    const body = JSON.stringify(appMentionPayload({ ts: "1234567890.999999" }));
    const result = adapter.parseWebhook(body, new Headers());
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.channelThreadId).toBe("1234567890.999999");
  });

  test("parses threaded channel message events", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev03",
      event: {
        type: "message",
        user: "U_USER",
        text: "continue in thread",
        channel: "C_CHAN",
        channel_type: "channel",
        thread_ts: "1234567890.200000",
        ts: "1234567890.200001",
      },
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.channelThreadId).toBe("1234567890.200000");
  });

  test("parses message_replied channel events", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev04",
      event: {
        type: "message",
        subtype: "message_replied",
        channel: "C_CHAN",
        channel_type: "channel",
        ts: "1234567890.300001",
        message: {
          user: "U_USER",
          text: "reply payload shape",
          thread_ts: "1234567890.300000",
          ts: "1234567890.300001",
        },
      },
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message");
    expect(result.message.text).toBe("reply payload shape");
    expect(result.message.channelThreadId).toBe("1234567890.300000");
  });

  test("ignores message_replied events from bots", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev05",
      event: {
        type: "message",
        subtype: "message_replied",
        channel: "C_CHAN",
        channel_type: "channel",
        ts: "1234567890.300001",
        message: {
          bot_id: "B_BOT",
          text: "bot reply",
          thread_ts: "1234567890.300000",
          ts: "1234567890.300001",
        },
      },
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("ignore");
  });

  test("ignores non-threaded channel message events", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev06",
      event: {
        type: "message",
        user: "U_USER",
        text: "hello channel",
        channel: "C_CHAN",
        channel_type: "channel",
        ts: "1234567890.200000",
      },
    });
    const result = adapter.parseWebhook(body, new Headers());
    expect(result.type).toBe("ignore");
  });
});

describe("splitMessage", () => {
  test("returns single chunk when under limit", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  test("returns single chunk when exactly at limit", () => {
    const text = "a".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  test("splits at last newline within limit", () => {
    const text = "aaa\nbbb\nccc";
    const chunks = splitMessage(text, 5);
    expect(chunks).toEqual(["aaa", "bbb", "ccc"]);
  });

  test("hard-breaks when no newline exists", () => {
    const text = "a".repeat(30);
    expect(splitMessage(text, 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(10)]);
  });

  test("handles empty string", () => {
    expect(splitMessage("", 10)).toEqual([""]);
  });
});

function createStubGateway(
  impl: (message: InboundMessage) => Promise<GatewayReply>,
): MessageGateway {
  return {
    handleMessage(message) {
      return impl(message);
    },
  };
}

describe("createWebhookHandler", () => {
  test("returns 401 for bad signature", async () => {
    const adapter = createAdapter();
    const gateway = createStubGateway(async () => {
      throw new Error("should not be called");
    });
    const handler = createWebhookHandler(adapter, gateway);

    const body = JSON.stringify(appMentionPayload());
    const headers = await sign(body, "wrong-secret");
    const req = makeSlackRequest(body, headers);
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  test("returns 200 for valid event", async () => {
    const adapter = createAdapter();
    const gateway = createStubGateway(async () => ({
      threadId: "test",
      routingMode: "per-channel-peer",
      provider: "claude",
      reply: "hello back",
    }));
    const handler = createWebhookHandler(adapter, gateway);

    const body = JSON.stringify(appMentionPayload());
    const headers = await sign(body, SIGNING_SECRET);
    const req = makeSlackRequest(body, headers);
    const res = await handler(req);
    expect(res.status).toBe(200);
  });

  test("deduplicates same event_id", async () => {
    const adapter = createAdapter();
    const gateway = createStubGateway(async () => {
      return {
        threadId: "test",
        routingMode: "per-channel-peer" as const,
        provider: "claude",
        reply: "ok",
      };
    });
    const handler = createWebhookHandler(adapter, gateway);

    const body = JSON.stringify(appMentionPayload({ eventId: "Ev_dedup" }));
    const headers = await sign(body, SIGNING_SECRET);

    const res1 = await handler(makeSlackRequest(body, headers));
    expect(res1.status).toBe(200);

    const headers2 = await sign(body, SIGNING_SECRET);
    const res2 = await handler(makeSlackRequest(body, headers2));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2["deduplicated"]).toBe(true);
  });

  test("passes through challenge response", async () => {
    const adapter = createAdapter();
    const gateway = createStubGateway(async () => {
      throw new Error("should not be called");
    });
    const handler = createWebhookHandler(adapter, gateway);

    const body = JSON.stringify({ type: "url_verification", challenge: "test123" });
    const headers = await sign(body, SIGNING_SECRET);
    const req = makeSlackRequest(body, headers);
    const res = await handler(req);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as Record<string, unknown>;
    expect(resBody["challenge"]).toBe("test123");
  });
});
