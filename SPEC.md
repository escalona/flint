# Flint Agent Harness Protocol

A portable, provider-agnostic protocol for coding agents. Based on the [Codex App Server protocol](https://developers.openai.com/codex/app-server/) with modifications for multi-provider support.

## Design Principles

1. **Codex-shaped, provider-agnostic.** The protocol follows the Codex App Server's structure (threads, turns, typed items, server-side tool execution) because it's the most complete model for coding agents. But it abstracts away provider-specific fields so the same client works against Claude, Codex, local models, etc.

2. **Server-side tool execution.** The agent runs tools (shell commands, file writes, MCP calls) and reports results to the client. The client renders them. This is the Codex model, and it's the right one for coding agents — the agent needs direct access to the filesystem and shell to work effectively. The client controls _policy_ (approval, sandboxing) not _execution_.

3. **Typed items for rich rendering.** ACP treats all tool calls as generic `ToolCall` objects with `kind` + `content`. This makes it hard for clients to render `commandExecution` differently from `fileChange` differently from `mcpToolCall`. Codex's typed item approach gives the client the structure it needs. We keep typed items.

4. **Config selectors for provider-specific features.** Instead of baking `personality`, `collaborationMode`, `reasoningEffort` into the protocol (which couples it to one provider), these are expressed as generic config selectors the agent advertises dynamically.

5. **Per-turn overrides for the common stuff.** Model, cwd, approval policy, and sandbox policy are common across all providers and change frequently enough to warrant per-turn params (matching Codex). Provider-specific config uses selectors.

## Transport

JSONL over stdio. Each message is a single line of JSON.

Like Codex, the `"jsonrpc": "2.0"` field is **omitted** on the wire to keep messages compact.

- **Requests** — `{ id, method, params }`
- **Responses** — `{ id, result }` or `{ id, error }`
- **Notifications** — `{ method, params }` (no `id`, no response)

---

## Protocol Lifecycle

```
Client                                    Agent
  │                                         │
  │──── initialize ────────────────────────>│
  │<─── { agentInfo, capabilities } ───────│
  │──── initialized ───────────────────────>│  (notification)
  │                                         │
  │──── thread/start { model, cwd } ──────>│
  │<─── { thread } ────────────────────────│
  │<──── thread/started ───────────────────│  (notification)
  │                                         │
  │──── turn/start { input, model? } ─────>│
  │<─── { turn } ──────────────────────────│
  │<──── turn/started ─────────────────────│  (notification)
  │<──── item/started { commandExec } ─────│
  │<──── item/commandExecution/outputDelta─│
  │<── item/commandExecution/requestApproval│  (server→client request)
  │──── { decision: "accept" } ───────────>│
  │<──── item/completed { commandExec } ───│
  │<──── item/started { agentMessage } ────│
  │<──── item/agentMessage/delta ──────────│
  │<──── item/completed { agentMessage } ──│
  │<──── turn/completed ───────────────────│  (notification)
  │                                         │
  │──── turn/interrupt ───────────────────>│
  │                                         │
  │──── config/set ───────────────────────>│  (config selectors)
  │                                         │
```

---

## 1. Initialization

### `initialize` (client → agent)

Must be the first message. Exactly once per connection.

```typescript
interface InitializeParams {
  clientInfo: {
    name: string;                     // e.g. "flint-tui", "flint-vscode"
    title?: string;                   // human-readable display name
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
  };
}

interface InitializeResult {
  agentInfo: {
    name: string;                     // e.g. "claude-agent", "codex-agent"
    version: string;
    provider: string;                 // e.g. "anthropic", "openai", "ollama"
  };
  capabilities: {
    streaming: boolean;
    configOptions: boolean;           // supports config/list, config/set
    reasoning: boolean;               // emits reasoning items
    plans: boolean;                   // emits plan items/updates
    review: boolean;                  // supports review/start
  };
}
```

### `initialized` (client → agent, notification)

Sent after receiving the `initialize` response to signal the client is ready.

```typescript
interface InitializedParams {}
```

---

## 2. Thread Management

Threads are persistent conversation containers. A thread has a model, working directory, and conversation history.

### `thread/start` (client → agent)

```typescript
interface ThreadStartParams {
  model?: string;                     // model ID from model/list
  cwd?: string;                       // absolute path to workspace
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxPolicy;
}

interface ThreadStartResult {
  thread: Thread;
  modelProvider: string;              // which provider is serving the model
}

interface Thread {
  id: string;
  preview: string;                    // short summary of conversation
  modelProvider: string;
  createdAt: number;                  // unix timestamp
}
```

### `thread/resume` (client → agent)

Resume an existing thread, replaying its history.

```typescript
interface ThreadResumeParams {
  threadId: string;
  // Optional overrides for the resumed thread
  model?: string;
  cwd?: string;
}

interface ThreadResumeResult {
  thread: Thread;
}
```

### `thread/list` (client → agent)

```typescript
interface ThreadListParams {
  cursor?: string;
  limit?: number;
  archived?: boolean;
}

interface ThreadListResult {
  data: Thread[];
  nextCursor?: string;
}
```

### `thread/archive` (client → agent)

```typescript
interface ThreadArchiveParams {
  threadId: string;
}
```

### `thread/started` (agent → client, notification)

Emitted after a thread is created or resumed.

```typescript
interface ThreadStartedNotification {
  thread: Thread;
}
```

---

## 3. Turn Execution

A turn is one user prompt → agent response cycle within a thread. Turns produce items.

### `turn/start` (client → agent)

```typescript
interface TurnStartParams {
  threadId: string;
  input: UserInput[];

  // --- Common per-turn overrides (become new thread defaults) ---
  model?: string;                     // override model for this turn
  cwd?: string;                       // override working directory
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;

  // --- Provider-specific overrides via config IDs ---
  // These reference config options from config/list.
  // e.g. { "reasoning_effort": "high", "personality": "pragmatic" }
  config?: Record<string, string>;
}

interface TurnStartResult {
  turn: Turn;
}

interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  error?: TurnError;
}

type TurnStatus =
  | "inProgress"
  | "completed"
  | "interrupted"
  | "failed";

type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };
```

### `turn/interrupt` (client → agent)

Cancel a running turn.

```typescript
interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}
```

### Turn notifications (agent → client)

```typescript
// turn/started
interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

// turn/completed
interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;                         // final state with all items
}
```

---

## 4. Items and Streaming

Items are the building blocks of a turn. Each item has a typed structure, a lifecycle (`item/started` → deltas → `item/completed`), and carries the data the client needs to render it.

### Item lifecycle

```
item/started      →  full item emitted when work begins
item/…/delta      →  incremental updates (type-specific)
item/completed    →  final authoritative state
```

### `item/started` and `item/completed` (agent → client, notification)

```typescript
interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}
```

### ThreadItem types

```typescript
type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | PlanItem;
```

#### AgentMessage

The agent's text response.

```typescript
interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
}
```

Delta: `item/agentMessage/delta`

```typescript
interface AgentMessageDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;                      // text chunk
}
```

#### Reasoning

The agent's thinking/reasoning content (e.g. Claude's extended thinking, OpenAI reasoning tokens).

