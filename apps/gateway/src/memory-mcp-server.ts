#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import path from "node:path";
import { MemoryMcpHandler } from "./memory-mcp.ts";

function parseArgs(argv: string[]): { workspaceDir: string } {
  let workspaceDir = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const nextToken = argv[i + 1];
    if (token === "--workspace" && typeof nextToken === "string") {
      workspaceDir = path.resolve(nextToken);
      i += 1;
    }
  }
  return { workspaceDir };
}

type TransportFraming = "contentLength" | "lineJson";

function writeMessage(payload: unknown, framing: TransportFraming): void {
  const json = JSON.stringify(payload);
  if (framing === "lineJson") {
    process.stdout.write(`${json}\n`);
    return;
  }
  const body = Buffer.from(json, "utf-8");
  const headers = `Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`;
  process.stdout.write(headers);
  process.stdout.write(body);
}

function firstNonWhitespaceByte(buffer: Buffer): number | undefined {
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      continue;
    }
    return byte;
  }
  return undefined;
}

function findHeaderEnd(buffer: Buffer): { index: number; sepLength: number } | undefined {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return { index: crlf, sepLength: 4 };
  }
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) {
    return { index: lf, sepLength: 2 };
  }
  return undefined;
}

async function main(): Promise<void> {
  const { workspaceDir } = parseArgs(process.argv.slice(2));
  const handler = new MemoryMcpHandler({ workspaceDir });

  const reader = Bun.stdin.stream().getReader();
  let buffer = Buffer.alloc(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer = Buffer.concat([buffer, Buffer.from(value)]);

    while (true) {
      const headerBoundary = findHeaderEnd(buffer);
      if (headerBoundary) {
        const { index: headerEnd, sepLength } = headerBoundary;
        const headerText = buffer.slice(0, headerEnd).toString("utf-8");
        const lines = headerText.split(/\r?\n/);
        let contentLength = -1;
        for (const line of lines) {
          const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
          if (match) {
            contentLength = Number(match[1]);
            break;
          }
        }
        if (contentLength < 0) {
          // Malformed frame; drop header section and continue.
          buffer = buffer.slice(headerEnd + sepLength);
          continue;
        }
        const frameSize = headerEnd + sepLength + contentLength;
        if (buffer.length < frameSize) {
          break;
        }

        const body = buffer.slice(headerEnd + sepLength, frameSize).toString("utf-8");
        buffer = buffer.slice(frameSize);

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          writeMessage(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            },
            "contentLength",
          );
          continue;
        }

        const response = await handler.handleRequest(parsed);
        if (response) {
          writeMessage(response, "contentLength");
        }
        continue;
      }

      // Fallback for newline-delimited JSON-RPC clients.
      const firstByte = firstNonWhitespaceByte(buffer);
      if (firstByte !== 0x7b && firstByte !== 0x5b) {
        break;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).toString("utf-8").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeMessage(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          },
          "lineJson",
        );
        continue;
      }

      const response = await handler.handleRequest(parsed);
      if (response) {
        writeMessage(response, "lineJson");
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[flint-memory-mcp] fatal: ${message}\n`);
  process.exit(1);
});
