#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const COMMANDS = {
  tui: {
    description: "Run the Flint terminal UI",
    args: [resolve(REPO_ROOT, "apps/tui/src/index.ts")],
  },
  gateway: {
    description: "Run the Flint HTTP gateway",
    args: [resolve(REPO_ROOT, "apps/gateway/src/index.ts")],
    envFile: resolve(REPO_ROOT, "apps/gateway/.env"),
  },
  "app-server": {
    description: "Run the Claude app server",
    args: [resolve(REPO_ROOT, "packages/claude-app-server/src/index.ts")],
  },
  "pi-app-server": {
    description: "Run the Pi app server",
    args: [resolve(REPO_ROOT, "packages/pi-app-server/src/index.ts")],
  },
  "cloudflare-sandbox:dev": {
    description: "Run the Cloudflare sandbox app in dev mode",
    args: ["--cwd", resolve(REPO_ROOT, "apps/cloudflare-sandbox"), "dev"],
    isScript: true,
  },
  "cloudflare-sandbox:deploy": {
    description: "Deploy the Cloudflare sandbox app",
    args: ["--cwd", resolve(REPO_ROOT, "apps/cloudflare-sandbox"), "deploy"],
    isScript: true,
  },
};

function printHelp() {
  console.log("flint <command> [args]");
  console.log("");
  console.log("Commands:");
  for (const [name, command] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(24)} ${command.description}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  flint tui");
  console.log("  flint gateway");
  console.log("  flint app-server");
  console.log("  flint pi-app-server");
}

function runBun(args) {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn("bun", args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => resolveExitCode(code ?? 1));
  });
}

async function main() {
  const [, , commandName, ...rest] = process.argv;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = COMMANDS[commandName];
  if (!command) {
    console.error(`Unknown command: ${commandName}`);
    console.error("");
    printHelp();
    process.exit(1);
  }

  if (command.isScript) {
    const exitCode = await runBun(["run", ...command.args, ...rest]);
    process.exit(exitCode);
  }

  const args = ["run"];
  if (command.envFile && existsSync(command.envFile)) {
    args.push("--env-file", command.envFile);
  }
  args.push(...command.args, ...rest);

  const exitCode = await runBun(args);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
