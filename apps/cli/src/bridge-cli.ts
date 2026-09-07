import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  type LocalBridgeApprovalMode,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
  parseLocalBridgeConnectionCode,
} from "@meanthis/schema";
import {
  fingerprintLocalBridgeAgentToken,
  inspectLocalBridgeAgentToken,
  loadOrCreateLocalBridgeAgentToken,
  LocalBridgeAgentTokenRotationCommittedButUnverifiedError,
  LocalBridgeAgentTokenRotationRequiredError,
  readLocalBridgeAgentToken,
  rotateLocalBridgeAgentToken,
  type LocalBridgeAgentTokenInspection,
  validateLocalBridgeAgentToken,
} from "./local-bridge-agent-token.js";
import {
  ensureDetachedLocalBridgeMcpHttpOwner,
  inspectLocalBridgeMcpHttpOwner,
  LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER,
  LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER_GUIDANCE,
  loadLocalBridgeMcpHttpOwnerIdentity,
  LocalBridgeMcpHttpLegacyForegroundOwnerError,
  LocalBridgeMcpHttpUnverifiedListenerError,
} from "./local-bridge-mcp-http-owner.js";
import {
  inspectLocalBridgeMcpHttpToken,
  loadOrCreateLocalBridgeMcpHttpToken,
  LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError,
  LocalBridgeMcpHttpTokenRotationRequiredError,
  readLocalBridgeMcpHttpToken,
  rotateLocalBridgeMcpHttpToken,
  type LocalBridgeMcpHttpTokenInspection,
} from "./local-bridge-mcp-http-token.js";
import {
  createSanitizedLocalBridgeOwnerEnvironment,
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
} from "./local-bridge-owner.js";
import {
  approveHttpLocalBridgeConnectionRequest,
  createCaptureListCliCommand,
  createHttpLocalBridgeReader,
  LocalBridgeConnectionInvitationExpiredError,
} from "./local-bridge-mcp.js";
import type { LocalBridgeConnectionApproval } from "./local-bridge.js";
import {
  installLocalBridgeNativeHost,
  LocalBridgeNativeHostInstallError,
} from "./local-bridge-native-host-install.js";
import {
  createMeanThisMcpDescriptor,
  createMeanThisMcpHostSetup,
  createMeanThisStdioCompatibilityDescriptor,
  MEANTHIS_MCP_HTTP_TOKEN_ENV_VAR,
  MEANTHIS_MCP_HTTP_URL,
  MEANTHIS_MCP_REGISTRATION_NAME,
  type MeanThisMcpHost,
} from "./mcp-host-config.js";

const REGISTRATION_NAME = MEANTHIS_MCP_REGISTRATION_NAME;
const LEGACY_REGISTRATION_NAME = "ui-attach";
const STANDALONE_RESOLVER_REGISTRATION_NAME = "meanthis-source-resolver";
const PROCESS_TIMEOUT_MS = 10_000;
const BROWSER_OWNER_STARTUP_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const PROCESS_TERMINATION_TIMEOUT_MS = 2_000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_TERMINATION_POLL_MS = 25;
const BRIDGE_PROFILE_LOCK_FILE = ".meanthis-bridge-profile.lock";
const BRIDGE_PROFILE_RECLAIM_LOCK_FILE = ".meanthis-bridge-profile.reclaim.lock";
const BRIDGE_PROFILE_LOCK_TTL_MS = 5 * 60_000;

type BridgeCommand =
  | "accept"
  | "config"
  | "doctor"
  | "install"
  | "install-native-host"
  | "launch"
  | "rotate-agent-token"
  | "rotate-mcp-token"
  | "start"
  | "uninstall";
type RegistrationStatus =
  | "current"
  | "legacy"
  | "drifted"
  | "missing"
  | "unavailable"
  | "termination_unconfirmed"
  | "error";
export type LoopbackProbeStatus = "ready" | "not_running" | "unexpected";
export type McpHttpOwnerProbeStatus =
  | "ready"
  | "not_running"
  | "stale_build"
  | "legacy_foreground"
  | "unverified_listener"
  | "unexpected";

export interface BridgeCliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface CodexProcessResult {
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  terminationStatus?: "confirmed" | "termination_unconfirmed";
  terminationReason?: "timeout" | "output_limit";
}

export interface RunProcessSpawnOptions {
  shell: false;
  windowsHide: true;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export interface RunProcessChild {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onceError(listener: (error: Error) => void): void;
  onceClose(listener: (exitCode: number | null) => void): void;
}

export interface RunProcessOptions {
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: RunProcessSpawnOptions,
  ) => RunProcessChild;
  terminateProcessTree?: (child: RunProcessChild, timeoutMs: number) => Promise<boolean>;
  terminationTimeoutMs?: number;
}

export interface BridgeCliDependencies {
  nodePath: string;
  entryPath: string;
  brokerEntryPath: string;
  standaloneResolverEntryPath: string;
  pathExists(path: string): Promise<boolean>;
  probeBrowserOwner(): Promise<LoopbackProbeStatus>;
  probeMcpHttpOwner(token: string): Promise<McpHttpOwnerProbeStatus>;
  inspectAgentCredential(): Promise<LocalBridgeAgentTokenInspection>;
  inspectMcpHttpCredential(): Promise<LocalBridgeMcpHttpTokenInspection>;
  loadOrCreateMcpHttpToken(): Promise<string>;
  readAgentToken(): Promise<string>;
  readMcpHttpToken(): Promise<string>;
  rotateAgentToken(): Promise<string>;
  rotateMcpHttpToken(): Promise<string>;
  acquireBridgeProfileLock(): Promise<() => Promise<void>>;
  backupCodexConfig(): Promise<CodexConfigBackup>;
  runCodex(args: string[]): Promise<CodexProcessResult>;
  ensureBrowserOwner(expectedAgentToken?: string): Promise<void>;
  ensureMcpHttpOwner(token: string): Promise<void>;
  approveConnectionRequest(
    requestId: string,
    approvalMode: LocalBridgeApprovalMode,
    approvalKey: string,
  ): Promise<LocalBridgeConnectionApproval>;
  installNativeHost?(): Promise<{ status: "installed" | "current"; browsers: Array<"chrome" | "edge"> }>;
}

export interface CodexConfigBackup {
  status: "created" | "not_found";
  path: string | null;
}

export interface MeanThisBridgeProfileLockOptions {
  codexHome?: string;
  now?: () => number;
  pid?: number;
  ttlMs?: number;
  nonce?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  processInstanceId?: string;
  readProcessInstanceId?: (pid: number) => Promise<string | null>;
}

export interface SecureCodexConfigBackupOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  applyWindowsAcl?: (path: string, environment: NodeJS.ProcessEnv) => Promise<void>;
}

export class MeanThisBridgeProfileLockError extends Error {
  constructor(readonly status: "active" | "invalid" | "reclaim_in_progress" | "io_error") {
    super("MeanThis bridge profile lock is unavailable.");
    this.name = "MeanThisBridgeProfileLockError";
  }
}

interface BridgeProfileLockRecord {
  kind: "meanthis-bridge-profile-lock-v1";
  pid: number;
  nonce: string;
  processInstanceId: string;
  createdAt: string;
  expiresAt: string;
}

interface BridgeProfileLockFileIdentity {
  dev: number;
  ino: number;
  size: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
}

type BridgeProfileLockFileInspection =
  | { status: "missing" }
  | { status: "unsafe" }
  | {
      status: "regular";
      identity: BridgeProfileLockFileIdentity;
      record: BridgeProfileLockRecord | null;
      changedAtMs: number;
    };

interface ParsedBridgeArguments {
  command: BridgeCommand;
  host: MeanThisMcpHost | null;
  dryRun: boolean;
  requestId: string | null;
  approvalMode: LocalBridgeApprovalMode | null;
  approvalKey: string | null;
}

interface CodexStdioTransport {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string> | null;
  envVars: string[];
  cwd: string | null;
  hasUnknownFields: boolean;
}

interface CodexStreamableHttpTransport {
  type: "streamable_http";
  url: string;
  bearerTokenEnvVar: string | null;
  httpHeaders: Record<string, string> | null;
  envHttpHeaders: Record<string, string> | null;
  hasUnknownFields: boolean;
}

interface CodexRegistration {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  startupTimeoutSec: number | null;
  toolTimeoutSec: number | null;
  authStatus: string | null;
  hasAuthStatus: boolean;
  enabledTools: string[] | null;
  disabledTools: string[] | null;
  hasUnknownFields: boolean;
  transport: CodexStdioTransport | CodexStreamableHttpTransport;
}

interface RegistrationReadback {
  status: RegistrationStatus;
  registration: CodexRegistration | null;
  terminationReason?: "timeout" | "output_limit";
}

interface RegistrationMutation {
  name: string;
  before: RegistrationReadback;
}

interface RegistrationRecovery {
  status: "restored" | "not_required" | "manual_required";
  configBackup: CodexConfigBackup;
  outcomes: RegistrationRecoveryOutcome[];
}

interface RegistrationRecoveryOutcome {
  registrationName: string;
  status: "restored" | "manual_required";
  reason?: "termination_unconfirmed";
}

interface RegistrationRemovalResult {
  status: "removed" | "conflict" | "failed" | "termination_unconfirmed";
  terminationReason?: "timeout" | "output_limit";
}

interface RegistrationMutationFailureOptions {
  terminationUnconfirmed?: boolean;
  terminationReason?: "timeout" | "output_limit";
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

  if (parsed.command === "config") return runConfig(io, parsed.host!, dependencies);
  if (parsed.command === "doctor") return runDoctor(io, dependencies);
  if (parsed.command === "start") return runStart(io, dependencies);
  if (parsed.command === "install-native-host") return runInstallNativeHost(io, dependencies);
  if (parsed.command === "accept") {
    return runConnectionAcceptance(
      io,
      dependencies,
      parsed.requestId!,
      parsed.approvalMode!,
      parsed.approvalKey!,
    );
  }
  if (parsed.host !== "codex") return writeHostInstallNotAutomated(io, parsed.host!);
  if (parsed.command === "install") return runInstall(io, dependencies, parsed.dryRun);
  if (parsed.command === "uninstall") return runUninstall(io, dependencies, parsed.dryRun);
  if (parsed.command === "launch") return runLaunch(io);
  if (parsed.command === "rotate-agent-token") return runRotateAgentToken(io, dependencies);
  return runRotateMcpToken(io, dependencies);
}