```typescript
interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary?: string;                   // human-readable summary
  content?: string;                   // full reasoning text (if available)
}
```

Delta: `item/reasoning/textDelta`

```typescript
interface ReasoningTextDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
```

Delta: `item/reasoning/summaryTextDelta`

```typescript
interface ReasoningSummaryTextDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
```

#### CommandExecution

A shell command the agent ran (or wants to run).

```typescript
interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;                    // human-readable command string
  cwd: string;
  status: CommandExecutionStatus;
  exitCode?: number;
  aggregatedOutput?: string;          // full stdout+stderr after completion
  durationMs?: number;
}

type CommandExecutionStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";                       // user rejected approval
```

Delta: `item/commandExecution/outputDelta`

```typescript
interface CommandExecutionOutputDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;                      // stdout/stderr chunk
}
```

Approval: `item/commandExecution/requestApproval` (agent → client, request)

```typescript
interface CommandExecutionRequestApproval {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
  reason?: string;                    // why the agent wants to run this
}

// Client responds:
interface CommandExecutionApprovalResponse {
  decision: "accept" | "decline";
}
```

#### FileChange

File creation, modification, or deletion.

```typescript
interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: FileUpdateChange[];
  status: FileChangeStatus;
}

interface FileUpdateChange {
  path: string;                       // absolute path
  kind: "add" | "modify" | "delete";
  diff: string;                       // unified diff
}

type FileChangeStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";
```

