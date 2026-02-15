#!/usr/bin/env bun
/**
 * Claude App Server
 * Codex-protocol compatible server backed by Claude Agent SDK
 *
 * Communicates over stdio using JSON-RPC 2.0
 */

import { stdio } from "@flint-dev/app-server-core";
import { processRequest } from "./processor.ts";
import { storage } from "./storage.ts";

async function main(): Promise<void> {
  // Initialize storage
  await storage.init();

  // Set up request handler
  stdio.setHandler(processRequest);

  // Start processing stdin
  stdio.start();

  // Log to stderr (stdout is for JSON-RPC)
  console.error("Claude App Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
