#!/usr/bin/env bun
/**
 * pi App Server
 * Codex-protocol compatible server backed by pi coding agent RPC mode
 *
 * Communicates over stdio using JSON-RPC 2.0
 */

import { stdio } from "@flint-dev/app-server-core";
import { processRequest } from "./processor.ts";
import { storage } from "./storage.ts";

async function main(): Promise<void> {
  await storage.init();

  stdio.setHandler(processRequest);
  stdio.start();

  console.error("pi App Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
