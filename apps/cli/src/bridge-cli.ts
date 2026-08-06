import { spawn } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type LocalBridgeApprovalMode,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
} from "@meanthis/schema";
import { loadOrCreateLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import { loadLocalBridgeOwnerIdentity } from "./local-bridge-owner.js";
import { approveHttpLocalBridgeConnectionRequest } from "./local-bridge-mcp.js";
import type { LocalBridgeConnectionApproval } from "./local-bridge.js";
import {
  createMeanThisMcpDescriptor,
  createMeanThisMcpHostSetup,
  MEANTHIS_MCP_REGISTRATION_NAME,
  type MeanThisMcpHost,
} from "./mcp-host-config.js";

const REGISTRATION_NAME = MEANTHIS_MCP_REGISTRATION_NAME;
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;

type BridgeCommand = "approve" | "config" | "doctor" | "install" | "uninstall";
type RegistrationStatus = "current" | "drifted" | "missing" | "unavailable" | "error";
export type LoopbackProbeStatus = "ready" | "not_running" | "unexpected";

export interface BridgeCliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface CodexProcessResult {
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface BridgeCliDependencies {
  nodePath: string;
  entryPath: string;
  pathExists(path: string): Promise<boolean>;
  probeLoopback(): Promise<LoopbackProbeStatus>;
  backupCodexConfig(): Promise<CodexConfigBackup>;
  runCodex(args: string[]): Promise<CodexProcessResult>;
  approveConnectionRequest(
    requestId: string,
    approvalMode: LocalBridgeApprovalMode,
    approvalKey: string,
  ): Promise<LocalBridgeConnectionApproval>;
}

export interface CodexConfigBackup {
  status: "created" | "not_found";
  path: string | null;
}

interface ParsedBridgeArguments {
  command: BridgeCommand;
  host: MeanThisMcpHost | null;
  dryRun: boolean;
  requestId: string | null;
  approvalMode: LocalBridgeApprovalMode | null;
  approvalKey: string | null;
}

interface CodexRegistration {
  name: string;
  enabled: boolean;
  transport: {
    type: "stdio";
    command: string;
    args: string[];
    env: Record<string, string> | null;
    cwd: string | null;
  };
}

interface RegistrationReadback {
  status: RegistrationStatus;
  registration: CodexRegistration | null;
}

const defaultIo: BridgeCliIo = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  writeStderr(value) {
    process.stderr.write(value);
  },
};

const defaultDependencies = createDefaultDependencies();

export async function runBridgeCli(
  args: string[],
  io: BridgeCliIo = defaultIo,
  dependencies: BridgeCliDependencies = defaultDependencies,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.writeStdout(renderBridgeHelp());
    return 0;
  }

  let parsed: ParsedBridgeArguments;
  try {
    parsed = parseBridgeArguments(args);
  } catch {
    return writeError(io, 2, "INVALID_ARGUMENTS", "Invalid bridge command arguments.");
  }

  if (parsed.command === "config") {
    return runConfig(io, dependencies, parsed.host!);
  }
  if (parsed.command === "doctor") {
    return runDoctor(io, dependencies);
  }
  if (parsed.command === "approve") {
    return runApprove(
      io,
      dependencies,
      parsed.requestId!,
      parsed.approvalMode!,
      parsed.approvalKey!,
    );
  }
  if (parsed.command === "install") {
    if (parsed.host !== "codex") return writeHostInstallNotAutomated(io, parsed.host!);
    return runInstall(io, dependencies, parsed.dryRun);
  }
  if (parsed.host !== "codex") return writeHostInstallNotAutomated(io, parsed.host!);
  return runUninstall(io, dependencies, parsed.dryRun);
}