export function renderBridgeHelp(): string {
  return [
    "MeanThis host-neutral MCP companion setup",
    "",
    "Usage:",
    "  meanthis bridge accept <connection-code> --json",
    "  meanthis bridge config --host <codex|claude-code|vscode|cursor> --json",
    "  meanthis bridge doctor --json",
    "  meanthis bridge install --host codex [--dry-run] --json",
    "  meanthis bridge install-native-host --json",
    "  meanthis bridge start --json",
    "  meanthis bridge launch --host codex --json",
    "  meanthis bridge rotate-agent-token --host codex --json",
    "  meanthis bridge rotate-mcp-token --host codex --json",
    "  meanthis bridge uninstall --host codex [--dry-run] --json",
    "",
    "Commands:",
    "  accept            Accept one browser-created connection invitation.",
    "  config            Generate the thin stdio broker descriptor for one host.",
    "  doctor            Inspect credentials, registrations, and both local owners without repair.",
    "  install           Install the exact stdio broker registration and start both local owners.",
    "  install-native-host  Register the current-user Chrome/Edge companion used for one-click startup.",
    "  start             Start or reuse both exact-build owners without changing host configuration.",
    "  launch            Deprecated fail-safe; start the bridge, then restart the host or open a fresh task.",
    "  rotate-agent-token  Explicitly rotate both local credentials after Agent-key exposure or ACL drift.",
    "  rotate-mcp-token  Explicitly rotate the MCP bearer; restart existing tasks afterward.",
    "  uninstall         Remove only the exact managed stdio broker registration.",
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
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (!isBridgeCommand(parsed.positionals[0])) {
    throw new Error("Invalid command.");
  }
  const command = parsed.positionals[0];
  const expectedPositionals = command === "accept" ? 2 : 1;
  if (parsed.positionals.length !== expectedPositionals) {
    throw new Error("Invalid command.");
  }
  const optionNames = Object.keys(parsed.values);
  let host: MeanThisMcpHost | null = null;
  let requestId: string | null = null;
  let approvalMode: LocalBridgeApprovalMode | null = null;
  let approvalKey: string | null = null;

  if (command === "config") {
    if (!isMeanThisMcpHost(parsed.values.host)
      || optionNames.some((name) => !["host", "json"].includes(name))) {
      throw new Error("Invalid config option.");
    }
    host = parsed.values.host;
  } else if (command === "doctor" || command === "start") {
    if ((parsed.values.host !== undefined && parsed.values.host !== "codex")
      || optionNames.some((name) => !["host", "json"].includes(name))) {
      throw new Error(`Invalid ${command} option.`);
    }
    host = "codex";
  } else if (command === "install-native-host") {
    if (optionNames.some((name) => name !== "json")) {
      throw new Error("Invalid install-native-host option.");
    }
  } else if (command === "accept") {
    const connection = parseLocalBridgeConnectionCode(parsed.positionals[1]);
    if (!connection || optionNames.some((name) => name !== "json")) {
      throw new Error("Invalid connection invitation option.");
    }
    requestId = connection.requestId;
    approvalMode = connection.approvalMode;
    approvalKey = connection.approvalKey;
  } else {
    const legacyCodex = parsed.values.codex === true;
    if (legacyCodex && parsed.values.host !== undefined) throw new Error("Choose one host option.");
    host = legacyCodex ? "codex" : isMeanThisMcpHost(parsed.values.host) ? parsed.values.host : null;
    if (!host) throw new Error("Expected --host.");
    const allowed = command === "install" || command === "uninstall"
      ? ["codex", "host", "dry-run", "json"]
      : ["codex", "host", "json"];
    if (optionNames.some((name) => !allowed.includes(name))) throw new Error("Invalid setup option.");
  }

  return {
    command,
    host,
    dryRun: parsed.values["dry-run"] === true,
    requestId,
    approvalMode,
    approvalKey,
  };
}

function isBridgeCommand(value: string): value is BridgeCommand {
  return value === "accept"
    || value === "config"
    || value === "doctor"
    || value === "install"
    || value === "install-native-host"
    || value === "launch"
    || value === "rotate-agent-token"
    || value === "rotate-mcp-token"
    || value === "start"
    || value === "uninstall";
}

async function runInstallNativeHost(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  if (!dependencies.installNativeHost) {
    return writeError(io, 5, "NATIVE_HOST_INSTALL_FAILED", "The local companion installer is unavailable.");
  }
  try {
    const result = await dependencies.installNativeHost();
    return writeJson(io, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.native-host-installed",
      ok: true,
      data: result,
    });
  } catch (error) {
    const code = error instanceof LocalBridgeNativeHostInstallError
      ? error.code
      : "INSTALL_FAILED";
    return writeError(
      io,
      5,
      code === "REGISTRATION_DRIFT" ? "NATIVE_HOST_REGISTRATION_DRIFT" : "NATIVE_HOST_INSTALL_FAILED",
      code === "REGISTRATION_DRIFT"
        ? "A different native host registration already owns the MeanThis host name."
        : "Unable to install the local browser companion.",
    );
  }
}

function isMeanThisMcpHost(value: unknown): value is MeanThisMcpHost {
  return value === "codex" || value === "claude-code" || value === "vscode" || value === "cursor";
}

function runConfig(
  io: BridgeCliIo,
  host: MeanThisMcpHost,
  dependencies: BridgeCliDependencies,
): number {
  const descriptor = createManagedBrokerDescriptor(dependencies);
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-config",
    ok: true,
    data: { descriptor, setup: createMeanThisMcpHostSetup(host, descriptor) },
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

async function runConnectionAcceptance(
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
      kind: "ui-attach.bridge-connection-accepted",
      ok: true,
      data: approval,
      nextAction: {
        kind: "list_captures",
        reason: "Discover shared captures before answering questions about captured A-Z targets.",
        preferred: { transport: "mcp", tool: "meanthis_list_captures", arguments: {} },
        fallback: { transport: "cli", ...createCaptureListCliCommand() },
      },
    });
  } catch (error) {
    if (error instanceof LocalBridgeConnectionInvitationExpiredError) {
      return writeError(
        io,
        5,
        error.code,
        error.message,
      );
    }
    return writeError(
      io,
      5,
      "CONNECTION_INVITATION_REJECTED",
      "The browser-created connection invitation was not accepted.",
    );
  }
}

async function runDoctor(io: BridgeCliIo, dependencies: BridgeCliDependencies): Promise<number> {
  const [
    cliBuilt,
    browserOwner,
    registration,
    legacyRegistration,
    resolverRegistration,
    agentCredential,
    inspectedCredential,
  ] = await Promise.all([
    dependencies.pathExists(dependencies.brokerEntryPath),
    dependencies.probeBrowserOwner(),
    readRegistration(dependencies, REGISTRATION_NAME),
    readRegistration(dependencies, LEGACY_REGISTRATION_NAME),
    readRegistration(dependencies, STANDALONE_RESOLVER_REGISTRATION_NAME),
    dependencies.inspectAgentCredential(),
    dependencies.inspectMcpHttpCredential(),
  ]);

  let credential = inspectedCredential;
  let mcpHttpOwner: McpHttpOwnerProbeStatus | "blocked" = "blocked";
  if (credential.status === "ready") {
    let token: string | null = null;
    try {
      token = await dependencies.readMcpHttpToken();
    } catch {
      credential = { kind: credential.kind, status: "unavailable" };
    }
    if (token) {
      try {
        mcpHttpOwner = await dependencies.probeMcpHttpOwner(token);
      } catch {
        mcpHttpOwner = "unexpected";
      }
    }
  }

  const codexAvailable = [registration, legacyRegistration, resolverRegistration]
    .every((value) => value.status !== "unavailable");
  const registrationReady = cliBuilt &&
    registration.status === "current" &&
    legacyRegistration.status === "missing" &&
    resolverRegistration.status === "missing" &&
    agentCredential.status === "ready" &&
    credential.status === "ready";
  const runtimeActive = browserOwner === "ready" && mcpHttpOwner === "ready";
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-doctor",
    ok: true,
    data: {
      registrationReady,
      runtimeActive,
      requiresFreshHostProcess: false,
      registrationName: REGISTRATION_NAME,
      legacyRegistrationName: LEGACY_REGISTRATION_NAME,
      standaloneResolverRegistrationName: STANDALONE_RESOLVER_REGISTRATION_NAME,
      registration: publicBrokerRegistration(dependencies),
      checks: {
        cliBuilt: {
          status: cliBuilt ? "pass" : "missing",
          next: cliBuilt ? null : "Run npm run build from the MeanThis checkout.",
        },
        codexCli: {
          status: codexAvailable ? "pass" : "missing",
          next: codexAvailable ? null : "Install Codex CLI or make codex available on PATH.",
        },
        registration: {
          status: registration.status,
          next: registration.status === "current"
            ? null
            : registration.status === "termination_unconfirmed"
              ? "Inspect the Codex MCP registrations manually before running another setup command."
              : registration.status === "drifted"
                ? "Resolve the existing meanthis MCP registration before installing this checkout."
                : "Run meanthis bridge install --host codex --json.",
        },
        legacyRegistration: registrationCheck(
          legacyRegistration.status,
          "Run meanthis bridge install --host codex --json to remove the managed ui-attach registration.",
        ),
        standaloneResolverRegistration: registrationCheck(
          resolverRegistration.status,
          "Run meanthis bridge install --host codex --json to remove the standalone resolver registration.",
        ),
        agentCredential: {
          status: agentCredential.status,
          next: agentCredential.status === "ready"
            ? null
            : agentCredential.status === "insecure" || agentCredential.status === "invalid"
              ? "Run meanthis bridge rotate-agent-token --host codex --json. This also rotates the MCP bearer so both owners turn over together."
              : agentCredential.status === "missing"
                ? "Run meanthis bridge start --json."
                : "Inspect the local Agent credential before retrying bridge setup.",
        },
        credential: {
          status: credential.status,
          next: credential.status === "ready"
            ? null
            : credential.status === "insecure"
              ? registration.status === "drifted"
                ? "Resolve the drifted meanthis registration, then run meanthis bridge rotate-mcp-token --host codex --json."
                : "Run meanthis bridge rotate-mcp-token --host codex --json."
              : "Run meanthis bridge start --json.",
        },
        browserOwner: {
          status: browserOwner,
          origin: UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
          next: browserOwner === "ready" ? null : "Run meanthis bridge start --json.",
        },
        mcpHttpOwner: {
          status: mcpHttpOwner,
          url: MEANTHIS_MCP_HTTP_URL,
          next: mcpHttpOwner === "ready"
            ? null
            : mcpHttpOwner === "legacy_foreground"
              ? "Stop the foreground meanthis mcp-http process that owns 127.0.0.1:38472, then run meanthis bridge start --json."
              : mcpHttpOwner === "unverified_listener"
                ? LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER_GUIDANCE
                : "Run meanthis bridge start --json.",
        },
        hostEnvironment: {
          status: "not_required",
          next: null,
        },
      },
    },
  });
}

function registrationCheck(status: RegistrationStatus, next: string) {
  return {
    status,
    next: status === "current"
      ? next
      : status === "termination_unconfirmed"
        ? "Inspect the Codex MCP registrations manually before running another setup command."
        : status === "drifted"
          ? "Resolve the drifted registration manually before installing MeanThis."
          : null,
  };
}

async function runStart(io: BridgeCliIo, dependencies: BridgeCliDependencies): Promise<number> {
  if (!await dependencies.pathExists(dependencies.brokerEntryPath)) {
    return writeError(io, 5, "CLI_NOT_BUILT", "Build MeanThis before starting its local bridge.");
  }
  return runWithProfileLock(io, dependencies, (lockedIo) => runStartLocked(lockedIo, dependencies));
}

async function runStartLocked(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  let token: string;
  try {
    token = await dependencies.loadOrCreateMcpHttpToken();
  } catch (error) {
    return writeCredentialPreparationError(io, error);
  }
  const ownerStatus = await ensureOwners(dependencies, token);
  if (ownerStatus !== "ready") {
    return writeOwnerStartError(
      io,
      ownerStatus,
      "The MeanThis local bridge owners did not start.",
    );
  }
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-start",
    ok: true,
    data: {
      runtimeActive: true,
      browserOrigin: UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
      mcpHttpUrl: MEANTHIS_MCP_HTTP_URL,
    },
  });
}

async function runInstall(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  if (!await dependencies.pathExists(dependencies.brokerEntryPath)) {
    return writeError(io, 5, "CLI_NOT_BUILT", "Build MeanThis before installing its MCP bridge.");
  }
  if (dryRun) return runInstallLocked(io, dependencies, true);
  return runWithProfileLock(
    io,
    dependencies,
    (lockedIo) => runInstallLocked(lockedIo, dependencies, false),
  );
}

