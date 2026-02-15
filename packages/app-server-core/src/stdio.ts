/**
 * Stdio JSON-RPC transport
 * Reads JSON-RPC messages from stdin, writes to stdout
 */

import type { JsonRpcRequest, JsonRpcResponse, JsonRpcError } from "./protocol/requests.ts";
import type { JsonRpcNotification } from "./protocol/notifications.ts";

export type MessageHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

// Notification methods that should be silently ignored (no response needed)
const IGNORED_NOTIFICATIONS = new Set(["initialized"]);

export class StdioTransport {
  private handler: MessageHandler | null = null;
  private running = false;
  private decoder = new TextDecoder();

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Use Bun's native stdin reading
    const reader = Bun.stdin.stream().getReader();
    let buffer = "";

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += this.decoder.decode(value, { stream: true });

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (line.trim()) {
            await this.processLine(line);
          }
        }
      }
    } catch {
      // Stream closed
    } finally {
      this.running = false;
    }
  }

  private async processLine(line: string): Promise<void> {
    try {
      const message = JSON.parse(line);

      // Check if this is a notification (no id) that we should ignore
      if (!("id" in message) || message.id == null) {
        if (IGNORED_NOTIFICATIONS.has(message.method)) {
          return; // Silently ignore
        }
      }

      const request = message as JsonRpcRequest;
      if (!this.handler) {
        this.sendError(request.id, -32603, "No handler registered");
        return;
      }

      const response = await this.handler(request);
      this.send(response);
    } catch (e) {
      // Parse error - use null id
      this.sendError(null, -32700, `Parse error: ${e}`);
    }
  }

  send(message: JsonRpcResponse | JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      method,
      params,
    };
    this.send(notification);
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    const error: JsonRpcError = { code, message };
    if (data !== undefined) error.data = data;

    const response: JsonRpcResponse = {
      id: id ?? 0,
      error,
    };
    this.send(response);
  }

  sendResult(id: string | number, result: unknown): void {
    const response: JsonRpcResponse = {
      id,
      result,
    };
    this.send(response);
  }

  stop(): void {
    this.running = false;
  }
}

export const stdio = new StdioTransport();
