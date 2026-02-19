# @flint-dev/sdk

Client library for Flint app servers and the Flint gateway.

It includes:

- `AppServerClient` / `createClient(...)` for Codex-style app server protocol over stdio.
- `GatewayClient` for HTTP calls to the Flint gateway (`/v1/threads` APIs).

## Install

```bash
bun add @flint-dev/sdk
```

Then install the app server for the provider you want to use:

```bash
bun add @flint-dev/claude-app-server  # Claude (Anthropic)
bun add @flint-dev/pi-app-server      # Pi (multi-provider)
```

## Quick start (app server)

```ts
import { createClient } from "@flint-dev/sdk";

const client = createClient({ provider: "claude", cwd: process.cwd() });
await client.start();
await client.createThread();

for await (const event of client.prompt("Explain this codebase")) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "tool_start":
      console.log(`\n[${event.name}]`);
      break;
    case "tool_end":
      console.log(event.isError ? "[failed]" : "[done]");
      break;
    case "error":
      console.error(event.message);
      break;
  }
}

client.close();
```

## Quick start (gateway HTTP)

```ts
import { GatewayClient } from "@flint-dev/sdk";

const gateway = new GatewayClient({ baseUrl: "http://127.0.0.1:8788" });

const created = await gateway.createThread({
  channel: "slack",
  userId: "u1",
  text: "Summarize the backlog",
});

const followup = await gateway.sendThreadMessage(created.threadId, "Now draft next steps");
console.log(followup.reply);
```

## Providers

A provider resolves to the command and arguments needed to spawn an app server. Three are built in:

| Name       | App server                         | Default model             |
| ---------- | ---------------------------------- | ------------------------- |
| `"claude"` | `@flint-dev/claude-app-server`     | `claude-opus-4-6`         |
| `"pi"`     | `@flint-dev/pi-app-server`         | `google/gemini-2.5-flash` |
| `"codex"`  | `codex app-server` (system binary) | —                         |

```ts
// Use a built-in provider
const client = createClient({ provider: "pi", cwd: process.cwd() });
```

### Custom providers

Register your own provider to point at any Codex-protocol-compatible server:

```ts
import { registerProvider, createClient } from "@flint-dev/sdk";

registerProvider("my-server", {
  resolve(config) {
    return {
      command: "my-app-server",
      args: ["--cwd", config.cwd],
      cwd: config.cwd,
      env: config.env,
    };
  },
});

const client = createClient({ provider: "my-server", cwd: process.cwd() });
```

### Manual configuration

Skip providers entirely and pass spawn options directly:

```ts
import { AppServerClient } from "@flint-dev/sdk";

const client = new AppServerClient({
  command: "bun",
  args: ["run", "./my-server/index.ts"],
  cwd: process.cwd(),
  env: { MY_API_KEY: "..." },
});
```

## API

### `createClient(options): AppServerClient`

Factory that resolves a provider name to spawn configuration.

```ts
type CreateClientOptions =
  | { provider: string; cwd: string; env?: Record<string, string> }
  | AppServerClientOptions;
```

### `AppServerClient`

#### `new AppServerClient(options)`

```ts
interface AppServerClientOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}
```

#### `client.start(): Promise<void>`

Spawns the app server process and sends the `initialize` handshake.

#### `client.createThread(options?): Promise<string>`

Creates a new conversation thread. Returns the thread ID.

```ts
interface CreateThreadOptions {
  model?: string;
  // Codex-only
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
}
```

For provider `"codex"`, these map to app-server `thread/start` as `approvalPolicy` and `sandbox`.

#### `client.prompt(text, options?): AsyncGenerator<AgentEvent>`

Sends a prompt and yields events as they stream back. Automatically creates a thread if one hasn't been created yet.

```ts
interface PromptOptions {
  model?: string;
}
```

#### `client.interrupt(): Promise<void>`

Interrupts the current turn.

#### `client.close(): void`

Kills the app server process.

### `GatewayClient`

```ts
new GatewayClient({
  baseUrl: string,
  headers?: HeadersInit,
  fetch?: typeof fetch,
});
```

#### `gateway.health(): Promise<GatewayHealth>`

Calls `GET /v1/health`.

#### `gateway.listThreads(): Promise<GatewayThreadRecord[]>`

Calls `GET /v1/threads`.

#### `gateway.getThread(threadId): Promise<GatewayThreadRecord | undefined>`

Calls `GET /v1/threads/:threadId`. Returns `undefined` on 404.

#### `gateway.createThread(payload, idempotencyKey?): Promise<GatewayReply>`

Calls `POST /v1/threads`.

#### `gateway.sendThreadMessage(threadId, payloadOrText, idempotencyKey?): Promise<GatewayReply>`

Calls `POST /v1/threads/:threadId`.

#### `gateway.interruptThread(threadId): Promise<boolean>`

Calls `POST /v1/threads/:threadId/interrupt`. Returns `false` when gateway reports no active runtime (`409`).

#### `GatewayHttpError`

Thrown for non-2xx responses (except handled `404`/`409` cases above). Includes:

- `status`: HTTP status code
- `body`: parsed JSON response body when available

### `AgentEvent`

```ts
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_end"; id: string; result?: unknown; isError: boolean }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string };
```

| Event        | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `text`       | Streamed text token from the agent                                 |
| `reasoning`  | Streamed reasoning/thinking token                                  |
| `tool_start` | Agent began using a tool (`Bash`, `Edit`, `Write`, or an MCP tool) |
| `tool_end`   | Tool execution finished                                            |
| `done`       | Turn completed                                                     |
| `error`      | Turn failed                                                        |

## Local development

To use the SDK from a local checkout of the flint repo without publishing to npm:

### bun link

Symlinks packages globally, then into your project. Best for active development since changes are reflected immediately.

```bash
# Register the packages (run once from the flint repo)
cd packages/sdk && bun link
cd packages/claude-app-server && bun link    # if using Claude
cd packages/pi-app-server && bun link       # if using Pi

# Link them into your project
cd ~/my-app
bun link @flint-dev/sdk
bun link @flint-dev/claude-app-server           # or @flint-dev/pi-app-server
```

### file: dependencies

Point at the local packages directly in your `package.json`:

```json
{
  "dependencies": {
    "@flint-dev/sdk": "file:../flint/packages/sdk",
    "@flint-dev/claude-app-server": "file:../flint/packages/claude-app-server"
  }
}
```

Then run `bun install`.

### bun pack

Creates a tarball, which is the closest to what `npm publish` actually produces. Useful for verifying the package is correctly configured before publishing.

```bash
cd packages/sdk && bun pack
# => flint-sdk-0.1.0.tgz

cd ~/my-app
bun add ../flint/packages/sdk/flint-sdk-0.1.0.tgz
```

## Requirements

- [Bun](https://bun.sh) runtime