async function runInstallLocked(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  const [registration, legacyRegistration, resolverRegistration] = await Promise.all([
    readRegistration(dependencies, REGISTRATION_NAME),
    readRegistration(dependencies, LEGACY_REGISTRATION_NAME),
    readRegistration(dependencies, STANDALONE_RESOLVER_REGISTRATION_NAME),
  ]);
  const registrations = [registration, legacyRegistration, resolverRegistration];
  const unconfirmedReadback = registrations.find(
    (value) => value.status === "termination_unconfirmed",
  );
  if (unconfirmedReadback) {
    return writeUnconfirmedProcessError(
      io,
      unconfirmedReadback.terminationReason,
      "A Codex registration read did not terminate cleanly, so installation was not attempted.",
    );
  }
  if (registrations.some((value) => value.status === "unavailable")) {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registrations.some((value) => value.status === "error")) {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the MeanThis MCP registrations.");
  }
  if (
    registration.status === "drifted" ||
    legacyRegistration.status === "drifted" ||
    resolverRegistration.status === "drifted"
  ) {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "A different MeanThis or legacy MCP registration already exists.",
    );
  }

  const shouldReplacePrimary = registration.status === "legacy";
  const shouldAddPrimary = registration.status === "missing" || shouldReplacePrimary;
  const shouldRemoveLegacy = legacyRegistration.status === "current";
  const shouldRemoveResolver = resolverRegistration.status === "current";
  const changed = shouldAddPrimary || shouldRemoveLegacy || shouldRemoveResolver;
  const action = shouldReplacePrimary || shouldRemoveLegacy || shouldRemoveResolver
    ? "migrate"
    : shouldAddPrimary
      ? "add"
      : "none";
  if (dryRun) {
    return writeSetupResult(io, dependencies, "install", action, false, true, null, {
      replacedLegacyRegistration: false,
      removedLegacyRegistration: false,
      removedStandaloneResolverRegistration: false,
      planned: {
        replaceLegacyRegistration: shouldReplacePrimary,
        removeLegacyRegistration: shouldRemoveLegacy,
        removeStandaloneResolverRegistration: shouldRemoveResolver,
      },
      runtimeActive: false,
      requiresFreshHostProcess: true,
    });
  }

  let backup: CodexConfigBackup | null = null;
  if (changed) {
    const createdBackup = await createConfigBackup(io, dependencies);
    if (typeof createdBackup === "number") return createdBackup;
    backup = createdBackup;
  }

  let token: string;
  try {
    token = await dependencies.loadOrCreateMcpHttpToken();
  } catch (error) {
    return writeCredentialPreparationError(io, error);
  }
  const ownerStatus = await ensureOwners(dependencies, token);
  if (ownerStatus !== "ready") {
    return writeOwnerStartError(
      io,
      ownerStatus,
      "The MeanThis local bridge owners did not start.",
    );
  }

  const mutations: RegistrationMutation[] = [];
  if (shouldAddPrimary) {
    const expectedStatus = shouldReplacePrimary ? "legacy" : "missing";
    const latest = await readRegistration(dependencies, REGISTRATION_NAME);
    if (latest.status === "termination_unconfirmed") {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
        "The Codex registration read did not terminate cleanly.",
        { terminationUnconfirmed: true, terminationReason: latest.terminationReason },
      );
    }
    if (latest.status !== expectedStatus) {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "REGISTRATION_CONFLICT",
        "The meanthis registration changed before the stdio broker registration could be installed.",
      );
    }
    mutations.push({ name: REGISTRATION_NAME, before: latest });
    const setup = createMeanThisMcpHostSetup("codex", createManagedBrokerDescriptor(dependencies));
    if (!setup.command) {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "REGISTRATION_WRITE_FAILED",
        "Unable to build the Codex registration command.",
      );
    }
    const added = await dependencies.runCodex(setup.command.args);
    if (isTerminationUnconfirmed(added)) {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
        "The Codex process tree could not be confirmed terminated after adding the meanthis MCP registration.",
        { terminationUnconfirmed: true, terminationReason: added.terminationReason },
      );
    }
    if (!added.started || added.exitCode !== 0) {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "REGISTRATION_WRITE_FAILED",
        "Unable to add the meanthis MCP registration.",
      );
    }
    const verified = await readRegistration(dependencies, REGISTRATION_NAME);
    if (verified.status === "termination_unconfirmed") {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
        "The Codex verification process tree could not be confirmed terminated.",
        { terminationUnconfirmed: true, terminationReason: verified.terminationReason },
      );
    }
    if (verified.status !== "current") {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        "REGISTRATION_VERIFY_FAILED",
        "The meanthis MCP registration did not verify.",
      );
    }
  }

  if (shouldRemoveLegacy) {
    const removed = await removeManagedRegistration(
      dependencies,
      LEGACY_REGISTRATION_NAME,
      "current",
      mutations,
    );
    if (removed.status !== "removed") {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        removed.status === "termination_unconfirmed"
          ? "CODEX_PROCESS_TERMINATION_UNCONFIRMED"
          : removed.status === "conflict" ? "REGISTRATION_CONFLICT" : "REGISTRATION_WRITE_FAILED",
        removed.status === "conflict"
          ? "The ui-attach registration changed before it could be removed."
          : removed.status === "termination_unconfirmed"
            ? "The Codex process tree could not be confirmed terminated while removing the legacy ui-attach registration."
            : "Unable to remove the legacy ui-attach registration.",
        removed.status === "termination_unconfirmed"
          ? { terminationUnconfirmed: true, terminationReason: removed.terminationReason }
          : undefined,
      );
    }
  }
  if (shouldRemoveResolver) {
    const removed = await removeManagedRegistration(
      dependencies,
      STANDALONE_RESOLVER_REGISTRATION_NAME,
      "current",
      mutations,
    );
    if (removed.status !== "removed") {
      return failRegistrationMutation(
        io,
        dependencies,
        mutations,
        backup!,
        removed.status === "termination_unconfirmed"
          ? "CODEX_PROCESS_TERMINATION_UNCONFIRMED"
          : removed.status === "conflict" ? "REGISTRATION_CONFLICT" : "REGISTRATION_WRITE_FAILED",
        removed.status === "conflict"
          ? "The standalone resolver registration changed before it could be removed."
          : removed.status === "termination_unconfirmed"
            ? "The Codex process tree could not be confirmed terminated while removing the standalone resolver registration."
            : "Unable to remove the standalone resolver registration.",
        removed.status === "termination_unconfirmed"
          ? { terminationUnconfirmed: true, terminationReason: removed.terminationReason }
          : undefined,
      );
    }
  }

  const [finalPrimary, finalLegacy, finalResolver] = await Promise.all([
    readRegistration(dependencies, REGISTRATION_NAME),
    readRegistration(dependencies, LEGACY_REGISTRATION_NAME),
    readRegistration(dependencies, STANDALONE_RESOLVER_REGISTRATION_NAME),
  ]);
  const finalUnconfirmed = [finalPrimary, finalLegacy, finalResolver].find(
    (value) => value.status === "termination_unconfirmed",
  );
  if (finalUnconfirmed) {
    return writeUnconfirmedProcessError(
      io,
      finalUnconfirmed.terminationReason,
      "A final Codex registration read did not terminate cleanly, so the committed state is unverified.",
      backup,
      mutations,
    );
  }
  if (
    finalPrimary.status !== "current" ||
    finalLegacy.status !== "missing" ||
    finalResolver.status !== "missing"
  ) {
    return writeError(
      io,
      5,
      "REGISTRATION_COMMITTED_BUT_UNVERIFIED",
      "MeanThis registration changes may be committed, but the final aggregate readback did not verify.",
      backup?.status === "created"
        ? "Inspect bridge doctor output and restore error.recovery.configBackup.path if needed."
        : "Inspect the Codex MCP registrations with meanthis bridge doctor --json.",
      {
        commit: { status: "committed_but_unverified" },
        recovery: { status: "manual_required", configBackup: backup },
      },
    );
  }

  return writeSetupResult(io, dependencies, "install", action, changed, false, backup, {
    replacedLegacyRegistration: shouldReplacePrimary,
    removedLegacyRegistration: shouldRemoveLegacy,
    removedStandaloneResolverRegistration: shouldRemoveResolver,
    runtimeActive: true,
    requiresFreshHostProcess: true,
  });
}

async function runUninstall(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return runUninstallLocked(io, dependencies, true);
  return runWithProfileLock(
    io,
    dependencies,
    (lockedIo) => runUninstallLocked(lockedIo, dependencies, false),
  );
}

async function runUninstallLocked(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  dryRun: boolean,
): Promise<number> {
  const registration = await readRegistration(dependencies, REGISTRATION_NAME);
  if (registration.status === "termination_unconfirmed") {
    return writeUnconfirmedProcessError(
      io,
      registration.terminationReason,
      "The Codex registration read did not terminate cleanly, so uninstall was not attempted.",
    );
  }
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the meanthis MCP registration.");
  }
  if (registration.status === "drifted" || registration.status === "legacy") {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "The existing meanthis MCP registration is not the managed stdio broker registration.",
    );
  }
  if (registration.status === "missing") {
    return writeSetupResult(io, dependencies, "uninstall", "none", false, dryRun, null);
  }
  if (dryRun) {
    return writeSetupResult(io, dependencies, "uninstall", "remove", false, true, null);
  }

  const backup = await createConfigBackup(io, dependencies);
  if (typeof backup === "number") return backup;
  const mutations: RegistrationMutation[] = [];
  const removed = await removeManagedRegistration(
    dependencies,
    REGISTRATION_NAME,
    "current",
    mutations,
  );
  if (removed.status !== "removed") {
    return failRegistrationMutation(
      io,
      dependencies,
      mutations,
      backup,
      removed.status === "termination_unconfirmed"
        ? "CODEX_PROCESS_TERMINATION_UNCONFIRMED"
        : removed.status === "conflict" ? "REGISTRATION_CONFLICT" : "REGISTRATION_WRITE_FAILED",
      removed.status === "conflict"
        ? "The meanthis registration changed before it could be removed."
        : removed.status === "termination_unconfirmed"
          ? "The Codex process tree could not be confirmed terminated while removing the meanthis MCP registration."
          : "Unable to remove the meanthis MCP registration.",
      removed.status === "termination_unconfirmed"
        ? { terminationUnconfirmed: true, terminationReason: removed.terminationReason }
        : undefined,
    );
  }
  return writeSetupResult(io, dependencies, "uninstall", "remove", true, false, backup, {
    requiresFreshHostProcess: true,
  });
}

function runLaunch(io: BridgeCliIo): number {
  return writeError(
    io,
    2,
    "HOST_LAUNCH_UNSUPPORTED",
    "The bridge launch command is deprecated and does not start or inject credentials into Codex.",
    "Run meanthis bridge start --json, then restart the Codex host or open a fresh task.",
  );
}

async function runRotateAgentToken(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  if (!await dependencies.pathExists(dependencies.brokerEntryPath)) {
    return writeError(io, 5, "CLI_NOT_BUILT", "Build MeanThis before rotating its credentials.");
  }
  return runWithProfileLock(
    io,
    dependencies,
    (lockedIo) => runRotateAgentTokenLocked(lockedIo, dependencies),
  );
}

