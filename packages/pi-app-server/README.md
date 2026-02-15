# @flint-dev/pi-app-server

pi-backed app server for Flint. It implements the Codex-style app server protocol (JSON-RPC over stdio) and translates pi coding-agent RPC events into protocol notifications.

## Requirements

- Bun
- `pi` CLI available on `PATH` (or set `PI_APP_SERVER_COMMAND`)

Optional command override:

- `PI_APP_SERVER_COMMAND`: executable to launch instead of `pi`
- `PI_APP_SERVER_ARGS`: extra args prepended before app-server-managed args

## Run

From repo root:

```sh
bun run pi-app-server
```
