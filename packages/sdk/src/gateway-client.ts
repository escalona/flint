export type GatewayRoutingMode =
  | "main"
  | "per-peer"
  | "per-channel-peer"
  | "per-account-channel-peer";

export type GatewayChatType = "direct" | "group" | "channel";

export interface GatewayHealth {
  ok: boolean;
  provider: string;
  defaultRoutingMode: GatewayRoutingMode;
}

export interface GatewayThreadRecord {
  threadId: string;
  routingMode: GatewayRoutingMode;
  provider: string;
  mcpProfileIds?: string[];
  channel: string;
  userId: string;
  chatType: GatewayChatType;
  peerId: string;
  accountId?: string;
  identityId?: string;
  channelThreadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayCreateThreadRequest {
  channel: string;
  userId: string;
  text: string;
  mcpProfileIds?: string[];
  provider?: string;
  chatType?: GatewayChatType;
  peerId?: string;
  accountId?: string;
  identityId?: string;
  channelThreadId?: string;
  routingMode?: GatewayRoutingMode;
  idempotencyKey?: string;
}

export interface GatewaySendThreadRequest {
  text: string;
  idempotencyKey?: string;
}

export interface GatewayReply {
  threadId: string;
  routingMode: GatewayRoutingMode;
  provider: string;
  reply: string;
  durationMs?: number;
  idempotencyKey?: string;
  cached?: boolean;
}

export interface GatewayClientOptions {
  baseUrl: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: typeof fetch;
}

export class GatewayHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const errorMessage =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Gateway request failed with status ${status}`;
    super(errorMessage);
    this.name = "GatewayHttpError";
    this.status = status;
    this.body = body;
  }
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Headers;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!this.baseUrl) {
      throw new Error("GatewayClient requires a non-empty baseUrl.");
    }
    this.defaultHeaders = new Headers(options.headers);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<GatewayHealth> {
    return this.requestJson<GatewayHealth>("GET", "/v1/health");
  }

  async listThreads(): Promise<GatewayThreadRecord[]> {
    const result = await this.requestJson<{ data: GatewayThreadRecord[] }>("GET", "/v1/threads");
    return result.data;
  }

  async getThread(threadId: string): Promise<GatewayThreadRecord | undefined> {
    const response = await this.request("GET", `/v1/threads/${encodeURIComponent(threadId)}`);
    if (response.status === 404) {
      return undefined;
    }
    return this.unwrapData<GatewayThreadRecord>(response);
  }

  async createThread(
    payload: GatewayCreateThreadRequest,
    idempotencyKey?: string,
  ): Promise<GatewayReply> {
    return this.requestJson<GatewayReply>("POST", "/v1/threads", payload, idempotencyKey);
  }

  async sendThreadMessage(
    threadId: string,
    payload: GatewaySendThreadRequest | string,
    idempotencyKey?: string,
  ): Promise<GatewayReply> {
    const body = typeof payload === "string" ? { text: payload } : payload;
    return this.requestJson<GatewayReply>(
      "POST",
      `/v1/threads/${encodeURIComponent(threadId)}`,
      body,
      idempotencyKey,
    );
  }

  async createThreadStream(
    payload: GatewayCreateThreadRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.request("POST", "/v1/threads", {
      body: payload,
      accept: "text/event-stream",
      signal,
    });
    if (!response.ok) throw await this.buildHttpError(response);
    return response;
  }

  async sendThreadMessageStream(
    threadId: string,
    payload: GatewaySendThreadRequest | string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const body = typeof payload === "string" ? { text: payload } : payload;
    const response = await this.request("POST", `/v1/threads/${encodeURIComponent(threadId)}`, {
      body,
      accept: "text/event-stream",
      signal,
    });
    if (!response.ok) throw await this.buildHttpError(response);
    return response;
  }

  async interruptThread(threadId: string): Promise<boolean> {
    const response = await this.request(
      "POST",
      `/v1/threads/${encodeURIComponent(threadId)}/interrupt`,
    );
    if (response.status === 409) {
      return false;
    }
    const result = await this.parseJsonOrThrow<{ interrupted: boolean }>(response);
    return result.interrupted;
  }

  private async unwrapData<T>(response: Response): Promise<T> {
    const parsed = await this.parseJsonOrThrow<{ data?: T }>(response);
    if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
      throw new Error("Gateway response is missing data.");
    }
    return parsed.data as T;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.request(method, path, { body, idempotencyKey });
    return this.parseJsonOrThrow<T>(response);
  }

  private async parseJsonOrThrow<T>(response: Response): Promise<T> {
    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      throw new GatewayHttpError(response.status, parsed);
    }
    return parsed as T;
  }

  private async buildHttpError(response: Response): Promise<GatewayHttpError> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return new GatewayHttpError(response.status, parsed);
  }

  private request(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      idempotencyKey?: string;
      accept?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const headers = new Headers(this.defaultHeaders);
    if (options?.idempotencyKey?.trim()) {
      headers.set("idempotency-key", options.idempotencyKey.trim());
    }
    if (options?.accept) {
      headers.set("accept", options.accept);
    }

    const requestInit: RequestInit = {
      method,
      headers,
      signal: options?.signal,
    };

    if (options?.body !== undefined) {
      headers.set("content-type", "application/json");
      requestInit.body = JSON.stringify(options.body);
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, requestInit);
  }
}