async function runRotateAgentTokenLocked(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  const registration = await readRegistration(dependencies, REGISTRATION_NAME);
  if (registration.status === "termination_unconfirmed") {
    return writeUnconfirmedProcessError(
      io,
      registration.terminationReason,
      "The Codex registration read did not terminate cleanly, so credential rotation was not attempted.",
    );
  }
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the meanthis MCP registration.");
  }
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_NOT_READY",
      "The existing meanthis MCP registration is not managed by this MeanThis checkout.",
      "Resolve the drifted registration before rotating local bridge credentials.",
    );
  }

  let mcpToken: string;
  try {
    mcpToken = await dependencies.rotateMcpHttpToken();
  } catch (error) {
    if (error instanceof LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError) {
      return writeError(
        io,
        5,
        "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
        "The MCP HTTP credential may already be rotated, but its secure readback did not verify; Agent credential rotation was not attempted.",
        "Run meanthis bridge doctor --json before retrying meanthis bridge rotate-agent-token --host codex --json.",
      );
    }
    return writeError(
      io,
      5,
      "MCP_HTTP_CREDENTIAL_FAILED",
      "The MCP HTTP credential was not rotated; Agent credential rotation was not attempted.",
    );
  }

  let agentToken: string;
  try {
    agentToken = await dependencies.rotateAgentToken();
  } catch (error) {
    if (error instanceof LocalBridgeAgentTokenRotationCommittedButUnverifiedError) {
      return writeError(
        io,
        5,
        "BRIDGE_AGENT_CREDENTIAL_ROTATION_UNVERIFIED",
        "The MCP HTTP credential was rotated and the Agent credential may also have rotated, but its secure readback did not verify.",
        "Run meanthis bridge doctor --json before retrying meanthis bridge rotate-agent-token --host codex --json.",
      );
    }
    return writeError(
      io,
      5,
      "BRIDGE_AGENT_CREDENTIAL_ROTATION_FAILED",
      "The MCP HTTP credential was rotated, but Agent credential rotation did not complete.",
      "Retry meanthis bridge rotate-agent-token --host codex --json, then run meanthis bridge doctor --json.",
    );
  }

  let expectedAgentFingerprint: string;
  try {
    expectedAgentFingerprint = fingerprintLocalBridgeAgentToken(agentToken);
    const [agentCredential, liveAgentToken, mcpCredential, liveMcpToken] = await Promise.all([
      dependencies.inspectAgentCredential(),
      dependencies.readAgentToken(),
      dependencies.inspectMcpHttpCredential(),
      dependencies.readMcpHttpToken(),
    ]);
    if (
      agentCredential.status !== "ready" ||
      agentCredential.fingerprint !== expectedAgentFingerprint ||
      !equalVerifiedAgentTokens(liveAgentToken, agentToken) ||
      mcpCredential.status !== "ready" ||
      liveMcpToken !== mcpToken
    ) {
      throw new Error("post-rotation credential verification failed");
    }
  } catch {
    return writeError(
      io,
      5,
      "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
      "Both local credentials were rotated, but their secure readback did not verify.",
      "Run meanthis bridge doctor --json before retrying bridge setup.",
    );
  }

  if (registration.status !== "current") {
    let browserOwnerStatus: OwnerEnsureStatus = "ready";
    try {
      await dependencies.ensureBrowserOwner(agentToken);
    } catch (error) {
      browserOwnerStatus = error instanceof LocalBridgeAgentTokenRotationRequiredError
        ? "agent_rotation_required"
        : "failed";
    }
    if (browserOwnerStatus !== "ready") {
      return writeOwnerStartError(
        io,
        browserOwnerStatus,
        "Both credentials rotated, but the browser owner did not turn over to the new Agent credential.",
        "Run meanthis bridge doctor --json. If an older pre-marker browser owner still owns 127.0.0.1:38471, stop that process; then run meanthis bridge start --json and meanthis bridge install --host codex --json.",
        {
          partialState: {
            credentialRotation: "committed_and_initially_verified",
            browserOwner: "turnover_unverified",
            mcpHttpOwner: "not_started",
          },
        },
      );
    }
    try {
      const [
        registrationReadback,
        agentCredential,
        liveAgentToken,
        mcpCredential,
        liveMcpToken,
      ] =
        await Promise.all([
          readRegistration(dependencies, REGISTRATION_NAME),
          dependencies.inspectAgentCredential(),
          dependencies.readAgentToken(),
          dependencies.inspectMcpHttpCredential(),
          dependencies.readMcpHttpToken(),
        ]);
      if (registrationReadback.status === "termination_unconfirmed") {
        return writeUnconfirmedProcessError(
          io,
          registrationReadback.terminationReason,
          "Both credentials rotated and the browser owner turned over, but the final Codex registration read did not terminate cleanly.",
          null,
          [],
          {
            credentialRotation: "committed_and_initially_verified",
            browserOwner: {
              turnover: "completed",
              credentialWatch: "bounded_fail_closed",
              finalReadback: "process_termination_unconfirmed",
            },
            mcpHttpOwner: "not_started",
          },
        );
      }
      if (
        registrationReadback.status !== registration.status ||
        !isDeepStrictEqual(registrationReadback.registration, registration.registration) ||
        agentCredential.status !== "ready" ||
        agentCredential.fingerprint !== expectedAgentFingerprint ||
        !equalVerifiedAgentTokens(liveAgentToken, agentToken) ||
        mcpCredential.status !== "ready" ||
        liveMcpToken !== mcpToken
      ) {
        throw new Error("post-turnover state verification failed");
      }
    } catch {
      return writeError(
        io,
        5,
        "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
        "Both credentials rotated and the browser owner turned over, but final secure readback did not verify.",
        "Run meanthis bridge doctor --json before installing the broker registration.",
        {
          partialState: {
            credentialRotation: "committed_final_verification_failed",
            browserOwner: {
              turnover: "completed",
              credentialWatch: "bounded_fail_closed",
              finalReadback: "unverified",
            },
            mcpHttpOwner: "not_started",
          },
        },
      );
    }
    return writeJson(io, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.bridge-agent-token-rotated",
      ok: true,
      data: {
        agentCredentialRotated: true,
        mcpHttpCredentialRotated: true,
        browserOwnerActive: true,
        runtimeActive: false,
        registrationStatus: registration.status,
        requiresFreshHostProcess: true,
        next: "Run meanthis bridge install --host codex --json.",
      },
    });
  }

  const ownerStatus = await ensureOwners(dependencies, mcpToken, agentToken);
  if (ownerStatus !== "ready") {
    return writeOwnerStartError(
      io,
      ownerStatus,
      "Both credentials rotated, but the MeanThis owners did not restart.",
      "Run meanthis bridge doctor --json. If an older pre-marker browser owner still owns 127.0.0.1:38471, stop that process; then run meanthis bridge start --json and restart affected Codex tasks.",
      {
        partialState: {
          credentialRotation: "committed_and_initially_verified",
          ownerRestart: "unverified",
        },
      },
    );
  }
  try {
    const [
      registrationReadback,
      agentCredential,
      liveAgentToken,
      mcpCredential,
      liveMcpToken,
      owner,
    ] =
      await Promise.all([
        readRegistration(dependencies, REGISTRATION_NAME),
        dependencies.inspectAgentCredential(),
        dependencies.readAgentToken(),
        dependencies.inspectMcpHttpCredential(),
        dependencies.readMcpHttpToken(),
        dependencies.probeMcpHttpOwner(mcpToken),
      ]);
    if (registrationReadback.status === "termination_unconfirmed") {
      return writeUnconfirmedProcessError(
        io,
        registrationReadback.terminationReason,
        "The Codex verification process tree could not be confirmed terminated after credential rotation.",
        null,
        [],
        {
          credentialRotation: "committed_and_initially_verified",
          browserOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "process_termination_unconfirmed",
          },
          mcpHttpOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "process_termination_unconfirmed",
          },
        },
      );
    }
    if (
      registrationReadback.status !== "current" ||
      agentCredential.status !== "ready" ||
      agentCredential.fingerprint !== expectedAgentFingerprint ||
      !equalVerifiedAgentTokens(liveAgentToken, agentToken) ||
      mcpCredential.status !== "ready" ||
      liveMcpToken !== mcpToken ||
      owner !== "ready"
    ) {
      throw new Error("post-rotation runtime verification failed");
    }
  } catch {
    return writeError(
      io,
      5,
      "BRIDGE_CREDENTIAL_ROTATION_UNVERIFIED",
      "Both credentials rotated, but the registration, secure readback, or authenticated owner did not verify.",
      "Run meanthis bridge doctor --json, then meanthis bridge start --json and restart affected Codex tasks.",
      {
        partialState: {
          credentialRotation: "committed_final_verification_failed",
          browserOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
          mcpHttpOwner: {
            startOrReuse: "completed",
            credentialWatch: "bounded_fail_closed",
            finalReadback: "unverified",
          },
        },
      },
    );
  }

  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-agent-token-rotated",
    ok: true,
    data: {
      agentCredentialRotated: true,
      mcpHttpCredentialRotated: true,
      runtimeActive: true,
      requiresFreshHostProcess: true,
      next: "Restart affected Codex tasks or the Codex host before using MeanThis again.",
    },
  });
}

async function runRotateMcpToken(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  if (!await dependencies.pathExists(dependencies.brokerEntryPath)) {
    return writeError(io, 5, "CLI_NOT_BUILT", "Build MeanThis before rotating its credential.");
  }
  return runWithProfileLock(
    io,
    dependencies,
    (lockedIo) => runRotateMcpTokenLocked(lockedIo, dependencies),
  );
}

async function runRotateMcpTokenLocked(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<number> {
  const registration = await readRegistration(dependencies, REGISTRATION_NAME);
  if (registration.status === "termination_unconfirmed") {
    return writeUnconfirmedProcessError(
      io,
      registration.terminationReason,
      "The Codex registration read did not terminate cleanly, so credential rotation was not attempted.",
    );
  }
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the meanthis MCP registration.");
  }
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_NOT_READY",
      "The existing meanthis MCP registration is not managed by this MeanThis checkout.",
      "Resolve the drifted registration before rotating the credential.",
    );
  }
  let token: string;
  try {
    token = await dependencies.rotateMcpHttpToken();
  } catch (error) {
    if (error instanceof LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError) {
      return writeError(
        io,
        5,
        "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
        "The MCP HTTP credential may already be rotated, but its secure readback did not verify.",
        registration.status === "current"
          ? "Run meanthis bridge doctor --json, then meanthis bridge start --json and restart affected Codex tasks."
          : "Run meanthis bridge doctor --json, then meanthis bridge install --host codex --json.",
      );
    }
    return writeError(io, 5, "MCP_HTTP_CREDENTIAL_FAILED", "The MCP HTTP credential was not rotated.");
  }
  if (registration.status !== "current") {
    try {
      const [credential, liveToken] = await Promise.all([
        dependencies.inspectMcpHttpCredential(),
        dependencies.readMcpHttpToken(),
      ]);
      if (credential.status !== "ready" || liveToken !== token) {
        throw new Error("post-rotation verification failed");
      }
    } catch {
      return writeError(
        io,
        5,
        "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
        "The MCP HTTP credential was rotated, but its secure readback did not verify.",
        "Run meanthis bridge doctor --json before retrying installation.",
      );
    }
    return writeJson(io, {
      schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
      kind: "ui-attach.bridge-mcp-token-rotated",
      ok: true,
      data: {
        rotated: true,
        runtimeActive: false,
        registrationStatus: registration.status,
        requiresFreshHostProcess: true,
        next: "Run meanthis bridge install --host codex --json.",
      },
    });
  }

  const ownerStatus = await ensureOwners(dependencies, token);
  if (ownerStatus !== "ready") {
    return writeOwnerStartError(
      io,
      ownerStatus,
      "The credential rotated, but the MeanThis owners did not restart.",
      "Run meanthis bridge start --json.",
    );
  }
  try {
    const [registrationReadback, credential, liveToken, owner] = await Promise.all([
      readRegistration(dependencies, REGISTRATION_NAME),
      dependencies.inspectMcpHttpCredential(),
      dependencies.readMcpHttpToken(),
      dependencies.probeMcpHttpOwner(token),
    ]);
    if (registrationReadback.status === "termination_unconfirmed") {
      return writeUnconfirmedProcessError(
        io,
        registrationReadback.terminationReason,
        "The Codex verification process tree could not be confirmed terminated after credential rotation.",
      );
    }
    if (
      registrationReadback.status !== "current" ||
      credential.status !== "ready" ||
      liveToken !== token ||
      owner !== "ready"
    ) {
      throw new Error("post-rotation verification failed");
    }
  } catch {
    return writeError(
      io,
      5,
      "MCP_HTTP_CREDENTIAL_ROTATION_UNVERIFIED",
      "The MCP HTTP credential was rotated, but the registration, secure readback, or authenticated owner did not verify.",
      "Run meanthis bridge doctor --json, then meanthis bridge start --json and restart affected Codex tasks.",
    );
  }
  return writeJson(io, {
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.bridge-mcp-token-rotated",
    ok: true,
    data: {
      rotated: true,
      runtimeActive: true,
      requiresFreshHostProcess: true,
      next: "Restart affected Codex tasks or the Codex host before using MeanThis again.",
    },
  });
}

