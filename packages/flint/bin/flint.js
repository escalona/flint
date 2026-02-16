#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const COMMANDS = {
  tui: {
    description: "Run Flint terminal UI",
    packageName: "@flint-dev/tui",
    binName: "flint-tui",
  },
  gateway: {
    description: "Run Flint HTTP gateway",
    packageName: "@flint-dev/gateway",
    binName: "flint-gateway",
  },
  "app-server": {
    description: "Run Claude app server",
    packageName: "@flint-dev/claude-app-server",
    binName: "claude-app-server",
  },
  "pi-app-server": {
    description: "Run Pi app server",
    packageName: "@flint-dev/pi-app-server",
    binName: "pi-app-server",
  },
};

function getCliVersion() {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return packageJson.version;
}

function printHelp() {
  console.log("flint <command> [args]");
  console.log("");
  console.log("Options:");
  console.log("  --version, -v     Print CLI version");
  console.log("  --help, -h        Show help");
  console.log("");
  console.log("Commands:");
  for (const [name, command] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${command.description}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  flint tui");
  console.log("  flint gateway");
}

function resolveCommandBinary(packageName, binName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  const binField = packageJson.bin;
  const relativeBinPath =
    typeof binField === "string"
      ? binField
      : binField && typeof binField === "object"
        ? binField[binName]
        : undefined;

  if (!relativeBinPath) {
    throw new Error(`Could not resolve binary "${binName}" in ${packageName}`);
  }

  return resolve(dirname(packageJsonPath), relativeBinPath);
}

function buildCommandEnv(commandName) {
  const env = { ...process.env };

  if (commandName === "tui" && !env.FLINT_APP_SERVER_COMMAND) {
    env.FLINT_APP_SERVER_COMMAND = resolveCommandBinary(
      "@flint-dev/claude-app-server",
      "claude-app-server",
    );
  }

  return env;
}

function runCommand(binaryPath, args, env) {
  const child = spawn(binaryPath, args, {
    stdio: "inherit",
    env,
  });

  child.on("error", (error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error("Flint requires Bun installed and available on PATH.");
      console.error("Install Bun: https://bun.sh");
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  child.on("exit", (code) => process.exit(code ?? 1));
}

function main() {
  const [, , commandName, ...rest] = process.argv;

  if (commandName === "--version" || commandName === "-v") {
    console.log(getCliVersion());
    process.exit(0);
  }

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

  const binaryPath = resolveCommandBinary(command.packageName, command.binName);
  const env = buildCommandEnv(commandName);
  runCommand(binaryPath, rest, env);
}

main();