Delta: `item/fileChange/outputDelta`

```typescript
interface FileChangeOutputDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;                      // streaming diff/patch content
}
```

Approval: `item/fileChange/requestApproval` (agent → client, request)

```typescript
interface FileChangeRequestApproval {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileUpdateChange[];
  reason?: string;
}

interface FileChangeApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline";
}
```

#### McpToolCall

A call to an MCP tool server.

```typescript
interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;                     // MCP server name
  tool: string;                       // tool name
  arguments?: Record<string, unknown>;
  status: "inProgress" | "completed" | "failed";
  result?: unknown;
  error?: string;
}
```

#### WebSearch

An agent-initiated web search.

```typescript
interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
}
```

#### Plan

Agent's execution plan.

```typescript
interface PlanItem {
  type: "plan";
  id: string;
  text: string;                       // plan description
  entries?: PlanEntry[];
}

interface PlanEntry {
  step: string;
  status: "pending" | "inProgress" | "completed" | "failed";
}
```

Delta: `item/plan/delta`

```typescript
interface PlanDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
```

Plan progress: `turn/plan/updated` (agent → client, notification)

```typescript
interface TurnPlanUpdated {
  threadId: string;
  turnId: string;
  explanation: string;
  plan: PlanEntry[];
}
```

---

## 5. Approval Policies and Sandbox

These are the common cross-provider concepts that live directly in the protocol.

```typescript
type ApprovalPolicy =
  | "never"                           // auto-approve everything
  | "unlessTrusted"                   // require approval for untrusted ops
  | "always";                         // require approval for everything

type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | { type: "workspaceWrite"; writableRoots?: string[]; networkAccess?: boolean }
  | { type: "externalSandbox"; networkAccess?: "restricted" | "enabled" };
```

---

## 6. Configuration

Configuration handles two concerns:

- **Model discovery** — what models are available
- **Provider-specific options** — features like reasoning effort, personality, etc.

### `model/list` (client → agent)

```typescript
interface ModelListParams {
  limit?: number;
}

interface ModelListResult {
  data: Model[];
}

interface Model {
  id: string;                         // model slug to pass in thread/start or turn/start
  displayName: string;
  description?: string;
  isDefault: boolean;
  // Optional provider-specific metadata the client can display
  meta?: Record<string, unknown>;
}
```

### `config/list` (client → agent)

Returns the agent's configurable options as typed selectors. The client renders these as UI controls without needing to understand what they mean.

```typescript
interface ConfigListResult {
  options: ConfigOption[];
}

interface ConfigOption {
  type: "select";
  id: string;                         // e.g. "reasoning_effort", "personality"
  name: string;                       // display name
  description?: string;
  group?: string;                     // for UI grouping
  options: ConfigSelectOption[];
  value: string;                      // current selected value
  // Which models this config applies to (empty = all)
  modelIds?: string[];
}

interface ConfigSelectOption {
  id: string;
  name: string;
  description?: string;
}
```

### `config/set` (client → agent)

```typescript
interface ConfigSetParams {
  id: string;                         // config option ID
  value: string;                      // selected option ID
}

interface ConfigSetResult {
  // Full updated config, since changing one option may affect others
  options: ConfigOption[];
}
```

### Config examples by provider

