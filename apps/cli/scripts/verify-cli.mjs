import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_SESSION_FILE_MAX_BYTES } from "@meanthis/hub-core";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(cliDir, "..", "..");
const cliEntry = join(cliDir, "dist", "index.js");
const brokerEntry = join(cliDir, "dist", "local-bridge-mcp-stdio-broker.js");
const twoAttachmentFixture = join(cliDir, "fixtures", "two-attachment.capture-session.json");
const agentSafeFixture = join(cliDir, "fixtures", "agent-safe.capture-session.json");

await verifyCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function verifyCli() {
  const help = runCli(["--help"]);
  require(help.status === 0, "Top-level help must exit 0.");
  require(help.stderr === "", "Top-level help must not write stderr.");
  require(
    help.stdout.includes("meanthis bridge --help")
      && help.stdout.includes("meanthis mcp")
      && help.stdout.includes("meanthis mcp-http [--port <1-65535>]")
      && help.stdout.includes("meanthis capture --help")
      && help.stdout.includes("bridge config --host"),
    "Top-level help must expose bridge setup, capture fallback, and both MCP transports.",
  );

  const bridgeHelp = runCli(["bridge", "--help"]);
  require(bridgeHelp.status === 0, "Bridge help must exit 0.");
  require(bridgeHelp.stderr === "", "Bridge help must not write stderr.");
  require(
    bridgeHelp.stdout.includes("meanthis bridge rotate-agent-token --host codex --json")
      && bridgeHelp.stdout.includes("Explicitly rotate both local credentials")
      && !/MEANTHIS_MCP_HTTP_TOKEN|Authorization|Bearer /u.test(bridgeHelp.stdout),
    "Bridge help must expose the secret-free Agent credential recovery command.",
  );

  const mcpHttpHelp = runCli(["mcp-http", "--help"]);
  require(mcpHttpHelp.status === 0, "MCP HTTP help must exit 0.");
  require(mcpHttpHelp.stderr === "", "MCP HTTP help must not write stderr.");
  require(
    mcpHttpHelp.stdout.includes("meanthis mcp-http [--port <1-65535>]")
      && mcpHttpHelp.stdout.includes("MEANTHIS_MCP_HTTP_TOKEN"),
    "MCP HTTP help must describe the foreground diagnostic command and bearer env contract.",
  );

  const cursorConfig = runCli(["bridge", "config", "--host", "cursor", "--json"]);
  require(cursorConfig.status === 0, "Cursor configuration generation must exit 0.");
  require(cursorConfig.stderr === "", "Cursor configuration generation must not write stderr.");
  const cursorConfigOutput = parseSingleJsonLine(cursorConfig.stdout, "Cursor config stdout");
  require(
    cursorConfigOutput.kind === "ui-attach.bridge-config"
      && cursorConfigOutput.data?.descriptor?.transport?.type === "stdio"
      && cursorConfigOutput.data?.descriptor?.transport?.command === process.execPath
      && JSON.stringify(cursorConfigOutput.data?.descriptor?.transport?.args)
        === JSON.stringify([brokerEntry])
      && cursorConfigOutput.data?.descriptor?.transport?.env === null
      && cursorConfigOutput.data?.descriptor?.transport?.cwd === null
      && cursorConfigOutput.data?.setup?.host === "cursor"
      && cursorConfigOutput.data?.setup?.installation === "manual"
      && cursorConfigOutput.data?.setup?.verification === "manual_required"
      && cursorConfigOutput.data?.setup?.manual?.transport === "stdio"
      && cursorConfigOutput.data?.setup?.manual?.command === process.execPath
      && JSON.stringify(cursorConfigOutput.data?.setup?.manual?.args)
        === JSON.stringify([brokerEntry])
      && cursorConfigOutput.data?.setup?.manual?.env === null
      && cursorConfigOutput.data?.setup?.manual?.cwd === null
      && !/MEANTHIS_MCP_HTTP_TOKEN|Authorization|Bearer /u.test(cursorConfig.stdout),
    "Cursor configuration must derive from the exact secret-free thin stdio broker descriptor.",
  );

  const sourceHash = await hashFile(twoAttachmentFixture);
  const firstSummary = runCli(["summary", "--input", twoAttachmentFixture]);
  const secondSummary = runCli(["summary", "--input", twoAttachmentFixture]);
  verifySummary(firstSummary, secondSummary);

  const jsonBundle = runCli([
    "bundle",
    "--input",
    twoAttachmentFixture,
    "--id",
    "att_save",
    "--id",
    "att_cancel",
    "--intent",
    "Move A below B.",
  ]);
  verifyJsonBundle(jsonBundle);

  const markdownBundle = runCli([
    "bundle",
    "--input",
    twoAttachmentFixture,
    "--id",
    "att_save",
    "--id",
    "att_cancel",
    "--intent",
    "Move A below B.",
    "--format",
    "markdown",
  ]);
  verifyMarkdownBundle(markdownBundle);

  const disclosureUpgrade = runCli([
    "attachment",
    "--input",
    agentSafeFixture,
    "--id",
    "att_save",
    "--disclosure",
    "full_debug",
  ]);
  require(disclosureUpgrade.status === 4, "Disclosure upgrade must exit 4.");
  require(disclosureUpgrade.stdout === "", "Disclosure upgrade must not write stdout.");
  const disclosureError = parseSingleJsonLine(
    disclosureUpgrade.stderr,
    "Disclosure upgrade stderr",
  );
  require(
    disclosureError.schemaVersion === "0.1.0" &&
      disclosureError.kind === "ui-attach.error" &&
      disclosureError.ok === false &&
      disclosureError.error?.code === "DISCLOSURE_UPGRADE_DENIED",
    "Disclosure upgrade must report DISCLOSURE_UPGRADE_DENIED.",
  );

  const invalidMcp = runCli(["mcp", "unexpected"]);
  require(invalidMcp.status === 2, "Invalid MCP invocation must exit 2.");
  require(invalidMcp.stdout === "", "Invalid MCP invocation must not write stdout.");
  const mcpError = parseSingleJsonLine(invalidMcp.stderr, "Invalid MCP stderr");
  require(
    mcpError.kind === "ui-attach.error" &&
      mcpError.error?.code === "INVALID_ARGUMENTS",
    "Invalid MCP invocation must report INVALID_ARGUMENTS.",
  );

  const invalidMcpHttp = runCli(["mcp-http", "--port", "0"]);
  require(invalidMcpHttp.status === 2, "Invalid MCP HTTP invocation must exit 2.");
  require(invalidMcpHttp.stdout === "", "Invalid MCP HTTP invocation must not write stdout.");
  const mcpHttpError = parseSingleJsonLine(
    invalidMcpHttp.stderr,
    "Invalid MCP HTTP stderr",
  );
  require(
    mcpHttpError.kind === "ui-attach.error"
      && mcpHttpError.error?.code === "INVALID_ARGUMENTS",
    "Invalid MCP HTTP invocation must report INVALID_ARGUMENTS.",
  );

  const hostileInheritedToken = Buffer.alloc(32, 8).toString("base64url");
  const invalidBroker = spawnSync(
    process.execPath,
    [brokerEntry, "unexpected"],
    {
      cwd: rootDir,
      encoding: "utf8",
      shell: false,
      env: { ...process.env, MEANTHIS_MCP_HTTP_TOKEN: hostileInheritedToken },
    },
  );
  if (invalidBroker.error) throw invalidBroker.error;
  require(invalidBroker.status === 1, "Broker arguments must fail closed with exit 1.");
  require(invalidBroker.stdout === "", "Broker argument failure must not write stdout.");
  require(
    !invalidBroker.stderr.includes(hostileInheritedToken),
    "Broker argument failure must not expose an inherited bearer.",
  );
  const brokerError = parseSingleJsonLine(
    invalidBroker.stderr,
    "Broker argument failure stderr",
  );
  require(
    brokerError.kind === "ui-attach.error"
      && brokerError.error?.code === "MCP_STDIO_BROKER_UNAVAILABLE"
      && brokerError.error?.message === "MeanThis MCP stdio broker unavailable.",
    "Broker argument failure must report only its generic unavailable error.",
  );

  const invalidBridge = runCli(["bridge", "install", "--json"]);
  require(invalidBridge.status === 2, "Invalid bridge invocation must exit 2.");
  require(invalidBridge.stdout === "", "Invalid bridge invocation must not write stdout.");
  const bridgeError = parseSingleJsonLine(invalidBridge.stderr, "Invalid bridge stderr");
  require(
    bridgeError.kind === "ui-attach.error" &&
      bridgeError.error?.code === "INVALID_ARGUMENTS",
    "Invalid bridge invocation must report INVALID_ARGUMENTS.",
  );

  await verifyOversizedSessionInputs();

  require(sourceHash === (await hashFile(twoAttachmentFixture)), "Source fixture was modified.");
  console.log("Agent handoff CLI verified.");
}

