#!/usr/bin/env node
import { runSourceResolverMcpServer } from "./index.js";

try {
  await runSourceResolverMcpServer();
} catch {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "0.1.0",
    kind: "ui-attach.error",
    ok: false,
    error: {
      code: "SOURCE_RESOLVER_UNAVAILABLE",
      message: "Unable to start the MeanThis source resolver.",
    },
  })}\n`);
  process.exitCode = 1;
}