**Claude adapter** would expose:
| Config ID | Options |
|----------------------|--------------------------------------|
| `reasoning_effort` | `low`, `medium`, `high` |
| `max_thinking_tokens`| `8000`, `16000`, `32000` |

**Codex adapter** would expose:
| Config ID | Options |
|----------------------|--------------------------------------|
| `reasoning_effort` | `low`, `medium`, `high` |
| `personality` | `default`, `pragmatic`, `friendly` |
| `collaboration_mode` | `default`, `review`, `plan` |

**Local model adapter** might expose:
| Config ID | Options |
|----------------------|--------------------------------------|
| `temperature` | `0.0`, `0.3`, `0.7`, `1.0` |
| `context_length` | `4096`, `8192`, `16384` |

The point: the client renders all of these the same way (as dropdowns, selectors, etc.) without knowing what `personality` or `temperature` means.

### `config/read` (client → agent)

Returns the current effective configuration for the session.

```typescript
interface ConfigReadResult {
  model: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandboxPolicy: SandboxPolicy;
  options: ConfigOption[];            // provider-specific config
}
```

---

## 7. Token Usage

### `thread/tokenUsage/updated` (agent → client, notification)

```typescript
interface TokenUsageUpdated {
  threadId: string;
  turnId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
```

---

## 8. Error Handling

### JSON-RPC errors

```typescript
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard codes
const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Protocol codes
  NotInitialized: -32000,
  ThreadNotFound: -32001,
  TurnInProgress: -32002,
  NotRunning: -32003,
};
```

### Turn errors

```typescript
interface TurnError {
  message: string;
  errorInfo?: string;                 // e.g. "ContextWindowExceeded", "UsageLimitExceeded"
  httpStatusCode?: number;
}
```

---

## 9. Extensibility

### `_meta` fields

Any object in the protocol MAY carry a `_meta` field with arbitrary metadata. Implementations MUST NOT make assumptions about `_meta` values. This allows providers to attach extra data without breaking the protocol.

```typescript
// Example: Claude adapter attaches SDK session info
{
  type: "agentMessage",
  id: "msg-1",
  text: "Hello",
  _meta: {
    sdkSessionId: "sess_abc123",
    conversationId: "conv_xyz"
  }
}
```

### Extension notifications

Agents MAY send provider-specific notifications using methods prefixed with their provider name:

```
anthropic/cache_updated
openai/rate_limits_updated
```

Clients SHOULD ignore unknown notification methods.

### Extension items

The `ThreadItem` union is open — agents MAY emit items with unrecognized `type` values. Clients SHOULD render unrecognized items as a generic "tool call" with the item's `id` and any available text content.

---

## Method Summary

### Client → Agent (requests)

| Method           | Purpose                           |
| ---------------- | --------------------------------- |
| `initialize`     | Handshake, negotiate capabilities |
| `thread/start`   | Create new thread                 |
| `thread/resume`  | Resume existing thread            |
| `thread/list`    | List threads                      |
| `thread/archive` | Archive thread                    |
| `turn/start`     | Send user prompt                  |
| `turn/interrupt` | Cancel running turn               |
| `model/list`     | List available models             |
| `config/list`    | List configurable options         |
| `config/set`     | Change a config option            |
| `config/read`    | Read current config               |

### Client → Agent (notifications)

| Method        | Purpose                      |
| ------------- | ---------------------------- |
| `initialized` | Client ready after handshake |

### Agent → Client (notifications)

| Method                              | Purpose                     |
| ----------------------------------- | --------------------------- |
| `thread/started`                    | Thread created/resumed      |
| `turn/started`                      | Turn began                  |
| `turn/completed`                    | Turn finished               |
| `turn/plan/updated`                 | Plan progress update        |
| `thread/tokenUsage/updated`         | Token counts                |
| `item/started`                      | Item work began             |
| `item/completed`                    | Item work finished          |
| `item/agentMessage/delta`           | Text streaming              |
| `item/reasoning/textDelta`          | Reasoning streaming         |
| `item/reasoning/summaryTextDelta`   | Reasoning summary streaming |
| `item/commandExecution/outputDelta` | Command output streaming    |
| `item/fileChange/outputDelta`       | File change streaming       |
| `item/plan/delta`                   | Plan text streaming         |

