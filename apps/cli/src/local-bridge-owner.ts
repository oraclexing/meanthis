import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UI_ATTACH_LOCAL_BRIDGE_HOST,
  UI_ATTACH_LOCAL_BRIDGE_PORT,
} from "@meanthis/schema";
import {
  fingerprintLocalBridgeAgentToken,
  inspectLocalBridgeAgentToken,
  loadOrCreateLocalBridgeAgentToken,
  readLocalBridgeAgentToken,
  readVerifiedLocalBridgeAgentToken,
  validateLocalBridgeAgentToken,
  type LocalBridgeAgentTokenInspection,
} from "./local-bridge-agent-token.js";
import {
  MEANTHIS_MCP_HTTP_TOKEN_ENV,
  MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
  readVerifiedLocalBridgeProtectedBuildMarker,
  writeLocalBridgeProtectedBuildMarker,
} from "./local-bridge-mcp-http-token.js";
import {
  createLocalBridgeState,
  startLocalBridgeHttpServer,
  type LocalBridgeOwnerIdentity,
} from "./local-bridge.js";

const OWNER_IDLE_MS = 30 * 60_000;
const OWNER_IDLE_CHECK_MS = 30_000;
const OWNER_DESIRED_IDENTITY_CHECK_MS = 1_000;
const OWNER_DESIRED_IDENTITY_CHECK_TIMEOUT_MS = 10_000;
const OWNER_AGENT_TOKEN_CHECK_MS = 1_000;
const OWNER_AGENT_TOKEN_CHECK_TIMEOUT_MS = 10_000;
const OWNER_AGENT_TOKEN_INSPECTION_MS = 30_000;
const OWNER_AGENT_TOKEN_INSPECTION_TIMEOUT_MS = 10_000;
const OWNER_STARTUP_TIMEOUT_MS = 3_000;
const OWNER_STALE_STARTUP_TIMEOUT_MS = 35_000;
const OWNER_STARTUP_POLL_MS = 50;
const OWNER_DIAGNOSTIC_HEARTBEAT_MS = 30_000;
const OWNER_DIAGNOSTIC_WRITE_TIMEOUT_MS = 500;

export type LocalBridgeOwnerLifecycleReason =
  | "idle"
  | "owner_identity_changed"
  | "owner_identity_check_failed"
  | "desired_identity_changed"
  | "desired_identity_check_failed"
  | "desired_identity_check_timeout"
  | "agent_token_changed"
  | "agent_token_check_failed"
  | "agent_token_check_timeout"
  | "agent_acl_failed"
  | "agent_acl_check_failed"
  | "agent_acl_check_timeout"
  | "mcp_identity_changed"
  | "mcp_identity_check_failed"
  | "mcp_identity_check_timeout"
  | "mcp_token_changed"
  | "mcp_token_check_failed"
  | "mcp_token_check_timeout"
  | "mcp_acl_failed"
  | "mcp_acl_check_failed"
  | "mcp_acl_check_timeout"
  | "bridge_lease_unavailable"
  | "signal"
  | "server_error";

export interface LocalBridgeOwnerLifecycleEvent {
  owner: "browser" | "mcp_http";
  event: "ready" | "heartbeat" | "close";
  reason?: LocalBridgeOwnerLifecycleReason;
  pid: number;
  port: number;
  at: string;
  uptimeMs: number;
}

export type LocalBridgeOwnerLifecycleReporter = (
  event: LocalBridgeOwnerLifecycleEvent,
) => void | Promise<void>;

export class AuthenticatedLocalBridgeOwnerIdentityMismatchError extends Error {
  readonly code = "LOCAL_BRIDGE_OWNER_IDENTITY_MISMATCH";

  constructor() {
    super("Detached local bridge owner is unavailable.");
    this.name = "AuthenticatedLocalBridgeOwnerIdentityMismatchError";
  }
}