export function renderBridgeHelp(): string {
  return [
    "MeanThis host-neutral MCP companion setup",
    "",
    "Usage:",
    "  meanthis bridge approve --request <uuid> --mode <ask|browser_session> --key <base64url> --json",
    "  meanthis bridge config --host <codex|claude-code|vscode|cursor> --json",
    "  meanthis bridge doctor --json",
    "  meanthis bridge install --host codex [--dry-run] --json",
    "  meanthis bridge uninstall --host codex [--dry-run] --json",
    "",
    "Commands:",
    "  approve    Approve one browser-created connection request through the authenticated owner.",
    "  config     Generate a host command or JSON configuration from one shared stdio descriptor.",
    "  doctor     Check the built MCP entry, Codex registration, and loopback runtime.",
    "  install    Add the exact ui-attach stdio MCP registration through Codex CLI.",
    "  uninstall  Remove only the exact registration managed by this checkout.",
    "",
    "All command results are stable JSON. Connection secrets, tokens, and page content are never printed.",
    "",
  ].join("\n");
}

function parseBridgeArguments(args: string[]): ParsedBridgeArguments {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      codex: { type: "boolean" },
      host: { type: "string" },
      request: { type: "string" },
      mode: { type: "string" },
      key: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (parsed.positionals.length !== 1 || !isBridgeCommand(parsed.positionals[0])) {
    throw new Error("Invalid command.");
  }
  const command = parsed.positionals[0];
  const optionNames = Object.keys(parsed.values);
  let host: MeanThisMcpHost | null = null;
  if (command === "config") {
    if (!isMeanThisMcpHost(parsed.values.host)
      || optionNames.some((name) => !["host", "json"].includes(name))) {
      throw new Error("Invalid config option.");
    }
    host = parsed.values.host;
  } else if (command === "doctor") {
    if ((parsed.values.host !== undefined && parsed.values.host !== "codex")
      || optionNames.some((name) => !["host", "json"].includes(name))) {
      throw new Error("Invalid doctor option.");
    }
    host = "codex";
  } else if (command === "approve") {
    if (
      typeof parsed.values.request !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.values.request) ||
      (parsed.values.mode !== "ask" && parsed.values.mode !== "browser_session") ||
      typeof parsed.values.key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.values.key) ||
      optionNames.some((name) => !["request", "mode", "key", "json"].includes(name))
    ) {
      throw new Error("Invalid approval option.");
    }
  } else {
    const legacyCodex = parsed.values.codex === true;
    if (legacyCodex && parsed.values.host !== undefined) throw new Error("Choose one host option.");
    if (legacyCodex) {
      host = "codex";
    } else if (isMeanThisMcpHost(parsed.values.host)) {
      host = parsed.values.host;
    } else {
      throw new Error("Expected --host.");
    }
    if (optionNames.some((name) => !["codex", "host", "dry-run", "json"].includes(name))) {
      throw new Error("Invalid setup option.");
    }
  }
  return {
    command,
    host,
    dryRun: parsed.values["dry-run"] === true,
    requestId: typeof parsed.values.request === "string" ? parsed.values.request : null,
    approvalMode: parsed.values.mode === "ask" || parsed.values.mode === "browser_session"
      ? parsed.values.mode
      : null,
    approvalKey: typeof parsed.values.key === "string" ? parsed.values.key : null,
  };
}

function isBridgeCommand(value: string): value is BridgeCommand {
  return value === "approve"
    || value === "config"
    || value === "doctor"
    || value === "install"
    || value === "uninstall";
}

function isMeanThisMcpHost(value: unknown): value is MeanThisMcpHost {
  return value === "codex" || value === "claude-code" || value === "vscode" || value === "cursor";
}

function runConfig(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  host: MeanThisMcpHost,
): number {
  const descriptor = createMeanThisMcpDescriptor(dependencies.nodePath, dependencies.entryPath);
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-config",
    ok: true,
    data: {
      descriptor,
      setup: createMeanThisMcpHostSetup(host, descriptor),
    },
  });
}

function writeHostInstallNotAutomated(io: BridgeCliIo, host: MeanThisMcpHost): number {
  return writeError(
    io,
    2,
    "HOST_INSTALL_NOT_AUTOMATED",
    `MeanThis generates ${host} configuration but does not mutate that host; run bridge config instead.`,
  );
}

