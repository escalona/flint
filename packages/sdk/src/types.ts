export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown; parentId?: string | null }
  | { type: "tool_end"; id: string; result?: unknown; isError: boolean; parentId?: string | null }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string };
