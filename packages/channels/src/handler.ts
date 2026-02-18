import type { InboundMessage } from "./contracts.ts";
import type { AgentEvent, ChannelAdapter, WebhookMeta } from "./types.ts";

const DEDUP_TTL_MS = 5 * 60 * 1000;

export interface MessageGateway {
  handleMessage(
    message: InboundMessage,
    onEvent?: (event: AgentEvent) => Promise<void>,
  ): Promise<{ reply: string }>;
}

export function createWebhookHandler(
  adapter: ChannelAdapter,
  gateway: MessageGateway,
): (req: Request) => Promise<Response> {
  const seen = new Map<string, number>();

  function cleanupSeen(): void {
    const now = Date.now();
    for (const [id, ts] of seen) {
      if (now - ts > DEDUP_TTL_MS) {
        seen.delete(id);
      }
    }
  }

  async function processWebhookEvent(meta: WebhookMeta, message: InboundMessage): Promise<void> {
    try {
      await adapter.acknowledge(meta);
    } catch (error) {
      console.warn(`[channels/${adapter.channel}] acknowledge failed:`, error);
    }

    const onEvent = adapter.onAgentEvent
      ? (event: AgentEvent) => adapter.onAgentEvent!(meta, event)
      : undefined;

    try {
      const result = await gateway.handleMessage(message, onEvent);
      await adapter.deliverReply(meta, result.reply);
    } catch (error) {
      console.error(`[channels/${adapter.channel}] process failed:`, error);
      try {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await adapter.deliverReply(
          meta,
          `Sorry, I hit an error while processing your request:\n\`\`\`${errorMessage}\`\`\``,
        );
      } catch (replyError) {
        console.error(`[channels/${adapter.channel}] error reply failed:`, replyError);
      }
    }
  }

  return async (req: Request): Promise<Response> => {
    const rawBody = await req.text();

    const valid = await adapter.verifyRequest(req, rawBody);
    if (!valid) {
      return new Response(JSON.stringify({ error: "Invalid signature." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const parsed = adapter.parseWebhook(rawBody, req.headers);

    if (parsed.type === "challenge") {
      return parsed.response;
    }

    if (parsed.type === "ignore") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    cleanupSeen();
    if (seen.has(parsed.meta.eventId)) {
      return new Response(JSON.stringify({ ok: true, deduplicated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    seen.set(parsed.meta.eventId, Date.now());

    void processWebhookEvent(parsed.meta, parsed.message);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