async function runApprove(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  requestId: string,
  approvalMode: LocalBridgeApprovalMode,
  approvalKey: string,
): Promise<number> {
  try {
    const approval = await dependencies.approveConnectionRequest(requestId, approvalMode, approvalKey);
    return writeJson(io, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.bridge-connection-approved",
      ok: true,
      data: approval,
    });
  } catch {
    return writeError(
      io,
      5,
      "CONNECTION_APPROVAL_DENIED",
      "The browser-created connection request was not approved.",
    );
  }
}

async function runDoctor(io: BridgeCliIo, dependencies: BridgeCliDependencies): Promise<number> {
  const [cliBuilt, loopback, registration] = await Promise.all([
    dependencies.pathExists(dependencies.entryPath),
    dependencies.probeLoopback(),
    readRegistration(dependencies),
  ]);
  const codexAvailable = registration.status !== "unavailable";
  const registrationReady = cliBuilt && registration.status === "current";
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-doctor",
    ok: true,
    data: {
      registrationReady,
      runtimeActive: loopback === "ready",
      registrationName: REGISTRATION_NAME,
      command: expectedCommand(dependencies),
      checks: {
        cliBuilt: {
          status: cliBuilt ? "pass" : "missing",
          next: cliBuilt ? null : "Run npm run build from the ui-attach checkout.",
        },
        codexCli: {
          status: codexAvailable ? "pass" : "missing",
          next: codexAvailable ? null : "Install Codex CLI or make codex available on PATH.",
        },
        registration: {
          status: registration.status,
          next: registration.status === "missing"
            ? "Run meanthis bridge install --codex --json."
            : registration.status === "drifted"
              ? "Resolve the existing ui-attach MCP registration before installing this checkout."
              : null,
        },
        loopback: {
          status: loopback,
          origin: UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
          next: loopback === "not_running"
            ? "A fresh Codex task starts the registered MCP process; then create a request in the extension."
            : loopback === "unexpected"
              ? "Another process is using the MeanThis loopback address."
              : null,
        },
      },
    },
  });
}

async function runInstall(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  if (!await dependencies.pathExists(dependencies.entryPath)) {
    return writeError(io, 5, "CLI_NOT_BUILT", "Build ui-attach before installing its MCP bridge.");
  }
  const registration = await readRegistration(dependencies);
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the ui-attach MCP registration.");
  }
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "A different ui-attach MCP registration already exists.",
    );
  }
  if (registration.status === "current") {
    return writeSetupResult(io, "install", "none", false, dryRun, dependencies, null);
  }
  if (dryRun) {
    return writeSetupResult(io, "install", "add", false, true, dependencies, null);
  }

  const backup = await createConfigBackup(io, dependencies);
  if (typeof backup === "number") return backup;
  const command = expectedCommand(dependencies);
  const added = await dependencies.runCodex([
    "mcp",
    "add",
    REGISTRATION_NAME,
    "--",
    command.executable,
    ...command.args,
  ]);
  if (!added.started || added.exitCode !== 0) {
    return writeError(io, 5, "REGISTRATION_WRITE_FAILED", "Unable to add the ui-attach MCP registration.");
  }
  const verified = await readRegistration(dependencies);
  if (verified.status !== "current") {
    return writeError(io, 5, "REGISTRATION_VERIFY_FAILED", "The ui-attach MCP registration did not verify.");
  }
  return writeSetupResult(io, "install", "add", true, false, dependencies, backup);
}

async function runUninstall(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  const registration = await readRegistration(dependencies);
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the ui-attach MCP registration.");
  }
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "The existing ui-attach MCP registration is not managed by this checkout.",
    );
  }
  if (registration.status === "missing") {
    return writeSetupResult(io, "uninstall", "none", false, dryRun, dependencies, null);
  }
  if (dryRun) {
    return writeSetupResult(io, "uninstall", "remove", false, true, dependencies, null);
  }

  const backup = await createConfigBackup(io, dependencies);
  if (typeof backup === "number") return backup;
  const removed = await dependencies.runCodex(["mcp", "remove", REGISTRATION_NAME]);
  if (!removed.started || removed.exitCode !== 0) {
    return writeError(io, 5, "REGISTRATION_WRITE_FAILED", "Unable to remove the ui-attach MCP registration.");
  }
  const verified = await readRegistration(dependencies);
  if (verified.status !== "missing") {
    return writeError(io, 5, "REGISTRATION_VERIFY_FAILED", "The ui-attach MCP removal did not verify.");
  }
  return writeSetupResult(io, "uninstall", "remove", true, false, dependencies, backup);
}

