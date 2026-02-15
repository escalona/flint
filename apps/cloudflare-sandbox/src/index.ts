import { getSandbox, Sandbox, type Process, type SandboxOptions } from "@cloudflare/sandbox";

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  FLINT_EDGE_TOKEN?: string;
  FLINT_SANDBOX_SLEEP_AFTER?: string;
  FLINT_GATEWAY_PORT?: string;
  FLINT_GATEWAY_STARTUP_TIMEOUT_MS?: string;
  FLINT_GATEWAY_PROVIDER?: string;
  FLINT_GATEWAY_MODEL?: string;
  FLINT_GATEWAY_ROUTING_MODE?: string;
  FLINT_GATEWAY_STORE_PATH?: string;
  FLINT_GATEWAY_CWD?: string;
  FLINT_GATEWAY_IDENTITY_LINKS?: string;
  FLINT_GATEWAY_IDEMPOTENCY_TTL_MS?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  PI_APP_SERVER_COMMAND?: string;
  PI_APP_SERVER_ARGS?: string;
}

const SERVICE_NAME = "@flint-dev/cloudflare-sandbox";
const SANDBOX_ID = "flint-gateway";
const DEFAULT_GATEWAY_PORT = 8788;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const GATEWAY_START_COMMAND = "/usr/local/bin/start-flint-gateway.sh";

const forwardedEnvKeys = [
  "FLINT_GATEWAY_PROVIDER",
  "FLINT_GATEWAY_MODEL",
  "FLINT_GATEWAY_ROUTING_MODE",
  "FLINT_GATEWAY_STORE_PATH",
  "FLINT_GATEWAY_CWD",
  "FLINT_GATEWAY_IDENTITY_LINKS",
  "FLINT_GATEWAY_IDEMPOTENCY_TTL_MS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "PI_APP_SERVER_COMMAND",
  "PI_APP_SERVER_ARGS",
] as const satisfies ReadonlyArray<keyof Env>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.floor(parsed);
  if (integer < 1) return fallback;
  return integer;
}

function getGatewayPort(env: Env): number {
  const port = parsePositiveInteger(env.FLINT_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
  if (port > 65535) return DEFAULT_GATEWAY_PORT;
  return port;
}

function getStartupTimeoutMs(env: Env): number {
  return parsePositiveInteger(env.FLINT_GATEWAY_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);
}

function buildSandboxOptions(env: Env): SandboxOptions {
  const sleepAfter = (env.FLINT_SANDBOX_SLEEP_AFTER ?? "never").trim().toLowerCase();
  if (!sleepAfter || sleepAfter === "never") {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

function parseBearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token || undefined;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.FLINT_EDGE_TOKEN?.trim();
  if (!expected) return true;
  const provided =
    parseBearerToken(request.headers.get("authorization")) ??
    request.headers.get("x-flint-edge-token")?.trim();
  return provided === expected;
}

function buildGatewayEnv(env: Env, port: number): Record<string, string> {
  const output: Record<string, string> = {
    PORT: String(port),
    FLINT_GATEWAY_PORT: String(port),
  };

  for (const key of forwardedEnvKeys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      output[key] = value.trim();
    }
  }

  return output;
}

function isGatewayProcessCommand(command: string): boolean {
  return (
    command.includes("start-flint-gateway.sh") || command.includes("apps/gateway/src/index.ts")
  );
}

async function findGatewayProcess(sandbox: Sandbox): Promise<Process | null> {
  const processes = await sandbox.listProcesses();
  for (const process of processes) {
    if (!isGatewayProcessCommand(process.command)) continue;
    if (process.status === "running" || process.status === "starting") {
      return process;
    }
  }
  return null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function ensureGatewayRunning(sandbox: Sandbox, env: Env): Promise<Process> {
  const port = getGatewayPort(env);
  const startupTimeoutMs = getStartupTimeoutMs(env);

  const existing = await findGatewayProcess(sandbox);
  if (existing) {
    try {
      await existing.waitForPort(port, { mode: "tcp", timeout: startupTimeoutMs });
      return existing;
    } catch {
      try {
        await existing.kill();
      } catch {}
    }
  }

  const process = await sandbox.startProcess(GATEWAY_START_COMMAND, {
    env: buildGatewayEnv(env, port),
  });

  try {
    await process.waitForPort(port, { mode: "tcp", timeout: startupTimeoutMs });
    return process;
  } catch (error) {
    const logs = await process.getLogs().catch(() => undefined);
    const stderr = logs?.stderr?.trim();
    throw new Error(stderr || formatError(error));
  }
}

function rewritePath(request: Request, pathname: string): Request {
  const nextUrl = new URL(request.url);
  nextUrl.pathname = pathname;
  return new Request(nextUrl.toString(), request);
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const port = getGatewayPort(env);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, buildSandboxOptions(env));

    if (request.method === "GET" && url.pathname === "/healthz") {
      const process = await findGatewayProcess(sandbox).catch(() => null);
      return json(200, {
        ok: true,
        service: SERVICE_NAME,
        gatewayPort: port,
        gatewayRunning: process !== null,
      });
    }

    if (!isAuthorized(request, env)) {
      return json(401, {
        error: "Unauthorized.",
        details: "Provide FLINT_EDGE_TOKEN as Bearer token or x-flint-edge-token header.",
      });
    }

    if (request.method === "GET" && url.pathname === "/sandbox/status") {
      const process = await findGatewayProcess(sandbox).catch(() => null);
      return json(200, {
        ok: true,
        gatewayPort: port,
        process: process
          ? {
              id: process.id,
              status: process.status,
              command: process.command,
            }
          : null,
      });
    }

    try {
      await ensureGatewayRunning(sandbox, env);
    } catch (error) {
      return json(503, {
        error: "Gateway unavailable.",
        details: formatError(error),
      });
    }

    if (request.method === "GET" && url.pathname === "/gateway/health") {
      const rewritten = rewritePath(request, "/v1/health");
      return sandbox.containerFetch(rewritten, port);
    }

    if (isWebSocketRequest(request)) {
      return sandbox.wsConnect(request, port);
    }

    return sandbox.containerFetch(request, port);
  },
};