### Agent → Client (requests, require response)

| Method                                  | Purpose               |
| --------------------------------------- | --------------------- |
| `item/commandExecution/requestApproval` | Approve shell command |
| `item/fileChange/requestApproval`       | Approve file changes  |

---

## Comparison with Codex Protocol

| Aspect                 | Codex Protocol                                                                                                         | This Spec                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Wire format**        | JSONL, no `jsonrpc` field                                                                                              | JSONL, no `jsonrpc` field                                                                     |
| **Tool execution**     | Server-side                                                                                                            | Server-side                                                                                   |
| **Item types**         | Typed (`commandExecution`, `fileChange`, etc.)                                                                         | Typed (same)                                                                                  |
| **Streaming**          | `item/started` → type-specific deltas → `item/completed`                                                               | Same                                                                                          |
| **Approval flow**      | `requestApproval` per item type                                                                                        | Same                                                                                          |
| **Model selection**    | `model` param on `thread/start` and `turn/start`                                                                       | Same                                                                                          |
| **Per-turn overrides** | `model`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `effort`, `personality`, `summary`, `collaborationMode`, `settings` | `model`, `cwd`, `approvalPolicy`, `sandboxPolicy` (common) + `config` map (provider-specific) |
| **Provider features**  | Hard-coded params (`personality`, `effort`, etc.)                                                                      | Generic `ConfigOption` selectors                                                              |
| **Extensibility**      | None                                                                                                                   | `_meta`, extension notifications, open item union                                             |

### What we keep from Codex

- Thread/turn model
- Typed items with lifecycle (`item/started` → deltas → `item/completed`)
- Server-side tool execution with approval flow
- `model` and `cwd` as first-class per-turn params
- Same notification structure and naming

### What we change

- **Provider-specific params → config selectors.** Codex's `effort`, `personality`, `summary`, `collaborationMode`, `settings.developer_instructions` become `ConfigOption` entries the agent advertises. The client doesn't need to know about these at the protocol level.

- **Per-turn `config` map.** Instead of adding a new field to `TurnStartParams` every time a provider adds a feature, we have a generic `config?: Record<string, string>` that references config option IDs. Clean, extensible, backwards-compatible.

- **`config/list` and `config/set`.** New methods for discovering and changing provider-specific settings. These are the equivalent of Codex's `config/read` + `config/value/write`, but structured as typed selectors rather than opaque key/value pairs.

- **`_meta` extensibility.** Borrowed from ACP. Any object can carry arbitrary metadata without breaking the protocol.

- **Open item union.** Unrecognized item types are rendered generically rather than causing errors. This lets providers ship new item types without requiring client updates.

---

## Implementation Plan for Flint

### Phase 1: Define the protocol types

Create a shared `@flint/protocol` package with the TypeScript types from this spec. Both the app server and SDK import from it.

### Phase 2: Update the Claude app server

- Wire `thread/start` model param through to the SDK (fix the hardcoded model bug)
- Add per-turn override support (`model`, `cwd`, `approvalPolicy`, `sandboxPolicy`)
- Implement `config/list` and `config/set` (expose reasoning effort, max thinking tokens)
- Implement `model/list` with proper Claude model metadata
- Add `_meta` support

### Phase 3: Update the SDK client

- `AppServerClient` already translates notifications to `AgentEvent` — extend this to handle the new item types and config methods
- Add config selector methods for the TUI to call

### Phase 4: Update the TUI

- Render config selectors as UI controls (model picker, effort dropdown)
- Use typed items for rich rendering (diffs for file changes, terminal output for commands)

### Phase 5: Codex adapter (optional)

Build a second app server that wraps the Codex CLI's app server, translating between the Codex protocol and this spec. The translation is thin since this spec is Codex-shaped — mostly just mapping the provider-specific params.