export interface EnsureLocalBridgeOwnerDependencies {
  probe(): Promise<void>;
  isPortAvailable?(): Promise<boolean>;
  publishDesiredIdentity?(identityFingerprint: string): Promise<void>;
  readDesiredIdentity?(): Promise<string>;
  spawnOwner(): void | Promise<void>;
  wait(delayMs: number): Promise<void>;
}

export async function ensureLocalBridgeOwner(
  dependencies: EnsureLocalBridgeOwnerDependencies,
  options: {
    agentToken?: string;
    expectedIdentity?: LocalBridgeOwnerIdentity;
    startupTimeoutMs?: number;
    staleStartupTimeoutMs?: number;
    delayMs?: number;
    now?: () => number;
    publishDesiredIdentity?: boolean;
  } = {},
): Promise<void> {
  const agentToken = options.agentToken ?? await loadOrCreateLocalBridgeAgentToken();
  const expectedIdentity = options.expectedIdentity ?? loadLocalBridgeOwnerIdentity();
  const expectedIdentityFingerprint = fingerprintLocalBridgeOwnerIdentity(
    expectedIdentity,
    agentToken,
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  const startupTimeoutMs = options.startupTimeoutMs ?? OWNER_STARTUP_TIMEOUT_MS;
  const staleStartupTimeoutMs = options.staleStartupTimeoutMs ?? OWNER_STALE_STARTUP_TIMEOUT_MS;
  const delayMs = options.delayMs ?? OWNER_STARTUP_POLL_MS;
  if (
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1 ||
    !Number.isSafeInteger(staleStartupTimeoutMs) ||
    staleStartupTimeoutMs < startupTimeoutMs ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 1
  ) {
    throw unavailableOwner();
  }
  const publishDesiredIdentity = dependencies.publishDesiredIdentity ??
    ((identityFingerprint: string) => writeLocalBridgeProtectedBuildMarker(
      identityFingerprint,
      MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
    ));
  const readDesiredIdentity = dependencies.readDesiredIdentity ??
    (() => readVerifiedLocalBridgeProtectedBuildMarker(
      MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
    ));
  const desiredIdentityIsCurrent = async (): Promise<boolean> => {
    try {
      return await readDesiredIdentity() === expectedIdentityFingerprint;
    } catch {
      return false;
    }
  };
  if (options.publishDesiredIdentity !== false) {
    if (!await desiredIdentityIsCurrent()) {
      try {
        await publishDesiredIdentity(expectedIdentityFingerprint);
      } catch {
        throw unavailableOwner();
      }
    }
  }
  if (!await desiredIdentityIsCurrent()) throw unavailableOwner();

  let observedAuthenticatedStaleOwner = false;
  const probe = async (): Promise<boolean> => {
    try {
      await dependencies.probe();
      return true;
    } catch (error) {
      if (error instanceof AuthenticatedLocalBridgeOwnerIdentityMismatchError) {
        observedAuthenticatedStaleOwner = true;
      }
      return false;
    }
  };
  if (await probe()) {
    if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
    return;
  }

  let deadline = startedAt + (
    observedAuthenticatedStaleOwner ? staleStartupTimeoutMs : startupTimeoutMs
  );
  const isPortAvailable = dependencies.isPortAvailable ?? isLocalBridgeOwnerPortAvailable;
  let portAvailable = false;
  while (now() < deadline) {
    if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
    try {
      portAvailable = await isPortAvailable();
    } catch {
      portAvailable = false;
    }
    if (portAvailable) break;
    if (await probe()) {
      if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
      return;
    }
    if (observedAuthenticatedStaleOwner) {
      deadline = Math.max(deadline, startedAt + staleStartupTimeoutMs);
    }
    await dependencies.wait(Math.min(delayMs, Math.max(1, deadline - now())));
  }
  if (!portAvailable || !await desiredIdentityIsCurrent()) throw unavailableOwner();

  try {
    await dependencies.spawnOwner();
  } catch {
    throw unavailableOwner();
  }
  // A detached Windows launcher can synchronously wait for PowerShell to
  // return after Start-Process has created the owner. Start the full
  // authenticated readiness window only after that launcher resolves.
  deadline = now() + (
    observedAuthenticatedStaleOwner ? staleStartupTimeoutMs : startupTimeoutMs
  );
  while (now() < deadline) {
    await dependencies.wait(Math.min(delayMs, Math.max(1, deadline - now())));
    if (await probe()) {
      if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
      return;
    }
  }
  throw unavailableOwner();
}

export function spawnDetachedLocalBridgeOwner(): void {
  const launch = createDetachedLocalBridgeOwnerSpawn();
  if (process.platform === "win32") {
    const result = spawnSync(launch.command, launch.args, {
      cwd: launch.options.cwd,
      shell: launch.options.shell,
      stdio: launch.options.stdio,
      windowsHide: launch.options.windowsHide,
      env: launch.options.env,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) throw unavailableOwner();
    return;
  }
  const child = spawn(launch.command, launch.args, launch.options);
  child.once("error", () => {
    // The bounded authenticated probe reports startup failure to the MCP client.
  });
  child.unref();
}

export function createDetachedLocalBridgeOwnerSpawn(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const entryPath = fileURLToPath(new URL("./index.js", import.meta.url));
  return createDetachedLocalBridgeProcessSpawn(
    entryPath,
    "bridge-owner",
    environment,
    platform,
  );
}

export function createDetachedLocalBridgeProcessSpawn(
  entryPath: string,
  ownerCommand: "bridge-owner" | "mcp-http-owner",
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const cwd = dirname(dirname(entryPath));
  const sanitizedEnvironment = createSanitizedLocalBridgeOwnerEnvironment(environment);
  if (platform === "win32") {
    const windowsPowerShellPath = resolveWindowsPowerShellPath(environment);
    const powerShellScript = [
      "$ErrorActionPreference = 'Stop'",
      `$nodePath = ${toPowerShellSingleQuotedLiteral(process.execPath)}`,
      `$entryPath = ${toPowerShellSingleQuotedLiteral(`"${entryPath}"`)}`,
      `$workingDirectory = ${toPowerShellSingleQuotedLiteral(cwd)}`,
      ...(sanitizedEnvironment.CODEX_HOME
        ? [`$env:CODEX_HOME = ${toPowerShellSingleQuotedLiteral(sanitizedEnvironment.CODEX_HOME)}`]
        : []),
      `try { $ownerProcess = Start-Process -FilePath $nodePath -ArgumentList @($entryPath, ${toPowerShellSingleQuotedLiteral(ownerCommand)}) -WorkingDirectory $workingDirectory -WindowStyle Hidden -PassThru; if ($null -eq $ownerProcess -or $ownerProcess.Id -le 0) { exit 1 } } catch { exit 1 }`,
    ].join("\n");
    return {
      command: windowsPowerShellPath,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(powerShellScript, "utf16le").toString("base64"),
      ],
      options: {
        cwd,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        env: sanitizedEnvironment,
      } as const,
    };
  }
  return {
    command: process.execPath,
    args: [entryPath, ownerCommand],
    options: {
      cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: sanitizedEnvironment,
    } as const,
  };
}

function toPowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveWindowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  const powerShellPath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!isAbsolute(powerShellPath)) throw unavailableOwner();
  return powerShellPath;
}

export function createSanitizedLocalBridgeOwnerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitizedEnvironment = { ...environment };
  const tokenEnvironmentName = MEANTHIS_MCP_HTTP_TOKEN_ENV.toUpperCase();
  for (const name of Object.keys(sanitizedEnvironment)) {
    if (name.toUpperCase() === tokenEnvironmentName) delete sanitizedEnvironment[name];
  }
  return sanitizedEnvironment;
}

export interface DetachedLocalBridgeOwnerOptions {
  agentToken?: string;
  port?: number;
  ownerIdentity?: LocalBridgeOwnerIdentity;
  loadOwnerIdentity?: () => LocalBridgeOwnerIdentity;
  loadDesiredIdentity?: () => Promise<string>;
  readAgentToken?: () => Promise<string>;
  inspectAgentToken?: () => Promise<LocalBridgeAgentTokenInspection>;
  idleMs?: number;
  idleCheckMs?: number;
  desiredIdentityCheckMs?: number;
  desiredIdentityCheckTimeoutMs?: number;
  agentTokenCheckMs?: number;
  agentTokenCheckTimeoutMs?: number;
  agentTokenInspectionMs?: number;
  agentTokenInspectionTimeoutMs?: number;
  onReady?: (owner: { origin: string }) => void;
  onLifecycleEvent?: LocalBridgeOwnerLifecycleReporter;
}

