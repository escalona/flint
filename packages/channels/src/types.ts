import type { InboundMessage } from "./contracts.ts";

export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown; parentId?: string | null }
  | { type: "tool_end"; id: string; result?: unknown; isError: boolean; parentId?: string | null }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string };

export interface WebhookMeta {
  eventId: string;
  [key: string]: unknown;
}

export interface ChannelAdapter {
  readonly channel: string;
  verifyRequest(req: Request, rawBody: string): Promise<boolean>;
  parseWebhook(
    rawBody: string,
    headers: Headers,
  ):
    | { type: "challenge"; response: Response }
    | { type: "message"; message: InboundMessage; meta: WebhookMeta }
    | { type: "ignore" };
  acknowledge(meta: WebhookMeta): Promise<void>;
  onAgentEvent?(meta: WebhookMeta, event: AgentEvent): Promise<void>;
  deliverReply(meta: WebhookMeta, reply: string): Promise<void>;
}