type OwnerEnsureStatus =
  | "ready"
  | "agent_rotation_required"
  | "legacy_foreground"
  | "unverified_listener"
  | "failed";

async function ensureOwners(
  dependencies: BridgeCliDependencies,
  token: string,
  expectedAgentToken?: string,
): Promise<OwnerEnsureStatus> {
  try {
    await dependencies.ensureBrowserOwner(expectedAgentToken);
    try {
      await dependencies.ensureMcpHttpOwner(token);
    } catch (error) {
      if (
        error instanceof LocalBridgeAgentTokenRotationRequiredError ||
        error instanceof LocalBridgeMcpHttpTokenRotationRequiredError ||
        error instanceof LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError ||
        error instanceof LocalBridgeMcpHttpUnverifiedListenerError ||
        error instanceof LocalBridgeMcpHttpLegacyForegroundOwnerError
      ) {
        throw error;
      }
      // A cold browser owner can publish authenticated health immediately
      // before its first MCP-owner lease probe is schedulable. Recheck that
      // exact owner once, then allow one bounded MCP startup retry.
      await dependencies.ensureBrowserOwner(expectedAgentToken);
      await dependencies.ensureMcpHttpOwner(token);
    }
    return "ready";
  } catch (error) {
    if (error instanceof LocalBridgeAgentTokenRotationRequiredError) {
      return "agent_rotation_required";
    }
    if (error instanceof LocalBridgeMcpHttpUnverifiedListenerError) {
      return "unverified_listener";
    }
    return error instanceof LocalBridgeMcpHttpLegacyForegroundOwnerError
      ? "legacy_foreground"
      : "failed";
  }
}

function writeOwnerStartError(
  io: BridgeCliIo,
  status: Exclude<OwnerEnsureStatus, "ready">,
  message: string,
  next?: string,
  details: Record<string, unknown> = {},
): number {
  if (status === "agent_rotation_required") {
    return writeError(
      io,
      5,
      "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED",
      "The existing local Agent credential is insecure or unverifiable; it was not reused.",
      "Run meanthis bridge rotate-agent-token --host codex --json, then follow its installation or task-restart next step.",
      details,
    );
  }
  if (status === "legacy_foreground") {
    return writeError(
      io,
      5,
      "MCP_HTTP_LEGACY_FOREGROUND_OWNER",
      "A legacy foreground MeanThis MCP HTTP server already owns 127.0.0.1:38472.",
      "Stop the foreground meanthis mcp-http process that owns 127.0.0.1:38472, then run meanthis bridge start --json.",
      details,
    );
  }
  if (status === "unverified_listener") {
    return writeError(
      io,
      5,
      LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER,
      "An unverified process is listening on 127.0.0.1:38472.",
      LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER_GUIDANCE,
      details,
    );
  }
  return writeError(io, 5, "BRIDGE_START_FAILED", message, next, details);
}

