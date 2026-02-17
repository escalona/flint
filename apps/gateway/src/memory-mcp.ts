import { MemoryManager, type MemoryGetResult, type MemorySearchResult } from "./memory.ts";

export interface MemoryMcpHandlerOptions {
  workspaceDir: string;
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

const SERVER_NAME = "flint-memory";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export class MemoryMcpHandler {
  private readonly manager: MemoryManager;

  constructor(options: MemoryMcpHandlerOptions) {
    this.manager = new MemoryManager({ workspaceDir: options.workspaceDir });
  }

  async handleRequest(raw: unknown): Promise<JsonRpcResponse | null> {
    const req = raw as JsonRpcRequest;
    const method = typeof req.method === "string" ? req.method : "";
    const id = req.id ?? null;

    // Notifications do not require responses.
    if (id === null && method === "notifications/initialized") {
      return null;
    }

    if (!method) {
      return errorResponse(id, -32600, "Invalid request: missing method.");
    }

    try {
      switch (method) {
        case "initialize":
          {
            const requestedVersion = parseRequestedProtocolVersion(req.params);
            const negotiatedVersion =
              requestedVersion &&
              (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requestedVersion)
                ? requestedVersion
                : DEFAULT_PROTOCOL_VERSION;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: negotiatedVersion,
              capabilities: {
                tools: {
                  listChanged: false,
                },
              },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
              },
            },
          };
          }

        case "ping":
          return {
            jsonrpc: "2.0",
            id,
            result: {},
          };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "memory_search",
                  description:
                    "Mandatory recall step: semantically search MEMORY.md + memory/*.md before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      query: { type: "string" },
                      maxResults: { type: "number" },
                      minScore: { type: "number" },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "memory_get",
                  description:
                    "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      from: { type: "number" },
                      lines: { type: "number" },
                    },
                    required: ["path"],
                  },
                },
              ],
            },
          };

        case "tools/call":
          return await this.handleToolCall(id, req.params);

        default:
          return errorResponse(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return errorResponse(id, -32603, error instanceof Error ? error.message : "Internal error.");
    }
  }

  private async handleToolCall(
    id: string | number | null,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    const payload = params as { name?: unknown; arguments?: unknown };
    const toolName = typeof payload?.name === "string" ? payload.name : "";
    const args = (payload?.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return toolResult(id, { error: "tool name is required." }, true);
    }

    if (toolName === "memory_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return toolResult(id, { error: "query is required." }, true);
      }
      const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
      const minScore = typeof args.minScore === "number" ? args.minScore : undefined;
      const results = await this.manager.search(query, { maxResults, minScore });
      return toolResult(id, { results });
    }

    if (toolName === "memory_get") {
      const relPath = typeof args.path === "string" ? args.path.trim() : "";
      if (!relPath) {
        return toolResult(id, { error: "path is required." }, true);
      }
      const from = typeof args.from === "number" ? Math.floor(args.from) : undefined;
      const lines = typeof args.lines === "number" ? Math.floor(args.lines) : undefined;
      try {
        const result = await this.manager.get({ path: relPath, from, lines });
        return toolResult(id, result);
      } catch (error) {
        return toolResult(
          id,
          { error: error instanceof Error ? error.message : "memory_get failed." },
          true,
        );
      }
    }

    return toolResult(id, { error: `Unknown tool: ${toolName}` }, true);
  }
}

function toolResult(
  id: string | number | null,
  payload: { results: MemorySearchResult[] } | MemoryGetResult | { error: string },
  isError = false,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      ...(isError && { isError: true }),
    },
  };
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function parseRequestedProtocolVersion(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const value = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof value === "string" ? value : undefined;
}