async function createConfigBackup(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<CodexConfigBackup | number> {
  try {
    return await dependencies.backupCodexConfig();
  } catch {
    return writeError(
      io,
      5,
      "CONFIG_BACKUP_FAILED",
      "Unable to back up the Codex config; registration was not changed.",
    );
  }
}

async function readRegistration(dependencies: BridgeCliDependencies): Promise<RegistrationReadback> {
  const result = await dependencies.runCodex(["mcp", "get", REGISTRATION_NAME, "--json"]);
  if (!result.started) return { status: "unavailable", registration: null };
  if (result.exitCode !== 0) {
    return /No MCP server named ['"]ui-attach['"] found\.?/i.test(result.stderr)
      ? { status: "missing", registration: null }
      : { status: "error", registration: null };
  }
  const registration = parseRegistration(result.stdout);
  if (!registration) return { status: "error", registration: null };
  return {
    status: isExpectedRegistration(registration, dependencies) ? "current" : "drifted",
    registration,
  };
}

function parseRegistration(value: string): CodexRegistration | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const registration = parsed as Record<string, unknown>;
    const transport = registration.transport;
    if (typeof transport !== "object" || transport === null || Array.isArray(transport)) return null;
    const candidate = transport as Record<string, unknown>;
    if (
      typeof registration.name !== "string" ||
      typeof registration.enabled !== "boolean" ||
      candidate.type !== "stdio" ||
      typeof candidate.command !== "string" ||
      !Array.isArray(candidate.args) ||
      !candidate.args.every((item) => typeof item === "string") ||
      (candidate.cwd !== null && candidate.cwd !== undefined && typeof candidate.cwd !== "string") ||
      (candidate.env !== null && candidate.env !== undefined && !isStringRecord(candidate.env))
    ) {
      return null;
    }
    return {
      name: registration.name,
      enabled: registration.enabled,
      transport: {
        type: "stdio",
        command: candidate.command,
        args: candidate.args as string[],
        env: isStringRecord(candidate.env) ? candidate.env : null,
        cwd: typeof candidate.cwd === "string" ? candidate.cwd : null,
      },
    };
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isExpectedRegistration(
  registration: CodexRegistration,
  dependencies: BridgeCliDependencies,
): boolean {
  const expected = expectedCommand(dependencies);
  return (
    registration.name === REGISTRATION_NAME &&
    registration.enabled &&
    samePath(registration.transport.command, expected.executable) &&
    registration.transport.args.length === expected.args.length &&
    registration.transport.args.every((arg, index) => (
      index === 0 ? samePath(arg, expected.args[0] ?? "") : arg === expected.args[index]
    )) &&
    registration.transport.cwd === null &&
    (registration.transport.env === null || Object.keys(registration.transport.env).length === 0)
  );
}

function expectedCommand(dependencies: BridgeCliDependencies): {
  executable: string;
  args: string[];
} {
  const transport = createMeanThisMcpDescriptor(
    dependencies.nodePath,
    dependencies.entryPath,
  ).transport;
  return { executable: transport.command, args: transport.args };
}

function samePath(left: string, right: string): boolean {
  const normalizePath = (value: string) => normalize(resolve(value)).replaceAll("\\", "/");
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function writeSetupResult(
  io: BridgeCliIo,
  command: "install" | "uninstall",
  action: "add" | "remove" | "none",
  changed: boolean,
  dryRun: boolean,
  dependencies: BridgeCliDependencies,
  configBackup: CodexConfigBackup | null,
): number {
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: `ui-attach.bridge-${command}`,
    ok: true,
    data: {
      action,
      changed,
      dryRun,
      configBackup,
      registrationName: REGISTRATION_NAME,
      command: expectedCommand(dependencies),
    },
  });
}

function writeJson(io: BridgeCliIo, value: unknown): number {
  io.writeStdout(`${JSON.stringify(value)}\n`);
  return 0;
}

function writeError(
  io: BridgeCliIo,
  exitCode: number,
  code: string,
  message: string,
): number {
  io.writeStderr(`${JSON.stringify({
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.error",
    ok: false,
    error: { code, message },
  })}\n`);
  return exitCode;
}

function createDefaultDependencies(): BridgeCliDependencies {
  let codexCommand: Promise<CommandSpec | null> | null = null;
  return {
    nodePath: process.execPath,
    entryPath: fileURLToPath(new URL("./index.js", import.meta.url)),
    pathExists,
    probeLoopback,
    backupCodexConfig,
    async approveConnectionRequest(requestId, approvalMode, approvalKey) {
      const agentToken = await loadOrCreateLocalBridgeAgentToken();
      const expectedOwnerIdentity = loadLocalBridgeOwnerIdentity();
      return approveHttpLocalBridgeConnectionRequest(
        UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
        agentToken,
        requestId,
        approvalMode,
        approvalKey,
        { expectedOwnerIdentity },
      );
    },
    async runCodex(args) {
      codexCommand ??= resolveCodexCommand();
      const command = await codexCommand;
      if (!command) return { started: false, exitCode: null, stdout: "", stderr: "" };
      return runProcess(command.executable, [...command.prefixArgs, ...args], PROCESS_TIMEOUT_MS);
    },
  };
}

async function backupCodexConfig(): Promise<CodexConfigBackup> {
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  const source = join(codexHome, "config.toml");
  if (!await pathExists(source)) return { status: "not_found", path: null };
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
  const destination = join(
    codexHome,
    `config.toml.bak-ui-attach-${timestamp}-${process.pid}`,
  );
  await copyFile(source, destination);
  return { status: "created", path: destination };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function probeLoopback(): Promise<LoopbackProbeStatus> {
  try {
    const response = await fetch(`${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return "unexpected";
    const value = await response.json() as unknown;
    return isExpectedHealth(value) ? "ready" : "unexpected";
  } catch {
    return "not_running";
  }
}

function isExpectedHealth(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return (
    Object.keys(health).sort().join(",") === "kind,ok,schemaVersion,sharing" &&
    health.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    health.kind === "ui-attach.local-bridge-health" &&
    health.ok === true &&
    health.sharing === "owner-proxy-v1"
  );
}

interface CommandSpec {
  executable: string;
  prefixArgs: string[];
}

async function resolveCodexCommand(): Promise<CommandSpec | null> {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured && isAbsolute(configured) && await pathExists(configured)) {
    return { executable: configured, prefixArgs: [] };
  }

  if (process.platform === "win32") {
    const executables = await findCommands("codex.exe");
    if (executables[0]) return { executable: executables[0], prefixArgs: [] };
    const shims = await findCommands("codex.cmd");
    for (const shim of shims) {
      const entry = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (await pathExists(entry)) return { executable: process.execPath, prefixArgs: [entry] };
    }
    return null;
  }

  const commands = await runProcess("which", ["codex"], 2_000);
  const executable = commands.started && commands.exitCode === 0
    ? commands.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : undefined;
  return executable ? { executable, prefixArgs: [] } : null;
}

async function findCommands(name: string): Promise<string[]> {
  const result = await runProcess("where.exe", [name], 2_000);
  return result.started && result.exitCode === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
}

function runProcess(executable: string, args: string[], timeoutMs: number): Promise<CodexProcessResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: CodexProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const append = (current: string, chunk: Buffer): string | null => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") <= MAX_PROCESS_OUTPUT_BYTES ? next : null;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const next = append(stdout, chunk);
      if (next === null) child.kill();
      else stdout = next;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = append(stderr, chunk);
      if (next === null) child.kill();
      else stderr = next;
    });
    child.once("error", () => finish({ started: false, exitCode: null, stdout: "", stderr: "" }));
    child.once("close", (exitCode) => finish({ started: true, exitCode, stdout, stderr }));
    const timeout = setTimeout(() => {
      child.kill();
      finish({ started: true, exitCode: null, stdout, stderr: "" });
    }, timeoutMs);
  });
}
