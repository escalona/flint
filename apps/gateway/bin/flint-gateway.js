#!/usr/bin/env bun

import { startGatewayServer } from "../src/index.ts";

const started = await startGatewayServer();
started.attachSignalHandlers();
