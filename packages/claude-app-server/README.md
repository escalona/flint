# @flint-dev/claude-app-server

Claude-backed app server for Flint. It implements the Codex-style app server protocol (JSON-RPC 2.0 over stdio) and translates Claude Agent SDK events into protocol notifications.

## What This Package Does

- Accepts newline-delimited JSON-RPC requests on `stdin`
- Returns JSON-RPC responses on `stdout`
- Streams turn and item notifications on `stdout`
- Persists threads as JSONL rollouts under `~/.flint/claude-app-server/threads/`

This package is primarily spawned by the TUI/SDK as a child process, but it can also run standalone.

## Requirements

- Bun
- `ANTHROPIC_API_KEY` in environment

## Run

From the repo root:

```sh
bun run app-server
```

From this package directory:

```sh
bun run dev
```

## Protocol Basics

- Transport: one JSON message per line (`\n` delimited)
- Requests use JSON-RPC 2.0 (`jsonrpc`, `id`, `method`, `params`)
- Notifications have no `id` and do not expect a response
- `initialize` must be called before any other method

### Request Methods

| Method           | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `initialize`     | Initialize server with client metadata and default working directory |
| `thread/start`   | Create a thread                                                      |
| `thread/resume`  | Load a thread and its turns                                          |
| `thread/list`    | List threads with optional status/limit/offset                       |
| `thread/archive` | Mark a thread as archived                                            |
| `thread/delete`  | Delete a thread from storage                                         |
| `turn/start`     | Start a turn and stream notifications asynchronously                 |
| `turn/interrupt` | Interrupt an active turn                                             |
| `model/list`     | List available Claude models                                         |
| `config/read`    | Read active server config                                            |

### Streaming Notifications

| Notification                      | Description                     |
| --------------------------------- | ------------------------------- |
| `turn/started`                    | Turn started                    |
| `turn/completed`                  | Turn completed with token usage |
| `turn/failed`                     | Turn failed                     |
| `item/started`                    | Tool/item execution started     |
| `item/delta`                      | Streaming text/reasoning chunks |
| `item/completed`                  | Tool/item execution completed   |
| `item/commandExecution/started`   | Command execution started       |
| `item/commandExecution/completed` | Command execution completed     |
| `item/fileChange/started`         | File change started             |
| `item/fileChange/completed`       | File change completed           |

## Minimal Request Example

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client_name":"demo","client_version":"0.1.0","working_directory":"/tmp"}}
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"working_directory":"/tmp","title":"Demo"}}
```

After `thread/start`, use the returned `thread.id` for `turn/start`.

## Models

Current built-in model IDs:

- `claude-opus-4-5-20251101`
- `claude-sonnet-4-20250514`
- `claude-haiku-4-5`

## Development

From `packages/claude-app-server`:

```sh
bun run typecheck
bun run test
```

From repo root (cross-workspace checks):

```sh
bun run typecheck
bun run lint
bun test
```
