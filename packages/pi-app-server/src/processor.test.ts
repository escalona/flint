import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { processRequest, resetProcessorForTesting } from "./processor.ts";
import { threadManager } from "./thread-manager.ts";
import { stdio } from "@flint-dev/app-server-core";
import type { UserInput } from "@flint-dev/app-server-core";

const TEST_CLIENT_INFO = {
  name: "test-client",
  version: "0.0.0",
};

type ThreadLike = {
  isRunning: () => boolean;
  executeTurn: (
    prompt: string,
    turnId: string,
    overrides?: { config?: Record<string, string> },
  ) => AsyncGenerator<unknown>;
};

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for asynchronous turn execution");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("processor turn config behavior", () => {
  const originalThreadManagerGet = threadManager.get.bind(threadManager);
  const originalStdioSend = stdio.send.bind(stdio);

  beforeEach(async () => {
    resetProcessorForTesting();
    stdio.send = () => {};

    await processRequest({
      id: "init",
      method: "initialize",
      params: {
        clientInfo: TEST_CLIENT_INFO,
      },
    });
  });

  afterEach(() => {
    threadManager.get = originalThreadManagerGet;
    stdio.send = originalStdioSend;
    resetProcessorForTesting();
  });

  test("applies persisted config/set values to turn/start execution", async () => {
    let capturedConfig: Record<string, string> | undefined;

    const fakeThread: ThreadLike = {
      isRunning: () => false,
      // oxlint-disable-next-line require-yield -- mock generator, no items to yield
      async *executeTurn(_prompt, _turnId, overrides) {
        capturedConfig = overrides?.config;
      },
    };

    threadManager.get = async () => fakeThread as never;

    await processRequest({
      id: "set-config",
      method: "config/set",
      params: { id: "thinking_level", value: "high" },
    });

    await processRequest({
      id: "turn",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Hello" } satisfies UserInput],
      },
    });

    await waitFor(() => capturedConfig !== undefined);
    expect(capturedConfig).toEqual({ thinking_level: "high" });
  });

  test("turn/start config overrides persisted values for the current turn", async () => {
    let capturedConfig: Record<string, string> | undefined;

    const fakeThread: ThreadLike = {
      isRunning: () => false,
      // oxlint-disable-next-line require-yield -- mock generator, no items to yield
      async *executeTurn(_prompt, _turnId, overrides) {
        capturedConfig = overrides?.config;
      },
    };

    threadManager.get = async () => fakeThread as never;

    await processRequest({
      id: "set-config",
      method: "config/set",
      params: { id: "thinking_level", value: "high" },
    });

    await processRequest({
      id: "turn",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Hello" } satisfies UserInput],
        config: {
          thinking_level: "low",
          custom_option: "enabled",
        },
      },
    });

    await waitFor(() => capturedConfig !== undefined);
    expect(capturedConfig).toEqual({
      thinking_level: "low",
      custom_option: "enabled",
    });
  });
});
