# @flint-dev/gateway

HTTP gateway prototype for routing normalized channel messages into Flint app servers.

## What It Does

- Starts/resumes threads and runs turns over HTTP (`POST /v1/threads`)
- Resolves each create request to a deterministic thread ID (`main`, `per-peer`, `per-channel-peer`, `per-account-channel-peer`)
- Serializes work per thread (queue) to avoid overlapping turns
- Persists thread records to disk (`~/.flint/gateway/threads.json`)
- Uses `@flint-dev/sdk` providers (`claude`, `pi`, `codex`, or registered custom providers)
- Supports idempotency keys with in-flight dedupe and replay cache
- Applies session lifecycle policies (daily reset, optional idle reset, per-type/per-channel overrides)
- Applies configurable Codex execution defaults (approval policy + sandbox mode)
- Supports in-band reset triggers (`/new`, `/reset`, plus configured extras)
- Appends memory recall guidance and `MEMORY.md`/`memory.md` contents to provider system/developer instructions
- Exposes model-callable memory MCP tools (`memory_search`, `memory_get`)

## Run

From repo root:

```sh
ANTHROPIC_API_KEY=... bun run gateway
```

Optional env vars:

- `PORT` (default: `8788`)
- `FLINT_GATEWAY_CWD` (default: current working directory)
- `FLINT_GATEWAY_MODEL` (optional model override)
- `FLINT_GATEWAY_PROVIDER` (default: `claude`)
- `FLINT_GATEWAY_ROUTING_MODE` (`main` | `per-peer` | `per-channel-peer` | `per-account-channel-peer`, default: `per-peer`)
- `FLINT_GATEWAY_STORE_PATH` (default: `~/.flint/gateway/threads.json`)
- `FLINT_GATEWAY_IDENTITY_LINKS` (optional JSON map for cross-channel identity collapse)
- `FLINT_GATEWAY_IDEMPOTENCY_TTL_MS` (default: `300000`)
- `FLINT_GATEWAY_IDLE_TIMEOUT_SECONDS` (default: `120`)
- `FLINT_GATEWAY_USER_SETTINGS_PATH` (optional override; default: `~/.flint/settings.json`)
- `FLINT_GATEWAY_MEMORY_ENABLED` (default: `true`)

## API

### `GET /v1/health`

Health/status check.

### `GET /v1/threads`

Lists persisted thread records.

### `GET /v1/threads/:threadId`

Returns one persisted thread record.

### `POST /v1/threads`

Starts or resumes a thread (derived from routing fields) and runs one turn.

Request body:

```json
{
  "channel": "telegram",
  "userId": "1234",
  "provider": "pi",
  "mcpProfileIds": ["linear-readonly"],
  "chatType": "direct",
  "peerId": "1234",
  "accountId": "work",
  "text": "Summarize today's TODOs",
  "identityId": "nader",
  "channelThreadId": "thread-42",
  "routingMode": "per-account-channel-peer",
  "idempotencyKey": "msg-3ef476"
}
```

Response:

```json
{
  "threadId": "agent:main:telegram:work:direct:nader:thread:thread-42",
  "routingMode": "per-account-channel-peer",
  "provider": "pi",
  "reply": "...",
  "idempotencyKey": "msg-3ef476"
}
```

Optional: send `Idempotency-Key` HTTP header instead of body `idempotencyKey`.

Gateway resolves `mcpProfileIds` to server-side MCP configs and forwards those to provider app servers on thread create/resume.
When memory is enabled, gateway also injects a built-in stdio MCP server that exposes `memory_search` and `memory_get`.
When memory is enabled, gateway also loads root memory context from `MEMORY.md` (fallback `memory.md`) and appends it to provider system/developer instructions.
When `mcpProfileIds` is omitted in a request, gateway falls back to `gateway.defaultMcpProfileIds` from settings.
If message text starts with exact `/new` or `/reset` (or configured `gateway.session.resetTriggers`), the gateway starts a fresh provider session and forwards the remaining text. `/new <model-or-provider>` updates the next session model/provider before running the next turn. A bare reset command runs a short greeting turn.
Gateway does not run a memory-flush turn on `/new` or `/reset`.

### `settings.json` example

```json
{
  "gateway": {
    "defaultMcpProfileIds": ["support-stack"],
    "mcpProfiles": {
      "linear-readonly": {
        "servers": {
          "linear": {
            "type": "http",
            "url": "${LINEAR_MCP_URL}",
            "headers": {
              "Authorization": "Bearer ${LINEAR_API_TOKEN}"
            }
          }
        }
      },
      "support-stack": {
        "profiles": ["linear-readonly"]
      }
    },
    "session": {
      "reset": {
        "mode": "daily",
        "atHour": 4,
        "idleMinutes": 120
      },
      "resetByType": {
        "direct": {
          "mode": "idle",
          "idleMinutes": 240
        },
        "thread": {
          "mode": "daily",
          "atHour": 4
        }
      },
      "resetByChannel": {
        "discord": {
          "mode": "idle",
          "idleMinutes": 10080
        }
      },
      "resetTriggers": ["/new", "/reset"],
      "greetingPrompt": "This session was reset. Greet briefly and ask what to work on next."
    },
    "codex": {
      "approvalPolicy": "on-request",
      "sandboxMode": "workspace-write"
    }
  }
}
```

Session lifecycle defaults:

- Default reset policy is daily at 4:00 AM (gateway host local time).
- If only `gateway.session.idleMinutes` is set (without `reset`/`resetByType`/`resetByChannel`), gateway uses legacy idle-only mode.
- When both daily and idle are configured, whichever expires first forces a fresh provider session.
- Channel overrides (`resetByChannel`) take precedence over type overrides (`resetByType`) and base `reset`.

Codex execution defaults:

- Applies only when provider is `codex`.
- Default `approvalPolicy` is `on-request`.
- Default `sandboxMode` is `workspace-write`.
- Override in `settings.gateway.codex` with:
  - `approvalPolicy`: `untrusted` | `on-failure` | `on-request` | `never`
  - `sandboxMode`: `read-only` | `workspace-write` | `danger-full-access`

Config loading:

- user settings (`~/.flint/settings.json`)

Env var substitution in any config string value:

- `${VAR_NAME}` where `VAR_NAME` matches `[A-Z_][A-Z0-9_]*`
- Missing or empty vars throw at startup
- Escape with `$${VAR_NAME}` for a literal `${VAR_NAME}`
- Inline substitution is supported (`"${BASE_URL}/mcp"`)

Raw `mcpServers` in request payloads are intentionally rejected.

### `POST /v1/threads/:threadId`

Runs another turn in an existing thread.

Request body:

```json
{
  "text": "Continue from the last answer",
  "idempotencyKey": "msg-3ef477"
}
```

### `POST /v1/threads/:threadId/interrupt`

Requests interruption for an in-flight turn for that thread.
