# Repository Guidelines

## Project Structure & Module Organization

Flint is a Bun + TypeScript monorepo.

- `apps/tui/`: terminal UI client.
- `apps/gateway/`: HTTP gateway app.
- `apps/cloudflare-sandbox/`: Cloudflare Worker sandbox app.
- `packages/claude-app-server/`: Claude app server (JSON-RPC over stdio).
- `packages/pi-app-server/`: provider-integrated app server.
- `packages/app-server-core/`: shared protocol + stdio transport primitives.
- `packages/channels/`: channel adapter layer used by gateway.
- `packages/sdk/`: client SDK (`src/` source, `dist/` published output).
- `packages/flint/`: publishable CLI entrypoint package (`@flint-dev/cli`).
- Root configs: `package.json`, `tsconfig.base.json`, `tsconfig.json`.

Keep cross-package imports through workspace package names (for example `@flint-dev/sdk`) instead of deep relative paths.

## Build, Test, and Development Commands

Run from repo root unless noted.

- `bun install`: install workspace dependencies.
- `bun run flint tui`: start the terminal UI through the local CLI entrypoint.
- `bun run flint gateway`: start the gateway through the local CLI entrypoint.
- `bun run cloudflare-sandbox:dev`: run the Cloudflare sandbox app locally.
- `bun run flint app-server`: run the Claude app server directly.
- `bun run flint pi-app-server`: run the provider-integrated app server directly.
- `bun run typecheck`: TypeScript project references build check.
- `bun run lint`: lint with `oxlint`.
- `bun run format` / `bun run format:check`: format or verify formatting with `oxfmt`.
- `bun test`: run Bun tests across workspaces.
- `bun run release:publish`: publish versioned npm packages in dependency order.

## Coding Style & Naming Conventions

- Language: TypeScript ESM (`"type": "module"`).
- Indentation: 2 spaces; prefer trailing commas where valid.
- Compiler settings are strict (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` enabled).
- Naming: `PascalCase` for types/classes, `camelCase` for variables/functions, lowercase file names with hyphens only when helpful (for example `app-server-client.ts`).
- Keep modules focused and small; colocate helper utilities near their consumer package.

## Testing Guidelines

- Framework: Bun test runner (`bun test`).
- Place tests as `*.test.ts` near source files or in package-local test folders.
- Add/adjust tests for behavior changes in protocol handling, stream parsing, and API/session lifecycle code.
- Before opening a PR, run at least: `bun run typecheck && bun run lint && bun test`.

## Commit & Pull Request Guidelines

Recent history uses short, imperative subjects (for example `Update sdk`, `Add resumable streams`). Follow that style.

- Commit messages: concise imperative line, optional package scope.
- PRs should include: what changed, why, affected packages, and validation steps run.
- Link related issues and include terminal screenshots for TUI-visible UX changes.

## Solo Agent Workflow

Humans steer; agents execute.

1. Define intent and acceptance criteria in the prompt.
2. Have the agent implement end-to-end (code, tests, docs).
3. Run validation (`bun run typecheck && bun run lint && bun test`).
4. Fix regressions immediately; prefer small follow-up PRs over large rewrites.

## Source Of Truth

Keep documentation minimal and repo-local.

- `SPEC.md`: protocol behavior source of truth.
- `README.md`: onboarding and common commands.
- `apps/gateway/README.md`: gateway HTTP/MCP behavior and runtime configuration.
- `packages/sdk/README.md`: SDK API behavior and provider usage.

If a decision changes architecture or behavior, encode it in one of the files above.
