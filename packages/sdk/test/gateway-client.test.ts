import { describe, expect, test } from "bun:test";
import { GatewayClient, GatewayHttpError } from "../src/gateway-client.ts";

type MockCall = {
  url: string;
  init: RequestInit;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function createMockFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const queue = [...responses];
  const mockFetch: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init: init ?? {},
    });
    const next = queue.shift();
    if (!next) {
      throw new Error("No mock response remaining.");
    }
    return next;
  }) as typeof fetch;
  return { fetch: mockFetch, calls };
}

function readJsonBody(call: MockCall): Record<string, unknown> {
  const raw = typeof call.init.body === "string" ? call.init.body : "{}";
  return JSON.parse(raw) as Record<string, unknown>;
}

function readHeaders(call: MockCall): Headers {
  return new Headers(call.init.headers);
}

describe("GatewayClient", () => {
  test("createThread posts to /v1/threads", async () => {
    const { fetch, calls } = createMockFetch([
      jsonResponse(200, {
        threadId: "agent:main:direct:u1",
        routingMode: "per-peer",
        provider: "codex",
        reply: "ok",
      }),
    ]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788/", fetch });

    const reply = await client.createThread({
      channel: "slack",
      userId: "u1",
      text: "hello",
    });

    expect(reply.threadId).toBe("agent:main:direct:u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8788/v1/threads");
    expect(calls[0]?.init.method).toBe("POST");
    expect(readJsonBody(calls[0]!)).toEqual({
      channel: "slack",
      userId: "u1",
      text: "hello",
    });
  });

  test("sendThreadMessage posts to /v1/threads/:threadId", async () => {
    const { fetch, calls } = createMockFetch([
      jsonResponse(200, {
        threadId: "agent:main:direct:u1",
        routingMode: "per-peer",
        provider: "codex",
        reply: "pong",
      }),
    ]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788", fetch });

    await client.sendThreadMessage("agent:main:direct:u1", "continue");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8788/v1/threads/agent%3Amain%3Adirect%3Au1");
    expect(readJsonBody(calls[0]!)).toEqual({ text: "continue" });
  });

  test("passes idempotency key header", async () => {
    const { fetch, calls } = createMockFetch([
      jsonResponse(200, {
        threadId: "agent:main:direct:u1",
        routingMode: "per-peer",
        provider: "codex",
        reply: "ok",
      }),
    ]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788", fetch });

    await client.createThread(
      {
        channel: "slack",
        userId: "u1",
        text: "hello",
      },
      "abc-123",
    );

    expect(readHeaders(calls[0]!).get("idempotency-key")).toBe("abc-123");
  });

  test("getThread returns undefined on 404", async () => {
    const { fetch } = createMockFetch([jsonResponse(404, { error: "Thread not found." })]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788", fetch });
    const thread = await client.getThread("agent:main:direct:u1");
    expect(thread).toBeUndefined();
  });

  test("interruptThread returns false on 409", async () => {
    const { fetch } = createMockFetch([
      jsonResponse(409, { error: "No active runtime for this thread." }),
    ]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788", fetch });
    const interrupted = await client.interruptThread("agent:main:direct:u1");
    expect(interrupted).toBe(false);
  });

  test("throws GatewayHttpError with response body", async () => {
    const { fetch } = createMockFetch([jsonResponse(500, { error: "Failed to process message." })]);
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8788", fetch });

    try {
      await client.listThreads();
      throw new Error("Expected listThreads to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayHttpError);
      const httpError = error as GatewayHttpError;
      expect(httpError.status).toBe(500);
      expect(httpError.message).toBe("Failed to process message.");
      expect(httpError.body).toEqual({ error: "Failed to process message." });
    }
  });
});
