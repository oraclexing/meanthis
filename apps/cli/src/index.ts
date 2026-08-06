#!/usr/bin/env node
import { renderBridgeHelp, runBridgeCli } from "./bridge-cli.js";
import { runCli } from "./cli.js";
import { runLocalBridgeMcpServer } from "./local-bridge-mcp.js";
import { runDetachedLocalBridgeOwner } from "./local-bridge-owner.js";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(renderCliHelp());
} else if (args[0] === "bridge-owner") {
  if (args.length !== 1) {
    process.exitCode = 2;
  } else {
    try {
      await runDetachedLocalBridgeOwner();
    } catch {
      process.exitCode = 1;
    }
  }
} else if (args[0] === "mcp") {
  const compatibility = args.length === 2 && args[1] === "--compatibility";
  if (args.length !== 1 && !compatibility) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.error",
      ok: false,
      error: {
        code: "INVALID_ARGUMENTS",
        message: "The mcp command accepts only the optional --compatibility flag.",
      },
    })}\n`);
    process.exitCode = 2;
  } else {
    try {
      await runLocalBridgeMcpServer({ includeCompatibilityTools: compatibility });
    } catch {
      process.stderr.write(`${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.error",
        ok: false,
        error: { code: "LOCAL_BRIDGE_UNAVAILABLE", message: "Unable to start the local agent bridge." },
      })}\n`);
      process.exitCode = 1;
    }
  }
} else if (args[0] === "bridge") {
  process.exitCode = await runBridgeCli(args.slice(1));
} else {
  process.exitCode = await runCli(args);
}

function renderCliHelp(): string {
  return [
    "MeanThis CLI",
    "",
    "Usage:",
    "  meanthis summary --input <session.json>",
    "  meanthis attachment --input <session.json> --id <attachment-id>",
    "  meanthis bundle --input <session.json> --id <attachment-id> [--format json|markdown]",
    "  meanthis bridge --help",
    "  meanthis mcp",
    "  meanthis mcp --compatibility",
    "",
    "Bridge setup:",
    renderBridgeHelp().trimEnd(),
    "",
  ].join("\n");
}
