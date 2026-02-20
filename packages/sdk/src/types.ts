export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "activity" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown; parentId?: string | null }
  | { type: "tool_end"; id: string; result?: unknown; isError: boolean; parentId?: string | null }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string };

/** Common interface for agent clients (local app server or remote gateway). */
export interface AgentClient {
  start(): Promise<void>;
  createThread(): Promise<string>;
  getThreadId(): string | null;
  prompt(text: string): AsyncGenerator<AgentEvent>;
  interrupt(): void;
  close(): void;
}
