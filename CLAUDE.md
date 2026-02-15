# CLAUDE.md

## Project

Flint is an agent platform built with Bun and TypeScript. It uses the Codex App Server protocol (JSON-RPC 2.0 over stdio) to run AI coding agents.

## Architecture

The TUI spawns the Claude app server as a child process. Communication is over stdio using JSON-RPC 2.0. The app server wraps `@anthropic-ai/claude-agent-sdk` and translates to the Codex protocol.

```
TUI → AppServerClient (stdio JSON-RPC) → App Server → Claude Agent SDK
```

### Packages

- `packages/claude-app-server/` — Claude app server (`@flint-dev/claude-app-server`). Codex protocol over stdio. Persists threads as JSONL rollouts in `~/.flint/claude-app-server/threads/`.
- `packages/sdk/` — Client library (`@flint/sdk`). `AppServerClient` spawns app server and translates notifications to `AgentEvent`.
- `packages/pi-app-server/` — Provider-integrated app server variant (`@flint/pi-app-server`).
- `packages/channels/` — Channel adapters (`@flint/channels`). Slack integration for the gateway. Webhook verification, event parsing, and reply delivery.
- `apps/tui/` — Terminal UI. Uses `AppServerClient` from SDK. Built with `@mariozechner/pi-tui`.
- `apps/gateway/` — HTTP gateway for routing inbound requests to agent sessions. Runs on Cloudflare Workers.

### Key data flow

1. TUI submits prompt via `client.prompt(text)` which sends `turn/start` JSON-RPC
2. App server's processor routes to `thread.executeTurn()`
3. Thread calls Claude SDK `query()` and streams messages
4. Adapter translates SDK messages to Codex notifications (`item/started`, `item/delta`, `item/completed`, `turn/completed`)
5. `AppServerClient` translates notifications back to `AgentEvent` (`text`, `tool_start`, `tool_end`, `done`)
6. TUI's `ToolTracker` renders events

### Protocol mapping (App Server → AgentEvent)

- `item/delta` (text) → `{ type: "text", delta }`
- `item/delta` (reasoning) → `{ type: "reasoning", delta }`
- `item/started` (command_execution) → `{ type: "tool_start", name: "Bash" }`
- `item/started` (file_change, kind=add) → `{ type: "tool_start", name: "Write" }`
- `item/started` (file_change, kind=modify) → `{ type: "tool_start", name: "Edit" }`
- `item/started` (mcp_tool_call) → `{ type: "tool_start", name: toolName }`
- `item/completed` → `{ type: "tool_end" }`
- `turn/completed` → `{ type: "done" }`
- `turn/failed` → `{ type: "error" }`

## Commands

```bash
bun run tui              # Start the TUI
bun run app-server       # Run app server standalone
bun run typecheck        # Type check all packages (tsc --build)
bun run lint             # Lint (oxlint)
bun test                 # Run tests
bun run gateway          # Run gateway standalone
```

## Conventions

- Bun runtime, TypeScript, ESM
- Monorepo with `packages/*` and `apps/*` workspaces
- `tsconfig.base.json` at root, each package extends it with `composite: true`
- SDK package uses extensionless imports (`"./client"` not `"./client.ts"`) due to `allowImportingTsExtensions: false`
- App server package uses `.ts` extension imports
- `AgentEvent` is the shared event type between app server client and TUI
