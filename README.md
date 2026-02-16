# Flint

Self-hosted infrastructure for embedding AI coding agents into your apps.

## What Flint Does

Flint gives you an HTTP gateway and TypeScript SDK to add AI coding agents to your own products. It handles thread management, tool execution, streaming, and provider abstraction — so you can embed a coding agent over a single HTTP call or a few lines of TypeScript.

## Use Cases

- **Slack bot** — Point Slack webhooks at the gateway, get a coding agent in your workspace
- **Internal tools** — Add agent-powered endpoints to dashboards or admin panels
- **CI/CD** — Trigger code review or generation from your pipeline via HTTP
- **Custom UIs** — Build your own chat interface using the SDK's event stream

## Quick Start

### Install

```bash
npm install -g @flint-dev/cli
```

### Try the TUI

```bash
ANTHROPIC_API_KEY=sk-ant-... flint tui
```

This opens a terminal chat where you can interact with a Claude-powered coding agent.

### Start the gateway

```bash
ANTHROPIC_API_KEY=sk-ant-... flint gateway
```

The gateway starts an HTTP server on port `8788` (override with `PORT`). You can then create threads and send messages via the REST API.

### From source

```bash
bun install
ANTHROPIC_API_KEY=sk-ant-... bun run flint tui
ANTHROPIC_API_KEY=sk-ant-... bun run flint gateway
```

## Architecture

```
Your App ──HTTP──→ Gateway ──stdio──→ App Server ──→ Claude / Pi / Codex
                      │                    │
                   Threads              Agent SDK
                   Routing              Tool Exec
                   Webhooks             Streaming

Terminal ──SDK──→ App Server ──→ Claude / Pi / Codex
  (TUI)
```

| Component      | What it does                                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| **Gateway**    | HTTP server that manages agent threads, routes messages, handles webhooks         |
| **App Server** | JSON-RPC process that wraps the Claude Agent SDK, executes tools, streams events  |
| **SDK**        | TypeScript client library — `AppServerClient` for local, `GatewayClient` for HTTP |
| **TUI**        | Terminal interface for testing and demos                                          |

## Gateway API

The gateway exposes a REST API for managing agent threads:

```
POST   /v1/threads                  Create thread + send first message
POST   /v1/threads/:id              Send message to existing thread
GET    /v1/threads                  List threads
GET    /v1/threads/:id              Get thread details
POST   /v1/threads/:id/interrupt    Interrupt a running turn
GET    /v1/health                   Health check
POST   /webhooks/:channel           Inbound webhooks (Slack, etc.)
```

## SDK Usage

### Local (stdio)

Spawn an app server as a child process and communicate over JSON-RPC:

```typescript
import { AppServerClient } from "@flint/sdk";

const client = new AppServerClient({
  command: "claude-app-server",
  cwd: "/path/to/project",
});

await client.start();
const threadId = await client.createThread({ model: "claude-sonnet-4-5-20250929" });

for await (const event of client.prompt("Refactor the auth module")) {
  // event.type: "text" | "reasoning" | "tool_start" | "tool_end" | "done" | "error"
}
```

### Remote (HTTP)

Talk to a running gateway over HTTP:

```typescript
import { GatewayClient } from "@flint/sdk";

const client = new GatewayClient({ baseUrl: "http://localhost:8788" });

const reply = await client.createThread({ message: "Fix the failing tests" });
const threads = await client.listThreads();
```

## Repository Layout

```
apps/
  tui/                    Terminal UI client
  gateway/                HTTP gateway server
  cloudflare-sandbox/     Cloudflare Workers deployment
  inspector/              Inspector tool
packages/
  sdk/                    TypeScript client SDK
  claude-app-server/      Claude app server (JSON-RPC over stdio)
  pi-app-server/          Pi app server variant
  app-server-core/        Shared app server utilities
  channels/               Channel adapters (Slack)
  flint/                  Publishable CLI entrypoint
```

## Commands

```bash
bun run flint tui              # Terminal UI (demo/playground)
bun run flint gateway          # HTTP gateway server
bun run flint app-server       # Claude app server standalone
bun run flint pi-app-server    # Pi app server standalone
```

## Environment Variables

| Variable                     | Description                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Required for Claude-backed runs                                                    |
| `PORT`                       | Gateway port (default: `8788`)                                                     |
| `FLINT_PROJECT`              | Working directory override for the TUI                                             |
| `FLINT_APP_SERVER_COMMAND`   | Override TUI app server command (default: `claude-app-server`)                     |
| `FLINT_APP_SERVER_ARGS`      | Space-delimited args forwarded by TUI                                              |
| `FLINT_GATEWAY_PROVIDER`     | Provider name (default: `claude`)                                                  |
| `FLINT_GATEWAY_MODEL`        | Model override                                                                     |
| `FLINT_GATEWAY_CWD`          | Gateway working directory                                                          |
| `FLINT_GATEWAY_ROUTING_MODE` | Thread routing: `main`, `per-peer`, `per-channel-peer`, `per-account-channel-peer` |
| `SLACK_BOT_TOKEN`            | Slack bot token for channel adapter                                                |
| `SLACK_SIGNING_SECRET`       | Slack webhook verification secret                                                  |

## Development

```bash
bun install
bun run typecheck    # Type-check all packages
bun run lint         # Lint (oxlint)
bun test             # Run tests
```

## Status

Early-stage: core infra works end-to-end, but interfaces are still evolving.

## License

MIT
