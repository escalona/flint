# Flint

Flint is a self-hosted gateway for coding agents, powered by the harnesses you already use: Claude, Pi, and Codex.

## What You Can Do

| Goal                                                  | Start here                                            | Result                                                    |
| ----------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Chat with an agent in your terminal                   | `apps/tui` + `packages/claude-app-server`             | Interactive threads for day-to-day tasks                  |
| Add agent workflows to apps                           | `apps/gateway`                                        | HTTP endpoints for thread create/resume + turns           |
| Build custom product integrations                     | `packages/sdk`                                        | Programmatic app-server and gateway clients               |
| Pick your coding harness (`Claude`, `Pi`, or `Codex`) | `packages/sdk` providers + app servers in `packages/` | Same Flint thread model across different harness runtimes |

## Getting Started (Published Packages)

Prerequisite: [Bun](https://bun.sh) installed.

1. Check the CLI:

```bash
npx @flint-dev/cli --help
```

2. Chat with Flint in your terminal:

```bash
ANTHROPIC_API_KEY=... npx @flint-dev/cli tui
```

3. Run the HTTP gateway (in a second terminal):

```bash
npx @flint-dev/cli gateway
```

4. Verify the gateway is up:

```bash
curl http://127.0.0.1:8788/v1/health
```

5. Optional: run app servers directly:

```bash
npx @flint-dev/cli app-server
npx @flint-dev/cli pi-app-server
```

Note: when gateway MCP profile server config references a missing env var (for example
`${LINEAR_API_KEY}`), Flint logs a warning and skips that MCP server instead of failing startup.

## Quick Start (From Source)

```bash
bun install
ANTHROPIC_API_KEY=... bun run flint tui
```

Other common entrypoints:

```bash
bun run flint app-server
bun run flint pi-app-server
bun run flint gateway
bun run flint cloudflare-sandbox:dev
```

Optional: link `flint` as a local command while developing:

```bash
bun link
flint --help
```

## Repository Layout

```text
apps/
  tui/                  Terminal UI client
  gateway/              HTTP gateway app
  cloudflare-sandbox/   Cloudflare Worker sandbox app
packages/
  flint/                Publishable CLI entrypoint (`flint`)
  claude-app-server/    Claude app server (JSON-RPC over stdio)
  pi-app-server/        Provider-integrated app server
  sdk/                  TypeScript client SDK
```

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
```

## Environment

- `ANTHROPIC_API_KEY` for Claude-backed runs.
- `FLINT_PROJECT` optional working directory override for the TUI.
- `FLINT_APP_SERVER_COMMAND` override TUI app server command (default `claude-app-server`).
- `FLINT_APP_SERVER_ARGS` optional space-delimited args forwarded by TUI.

## Status

Early-stage: core infra works end-to-end, but interfaces are still evolving.

## License

MIT
