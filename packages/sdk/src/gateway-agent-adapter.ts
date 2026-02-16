import { userInfo } from "os";
import { GatewayClient, type GatewayClientOptions } from "./gateway-client";
import type { AgentClient, AgentEvent } from "./types";

interface SSEMessage {
  event: string;
  data: string;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7);
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "") {
          if (currentEvent || currentData) {
            yield { event: currentEvent, data: currentData };
            currentEvent = "";
            currentData = "";
          }
        }
      }
    }

    if (currentEvent || currentData) {
      yield { event: currentEvent, data: currentData };
    }
  } finally {
    reader.releaseLock();
  }
}

export class GatewayAgentAdapter implements AgentClient {
  private readonly gateway: GatewayClient;
  private threadId: string | null = null;
  private abortController: AbortController | null = null;
  private readonly userId: string;

  constructor(options: GatewayClientOptions) {
    this.gateway = new GatewayClient(options);
    try {
      this.userId = userInfo().username;
    } catch {
      this.userId = "tui-user";
    }
  }

  async start(): Promise<void> {
    await this.gateway.health();
  }

  async createThread(): Promise<string> {
    // Gateway requires text to create a thread, so defer to first prompt().
    return "pending";
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async *prompt(text: string): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      let response: Response;

      if (!this.threadId) {
        response = await this.gateway.createThreadStream(
          { channel: "tui", userId: this.userId, text },
          signal,
        );
      } else {
        response = await this.gateway.sendThreadMessageStream(this.threadId, { text }, signal);
      }

      if (!response.body) {
        throw new Error("Gateway returned empty response body.");
      }

      for await (const message of parseSSE(response.body)) {
        if (signal.aborted) return;

        if (message.event === "result") {
          const result = JSON.parse(message.data) as { threadId?: string };
          if (result.threadId) {
            this.threadId = result.threadId;
          }
          continue;
        }

        const event = JSON.parse(message.data) as AgentEvent;
        yield event;
      }
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    } finally {
      this.abortController = null;
    }
  }

  interrupt(): void {
    this.abortController?.abort();
    if (this.threadId) {
      this.gateway.interruptThread(this.threadId).catch(() => {});
    }
  }

  close(): void {
    this.abortController?.abort();
  }
}
