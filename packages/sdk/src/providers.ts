import { join, dirname } from "path";
import { createRequire } from "module";
import type { AppServerClientOptions } from "./app-server-client";

export interface ProviderConfig {
  cwd: string;
  env?: Record<string, string>;
}

export interface Provider {
  resolve(config: ProviderConfig): AppServerClientOptions;
}

const claudeProvider: Provider = {
  resolve(config) {
    const pkgPath = resolvePackagePath("@flint-dev/claude-app-server/package.json");
    const entry = join(dirname(pkgPath), "src/index.ts");
    return {
      provider: "claude",
      command: "bun",
      args: ["run", entry],
      cwd: config.cwd,
      env: {
        ...config.env,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
    };
  },
};

const codexProvider: Provider = {
  resolve(config) {
    return {
      provider: "codex",
      command: "codex",
      args: ["app-server"],
      cwd: config.cwd,
      env: config.env,
    };
  },
};

const piProvider: Provider = {
  resolve(config) {
    const pkgPath = resolvePackagePath("@flint-dev/pi-app-server/package.json");
    const entry = join(dirname(pkgPath), "src/index.ts");
    return {
      provider: "pi",
      command: "bun",
      args: ["run", entry],
      cwd: config.cwd,
      env: config.env,
    };
  },
};

const builtins = new Map<string, Provider>([
  ["claude", claudeProvider],
  ["codex", codexProvider],
  ["pi", piProvider],
]);

const custom = new Map<string, Provider>();

export function registerProvider(name: string, provider: Provider): void {
  custom.set(name, provider);
}

export function getProvider(name: string): Provider {
  const provider = custom.get(name) ?? builtins.get(name);
  if (!provider) {
    throw new Error(`Unknown provider: "${name}". Register it with registerProvider().`);
  }
  return provider;
}

function resolvePackagePath(specifier: string): string {
  const consumerRequire = createRequire(join(process.cwd(), "__placeholder__.js"));
  try {
    // First try consumer resolution (published package use-case).
    return consumerRequire.resolve(specifier);
  } catch {
    // Fall back to SDK-local resolution (workspace/dev use-case).
    const sdkRequire = createRequire(import.meta.url);
    return sdkRequire.resolve(specifier);
  }
}
