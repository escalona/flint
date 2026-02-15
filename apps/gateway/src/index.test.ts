import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayApp,
  createGatewayRuntime,
  IdempotencyStore,
  parseInboundMessage,
  resolveThreadId,
  type GatewayLike,
  type GatewayReply,
  type InboundMessage,
  type ThreadRecord,
} from "./index.ts";

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("parseInboundMessage", () => {
  test("validates required fields", () => {
    const missingChannel = parseInboundMessage({ userId: "u1", text: "hello" });
    expect(missingChannel).toEqual({ ok: false, error: "channel is required." });

    const missingUser = parseInboundMessage({ channel: "telegram", text: "hello" });
    expect(missingUser).toEqual({ ok: false, error: "userId is required." });

    const missingText = parseInboundMessage({ channel: "telegram", userId: "u1", text: "   " });
    expect(missingText).toEqual({ ok: false, error: "text is required." });
  });

  test("normalizes optional fields", () => {
    const parsed = parseInboundMessage({
      channel: " Telegram ",
      userId: "  User-1  ",
      text: "hello",
      mcpProfileIds: ["figma-readonly", "linear-readonly", "figma-readonly"],
      provider: " PI ",
      chatType: "direct",
      peerId: " Peer-42 ",
      accountId: " Work ",
      identityId: " Nader ",
      channelThreadId: " Thread-9 ",
      routingMode: "per-account-channel-peer",
      idempotencyKey: " key-1 ",
    });

    if (!parsed.ok) throw new Error("Expected parseInboundMessage to succeed");

    expect(parsed.message).toEqual({
      channel: "telegram",
      userId: "User-1",
      text: "hello",
      mcpProfileIds: ["figma-readonly", "linear-readonly"],
      provider: "pi",
      chatType: "direct",
      peerId: "peer-42",
      accountId: "work",
      identityId: "nader",
      channelThreadId: "thread-9",
      routingMode: "per-account-channel-peer",
      idempotencyKey: "key-1",
    });
  });

  test("rejects invalid enum values", () => {
    const invalidMode = parseInboundMessage({
      channel: "telegram",
      userId: "u1",
      text: "hello",
      routingMode: "unknown",
    });
    expect(invalidMode).toEqual({
      ok: false,
      error:
        "routingMode must be one of: main, per-peer, per-channel-peer, per-account-channel-peer.",
    });

    const invalidChatType = parseInboundMessage({
      channel: "telegram",
      userId: "u1",
      text: "hello",
      chatType: "dm",
    });
    expect(invalidChatType).toEqual({
      ok: false,
      error: "chatType must be one of: direct, group, channel.",
    });

    const invalidRawMcpServers = parseInboundMessage({
      channel: "telegram",
      userId: "u1",
      text: "hello",
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    });
    expect(invalidRawMcpServers).toEqual({
      ok: false,
      error: "mcpServers is not accepted; use mcpProfileIds instead.",
    });
  });
});

