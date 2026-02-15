export type RoutingMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type ChatType = "direct" | "group" | "channel";

export interface InboundMessage {
  channel: string;
  userId: string;
  text: string;
  mcpProfileIds?: string[];
  provider?: string;
  chatType?: ChatType;
  peerId?: string;
  accountId?: string;
  identityId?: string;
  channelThreadId?: string;
  routingMode?: RoutingMode;
  idempotencyKey?: string;
}

export interface GatewayReply {
  threadId: string;
  routingMode: RoutingMode;
  provider: string;
  reply: string;
}
