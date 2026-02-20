import type { InboundMessage } from "./contracts.ts";
import { markdownToMrkdwn } from "./markdown-to-mrkdwn.ts";
import type { AgentEvent, ChannelAdapter, WebhookMeta } from "./types.ts";

export interface SlackAdapterOptions {
  botToken: string;
  signingSecret: string;
  botUserId?: string;
}

interface SlackEventPayload {
  type: string;
  token?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    thread_ts?: string;
    ts?: string;
    message?: {
      user?: string;
      bot_id?: string;
      text?: string;
      thread_ts?: string;
      ts?: string;
    };
  };
}

/** Friendly labels for tool names shown in the status message. */
const TOOL_LABELS: Record<string, string> = {
  mcp__axiom__queryApl: "Querying Axiom",
  mcp__axiom__listDatasets: "Listing Axiom datasets",
  mcp__axiom__getDatasetInfo: "Inspecting dataset",
  Bash: "Running command",
  Read: "Reading file",
  Glob: "Searching files",
  Grep: "Searching code",
  Edit: "Editing file",
  Write: "Writing file",
  WebFetch: "Fetching URL",
  WebSearch: "Searching the web",
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith("mcp__axiom__")) return "Querying Axiom";
  if (name.startsWith("mcp__")) return `Using ${name.split("__")[1]}`;
  return `Running ${name}`;
}

/** Slack's message text limit is 40,000 characters; we leave a small buffer. */
const SLACK_MAX_TEXT_LENGTH = 39_000;

/** Minimum interval between status message updates to avoid rate limits. */
const STATUS_UPDATE_INTERVAL_MS = 2_000;

export class SlackAdapter implements ChannelAdapter {
  readonly channel = "slack";
  private readonly botToken: string;
  private readonly signingSecret: string;
  private readonly botUserId: string | undefined;
  /** Track status message ts per event so we can update/delete it. */
  private readonly statusMessages = new Map<string, { ts: string; lastUpdate: number }>();

  constructor(options: SlackAdapterOptions) {
    this.botToken = options.botToken;
    this.signingSecret = options.signingSecret;
    this.botUserId = options.botUserId;
  }

  async verifyRequest(req: Request, rawBody: string): Promise<boolean> {
    const timestamp = req.headers.get("x-slack-request-timestamp");
    const signature = req.headers.get("x-slack-signature");
    if (!timestamp || !signature) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) return false;

    const baseString = `v0:${timestamp}:${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expected = `v0=${hex}`;

    return timingSafeEqual(expected, signature);
  }

  parseWebhook(
    rawBody: string,
    _headers: Headers,
  ):
    | { type: "challenge"; response: Response }
    | { type: "message"; message: InboundMessage; meta: WebhookMeta }
    | { type: "ignore" } {
    let payload: SlackEventPayload;
    try {
      payload = JSON.parse(rawBody) as SlackEventPayload;
    } catch {
      return { type: "ignore" };
    }

    if (payload.type === "url_verification" && payload.challenge) {
      return {
        type: "challenge",
        response: new Response(JSON.stringify({ challenge: payload.challenge }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      };
    }

    if (payload.type !== "event_callback" || !payload.event) {
      return { type: "ignore" };
    }

    const event = payload.event;
    if (event.type !== "app_mention" && event.type !== "message") {
      return { type: "ignore" };
    }

    const messageEvent =
      event.type === "message" && event.subtype === "message_replied" && event.message
        ? event.message
        : event;

    if (event.type === "message" && event.channel_type !== "im" && !messageEvent.thread_ts) {
      // In channels, only process threaded follow-ups to avoid reacting to all messages.
      return { type: "ignore" };
    }

    if (event.bot_id) return { type: "ignore" };
    if (messageEvent.bot_id) return { type: "ignore" };
    if (this.botUserId && messageEvent.user === this.botUserId) return { type: "ignore" };

    let text = messageEvent.text ?? "";
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
    }

    if (!text) return { type: "ignore" };

    const channelId = event.channel ?? "unknown";
    // For channel mentions, start a thread by default using the message ts.
    const threadTs =
      event.channel_type === "im"
        ? messageEvent.thread_ts
        : (messageEvent.thread_ts ?? messageEvent.ts);
    const chatType = event.channel_type === "im" ? "direct" : "channel";
    const eventId = `${channelId}:${messageEvent.ts ?? event.ts ?? payload.event_id ?? ""}`;

    const message: InboundMessage = {
      channel: "slack",
      userId: messageEvent.user ?? "unknown",
      text,
      chatType,
      peerId: channelId,
      routingMode: "per-channel-peer",
      idempotencyKey: eventId,
      ...(threadTs ? { channelThreadId: threadTs } : {}),
    };

    const meta: WebhookMeta = {
      eventId,
      channelId,
      threadTs,
      messageTs: event.ts ?? "",
    };

    return { type: "message", message, meta };
  }

  async acknowledge(meta: WebhookMeta): Promise<void> {
    const channelId = meta["channelId"] as string;
    const threadTs = meta["threadTs"] as string;

    // Post an initial status message instead of a reaction
    try {
      const result = (await this.slackApi("chat.postMessage", {
        channel: channelId,
        text: ":hourglass_flowing_sand: Thinking...",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })) as { ts?: string };

      if (result.ts) {
        this.statusMessages.set(meta.eventId, { ts: result.ts, lastUpdate: Date.now() });
      }
    } catch (error) {
      console.warn("[channels/slack] status message post failed:", error);
    }
  }

  async onAgentEvent(meta: WebhookMeta, event: AgentEvent): Promise<void> {
    if (event.type !== "tool_start") return;

    const status = this.statusMessages.get(meta.eventId);
    if (!status) return;

    // Throttle updates to avoid Slack rate limits
    const now = Date.now();
    if (now - status.lastUpdate < STATUS_UPDATE_INTERVAL_MS) return;

    const label = toolLabel(event.name);
    try {
      await this.slackApi("chat.update", {
        channel: meta["channelId"] as string,
        ts: status.ts,
        text: `:hourglass_flowing_sand: ${label}...`,
      });
      status.lastUpdate = now;
    } catch (error) {
      console.warn("[channels/slack] status update failed:", error);
    }
  }

  async deliverReply(meta: WebhookMeta, reply: string): Promise<void> {
    const channelId = meta["channelId"] as string;
    const threadTs = meta["threadTs"] as string;
    const status = this.statusMessages.get(meta.eventId);
    const formatted = markdownToMrkdwn(reply);
    const chunks = splitMessage(formatted, SLACK_MAX_TEXT_LENGTH);

    if (status) {
      this.statusMessages.delete(meta.eventId);
      try {
        await this.slackApi("chat.update", {
          channel: channelId,
          ts: status.ts,
          text: chunks[0],
        });
        chunks.shift();
      } catch (error) {
        console.warn("[channels/slack] status→reply update failed, posting new message:", error);
      }
    }

    for (const chunk of chunks) {
      await this.slackApi("chat.postMessage", {
        channel: channelId,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private async slackApi(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { ok: boolean; error?: string; ts?: string };
    if (!data.ok) {
      throw new Error(`Slack API ${method} failed: ${data.error ?? "unknown error"}`);
    }
    return data;
  }
}

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Tries to break at newline boundaries to avoid splitting mid-line.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit to break cleanly
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      // No newline found; hard-break at the limit
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}