function writeCredentialPreparationError(
  io: BridgeCliIo,
  error: unknown,
): number {
  if (error instanceof LocalBridgeMcpHttpTokenRotationRequiredError) {
    return writeError(
      io,
      5,
      "MCP_HTTP_CREDENTIAL_ROTATION_REQUIRED",
      "The existing MCP HTTP credential is insecure or unverifiable; it was not reused.",
      "Run meanthis bridge rotate-mcp-token --host codex --json, then follow its installation or fresh-host next step.",
    );
  }
  return writeError(io, 5, "MCP_HTTP_CREDENTIAL_FAILED", "The MCP HTTP credential is unavailable.");
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

async function acquireProfileLock(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
): Promise<(() => Promise<void>) | number> {
  try {
    return await dependencies.acquireBridgeProfileLock();
  } catch (error) {
    const status = error instanceof MeanThisBridgeProfileLockError ? error.status : "io_error";
    return writeError(
      io,
      5,
      "PROFILE_LOCK_UNAVAILABLE",
      "Another MeanThis bridge or credential change may be in progress.",
      "Wait for the other MeanThis setup command to finish, then retry.",
      { lock: { status } },
    );
  }
}

async function runWithProfileLock(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  operation: (lockedIo: BridgeCliIo) => Promise<number>,
): Promise<number> {
  const release = await acquireProfileLock(io, dependencies);
  if (typeof release === "number") return release;
  let stdout = "";
  let stderr = "";
  const bufferedIo: BridgeCliIo = {
    writeStdout(value) { stdout += value; },
    writeStderr(value) { stderr += value; },
  };
  let exitCode: number;
  try {
    exitCode = await operation(bufferedIo);
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  try {
    await release();
  } catch {
    if (exitCode === 0) {
      return writeError(
        io,
        5,
        "PROFILE_LOCK_RELEASE_FAILED",
        "The MeanThis operation completed, but its profile lock could not be released safely.",
        "Run meanthis bridge doctor --json before retrying any setup or token operation.",
      );
    }
  }
  if (stdout) io.writeStdout(stdout);
  if (stderr) io.writeStderr(stderr);
  return exitCode;
}

async function removeManagedRegistration(
  dependencies: BridgeCliDependencies,
  registrationName: string,
  expectedStatus: "current" | "legacy",
  mutations: RegistrationMutation[],
): Promise<RegistrationRemovalResult> {
  // The cooperative profile lock serializes MeanThis writers only. External Codex
  // config writers do not honor it, so every destructive remove still re-reads here.
  const latest = await readRegistration(dependencies, registrationName);
  if (latest.status === "termination_unconfirmed") {
    return { status: "termination_unconfirmed", terminationReason: latest.terminationReason };
  }
  if (latest.status !== expectedStatus) return { status: "conflict" };
  mutations.push({ name: registrationName, before: latest });
  const removed = await dependencies.runCodex(["mcp", "remove", registrationName]);
  if (isTerminationUnconfirmed(removed)) {
    return { status: "termination_unconfirmed", terminationReason: removed.terminationReason };
  }
  if (!removed.started || removed.exitCode !== 0) return { status: "failed" };
  const verified = await readRegistration(dependencies, registrationName);
  if (verified.status === "termination_unconfirmed") {
    return { status: "termination_unconfirmed", terminationReason: verified.terminationReason };
  }
  return { status: verified.status === "missing" ? "removed" : "failed" };
}

async function failRegistrationMutation(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  mutations: RegistrationMutation[],
  configBackup: CodexConfigBackup,
  code: string,
  message: string,
  options: RegistrationMutationFailureOptions = {},
): Promise<number> {
  const recovery = options.terminationUnconfirmed
    ? {
        status: "manual_required" as const,
        outcomes: [...mutations].reverse().map((mutation) => ({
          registrationName: mutation.name,
          status: "manual_required" as const,
          reason: "termination_unconfirmed" as const,
        })),
      }
    : mutations.length === 0
      ? { status: "not_required" as const, outcomes: [] }
      : await rollbackRegistrationMutations(dependencies, mutations);
  const next = recovery.status === "manual_required"
    ? configBackup.status === "created"
      ? "Restore the Codex config from error.recovery.configBackup.path, then run bridge doctor."
      : "Inspect the Codex MCP registrations, then run meanthis bridge doctor --json."
    : undefined;
  return writeError(io, 5, code, message, next, {
    ...(options.terminationUnconfirmed
      ? {
          process: {
            terminationStatus: "termination_unconfirmed",
            ...(options.terminationReason
              ? { terminationReason: options.terminationReason }
              : {}),
          },
        }
      : {}),
    recovery: {
      ...recovery,
      configBackup,
    } satisfies RegistrationRecovery,
  });
}

async function rollbackRegistrationMutations(
  dependencies: BridgeCliDependencies,
  mutations: RegistrationMutation[],
): Promise<Pick<RegistrationRecovery, "status" | "outcomes">> {
  const outcomes: RegistrationRecoveryOutcome[] = [];
  let terminationUnconfirmed = false;
  for (const mutation of [...mutations].reverse()) {
    if (terminationUnconfirmed) {
      outcomes.push({
        registrationName: mutation.name,
        status: "manual_required",
        reason: "termination_unconfirmed",
      });
      continue;
    }
    let restored: "restored" | "manual_required" | "termination_unconfirmed" = "manual_required";
    try {
      restored = await restoreRegistration(dependencies, mutation);
    } catch {
      restored = "manual_required";
    }
    terminationUnconfirmed = restored === "termination_unconfirmed";
    outcomes.push({
      registrationName: mutation.name,
      status: restored === "restored" ? "restored" : "manual_required",
      ...(terminationUnconfirmed ? { reason: "termination_unconfirmed" as const } : {}),
    });
  }
  return {
    status: outcomes.every((outcome) => outcome.status === "restored")
      ? "restored"
      : "manual_required",
    outcomes,
  };
}

async function restoreRegistration(
  dependencies: BridgeCliDependencies,
  mutation: RegistrationMutation,
): Promise<"restored" | "manual_required" | "termination_unconfirmed"> {
  const current = await readRegistration(dependencies, mutation.name);
  if (current.status === "termination_unconfirmed") return "termination_unconfirmed";
  if (sameRegistrationSnapshot(current, mutation.before)) return "restored";
  if (mutation.before.status === "missing") {
    if (mutation.name !== REGISTRATION_NAME || current.status !== "current") return "manual_required";
    const removed = await dependencies.runCodex(["mcp", "remove", mutation.name]);
    if (isTerminationUnconfirmed(removed)) return "termination_unconfirmed";
    if (!removed.started || removed.exitCode !== 0) return "manual_required";
    const verified = await readRegistration(dependencies, mutation.name);
    if (verified.status === "termination_unconfirmed") return "termination_unconfirmed";
    return verified.status === "missing" ? "restored" : "manual_required";
  }

  const canRestore = current.status === "missing" || (
    mutation.name === REGISTRATION_NAME &&
    mutation.before.status === "legacy" &&
    current.status === "current"
  );
  if (!canRestore || !mutation.before.registration) return "manual_required";
  const addArgs = registrationAddArgs(mutation.before.registration);
  if (!addArgs) return "manual_required";
  const restored = await dependencies.runCodex(addArgs);
  if (isTerminationUnconfirmed(restored)) return "termination_unconfirmed";
  if (!restored.started || restored.exitCode !== 0) return "manual_required";
  const verified = await readRegistration(dependencies, mutation.name);
  if (verified.status === "termination_unconfirmed") return "termination_unconfirmed";
  return sameRegistrationSnapshot(verified, mutation.before) ? "restored" : "manual_required";
}

function registrationAddArgs(registration: CodexRegistration): string[] | null {
  if (registration.transport.type === "stdio") {
    return [
      "mcp",
      "add",
      registration.name,
      "--",
      registration.transport.command,
      ...registration.transport.args,
    ];
  }
  if (!isExpectedHttpRegistration(registration)) return null;
  return [
    "mcp",
    "add",
    registration.name,
    "--url",
    registration.transport.url,
    "--bearer-token-env-var",
    registration.transport.bearerTokenEnvVar!,
  ];
}

function sameRegistrationSnapshot(
  left: RegistrationReadback,
  right: RegistrationReadback,
): boolean {
  if (left.status !== right.status) return false;
  const leftRegistration = left.registration;
  const rightRegistration = right.registration;
  if (!leftRegistration || !rightRegistration) {
    return leftRegistration === rightRegistration;
  }
  if (
    leftRegistration.name !== rightRegistration.name ||
    leftRegistration.enabled !== rightRegistration.enabled ||
    leftRegistration.disabledReason !== rightRegistration.disabledReason ||
    leftRegistration.startupTimeoutSec !== rightRegistration.startupTimeoutSec ||
    leftRegistration.toolTimeoutSec !== rightRegistration.toolTimeoutSec ||
    leftRegistration.authStatus !== rightRegistration.authStatus ||
    leftRegistration.hasAuthStatus !== rightRegistration.hasAuthStatus ||
    leftRegistration.hasUnknownFields !== rightRegistration.hasUnknownFields ||
    !sameStringArray(leftRegistration.enabledTools, rightRegistration.enabledTools) ||
    !sameStringArray(leftRegistration.disabledTools, rightRegistration.disabledTools) ||
    leftRegistration.transport.type !== rightRegistration.transport.type
  ) return false;

  const leftTransport = leftRegistration.transport;
  const rightTransport = rightRegistration.transport;
  if (leftTransport.type === "stdio" && rightTransport.type === "stdio") {
    return leftTransport.command === rightTransport.command &&
      sameStringArray(leftTransport.args, rightTransport.args) &&
      sameStringRecord(leftTransport.env, rightTransport.env) &&
      sameStringArray(leftTransport.envVars, rightTransport.envVars) &&
      leftTransport.cwd === rightTransport.cwd &&
      leftTransport.hasUnknownFields === rightTransport.hasUnknownFields;
  }
  if (leftTransport.type === "streamable_http" && rightTransport.type === "streamable_http") {
    return leftTransport.url === rightTransport.url &&
      leftTransport.bearerTokenEnvVar === rightTransport.bearerTokenEnvVar &&
      sameStringRecord(leftTransport.httpHeaders, rightTransport.httpHeaders) &&
      sameStringRecord(leftTransport.envHttpHeaders, rightTransport.envHttpHeaders) &&
      leftTransport.hasUnknownFields === rightTransport.hasUnknownFields;
  }
  return false;
}

function sameStringArray(left: string[] | null, right: string[] | null): boolean {
  return left === right || (
    left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameStringRecord(
  left: Record<string, string> | null,
  right: Record<string, string> | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameStringArray(leftKeys, rightKeys) &&
    leftKeys.every((key) => left[key] === right[key]);
}

async function readRegistration(
  dependencies: BridgeCliDependencies,
  registrationName: string,
): Promise<RegistrationReadback> {
  const result = await dependencies.runCodex(["mcp", "get", registrationName, "--json"]);
  if (isTerminationUnconfirmed(result)) {
    return {
      status: "termination_unconfirmed",
      registration: null,
      terminationReason: result.terminationReason,
    };
  }
  if (result.terminationStatus === "confirmed") {
    return { status: "error", registration: null };
  }
  if (!result.started) return { status: "unavailable", registration: null };
  if (result.exitCode !== 0) {
    const missingPattern = new RegExp(
      `No MCP server named ['"]${escapeRegExp(registrationName)}['"] found\\.?`,
      "i",
    );
    return missingPattern.test(result.stderr)
      ? { status: "missing", registration: null }
      : { status: "error", registration: null };
  }
  const registration = parseRegistration(result.stdout);
  if (!registration || registration.name !== registrationName) {
    return { status: "error", registration: null };
  }

  let status: RegistrationStatus = "drifted";
  if (registrationName === REGISTRATION_NAME) {
    if (isExpectedBrokerRegistration(registration, dependencies)) status = "current";
    else if (
      isExpectedHttpRegistration(registration) ||
      isManagedMainStdioRegistration(registration, dependencies)
    ) status = "legacy";
  } else if (registrationName === LEGACY_REGISTRATION_NAME) {
    if (isManagedMainStdioRegistration(registration, dependencies)) status = "current";
  } else if (registrationName === STANDALONE_RESOLVER_REGISTRATION_NAME) {
    if (isManagedResolverStdioRegistration(registration, dependencies)) status = "current";
  }
  return { status, registration };
}

function isTerminationUnconfirmed(
  result: CodexProcessResult,
): result is CodexProcessResult & { terminationStatus: "termination_unconfirmed" } {
  return result.terminationStatus === "termination_unconfirmed";
}

function parseRegistration(value: string): CodexRegistration | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isObject(parsed) ||
      typeof parsed.name !== "string" ||
      typeof parsed.enabled !== "boolean" ||
      (parsed.disabled_reason !== null && parsed.disabled_reason !== undefined &&
        typeof parsed.disabled_reason !== "string") ||
      (parsed.startup_timeout_sec !== null && parsed.startup_timeout_sec !== undefined &&
        typeof parsed.startup_timeout_sec !== "number") ||
      (parsed.tool_timeout_sec !== null && parsed.tool_timeout_sec !== undefined &&
        typeof parsed.tool_timeout_sec !== "number") ||
      (parsed.auth_status !== null && parsed.auth_status !== undefined &&
        typeof parsed.auth_status !== "string") ||
      (parsed.enabled_tools !== null && parsed.enabled_tools !== undefined &&
        !isStringArray(parsed.enabled_tools)) ||
      (parsed.disabled_tools !== null && parsed.disabled_tools !== undefined &&
        !isStringArray(parsed.disabled_tools))
    ) {
      return null;
    }
    if (!isObject(parsed.transport) || typeof parsed.transport.type !== "string") return null;
    const candidate = parsed.transport;
    const common = {
      name: parsed.name,
      enabled: parsed.enabled,
      disabledReason: typeof parsed.disabled_reason === "string" ? parsed.disabled_reason : null,
      startupTimeoutSec: typeof parsed.startup_timeout_sec === "number"
        ? parsed.startup_timeout_sec
        : null,
      toolTimeoutSec: typeof parsed.tool_timeout_sec === "number" ? parsed.tool_timeout_sec : null,
      authStatus: typeof parsed.auth_status === "string" ? parsed.auth_status : null,
      hasAuthStatus: Object.hasOwn(parsed, "auth_status"),
      enabledTools: isStringArray(parsed.enabled_tools) ? parsed.enabled_tools : null,
      disabledTools: isStringArray(parsed.disabled_tools) ? parsed.disabled_tools : null,
      hasUnknownFields: !hasOnlyKeys(parsed, [
        "name",
        "enabled",
        "disabled_reason",
        "transport",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "auth_status",
        "enabled_tools",
        "disabled_tools",
      ]),
    };
    if (candidate.type === "stdio") {
      if (
        typeof candidate.command !== "string" ||
        !Array.isArray(candidate.args) ||
        !candidate.args.every((item) => typeof item === "string") ||
        (candidate.cwd !== null && candidate.cwd !== undefined && typeof candidate.cwd !== "string") ||
        (candidate.env !== null && candidate.env !== undefined && !isStringRecord(candidate.env)) ||
        (candidate.env_vars !== null && candidate.env_vars !== undefined &&
          !isStringArray(candidate.env_vars))
      ) return null;
      return {
        ...common,
        transport: {
          type: "stdio",
          command: candidate.command,
          args: candidate.args as string[],
          env: isStringRecord(candidate.env) ? candidate.env : null,
          envVars: isStringArray(candidate.env_vars) ? candidate.env_vars : [],
          cwd: typeof candidate.cwd === "string" ? candidate.cwd : null,
          hasUnknownFields: !hasOnlyKeys(candidate, [
            "type", "command", "args", "env", "env_vars", "cwd",
          ]),
        },
      };
    }
    if (candidate.type === "streamable_http") {
      if (
        typeof candidate.url !== "string" ||
        (candidate.bearer_token_env_var !== null &&
          candidate.bearer_token_env_var !== undefined &&
          typeof candidate.bearer_token_env_var !== "string") ||
        (candidate.http_headers !== null && candidate.http_headers !== undefined &&
          !isStringRecord(candidate.http_headers)) ||
        (candidate.env_http_headers !== null && candidate.env_http_headers !== undefined &&
          !isStringRecord(candidate.env_http_headers))
      ) return null;
      return {
        ...common,
        transport: {
          type: "streamable_http",
          url: candidate.url,
          bearerTokenEnvVar: typeof candidate.bearer_token_env_var === "string"
            ? candidate.bearer_token_env_var
            : null,
          httpHeaders: isStringRecord(candidate.http_headers) ? candidate.http_headers : null,
          envHttpHeaders: isStringRecord(candidate.env_http_headers) ? candidate.env_http_headers : null,
          hasUnknownFields: !hasOnlyKeys(candidate, [
            "type",
            "url",
            "bearer_token_env_var",
            "http_headers",
            "env_http_headers",
          ]),
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isExpectedHttpRegistration(registration: CodexRegistration): boolean {
  return hasExpectedRegistrationMetadata(registration, "bearer_token")
    && registration.transport.type === "streamable_http"
    && !registration.transport.hasUnknownFields
    && registration.transport.url === MEANTHIS_MCP_HTTP_URL
    && registration.transport.bearerTokenEnvVar === MEANTHIS_MCP_HTTP_TOKEN_ENV_VAR
    && registration.transport.httpHeaders === null
    && registration.transport.envHttpHeaders === null;
}

function isExpectedBrokerRegistration(
  registration: CodexRegistration,
  dependencies: BridgeCliDependencies,
): boolean {
  const expected = createManagedBrokerDescriptor(dependencies).transport;
  return isExpectedStdio(registration, expected.command, expected.args);
}

function isManagedMainStdioRegistration(
  registration: CodexRegistration,
  dependencies: BridgeCliDependencies,
): boolean {
  const expected = createMeanThisStdioCompatibilityDescriptor(
    dependencies.nodePath,
    dependencies.entryPath,
  ).transport;
  return isExpectedStdio(registration, expected.command, expected.args);
}

function isManagedResolverStdioRegistration(
  registration: CodexRegistration,
  dependencies: BridgeCliDependencies,
): boolean {
  return isExpectedStdio(
    registration,
    dependencies.nodePath,
    [dependencies.standaloneResolverEntryPath],
  );
}

function isExpectedStdio(
  registration: CodexRegistration,
  command: string,
  args: string[],
): boolean {
  return hasExpectedRegistrationMetadata(registration, "unsupported")
    && registration.transport.type === "stdio"
    && !registration.transport.hasUnknownFields
    && samePath(registration.transport.command, command)
    && registration.transport.args.length === args.length
    && registration.transport.args.every((arg, index) => (
      index === 0 ? samePath(arg, args[index] ?? "") : arg === args[index]
    ))
    && registration.transport.cwd === null
    && (registration.transport.env === null || Object.keys(registration.transport.env).length === 0)
    && registration.transport.envVars.length === 0;
}

function hasExpectedRegistrationMetadata(
  registration: CodexRegistration,
  authStatus: string,
): boolean {
  return registration.enabled &&
    !registration.hasUnknownFields &&
    registration.disabledReason === null &&
    registration.startupTimeoutSec === null &&
    registration.toolTimeoutSec === null &&
    (!registration.hasAuthStatus || registration.authStatus === authStatus) &&
    registration.enabledTools === null &&
    registration.disabledTools === null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function equalVerifiedAgentTokens(left: string, right: string): boolean {
  if (!validateLocalBridgeAgentToken(left) || !validateLocalBridgeAgentToken(right)) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function samePath(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  const normalizePath = (value: string) => normalize(resolve(value)).replaceAll("\\", "/");
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createManagedBrokerDescriptor(dependencies: BridgeCliDependencies) {
  return createMeanThisMcpDescriptor(dependencies.nodePath, dependencies.brokerEntryPath);
}

function publicBrokerRegistration(dependencies: BridgeCliDependencies) {
  const descriptor = createManagedBrokerDescriptor(dependencies);
  return {
    type: "stdio_broker" as const,
    command: descriptor.transport.command,
    args: descriptor.transport.args,
    env: null,
    cwd: null,
  };
}

function writeSetupResult(
  io: BridgeCliIo,
  dependencies: BridgeCliDependencies,
  command: "install" | "uninstall",
  action: "add" | "migrate" | "remove" | "none",
  changed: boolean,
  dryRun: boolean,
  configBackup: CodexConfigBackup | null,
  extra: Record<string, unknown> = {},
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
      registration: publicBrokerRegistration(dependencies),
      ...extra,
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
  next?: string,
  details: Record<string, unknown> = {},
): number {
  io.writeStderr(`${JSON.stringify({
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.error",
    ok: false,
    error: { code, message, ...(next ? { next } : {}), ...details },
  })}\n`);
  return exitCode;
}

function writeUnconfirmedProcessError(
  io: BridgeCliIo,
  terminationReason: "timeout" | "output_limit" | undefined,
  message: string,
  configBackup: CodexConfigBackup | null = null,
  mutations: RegistrationMutation[] = [],
  partialState?: Record<string, unknown>,
): number {
  return writeError(
    io,
    5,
    "CODEX_PROCESS_TERMINATION_UNCONFIRMED",
    message,
    configBackup?.status === "created"
      ? "Restore the Codex config from error.recovery.configBackup.path if needed, then run bridge doctor."
      : "Inspect the Codex MCP registrations manually, then run meanthis bridge doctor --json.",
    {
      process: {
        terminationStatus: "termination_unconfirmed",
        ...(terminationReason ? { terminationReason } : {}),
      },
      recovery: {
        status: "manual_required",
        configBackup,
        outcomes: [...mutations].reverse().map((mutation) => ({
          registrationName: mutation.name,
          status: "manual_required",
          reason: "termination_unconfirmed",
        })),
      },
      ...(partialState ? { partialState } : {}),
    },
  );
}

function createDefaultDependencies(): BridgeCliDependencies {
  let codexCommand: Promise<CommandSpec | null> | null = null;
  return {
    nodePath: process.execPath,
    entryPath: fileURLToPath(new URL("./index.js", import.meta.url)),
    brokerEntryPath: fileURLToPath(
      new URL("./local-bridge-mcp-stdio-broker.js", import.meta.url),
    ),
    standaloneResolverEntryPath: resolveStandaloneResolverEntryPath(),
    pathExists,
    probeBrowserOwner: probeBrowserOwner,
    async probeMcpHttpOwner(token) {
      const inspection = await inspectLocalBridgeMcpHttpOwner(
        token,
        loadLocalBridgeMcpHttpOwnerIdentity(),
      );
      if (inspection.status === "absent") return "not_running";
      if (inspection.status === "stale") return "stale_build";
      return inspection.status;
    },
    inspectAgentCredential: inspectLocalBridgeAgentToken,
    inspectMcpHttpCredential: inspectLocalBridgeMcpHttpToken,
    loadOrCreateMcpHttpToken: loadOrCreateLocalBridgeMcpHttpToken,
    readAgentToken: readLocalBridgeAgentToken,
    readMcpHttpToken: readLocalBridgeMcpHttpToken,
    rotateAgentToken: rotateLocalBridgeAgentToken,
    rotateMcpHttpToken: rotateLocalBridgeMcpHttpToken,
    acquireBridgeProfileLock: acquireMeanThisBridgeProfileLock,
    backupCodexConfig,
    async ensureBrowserOwner(expectedAgentToken) {
      const agentToken = expectedAgentToken ?? await loadOrCreateLocalBridgeAgentToken();
      const expectedOwnerIdentity = loadLocalBridgeOwnerIdentity();
      const startupReader = createHttpLocalBridgeReader(
        UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
        agentToken,
        { expectedOwnerIdentity, requestTimeoutMs: 250 },
      );
      await ensureLocalBridgeOwner({
        probe: async () => { await startupReader.getStatus(); },
        spawnOwner: spawnDetachedLocalBridgeOwner,
        wait: waitForLocalBridgeOwner,
      }, {
        agentToken,
        expectedIdentity: expectedOwnerIdentity,
        startupTimeoutMs: BROWSER_OWNER_STARTUP_TIMEOUT_MS,
      });
    },
    async ensureMcpHttpOwner(token) {
      await ensureDetachedLocalBridgeMcpHttpOwner(token);
    },
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
    installNativeHost() {
      return installLocalBridgeNativeHost({
        nodePath: process.execPath,
        entryPath: fileURLToPath(new URL("./index.js", import.meta.url)),
      });
    },
    async runCodex(args) {
      codexCommand ??= resolveCodexCommand();
      const command = await codexCommand;
      if (!command) return { started: false, exitCode: null, stdout: "", stderr: "" };
      return runProcess(command.executable, [...command.prefixArgs, ...args], PROCESS_TIMEOUT_MS);
    },
  };
}

function resolveStandaloneResolverEntryPath(): string {
  const resolver = new URL(import.meta.resolve("@meanthis/source-resolver-mcp"));
  if (resolver.protocol !== "file:") throw new Error("Source resolver package is unavailable.");
  return fileURLToPath(new URL("./cli.js", resolver));
}

export async function acquireMeanThisBridgeProfileLock(
  options: MeanThisBridgeProfileLockOptions = {},
): Promise<() => Promise<void>> {
  const codexHome = resolve(options.codexHome ?? resolveCodexHome());
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const ttlMs = options.ttlMs ?? BRIDGE_PROFILE_LOCK_TTL_MS;
  const createNonce = options.nonce ?? (() => randomBytes(16).toString("base64url"));
  const isProcessAlive = options.isProcessAlive ?? isLocalProcessAlive;
  const readProcessInstanceId = options.readProcessInstanceId ?? readLocalProcessInstanceId;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
    throw new MeanThisBridgeProfileLockError("invalid");
  }
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const processInstanceId = options.processInstanceId ?? await readProcessInstanceId(pid);
  if (!processInstanceId || !/^[A-Za-z0-9_-]{43}$/.test(processInstanceId)) {
    throw new MeanThisBridgeProfileLockError("io_error");
  }
  const lockPath = join(codexHome, BRIDGE_PROFILE_LOCK_FILE);
  const reclaimPath = join(codexHome, BRIDGE_PROFILE_RECLAIM_LOCK_FILE);
  const createRecord = (): BridgeProfileLockRecord => {
    const createdAtMs = now();
    const nonce = createNonce();
    if (!Number.isFinite(createdAtMs) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) {
      throw new MeanThisBridgeProfileLockError("invalid");
    }
    return {
      kind: "meanthis-bridge-profile-lock-v1",
      pid,
      nonce,
      processInstanceId,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
    };
  };

  let record = createRecord();
  let handle: FileHandle | null = null;
  try {
    handle = await createBridgeProfileLockFile(lockPath, record);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      if (error instanceof MeanThisBridgeProfileLockError) throw error;
      throw new MeanThisBridgeProfileLockError("io_error");
    }
    const existing = await requireReclaimableLock(
      await inspectBridgeProfileLockFile(lockPath),
      now(),
      ttlMs,
      isProcessAlive,
      readProcessInstanceId,
      "active",
    );
    const reclaim = await acquireBridgeProfileReclaimGuard(
      reclaimPath,
      createRecord,
      now,
      ttlMs,
      isProcessAlive,
      readProcessInstanceId,
    );
    let acquiredReplacement = false;
    let reclaimError: unknown = null;
    try {
      const latest = await inspectBridgeProfileLockFile(lockPath);
      if (
        latest.status !== "regular" ||
        !sameBridgeProfileLockIdentity(latest.identity, existing.identity)
      ) {
        throw new MeanThisBridgeProfileLockError("active");
      }
      await requireReclaimableLock(
        latest,
        now(),
        ttlMs,
        isProcessAlive,
        readProcessInstanceId,
        "active",
      );
      await unlink(lockPath);
      record = createRecord();
      handle = await createBridgeProfileLockFile(lockPath, record);
      acquiredReplacement = true;
    } catch (replacementError) {
      reclaimError = replacementError;
    }
    try {
      await reclaim.release();
    } catch {
      if (acquiredReplacement) {
        await handle?.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      throw new MeanThisBridgeProfileLockError("io_error");
    }
    if (reclaimError) {
      if (reclaimError instanceof MeanThisBridgeProfileLockError) throw reclaimError;
      throw new MeanThisBridgeProfileLockError("io_error");
    }
  }

  if (!handle) throw new MeanThisBridgeProfileLockError("io_error");
  const ownedHandle = handle;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const current = await inspectBridgeProfileLockFile(lockPath);
    if (current.status !== "regular" || current.record?.nonce !== record.nonce) {
      await ownedHandle.close().catch(() => undefined);
      throw new MeanThisBridgeProfileLockError("invalid");
    }
    await ownedHandle.close();
    const readback = await inspectBridgeProfileLockFile(lockPath);
    if (readback.status !== "regular" || readback.record?.nonce !== record.nonce) {
      throw new MeanThisBridgeProfileLockError("invalid");
    }
    try {
      await unlink(lockPath);
    } catch {
      throw new MeanThisBridgeProfileLockError("io_error");
    }
  };
}

async function acquireBridgeProfileReclaimGuard(
  reclaimPath: string,
  createRecord: () => BridgeProfileLockRecord,
  now: () => number,
  ttlMs: number,
  isProcessAlive: (pid: number) => boolean,
  readProcessInstanceId: (pid: number) => Promise<string | null>,
): Promise<{ release(): Promise<void> }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = createRecord();
    try {
      const handle = await createBridgeProfileLockFile(reclaimPath, record);
      return {
        async release() {
          const beforeClose = await inspectBridgeProfileLockFile(reclaimPath);
          if (beforeClose.status !== "regular" || beforeClose.record?.nonce !== record.nonce) {
            await handle.close().catch(() => undefined);
            throw new MeanThisBridgeProfileLockError("invalid");
          }
          await handle.close();
          const latest = await inspectBridgeProfileLockFile(reclaimPath);
          if (latest.status !== "regular" || latest.record?.nonce !== record.nonce) {
            throw new MeanThisBridgeProfileLockError("invalid");
          }
          await unlink(reclaimPath);
        },
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        if (error instanceof MeanThisBridgeProfileLockError) throw error;
        throw new MeanThisBridgeProfileLockError("io_error");
      }
    }

    const existing = await requireReclaimableLock(
      await inspectBridgeProfileLockFile(reclaimPath),
      now(),
      ttlMs,
      isProcessAlive,
      readProcessInstanceId,
      "reclaim_in_progress",
    );
    const latest = await inspectBridgeProfileLockFile(reclaimPath);
    if (
      latest.status !== "regular" ||
      !sameBridgeProfileLockIdentity(existing.identity, latest.identity)
    ) {
      throw new MeanThisBridgeProfileLockError("reclaim_in_progress");
    }
    await requireReclaimableLock(
      latest,
      now(),
      ttlMs,
      isProcessAlive,
      readProcessInstanceId,
      "reclaim_in_progress",
    );
    try {
      await unlink(reclaimPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw new MeanThisBridgeProfileLockError("io_error");
    }
  }
  throw new MeanThisBridgeProfileLockError("reclaim_in_progress");
}

async function createBridgeProfileLockFile(path: string, record: BridgeProfileLockRecord) {
  const handle = await open(path, "wx", 0o600);
  let written = false;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
    written = true;
    return handle;
  } finally {
    if (!written) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    }
  }
}

async function inspectBridgeProfileLockFile(path: string): Promise<BridgeProfileLockFileInspection> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return { status: "unsafe" };
    const identity = {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      birthtimeMs: stats.birthtimeMs,
      ctimeMs: stats.ctimeMs,
      mtimeMs: stats.mtimeMs,
    };
    let record: BridgeProfileLockRecord | null = null;
    if (stats.size <= 1_024) {
      try {
        record = parseBridgeProfileLockRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      } catch {
        record = null;
      }
    }
    return {
      status: "regular",
      identity,
      record,
      changedAtMs: Math.max(stats.ctimeMs, stats.mtimeMs),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    throw new MeanThisBridgeProfileLockError("io_error");
  }
}

function parseBridgeProfileLockRecord(value: unknown): BridgeProfileLockRecord | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
      "kind", "pid", "nonce", "processInstanceId", "createdAt", "expiresAt",
  ])) return null;
  if (
    value.kind !== "meanthis-bridge-profile-lock-v1" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.nonce) ||
    typeof value.processInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.processInstanceId) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalIsoTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) return null;
  return value as unknown as BridgeProfileLockRecord;
}

