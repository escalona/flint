# @flint-dev/cloudflare-sandbox

Cloudflare Worker + Sandbox container project that runs the Flint gateway (`apps/gateway`) as a long-lived process and proxies inbound requests to it.

## Architecture

- Worker entrypoint (`src/index.ts`) receives internet traffic.
- Worker ensures a sandbox container process is running (`start-flint-gateway.sh`).
- Container runs Flint gateway on an internal port (`8788` by default).
- Worker proxies HTTP and WebSocket requests into the container.

This gives a Cloudflare-native edge while preserving Flint's process-based SDK/app-server runtime.

## Files

- `src/index.ts`: Worker edge, process supervisor, proxy routes.
- `wrangler.jsonc`: Container + Durable Object wiring.
- `Dockerfile`: Builds runtime image with Bun + Flint workspace packages.
- `scripts/start-flint-gateway.sh`: Starts Flint gateway inside the container.

## Local Dev

From repo root:

```sh
bun install
bun run cloudflare-sandbox:dev
```

Or from this directory:

```sh
bun install
bun run dev
```

Use `.dev.vars` (copy from `.dev.vars.example`) for local secrets.

## Deploy

From repo root:

```sh
bun run cloudflare-sandbox:deploy
```

Or from this directory:

```sh
bun run deploy
```

## Required/Useful Environment Variables

- `ANTHROPIC_API_KEY` (if using Claude provider)
- `OPENAI_API_KEY` (optional, if your provider stack needs it)
- `FLINT_GATEWAY_PROVIDER` (`claude` | `pi` | `codex`, default set by gateway)
- `FLINT_EDGE_TOKEN` (optional but recommended edge auth)
- `FLINT_SANDBOX_SLEEP_AFTER` (`never` by default; or `10m`, `1h`, etc)
- `FLINT_GATEWAY_MODEL` (optional)
- `FLINT_GATEWAY_ROUTING_MODE` (optional)
- `FLINT_GATEWAY_IDEMPOTENCY_TTL_MS` (optional)
- `FLINT_GATEWAY_IDENTITY_LINKS` (optional JSON map)

## HTTP Endpoints

- `GET /healthz`: Worker health + gateway-running flag.
- `GET /sandbox/status`: Process status for sandbox gateway runtime.
- `GET /gateway/health`: Proxied Flint gateway health check.
- `POST /v1/threads`: Proxied to Flint gateway (start/resume + first turn).
- `POST /v1/threads/:threadId`: Proxied to Flint gateway.
- `POST /v1/threads/:threadId/interrupt`: Proxied to Flint gateway.
- `GET /v1/threads`: Proxied to Flint gateway.

When `FLINT_EDGE_TOKEN` is set, all routes except `/healthz` require:

- `Authorization: Bearer <token>`, or
- `x-flint-edge-token: <token>`
