#!/usr/bin/env node
import { renderBridgeHelp, runBridgeCli } from "./bridge-cli.js";
import { renderCaptureHelp, runCaptureCli } from "./capture-cli.js";
import {
  renderAnnotationLifecycleControlHelp,
  runAnnotationLifecycleControlCli,
} from "./annotation-lifecycle-control-cli.js";
import { runCli } from "./cli.js";
import { runLocalBridgeMcpServer } from "./local-bridge-mcp.js";
import {
  parseLocalBridgeMcpHttpArgs,
  renderLocalBridgeMcpHttpHelp,
  runLocalBridgeMcpHttpServer,
} from "./local-bridge-mcp-http.js";
import { runDetachedLocalBridgeMcpHttpOwner } from "./local-bridge-mcp-http-owner.js";
import {
  createLocalBridgeOwnerLifecycleReporter,
  runDetachedLocalBridgeOwner,
} from "./local-bridge-owner.js";
import { runLocalBridgeNativeMessagingHost } from "./local-bridge-native-host.js";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(renderCliHelp());
} else if (args[0] === "native-host") {
  if (args.length < 2 || args.length > 3) {
    process.exitCode = 2;
  } else {
    try {
      await runLocalBridgeNativeMessagingHost({ callerArgs: args.slice(1) });
    } catch {
      process.exitCode = 1;
    }
  }
} else if (args[0] === "bridge-owner") {
  if (args.length !== 1) {
    process.exitCode = 2;
  } else {
    try {
      await runDetachedLocalBridgeOwner({
        onLifecycleEvent: createLocalBridgeOwnerLifecycleReporter(),
      });
    } catch {
      process.exitCode = 1;
    }
  }
} else if (args[0] === "mcp-http-owner") {
  if (args.length !== 1) {
    process.exitCode = 2;
  } else {
    try {
      await runDetachedLocalBridgeMcpHttpOwner({
        onLifecycleEvent: createLocalBridgeOwnerLifecycleReporter(),
      });
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
} else if (args[0] === "mcp-http") {
  if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
    process.stdout.write(renderLocalBridgeMcpHttpHelp());
  } else {
    const parsed = parseLocalBridgeMcpHttpArgs(args.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`${JSON.stringify({
        schemaVersion: "0.1.0",
        kind: "ui-attach.error",
        ok: false,
        error: { code: parsed.code, message: parsed.message },
      })}\n`);
      process.exitCode = 2;
    } else {
      try {
        await runLocalBridgeMcpHttpServer(parsed.port);
      } catch {
        process.stderr.write(`${JSON.stringify({
          schemaVersion: "0.1.0",
          kind: "ui-attach.error",
          ok: false,
          error: {
            code: "MCP_HTTP_UNAVAILABLE",
            message: "Unable to start the shared local MCP endpoint.",
          },
        })}\n`);
        process.exitCode = 1;
      }
    }
  }
} else if (args[0] === "bridge") {
  process.exitCode = await runBridgeCli(args.slice(1));
} else if (args[0] === "capture") {
  process.exitCode = await runCaptureCli(args.slice(1));
} else if (args[0] === "control") {
  process.exitCode = await runAnnotationLifecycleControlCli(args.slice(1));
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
    "  meanthis capture --help",
    "  meanthis control --help",
    "  meanthis bridge --help",
    "  meanthis mcp",
    "  meanthis mcp --compatibility",
    "  meanthis mcp-http [--port <1-65535>]",
    "",
    "Bridge setup:",
    renderBridgeHelp().trimEnd(),
    "",
    "Capture fallback:",
    renderCaptureHelp().trimEnd(),
    "",
    "Lifecycle control:",
    renderAnnotationLifecycleControlHelp().trimEnd(),
    "",
  ].join("\n");
}