async function requireReclaimableLock(
  inspection: BridgeProfileLockFileInspection,
  now: number,
  ttlMs: number,
  isProcessAlive: (pid: number) => boolean,
  readProcessInstanceId: (pid: number) => Promise<string | null>,
  activeStatus: "active" | "reclaim_in_progress",
): Promise<Extract<BridgeProfileLockFileInspection, { status: "regular" }>> {
  if (inspection.status === "unsafe" || inspection.status === "missing") {
    throw new MeanThisBridgeProfileLockError("invalid");
  }
  if (inspection.record) {
    if (isProcessAlive(inspection.record.pid)) {
      const liveInstanceId = await readProcessInstanceId(inspection.record.pid);
      if (liveInstanceId === null || liveInstanceId === inspection.record.processInstanceId) {
        throw new MeanThisBridgeProfileLockError(activeStatus);
      }
    }
    return inspection;
  }
  if (now - inspection.changedAtMs < ttlMs) {
    throw new MeanThisBridgeProfileLockError("invalid");
  }
  return inspection;
}

function sameBridgeProfileLockIdentity(
  left: BridgeProfileLockFileIdentity,
  right: BridgeProfileLockFileIdentity,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs;
}

async function readLocalProcessInstanceId(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let raw: string | null = null;
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    for (const host of ["pwsh.exe", "powershell.exe"]) {
      const result = await runProcess(host, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], 2_000);
      if (!result.started) continue;
      if (result.exitCode === 0 && /^\d+$/.test(result.stdout.trim())) raw = `win:${result.stdout.trim()}`;
      break;
    }
  } else if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = closeParen >= 0 ? stat.slice(closeParen + 2).trim().split(/\s+/) : [];
      const startTicks = fields[19];
      if (startTicks && /^\d+$/.test(startTicks)) raw = `linux:${startTicks}`;
    } catch {
      raw = null;
    }
  } else {
    const result = await runProcess("ps", ["-o", "lstart=", "-p", String(pid)], 2_000);
    if (result.started && result.exitCode === 0 && result.stdout.trim()) {
      raw = `${process.platform}:${result.stdout.trim()}`;
    }
  }
  return raw ? createHash("sha256").update(raw, "utf8").digest("base64url") : null;
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
}

