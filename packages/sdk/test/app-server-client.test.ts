import { describe, expect, test } from "bun:test";
import { AppServerClient } from "../src/app-server-client.ts";

function createHarness(provider?: string) {
  const client = new AppServerClient({
    provider,
    command: "does-not-run-in-tests",
    cwd: process.cwd(),
  });
  const calls: Array<{ method: string; params: unknown }> = [];

  (
    client as unknown as { request: (method: string, params?: unknown) => Promise<unknown> }
  ).request = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    return { thread: { id: "thread-1" } };
  };

  return { client, calls };
}

describe("AppServerClient thread parameter mapping", () => {
  test("maps codex thread/start options to developerInstructions + config.mcp_servers", async () => {
    const { client, calls } = createHarness("codex");
    await client.createThread({
      model: "gpt-5-codex",
      systemPrompt: "Base instructions override",
      systemPromptAppend: "Memory instructions append",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      mcpServers: {
        flint_memory: {
          type: "stdio",
          command: "bun",
          args: ["memory-mcp.ts"],
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("thread/start");
    expect(calls[0]?.params).toEqual({
      cwd: process.cwd(),
      model: "gpt-5-codex",
      baseInstructions: "Base instructions override",
      developerInstructions: "Memory instructions append",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        "mcp_servers.flint_memory.command": "bun",
        "mcp_servers.flint_memory.args": ["memory-mcp.ts"],
      },
    });
  });

  test("maps non-codex providers to systemPromptAppend + mcpServers", async () => {
    const { client, calls } = createHarness("claude");
    await client.createThread({
      model: "claude-opus-4-6",
      systemPromptAppend: "Memory instructions append",
      mcpServers: {
        flint_memory: {
          type: "stdio",
          command: "bun",
          args: ["memory-mcp.ts"],
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("thread/start");
    expect(calls[0]?.params).toEqual({
      cwd: process.cwd(),
      model: "claude-opus-4-6",
      systemPromptAppend: "Memory instructions append",
      mcpServers: {
        flint_memory: {
          type: "stdio",
          command: "bun",
          args: ["memory-mcp.ts"],
        },
      },
    });
  });

  test("maps codex thread/resume options to developerInstructions + config.mcp_servers", async () => {
    const { client, calls } = createHarness("codex");
    await client.resumeThread("thread-abc", {
      cwd: "/tmp/project",
      systemPromptAppend: "Memory instructions append",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      mcpServers: {
        flint_memory: {
          type: "stdio",
          command: "bun",
          args: ["memory-mcp.ts"],
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("thread/resume");
    expect(calls[0]?.params).toEqual({
      threadId: "thread-abc",
      cwd: "/tmp/project",
      developerInstructions: "Memory instructions append",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.flint_memory.command": "bun",
        "mcp_servers.flint_memory.args": ["memory-mcp.ts"],
      },
    });
  });

  test("ignores codex execution overrides for non-codex providers", async () => {
    const { client, calls } = createHarness("claude");
    await client.createThread({
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("thread/start");
    expect(calls[0]?.params).toEqual({
      cwd: process.cwd(),
    });
  });

  test("converts http mcp server config to codex transport shape", async () => {
    const { client, calls } = createHarness("codex");
    await client.createThread({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    });

    expect(calls[0]?.params).toEqual({
      cwd: process.cwd(),
      config: {
        "mcp_servers.linear.url": "https://mcp.linear.app/mcp",
        "mcp_servers.linear.http_headers": { Authorization: "Bearer token" },
      },
    });
  });
});

describe("AppServerClient approval request handling", () => {
  test("treats id+method messages as server requests and applies configured decision", () => {
    const client = new AppServerClient({
      command: "does-not-run-in-tests",
      cwd: process.cwd(),
      approvalResponseDecision: "decline",
    });
    const writes: string[] = [];
    const internals = client as unknown as {
      stdin: { write: (line: string) => void };
      pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
      handleMessage: (line: string) => void;
    };
    internals.stdin = { write: (line: string) => writes.push(line) };
    internals.pendingRequests.set(42, {
      resolve: () => {},
      reject: () => {},
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      internals.handleMessage(
        JSON.stringify({
          id: 42,
          method: "item/commandExecution/requestApproval",
          params: { itemId: "cmd-1", command: "bun install" },
        }),
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(internals.pendingRequests.has(42)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({
      id: 42,
      result: { decision: "decline" },
    });
  });

  test("maps forwarded approval notifications to activity heartbeat events", () => {
    const client = new AppServerClient({
      command: "does-not-run-in-tests",
      cwd: process.cwd(),
    });
    const writes: string[] = [];
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const internals = client as unknown as {
      stdin: { write: (line: string) => void };
      notificationListeners: Array<(notification: { method: string; params?: unknown }) => void>;
      handleMessage: (line: string) => void;
      translateNotification: (notification: { method: string; params?: unknown }) => Array<{
        type: string;
      }>;
    };
    internals.stdin = { write: (line: string) => writes.push(line) };
    internals.notificationListeners.push((notification) => notifications.push(notification));

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      internals.handleMessage(
        JSON.stringify({
          id: 7,
          method: "item/fileChange/requestApproval",
          params: { itemId: "edit-1", reason: "apply patch" },
        }),
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(writes).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(internals.translateNotification(notifications[0]!)).toEqual([{ type: "activity" }]);
  });
});