function runCli(args, options = {}) {
  const result = spawnSync(
    process.execPath,
    [cliEntry, ...args],
    {
      cwd: rootDir,
      encoding: "utf8",
      input: options.input,
      shell: false,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function verifyOversizedSessionInputs() {
  const oversizedPayload = "x".repeat(CAPTURE_SESSION_FILE_MAX_BYTES + 1);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "meanthis-cli-verify-"));
  try {
    const oversizedFile = join(temporaryDirectory, "oversized.capture-session.json");
    await writeFile(oversizedFile, oversizedPayload, "utf8");

    verifyOversizedSessionResult(
      runCli(["summary", "--input", oversizedFile]),
      "Oversized file",
    );
    verifyOversizedSessionResult(
      runCli(["summary", "--input", "-"], { input: oversizedPayload }),
      "Oversized stdin",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyOversizedSessionResult(result, label) {
  require(result.status === 3, `${label} must exit 3.`);
  require(result.stdout === "", `${label} must not write stdout.`);
  const output = parseSingleJsonLine(result.stderr, `${label} stderr`);
  require(
    output.kind === "ui-attach.error" &&
      output.ok === false &&
      output.error?.code === "INVALID_SESSION_FILE",
    `${label} must report INVALID_SESSION_FILE.`,
  );
}

function verifySummary(first, second) {
  require(first.status === 0 && second.status === 0, "Summary must exit 0.");
  require(first.stderr === "" && second.stderr === "", "Summary must not write stderr.");
  require(first.stdout === second.stdout, "Summary stdout must be byte-identical.");
  require(!/ada@example\.com|sk-test-\d+|token=secret/.test(first.stdout), "Summary exposed a secret.");

  const summary = parseSingleJsonLine(first.stdout, "Summary stdout");
  require(summary.schemaVersion === "0.1.0", "Summary schema version must be v1.");
  require(summary.kind === "ui-attach.session-summary", "Summary kind must be v1 session summary.");
  require(summary.data?.items?.length === 2, "Summary must contain two items.");
}

function verifyJsonBundle(result) {
  require(result.status === 0, "JSON bundle must exit 0.");
  require(result.stderr === "", "JSON bundle must not write stderr.");
  const bundle = parseSingleJsonLine(result.stdout, "JSON bundle stdout");
  require(
    JSON.stringify(bundle.data?.attachmentIds) === JSON.stringify(["att_save", "att_cancel"]),
    "JSON bundle must contain exactly att_save and att_cancel.",
  );
  require(
    typeof bundle.data?.markdown === "string" && bundle.data.markdown.includes("Move A below B."),
    "JSON bundle Markdown must contain the explicit intent.",
  );
  verifyFixtureIntentsExcluded(result.stdout, "JSON bundle");
}

function verifyMarkdownBundle(result) {
  require(result.status === 0, "Markdown bundle must exit 0.");
  require(result.stderr === "", "Markdown bundle must not write stderr.");
  require(result.stdout.startsWith("# MeanThis Capture Bundle"), "Markdown bundle must start with its heading.");
  require(result.stdout.endsWith("\n"), "Markdown bundle must end with a newline.");
  require(!result.stdout.includes('"kind":"ui-attach.prompt-bundle"'), "Markdown bundle must not contain a JSON envelope.");
  verifyFixtureIntentsExcluded(result.stdout, "Markdown bundle");
}

function verifyFixtureIntentsExcluded(value, label) {
  require(!value.includes("Persist billing changes."), `${label} exposed the save record intent.`);
  require(!value.includes("Discard billing changes."), `${label} exposed the cancel record intent.`);
}

function parseSingleJsonLine(value, label) {
  require(value.endsWith("\n"), `${label} must end with exactly one newline.`);
  const line = value.slice(0, -1);
  require(
    line.length > 0 && !line.includes("\n") && !line.includes("\r"),
    `${label} must contain exactly one non-empty JSON line.`,
  );
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${label} must be JSON.`);
  }
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function require(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