export async function runDetachedLocalBridgeOwner(
  options: DetachedLocalBridgeOwnerOptions = {},
): Promise<void> {
  const agentToken = options.agentToken ?? await readVerifiedLocalBridgeAgentToken();
  const agentTokenFingerprint = fingerprintLocalBridgeAgentToken(agentToken);
  const state = createLocalBridgeState();
  const ownerIdentity = options.ownerIdentity ?? loadLocalBridgeOwnerIdentity();
  const ownerIdentityFingerprint = fingerprintLocalBridgeOwnerIdentity(ownerIdentity, agentToken);
  const loadOwnerIdentity = options.loadOwnerIdentity ?? loadLocalBridgeOwnerIdentity;
  const port = options.port ?? UI_ATTACH_LOCAL_BRIDGE_PORT;
  const loadDesiredIdentity = options.loadDesiredIdentity ?? (
    port === UI_ATTACH_LOCAL_BRIDGE_PORT
      ? () => readVerifiedLocalBridgeProtectedBuildMarker(
          MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME,
        )
      : async () => ownerIdentityFingerprint
  );
  const readAgentToken = options.readAgentToken ?? readLocalBridgeAgentToken;
  const inspectAgentToken = options.inspectAgentToken ?? inspectLocalBridgeAgentToken;
  let desiredIdentity: string;
  try {
    desiredIdentity = await loadDesiredIdentity();
  } catch {
    throw unavailableOwner();
  }
  if (desiredIdentity !== ownerIdentityFingerprint) throw unavailableOwner();
  const lifecycle = createLocalBridgeOwnerLifecycle({ idleMs: options.idleMs });
  const idleCheckMs = options.idleCheckMs ?? OWNER_IDLE_CHECK_MS;
  if (!Number.isSafeInteger(idleCheckMs) || idleCheckMs < 1) {
    throw new Error("Invalid local bridge owner idle check interval.");
  }
  const desiredIdentityCheckMs = options.desiredIdentityCheckMs ??
    OWNER_DESIRED_IDENTITY_CHECK_MS;
  const desiredIdentityCheckTimeoutMs = options.desiredIdentityCheckTimeoutMs ??
    OWNER_DESIRED_IDENTITY_CHECK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(desiredIdentityCheckMs) ||
    desiredIdentityCheckMs < 1 ||
    !Number.isSafeInteger(desiredIdentityCheckTimeoutMs) ||
    desiredIdentityCheckTimeoutMs < 1 ||
    desiredIdentityCheckTimeoutMs > 60_000
  ) {
    throw new Error("Invalid local bridge owner desired identity check interval.");
  }
  const agentTokenCheckMs = options.agentTokenCheckMs ?? OWNER_AGENT_TOKEN_CHECK_MS;
  const agentTokenCheckTimeoutMs = options.agentTokenCheckTimeoutMs ??
    OWNER_AGENT_TOKEN_CHECK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(agentTokenCheckMs) ||
    agentTokenCheckMs < 1 ||
    agentTokenCheckMs > 60_000 ||
    !Number.isSafeInteger(agentTokenCheckTimeoutMs) ||
    agentTokenCheckTimeoutMs < 1 ||
    agentTokenCheckTimeoutMs > 60_000
  ) {
    throw new Error("Invalid local bridge owner agent credential check interval.");
  }
  const agentTokenInspectionMs = options.agentTokenInspectionMs ??
    OWNER_AGENT_TOKEN_INSPECTION_MS;
  const minimumAgentTokenInspectionMs = options.inspectAgentToken
    ? 1
    : OWNER_AGENT_TOKEN_INSPECTION_MS;
  const agentTokenInspectionTimeoutMs = options.agentTokenInspectionTimeoutMs ??
    OWNER_AGENT_TOKEN_INSPECTION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(agentTokenInspectionMs) ||
    agentTokenInspectionMs < minimumAgentTokenInspectionMs ||
    agentTokenInspectionMs > 24 * 60 * 60_000 ||
    !Number.isSafeInteger(agentTokenInspectionTimeoutMs) ||
    agentTokenInspectionTimeoutMs < 1 ||
    agentTokenInspectionTimeoutMs > OWNER_AGENT_TOKEN_INSPECTION_MS
  ) {
    throw new Error("Invalid local bridge owner agent credential inspection interval.");
  }
  let http: Awaited<ReturnType<typeof startLocalBridgeHttpServer>> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let desiredIdentityTimer: ReturnType<typeof setInterval> | null = null;
  let desiredIdentityTimeout: ReturnType<typeof setTimeout> | null = null;
  let agentTokenTimer: ReturnType<typeof setInterval> | null = null;
  let agentTokenTimeout: ReturnType<typeof setTimeout> | null = null;
  let agentTokenInspectionTimer: ReturnType<typeof setInterval> | null = null;
  let agentTokenInspectionTimeout: ReturnType<typeof setTimeout> | null = null;
  let diagnosticHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let desiredIdentityCheckInFlight = false;
  let agentTokenCheckInFlight = false;
  let agentTokenInspectionInFlight = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const startedAt = Date.now();
  const reportLifecycle = async (
    event: LocalBridgeOwnerLifecycleEvent["event"],
    reason?: LocalBridgeOwnerLifecycleReason,
  ): Promise<void> => {
    await reportLocalBridgeOwnerLifecycleWithDeadline(options.onLifecycleEvent, {
      owner: "browser",
      event,
      ...(reason ? { reason } : {}),
      pid: process.pid,
      port,
      at: new Date().toISOString(),
      uptimeMs: Math.max(0, Date.now() - startedAt),
    });
  };
  const close = async (reason: LocalBridgeOwnerLifecycleReason): Promise<void> => {
    if (!lifecycle.beginClose()) return;
    if (idleTimer) clearInterval(idleTimer);
    if (desiredIdentityTimer) clearInterval(desiredIdentityTimer);
    if (desiredIdentityTimeout) clearTimeout(desiredIdentityTimeout);
    if (agentTokenTimer) clearInterval(agentTokenTimer);
    if (agentTokenTimeout) clearTimeout(agentTokenTimeout);
    if (agentTokenInspectionTimer) clearInterval(agentTokenInspectionTimer);
    if (agentTokenInspectionTimeout) clearTimeout(agentTokenInspectionTimeout);
    if (diagnosticHeartbeatTimer) clearInterval(diagnosticHeartbeatTimer);
    const diagnostic = reportLifecycle("close", reason).catch(() => undefined);
    if (http) await http.close();
    await diagnostic;
    resolveDone?.();
  };
  http = await startLocalBridgeHttpServer(state, {
    port,
    agentToken,
    ownerIdentity,
    enableAnnotationLifecycleControl: true,
    onActivity: lifecycle.recordActivity,
    onRequestStart: lifecycle.startRequest,
    onRequestEnd: () => {
      lifecycle.endRequest();
      if (lifecycle.shouldCloseAfterDrain()) void close("idle");
    },
    isClosing: lifecycle.isRejectingNewRequests,
  });
  idleTimer = setInterval(() => {
    try {
      if (!sameLocalBridgeOwnerIdentity(ownerIdentity, loadOwnerIdentity())) {
        void close("owner_identity_changed");
        return;
      }
    } catch {
      void close("owner_identity_check_failed");
      return;
    }
    if (!lifecycle.shouldBeginIdleDrain()) return;
    lifecycle.beginIdleDrain();
    if (lifecycle.shouldCloseAfterDrain()) void close("idle");
  }, idleCheckMs);
  idleTimer.unref();
  const verifyDesiredIdentity = (): void => {
    if (desiredIdentityCheckInFlight || lifecycle.isClosing()) return;
    desiredIdentityCheckInFlight = true;
    desiredIdentityTimeout = setTimeout(() => {
      desiredIdentityTimeout = null;
      desiredIdentityCheckInFlight = false;
      void close("desired_identity_check_timeout");
    }, desiredIdentityCheckTimeoutMs);
    desiredIdentityTimeout.unref();
    void loadDesiredIdentity().then((currentDesiredIdentity) => {
      if (currentDesiredIdentity !== ownerIdentityFingerprint) {
        return close("desired_identity_changed");
      }
    }).catch(() => close("desired_identity_check_failed")).finally(() => {
      if (desiredIdentityTimeout) clearTimeout(desiredIdentityTimeout);
      desiredIdentityTimeout = null;
      desiredIdentityCheckInFlight = false;
    });
  };
  desiredIdentityTimer = setInterval(verifyDesiredIdentity, desiredIdentityCheckMs);
  desiredIdentityTimer.unref();
  const verifyAgentToken = (): void => {
    if (agentTokenCheckInFlight || lifecycle.isClosing()) return;
    agentTokenCheckInFlight = true;
    agentTokenTimeout = setTimeout(() => {
      agentTokenTimeout = null;
      agentTokenCheckInFlight = false;
      void close("agent_token_check_timeout");
    }, agentTokenCheckTimeoutMs);
    agentTokenTimeout.unref();
    void readAgentToken().then((currentAgentToken) => {
      if (!sameCredentialBytes(currentAgentToken, agentToken)) {
        return close("agent_token_changed");
      }
    }).catch(() => close("agent_token_check_failed")).finally(() => {
      if (agentTokenTimeout) clearTimeout(agentTokenTimeout);
      agentTokenTimeout = null;
      agentTokenCheckInFlight = false;
    });
  };
  agentTokenTimer = setInterval(verifyAgentToken, agentTokenCheckMs);
  agentTokenTimer.unref();
  const verifyAgentTokenInspection = (): void => {
    if (agentTokenInspectionInFlight || lifecycle.isClosing()) return;
    agentTokenInspectionInFlight = true;
    agentTokenInspectionTimeout = setTimeout(() => {
      agentTokenInspectionTimeout = null;
      agentTokenInspectionInFlight = false;
      void close("agent_acl_check_timeout");
    }, agentTokenInspectionTimeoutMs);
    agentTokenInspectionTimeout.unref();
    void inspectAgentToken().then(async (inspection) => {
      if (
        inspection.status !== "ready" ||
        inspection.fingerprint !== agentTokenFingerprint
      ) {
        return close("agent_acl_failed");
      }
      const currentAgentToken = await readAgentToken();
      if (!sameCredentialBytes(currentAgentToken, agentToken)) return close("agent_token_changed");
    }).catch(() => close("agent_acl_check_failed")).finally(() => {
      if (agentTokenInspectionTimeout) clearTimeout(agentTokenInspectionTimeout);
      agentTokenInspectionTimeout = null;
      agentTokenInspectionInFlight = false;
    });
  };
  agentTokenInspectionTimer = setInterval(
    verifyAgentTokenInspection,
    agentTokenInspectionMs,
  );
  agentTokenInspectionTimer.unref();
  await reportLifecycle("ready").catch(() => undefined);
  diagnosticHeartbeatTimer = setInterval(() => {
    void reportLifecycle("heartbeat").catch(() => undefined);
  }, OWNER_DIAGNOSTIC_HEARTBEAT_MS);
  diagnosticHeartbeatTimer.unref();
  const onSignal = () => void close("signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    options.onReady?.({ origin: http.origin });
    await done;
  } catch (error) {
    await close("server_error");
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function waitForLocalBridgeOwner(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createLocalBridgeOwnerLifecycleReporter(
  codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex"),
  options: {
    /** @internal Deterministic seam for reporter coalescing and failure tests. */
    persist?: typeof persistLocalBridgeOwnerLifecycleEvent;
  } = {},
): LocalBridgeOwnerLifecycleReporter {
  const persist = options.persist ?? persistLocalBridgeOwnerLifecycleEvent;
  let queued: LocalBridgeOwnerLifecycleEvent | undefined;
  let running: Promise<void> | undefined;
  const start = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (queued) {
        const event = queued;
        queued = undefined;
        await persist(event, codexHome).catch(() => undefined);
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return (event) => {
    if (queued?.event !== "close" || event.event === "close") queued = event;
    return start();
  };
}

export async function reportLocalBridgeOwnerLifecycleWithDeadline(
  reporter: LocalBridgeOwnerLifecycleReporter | undefined,
  event: LocalBridgeOwnerLifecycleEvent,
  timeoutMs = OWNER_DIAGNOSTIC_WRITE_TIMEOUT_MS,
): Promise<void> {
  if (!reporter) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => reporter(event)).catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getLocalBridgeOwnerLifecycleDiagnosticPath(
  owner: LocalBridgeOwnerLifecycleEvent["owner"],
  codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex"),
): string {
  return join(
    resolve(codexHome),
    "ui-attach",
    "diagnostics",
    `owner-${owner}-lifecycle.json`,
  );
}

async function persistLocalBridgeOwnerLifecycleEvent(
  event: LocalBridgeOwnerLifecycleEvent,
  codexHome: string,
): Promise<void> {
  const directory = join(resolve(codexHome), "ui-attach", "diagnostics");
  const path = getLocalBridgeOwnerLifecycleDiagnosticPath(event.owner, codexHome);
  const temporaryPath = join(directory, `.owner-lifecycle-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export interface LocalBridgeOwnerLifecycle {
  recordActivity(): void;
  startRequest(): void;
  endRequest(): void;
  isClosing(): boolean;
  isRejectingNewRequests(): boolean;
  shouldBeginIdleDrain(): boolean;
  beginIdleDrain(): void;
  shouldCloseAfterDrain(): boolean;
  beginClose(): boolean;
}

export function createLocalBridgeOwnerLifecycle(
  options: { now?: () => number; idleMs?: number } = {},
): LocalBridgeOwnerLifecycle {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? OWNER_IDLE_MS;
  let lastActivityAt = now();
  let activeRequests = 0;
  let draining = false;
  let closing = false;
  return {
    recordActivity() {
      if (closing) return;
      lastActivityAt = now();
      draining = false;
    },
    startRequest() {
      if (!closing) activeRequests += 1;
    },
    endRequest() {
      activeRequests = Math.max(0, activeRequests - 1);
    },
    isClosing() {
      return closing;
    },
    isRejectingNewRequests() {
      return closing || draining;
    },
    shouldBeginIdleDrain() {
      return !closing && !draining && now() - lastActivityAt >= idleMs;
    },
    beginIdleDrain() {
      if (!closing) draining = true;
    },
    shouldCloseAfterDrain() {
      return !closing && draining && activeRequests === 0;
    },
    beginClose() {
      if (closing) return false;
      closing = true;
      draining = false;
      return true;
    },
  };
}

export function loadLocalBridgeOwnerIdentity(
  executablePath = process.execPath,
  entryPath = fileURLToPath(new URL("./index.js", import.meta.url)),
  readFile: (path: string) => Uint8Array = readFileSync,
): LocalBridgeOwnerIdentity {
  const buildFiles = [
    ["cli/index.js", entryPath],
    ["cli/bridge-cli.js", fileURLToPath(new URL("./bridge-cli.js", import.meta.url))],
    ["cli/local-bridge-native-host.js", fileURLToPath(new URL("./local-bridge-native-host.js", import.meta.url))],
    ["cli/local-bridge-native-host-contract.js", fileURLToPath(new URL("./local-bridge-native-host-contract.js", import.meta.url))],
    ["cli/local-bridge-native-host-install.js", fileURLToPath(new URL("./local-bridge-native-host-install.js", import.meta.url))],
    ["cli/local-bridge-owner.js", fileURLToPath(new URL("./local-bridge-owner.js", import.meta.url))],
    ["cli/local-bridge-mcp.js", fileURLToPath(new URL("./local-bridge-mcp.js", import.meta.url))],
    ["cli/local-bridge.js", fileURLToPath(new URL("./local-bridge.js", import.meta.url))],
    ["cli/local-bridge-agent-auth.js", fileURLToPath(new URL("./local-bridge-agent-auth.js", import.meta.url))],
    ["cli/local-bridge-agent-token.js", fileURLToPath(new URL("./local-bridge-agent-token.js", import.meta.url))],
    ["cli/local-bridge-mcp-http-token.js", fileURLToPath(new URL("./local-bridge-mcp-http-token.js", import.meta.url))],
    ["schema/index.js", fileURLToPath(new URL("../../../packages/schema/dist/index.js", import.meta.url))],
  ] as const;
  const hash = createHash("sha256");
  for (const [label, path] of buildFiles) {
    hash.update(label, "utf8");
    hash.update("\0", "utf8");
    hash.update(readFile(path));
    hash.update("\0", "utf8");
  }
  return { executablePath, entryPath, buildHash: hash.digest("hex") };
}

export function sameLocalBridgeOwnerIdentity(
  left: LocalBridgeOwnerIdentity,
  right: LocalBridgeOwnerIdentity,
): boolean {
  return left.executablePath === right.executablePath &&
    left.entryPath === right.entryPath &&
    left.buildHash === right.buildHash;
}

export function fingerprintLocalBridgeOwnerIdentity(
  identity: LocalBridgeOwnerIdentity,
  agentToken: string,
): string {
  if (
    typeof identity.executablePath !== "string" ||
    identity.executablePath.length === 0 ||
    typeof identity.entryPath !== "string" ||
    identity.entryPath.length === 0 ||
    !/^[0-9a-f]{64}$/.test(identity.buildHash) ||
    !validateLocalBridgeAgentToken(agentToken)
  ) {
    throw unavailableOwner();
  }
  const hash = createHash("sha256");
  hash.update("meanthis.local-bridge-owner-desired-identity.v2", "utf8");
  for (const [label, value] of [
    ["executablePath", identity.executablePath],
    ["entryPath", identity.entryPath],
    ["buildHash", identity.buildHash],
    ["agentToken", agentToken],
  ] as const) {
    hash.update("\0", "utf8");
    hash.update(label, "utf8");
    hash.update("\0", "utf8");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

function isLocalBridgeOwnerPortAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(unavailableOwner());
    });
    server.once("listening", () => {
      server.close((error) => error ? reject(unavailableOwner()) : resolve(true));
    });
    server.listen(UI_ATTACH_LOCAL_BRIDGE_PORT, UI_ATTACH_LOCAL_BRIDGE_HOST);
  });
}

function unavailableOwner(): Error {
  return new Error("Detached local bridge owner is unavailable.");
}

function sameCredentialBytes(currentCredential: string, expectedCredential: string): boolean {
  const currentBytes = Buffer.from(currentCredential, "utf8");
  const expectedBytes = Buffer.from(expectedCredential, "utf8");
  return currentBytes.length === expectedBytes.length &&
    timingSafeEqual(currentBytes, expectedBytes);
}
