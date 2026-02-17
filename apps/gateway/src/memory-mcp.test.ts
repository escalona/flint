import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryMcpHandler } from "./memory-mcp.ts";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "flint-memory-mcp-"));
}

describe("MemoryMcpHandler", () => {
  test("negotiates initialize protocol version from client request", async () => {
    const workspace = await createWorkspace();
    const handler = new MemoryMcpHandler({ workspaceDir: workspace });
    const response = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
      },
    });

    if (!response) {
      throw new Error("Expected initialize response");
    }
    expect(response?.error).toBeUndefined();
    expect((response.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
  });

  test("lists memory tools", async () => {
    const workspace = await createWorkspace();
    const handler = new MemoryMcpHandler({ workspaceDir: workspace });
    const response = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response).not.toBeNull();
    expect(response?.error).toBeUndefined();
    if (!response) {
      throw new Error("Expected tools/list response");
    }
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_get"]);
  });

  test("calls memory_search and memory_get", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "memory"), { recursive: true });
    await writeFile(join(workspace, "MEMORY.md"), "Keep updates concise.\n");
    await writeFile(join(workspace, "memory", "2026-02-16.md"), "Shipped memory tools.\n");

    const handler = new MemoryMcpHandler({ workspaceDir: workspace });

    const searchResponse = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "memory tools", maxResults: 3 },
      },
    });
    const searchResult = searchResponse?.result as {
      structuredContent: { results: Array<{ path: string }> };
    };
    expect(searchResult.structuredContent.results.length).toBeGreaterThan(0);

    const getResponse = await handler.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_get",
        arguments: { path: "memory/2026-02-16.md" },
      },
    });
    const getResult = getResponse?.result as {
      structuredContent: { path: string; text: string };
    };
    expect(getResult.structuredContent.path).toBe("memory/2026-02-16.md");
    expect(getResult.structuredContent.text).toContain("Shipped memory tools.");
  });
});
