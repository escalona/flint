import type { InboundMessage } from "./contracts.ts";

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
  deliverReply(meta: WebhookMeta, reply: string): Promise<void>;
}