describe("MCP settings", () => {
  test("loads user settings, env substitution, and default profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flint-gateway-settings-"));
    const userPath = join(dir, "user-settings.json");
    const storePath = join(dir, "threads.json");

    await Bun.write(
      userPath,
      JSON.stringify({
        gateway: {
          defaultMcpProfileIds: ["linear"],
          mcpProfiles: {
            linear: {
              servers: {
                linear: {
                  type: "http",
                  url: "${LINEAR_BASE}/mcp",
                  headers: {
                    Authorization: "Bearer ${LINEAR_TOKEN}",
                  },
                },
              },
            },
          },
        },
      }),
    );

    const runtime = await createGatewayRuntime({
      FLINT_GATEWAY_USER_SETTINGS_PATH: userPath,
      FLINT_GATEWAY_STORE_PATH: storePath,
      LINEAR_BASE: "https://mcp.linear.app",
      LINEAR_TOKEN: "token-123",
    });
    expect(runtime.mcpProfileCount).toBe(1);
    await runtime.gateway.close();
  });

  test("skips MCP servers with missing env vars and warns instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flint-gateway-settings-"));
    const userPath = join(dir, "user-settings.json");
    const storePath = join(dir, "threads.json");

    await Bun.write(
      userPath,
      JSON.stringify({
        gateway: {
          defaultMcpProfileIds: ["linear"],
          mcpProfiles: {
            linear: {
              servers: {
                linear: {
                  type: "http",
                  url: "https://mcp.linear.app/mcp",
                  headers: {
                    Authorization: "Bearer ${LINEAR_API_KEY}",
                  },
                },
              },
            },
          },
        },
      }),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const runtime = await createGatewayRuntime({
        FLINT_GATEWAY_USER_SETTINGS_PATH: userPath,
        FLINT_GATEWAY_STORE_PATH: storePath,
      });

      expect(runtime.mcpProfileCount).toBe(1);
      expect(
        warnings.some(
          (line) =>
            line.includes('missing or empty env var "LINEAR_API_KEY"') &&
            line.includes('skipping MCP server "linear" in profile "linear"'),
        ),
      ).toBe(true);

      await runtime.gateway.close();
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("resolveThreadId", () => {
  const baseMessage: InboundMessage = {
    channel: "telegram",
    userId: "user-1",
    text: "hello",
    chatType: "direct",
    peerId: "peer-1",
  };

  test("uses linked identity for direct chats", () => {
    const threadId = resolveThreadId(baseMessage, "per-peer", {
      nader: ["telegram:peer-1"],
    });

    expect(threadId).toBe("agent:main:direct:nader");
  });

  test("uses non-direct routing regardless of routing mode", () => {
    const threadId = resolveThreadId(
      {
        ...baseMessage,
        chatType: "group",
      },
      "main",
      {},
    );

    expect(threadId).toBe("agent:main:telegram:group:peer-1");
  });
});

function createStubGateway(
  impl: (message: InboundMessage) => Promise<GatewayReply>,
  threads: ThreadRecord[] = [],
  interruptResult = true,
): GatewayLike {
  return {
    listThreads() {
      return threads;
    },
    getThread(threadId) {
      return threads.find((thread) => thread.threadId === threadId);
    },
    handleMessage(message) {
      return impl(message);
    },
    handleThreadMessage(threadId, text) {
      const thread = threads.find((candidate) => candidate.threadId === threadId);
      if (!thread) {
        return Promise.reject(new Error("Thread not found."));
      }
      return impl({
        channel: thread.channel,
        userId: thread.userId,
        text,
        peerId: thread.peerId,
        chatType: thread.chatType,
        provider: thread.provider,
        routingMode: thread.routingMode,
      });
    },
    interruptThread() {
      return Promise.resolve(interruptResult);
    },
  };
}

describe("createGatewayApp", () => {
  test("serves health and thread routes", async () => {
    const gateway = createStubGateway(async () => {
      throw new Error("not used");
    }, [
      {
        threadId: "a",
        routingMode: "per-peer",
        provider: "claude",
        providerThreadId: "provider-thread-1",
        channel: "telegram",
        userId: "u1",
        chatType: "direct",
        peerId: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const fetchHandler = createGatewayApp({
      gateway,
      idempotency: new IdempotencyStore(300_000),
      defaultProvider: "claude",
      routingMode: "per-peer",
    }).fetch;

    const health = await fetchHandler(new Request("http://localhost/v1/health"));
    expect(health.status).toBe(200);
    expect(await jsonBody(health)).toEqual({
      ok: true,
      provider: "claude",
      defaultRoutingMode: "per-peer",
    });

    const threads = await fetchHandler(new Request("http://localhost/v1/threads"));
    expect(threads.status).toBe(200);
    expect(await jsonBody(threads)).toEqual({
      data: [
        {
          threadId: "a",
          routingMode: "per-peer",
          provider: "claude",
          channel: "telegram",
          userId: "u1",
          chatType: "direct",
          peerId: "u1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("handles thread create/message/interrupt", async () => {
    let callCount = 0;
    const threads: ThreadRecord[] = [
      {
        threadId: "agent:main:direct:u1",
        routingMode: "per-peer",
        provider: "claude",
        providerThreadId: "provider-thread-1",
        channel: "telegram",
        userId: "u1",
        chatType: "direct",
        peerId: "u1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const gateway = createStubGateway(async (message) => {
      callCount += 1;
      return {
        threadId: `agent:main:direct:${message.userId}`,
        routingMode: "per-peer",
        provider: "claude",
        reply: "ok",
      };
    }, threads);

    const fetchHandler = createGatewayApp({
      gateway,
      idempotency: new IdempotencyStore(300_000),
      defaultProvider: "claude",
      routingMode: "per-peer",
    }).fetch;

    const created = await fetchHandler(
      new Request("http://localhost/v1/threads", {
        method: "POST",
        headers: { "idempotency-key": "message-1" },
        body: JSON.stringify({
          channel: "telegram",
          userId: "u1",
          text: "hello",
        }),
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = await jsonBody(created);
    expect(createdBody.threadId).toBe("agent:main:direct:u1");

    const posted = await fetchHandler(
      new Request("http://localhost/v1/threads/agent:main:direct:u1", {
        method: "POST",
        body: JSON.stringify({ text: "continue" }),
      }),
    );
    expect(posted.status).toBe(200);

    const interrupted = await fetchHandler(
      new Request("http://localhost/v1/threads/agent:main:direct:u1/interrupt", {
        method: "POST",
      }),
    );
    expect(interrupted.status).toBe(200);
    expect(await jsonBody(interrupted)).toEqual({
      ok: true,
      threadId: "agent:main:direct:u1",
      interrupted: true,
    });

    expect(callCount).toBe(2);
  });
});