async function backupCodexConfig(): Promise<CodexConfigBackup> {
  const codexHome = resolveCodexHome();
  const source = join(codexHome, "config.toml");
  if (!await pathExists(source)) return { status: "not_found", path: null };
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
  const nonce = randomBytes(6).toString("base64url");
  const destination = join(
    codexHome,
    `config.toml.bak-meanthis-${timestamp}-${process.pid}-${nonce}`,
  );
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  try {
    await secureCodexConfigBackup(destination);
    return { status: "created", path: destination };
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function secureCodexConfigBackup(
  path: string,
  options: SecureCodexConfigBackupOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await (options.applyWindowsAcl ?? applyWindowsProtectedBackupAcl)(
      path,
      createSanitizedLocalBridgeOwnerEnvironment(options.environment ?? process.env),
    );
  } else {
    await chmod(path, 0o600);
  }
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Codex config backup is not a regular file.");
  }
  if (platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    throw new Error("Codex config backup permissions did not verify.");
  }
}

async function applyWindowsProtectedBackupAcl(
  path: string,
  baseEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "MEANTHIS_BACKUP_ACL_PATH") delete environment[name];
  }
  environment.MEANTHIS_BACKUP_ACL_PATH = path;
  for (const host of ["pwsh.exe", "powershell.exe"]) {
    const status = await runWindowsBackupAclHost(host, environment);
    if (status === "success") return;
    if (status === "failure") break;
  }
  throw new Error("Unable to secure the Codex config backup ACL.");
}

function runWindowsBackupAclHost(
  host: string,
  env: NodeJS.ProcessEnv,
): Promise<"success" | "missing" | "failure"> {
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(host, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_BACKUP_PROTECTED_ACL_SCRIPT,
    ], {
      env,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const finish = (status: "success" | "missing" | "failure") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(status);
    };
    child.once("error", (error) => finish(isNodeError(error, "ENOENT") ? "missing" : "failure"));
    child.once("close", (code) => finish(code === 0 ? "success" : "failure"));
    const timeout = setTimeout(() => {
      child.kill();
      finish("failure");
    }, 15_000);
  });
}

const WINDOWS_BACKUP_PROTECTED_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPath = $env:MEANTHIS_BACKUP_ACL_PATH
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'Missing backup path.' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl = Get-Acl -LiteralPath $targetPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
foreach ($sid in @($currentSid, $systemSid)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    $rights,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    $allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $targetPath -AclObject $acl
$readback = Get-Acl -LiteralPath $targetPath
if (-not $readback.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled.' }
$rules = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'ACL rule count is invalid.' }
$expected = @($currentSid.Value, $systemSid.Value) | Sort-Object
$actual = @()
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains.' }
  if ($rule.AccessControlType -ne $allow) { throw 'Non-allow ACL rule remains.' }
  if ([int64]$rule.FileSystemRights -ne [int64]$rights) { throw 'ACL rights are invalid.' }
  $actual += $rule.IdentityReference.Value
}
$actual = $actual | Sort-Object
if ((Compare-Object -ReferenceObject $expected -DifferenceObject $actual).Count -ne 0) {
  throw 'ACL principals are invalid.'
}
`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function probeBrowserOwner(): Promise<LoopbackProbeStatus> {
  try {
    const response = await fetch(`${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return "unexpected";
    const value = await response.json() as unknown;
    return isExpectedBrowserHealth(value) ? "ready" : "unexpected";
  } catch {
    return "not_running";
  }
}

function isExpectedBrowserHealth(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Object.keys(value).sort().join(",") === "kind,ok,schemaVersion,sharing"
    && value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION
    && value.kind === "ui-attach.local-bridge-health"
    && value.ok === true
    && value.sharing === "owner-proxy-v1";
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

export function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  options: RunProcessOptions = {},
): Promise<CodexProcessResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timeout: NodeJS.Timeout | undefined;
    const spawnOptions: RunProcessSpawnOptions = {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: createSanitizedLocalBridgeOwnerEnvironment(options.environment ?? process.env),
    };
    let child: RunProcessChild;
    try {
      child = (options.spawnProcess ?? spawnRunProcessChild)(executable, args, spawnOptions);
    } catch {
      resolveResult({ started: false, exitCode: null, stdout: "", stderr: "" });
      return;
    }
    const finish = (result: CodexProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveResult(result);
    };
    const append = (current: string, chunk: Buffer): string | null => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") <= MAX_PROCESS_OUTPUT_BYTES ? next : null;
    };
    const terminate = (terminationReason: "timeout" | "output_limit") => {
      if (settled || terminating) return;
      terminating = true;
      if (timeout) clearTimeout(timeout);
      const terminateProcessTree = options.terminateProcessTree ?? terminateExactProcessTree;
      void terminateProcessTree(
        child,
        options.terminationTimeoutMs ?? PROCESS_TERMINATION_TIMEOUT_MS,
      ).then(
        (confirmed) => finish({
          started: true,
          exitCode: null,
          stdout,
          stderr,
          terminationStatus: confirmed ? "confirmed" : "termination_unconfirmed",
          terminationReason,
        }),
        () => finish({
          started: true,
          exitCode: null,
          stdout,
          stderr,
          terminationStatus: "termination_unconfirmed",
          terminationReason,
        }),
      );
    };
    child.onStdout((chunk: Buffer) => {
      if (terminating) return;
      const next = append(stdout, chunk);
      if (next === null) terminate("output_limit");
      else stdout = next;
    });
    child.onStderr((chunk: Buffer) => {
      if (terminating) return;
      const next = append(stderr, chunk);
      if (next === null) terminate("output_limit");
      else stderr = next;
    });
    child.onceError(() => {
      if (!terminating) finish({ started: false, exitCode: null, stdout: "", stderr: "" });
    });
    child.onceClose((exitCode) => {
      if (!terminating) finish({ started: true, exitCode, stdout, stderr });
    });
    if (!settled) timeout = setTimeout(() => terminate("timeout"), timeoutMs);
  });
}

function spawnRunProcessChild(
  executable: string,
  args: string[],
  options: RunProcessSpawnOptions,
): RunProcessChild {
  const child = spawn(executable, args, options);
  return {
    get pid() { return child.pid; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    onStdout(listener) { child.stdout?.on("data", listener); },
    onStderr(listener) { child.stderr?.on("data", listener); },
    onceError(listener) { child.once("error", listener); },
    onceClose(listener) { child.once("close", (exitCode) => listener(exitCode)); },
  };
}

async function terminateExactProcessTree(
  child: RunProcessChild,
  timeoutMs: number,
): Promise<boolean> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || timeoutMs <= 0) return false;
  return process.platform === "win32"
    ? terminateWindowsProcessTree(child, pid, timeoutMs)
    : terminatePosixProcessTree(child, pid, timeoutMs);
}

async function terminateWindowsProcessTree(
  child: RunProcessChild,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  let killer;
  try {
    killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      env: createSanitizedLocalBridgeOwnerEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    return false;
  }
  const rootClosed = waitForRunProcessChildClose(child, timeoutMs);
  const killerExit = await new Promise<number | null>((resolveExit) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveExit(exitCode);
    };
    killer.once("error", () => finish(null));
    killer.once("close", (exitCode) => finish(exitCode));
    timer = setTimeout(() => {
      killer.kill();
      finish(null);
    }, timeoutMs);
  });
  const closed = await rootClosed;
  return killerExit === 0 && closed;
}

async function terminatePosixProcessTree(
  child: RunProcessChild,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const rootClosed = waitForRunProcessChildClose(child, timeoutMs);
  const term = signalPosixProcessGroup(pid, "SIGTERM");
  if (term === "unconfirmed") {
    await rootClosed;
    return false;
  }
  let groupGone = term === "gone" || await waitForPosixProcessGroupExit(
    pid,
    Math.min(deadline, Date.now() + PROCESS_TERMINATION_GRACE_MS),
  );
  if (!groupGone) {
    const killed = signalPosixProcessGroup(pid, "SIGKILL");
    if (killed === "unconfirmed") {
      await rootClosed;
      return false;
    }
    groupGone = killed === "gone" || await waitForPosixProcessGroupExit(pid, deadline);
  }
  return groupGone && await rootClosed;
}

function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): "sent" | "gone" | "unconfirmed" {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    return isNodeError(error, "ESRCH") ? "gone" : "unconfirmed";
  }
}

async function waitForPosixProcessGroupExit(pid: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (isPosixProcessGroupGone(pid)) return true;
    await delay(Math.min(PROCESS_TERMINATION_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return isPosixProcessGroupGone(pid);
}

function isPosixProcessGroupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, "ESRCH");
  }
}

export function waitForRunProcessChildClose(
  child: RunProcessChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveClosed) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveClosed(closed);
    };
    child.onceClose(() => finish(true));
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
      return;
    }
    if (!settled) timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}
