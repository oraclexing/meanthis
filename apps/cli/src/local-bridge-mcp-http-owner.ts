import { spawn, spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { opendirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  type WorkerOptions,
} from "node:worker_threads";
import { UI_ATTACH_LOCAL_BRIDGE_ORIGIN } from "@meanthis/schema";
import { readVerifiedLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  createHttpLocalBridgeReader,
  startLocalBridgeOwnerLease,
  type LocalBridgeOwnerLease,
  type LocalBridgeReader,
} from "./local-bridge-mcp.js";
import {
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HOST,
  createLocalBridgeMcpHttpHealthProofRequest,
  isLocalBridgeMcpHttpHealth,
  startLocalBridgeMcpHttpServer,
  verifyLocalBridgeMcpHttpHealthProofResponse,
  type LocalBridgeMcpHttpHealth,
  type LocalBridgeMcpHttpServer,
} from "./local-bridge-mcp-http.js";
import {
  fingerprintLocalBridgeMcpHttpToken,
  inspectLocalBridgeMcpHttpToken,
  readLocalBridgeMcpHttpDesiredIdentity,
  readLocalBridgeMcpHttpToken,
  readVerifiedLocalBridgeMcpHttpToken,
  validateLocalBridgeMcpHttpToken,
  writeLocalBridgeMcpHttpDesiredIdentity,
} from "./local-bridge-mcp-http-token.js";
import {
  createDetachedLocalBridgeProcessSpawn,
  createSanitizedLocalBridgeOwnerEnvironment,
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  reportLocalBridgeOwnerLifecycleWithDeadline,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
  type LocalBridgeOwnerLifecycleReason,
  type LocalBridgeOwnerLifecycleReporter,
} from "./local-bridge-owner.js";

const OWNER_CHECK_INTERVAL_MS = 1_000;
const OWNER_FAST_CHECK_TIMEOUT_MS = 10_000;
const OWNER_BUILD_CHECK_INTERVAL_MS = 30_000;
const OWNER_CREDENTIAL_CHECK_INTERVAL_MS = 30_000;
const OWNER_SLOW_CHECK_TIMEOUT_MS = 10_000;
const OWNER_STARTUP_TIMEOUT_MS = 30_000;
const OWNER_STARTUP_POLL_MS = 50;
const OWNER_HEALTH_TIMEOUT_MS = 250;
const OWNER_DIAGNOSTIC_HEARTBEAT_MS = 30_000;
const MAX_HEALTH_BYTES = 64 * 1024;
const TOKEN_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/;
const OWNER_BUILD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_IMPORT_CONDITIONS = new Set(["import", "node", "default"]);
const MAX_FINGERPRINT_PACKAGE_FILES = 4_096;
const MAX_FINGERPRINT_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_FINGERPRINT_PACKAGE_DIRECTORIES = 4_096;
const MAX_FINGERPRINT_PACKAGE_DIRECTORY_DEPTH = 64;
const MAX_FINGERPRINT_PACKAGE_DIRECTORY_ENTRIES = 4_096;
const MAX_FINGERPRINT_PACKAGE_ENTRIES = 32_768;
const MAX_FINGERPRINT_CLOSURE_PACKAGES = 256;
const MAX_FINGERPRINT_CLOSURE_FILES = 32_768;
const MAX_FINGERPRINT_CLOSURE_BYTES = 256 * 1024 * 1024;
const MAX_FINGERPRINT_PACKAGE_DEPENDENCIES = 256;
const OWNER_IDENTITY_WORKER_KIND = "meanthis.mcp-http-owner-identity-worker.v1";

export const LOCAL_BRIDGE_MCP_HTTP_LEGACY_FOREGROUND_OWNER =
  "MCP_HTTP_LEGACY_FOREGROUND_OWNER" as const;
export const LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER =
  "MCP_HTTP_UNVERIFIED_LISTENER" as const;
export const LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER_GUIDANCE =
  "Stop the process that owns 127.0.0.1:38472 manually, then run meanthis bridge start --json.";

export class LocalBridgeMcpHttpLegacyForegroundOwnerError extends Error {
  readonly code = LOCAL_BRIDGE_MCP_HTTP_LEGACY_FOREGROUND_OWNER;

  constructor() {
    super("A legacy foreground MeanThis MCP HTTP server is occupying the configured port.");
    this.name = "LocalBridgeMcpHttpLegacyForegroundOwnerError";
  }
}

export class LocalBridgeMcpHttpUnverifiedListenerError extends Error {
  readonly code = LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER;
  readonly next = LOCAL_BRIDGE_MCP_HTTP_UNVERIFIED_LISTENER_GUIDANCE;

  constructor() {
    super("An unverified listener is occupying 127.0.0.1:38472.");
    this.name = "LocalBridgeMcpHttpUnverifiedListenerError";
  }
}

export interface LocalBridgeMcpHttpOwnerIdentity {
  executablePath: string;
  entryPath: string;
  buildHash: string;
}

export {
  getLocalBridgeMcpHttpDesiredIdentityPath,
  readLocalBridgeMcpHttpDesiredIdentity,
  writeLocalBridgeMcpHttpDesiredIdentity,
} from "./local-bridge-mcp-http-token.js";

interface PackageRuntimeFile {
  relativePath: string;
  path: string;
}

interface PackageRuntimeManifest {
  identityKey: string;
  dependencies: readonly string[];
  optionalDependencies: readonly string[];
  peerDependencies: readonly string[];
  optionalPeerDependencies: ReadonlySet<string>;
}

interface RuntimePackageSeed {
  role: string;
  entryUrl: string;
  packageName: string;
}

type OwnerIdentityWorkerResponse =
  | { ok: true; identity: LocalBridgeMcpHttpOwnerIdentity }
  | { ok: false };

if (!isMainThread && isOwnerIdentityWorkerRequest(workerData)) {
  let response: OwnerIdentityWorkerResponse;
  try {
    response = { ok: true, identity: loadLocalBridgeMcpHttpOwnerIdentity() };
  } catch {
    response = { ok: false };
  }
  parentPort?.postMessage(response);
  parentPort?.close();
}

export interface EnsureLocalBridgeMcpHttpOwnerDependencies {
  probe(): Promise<LocalBridgeMcpHttpHealth>;
  isPortAvailable(): Promise<boolean>;
  isDesiredIdentityCurrent?(): Promise<boolean>;
  spawnOwner(): void | Promise<void>;
  wait(delayMs: number): Promise<void>;
}

export async function ensureLocalBridgeMcpHttpOwner(
  dependencies: EnsureLocalBridgeMcpHttpOwnerDependencies,
  options: {
    expectedIdentity?: LocalBridgeMcpHttpOwnerIdentity;
    startupTimeoutMs?: number;
    delayMs?: number;
    now?: () => number;
  } = {},
): Promise<LocalBridgeMcpHttpHealth> {
  const expectedIdentity = options.expectedIdentity ?? loadLocalBridgeMcpHttpOwnerIdentity();
  validateOwnerIdentity(expectedIdentity);
  const now = options.now ?? Date.now;
  const timeoutMs = options.startupTimeoutMs ?? OWNER_STARTUP_TIMEOUT_MS;
  const delayMs = options.delayMs ?? OWNER_STARTUP_POLL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(delayMs) || delayMs < 1) {
    throw unavailableOwner();
  }
  let deadline = now() + timeoutMs;

  const desiredIdentityIsCurrent = async (): Promise<boolean> => {
    if (!dependencies.isDesiredIdentityCurrent) return true;
    try {
      return await dependencies.isDesiredIdentityCurrent();
    } catch {
      return false;
    }
  };

  let observedUnverifiedListener = false;
  const probeExistingOwner = async (): Promise<LocalBridgeMcpHttpHealth | null> => {
    try {
      return await probeMatchingOwner(dependencies.probe, expectedIdentity.buildHash);
    } catch (error) {
      if (!(error instanceof LocalBridgeMcpHttpUnverifiedListenerError)) throw error;
      observedUnverifiedListener = true;
      return null;
    }
  };
  const finalUnavailableError = (): Error => observedUnverifiedListener
    ? new LocalBridgeMcpHttpUnverifiedListenerError()
    : unavailableOwner();

  const existing = await probeExistingOwner();
  if (existing) {
    if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
    return existing;
  }

  // A failed authenticated probe can mean no listener, a stale owner using the
  // previous token, or a foreign process. Never race a replacement against an
  // occupied port: the stale owner detects build/token turnover and drains first.
  let portAvailable = false;
  while (now() < deadline) {
    if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
    try {
      portAvailable = await dependencies.isPortAvailable();
    } catch {
      // Keep the public failure generic and retry only for the bounded window.
    }
    if (portAvailable) break;
    const concurrentWinner = await probeExistingOwner();
    if (concurrentWinner) {
      if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
      return concurrentWinner;
    }
    await dependencies.wait(Math.min(delayMs, Math.max(1, deadline - now())));
  }
  if (!portAvailable) throw finalUnavailableError();
  if (!await desiredIdentityIsCurrent()) throw unavailableOwner();

  try {
    await dependencies.spawnOwner();
  } catch {
    throw unavailableOwner();
  }
  // The detached Windows launcher waits for hidden PowerShell to confirm a
  // valid child PID. Give the owner a complete authenticated readiness window
  // only after that launcher resolves.
  deadline = now() + timeoutMs;
  while (now() < deadline) {
    await dependencies.wait(Math.min(delayMs, Math.max(1, deadline - now())));
    const started = await probeExistingOwner();
    if (started) {
      if (!await desiredIdentityIsCurrent()) throw unavailableOwner();
      return started;
    }
  }
  throw finalUnavailableError();
}

export async function ensureDetachedLocalBridgeMcpHttpOwner(
  bearerToken: string,
  options: {
    expectedIdentity?: LocalBridgeMcpHttpOwnerIdentity;
    startupTimeoutMs?: number;
    delayMs?: number;
  } = {},
): Promise<LocalBridgeMcpHttpHealth> {
  if (!validateLocalBridgeMcpHttpToken(bearerToken)) throw unavailableOwner();
  let expectedIdentity: LocalBridgeMcpHttpOwnerIdentity;
  try {
    expectedIdentity = options.expectedIdentity ?? loadLocalBridgeMcpHttpOwnerIdentity();
  } catch {
    throw unavailableOwner();
  }
  try {
    await writeLocalBridgeMcpHttpDesiredIdentity(expectedIdentity.buildHash);
  } catch {
    throw unavailableOwner();
  }
  return ensureLocalBridgeMcpHttpOwner({
    probe: () => probeLocalBridgeMcpHttpOwner(bearerToken, expectedIdentity),
    isPortAvailable: isLocalBridgeMcpHttpPortAvailable,
    isDesiredIdentityCurrent: async () =>
      await readLocalBridgeMcpHttpDesiredIdentity() === expectedIdentity.buildHash,
    spawnOwner: spawnDetachedLocalBridgeMcpHttpOwner,
    wait: waitForLocalBridgeMcpHttpOwner,
  }, {
    expectedIdentity,
    startupTimeoutMs: options.startupTimeoutMs,
    delayMs: options.delayMs,
  });
}

export function createDetachedLocalBridgeMcpHttpOwnerSpawn(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const entryPath = fileURLToPath(new URL("./index.js", import.meta.url));
  return createDetachedLocalBridgeProcessSpawn(
    entryPath,
    "mcp-http-owner",
    environment,
    platform,
  );
}

export function spawnDetachedLocalBridgeMcpHttpOwner(): void {
  const launch = createDetachedLocalBridgeMcpHttpOwnerSpawn();
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
    // The bounded authenticated health probe reports startup failure generically.
  });
  child.unref();
}

export interface DetachedLocalBridgeMcpHttpOwnerOptions {
  bearerToken?: string;
  agentToken?: string;
  ownerIdentity?: LocalBridgeMcpHttpOwnerIdentity;
  browserOwnerIdentity?: ReturnType<typeof loadLocalBridgeOwnerIdentity>;
  tokenFingerprint?: string;
  checkIntervalMs?: number;
  fastCheckTimeoutMs?: number;
  buildCheckIntervalMs?: number;
  slowCheckTimeoutMs?: number;
  port?: number;
  loadOwnerIdentity?: (
    signal?: AbortSignal,
  ) => LocalBridgeMcpHttpOwnerIdentity | Promise<LocalBridgeMcpHttpOwnerIdentity>;
  loadTokenFingerprint?: () => Promise<string>;
  readTokenCredential?: () => Promise<string>;
  loadDesiredBuildHash?: () => Promise<string>;
  credentialCheckIntervalMs?: number;
  inspectTokenCredential?: () => Promise<boolean>;
  createReader?: (agentToken: string) => LocalBridgeReader;
  startServer?: (
    reader: LocalBridgeReader,
    options: {
      bearerToken: string;
      ownerIdentity: { buildHash: string };
      port: number;
    },
  ) => Promise<LocalBridgeMcpHttpServer>;
  ensureBridgeOwner?: (
    reader: LocalBridgeReader,
    options: { publishDesiredIdentity: boolean },
  ) => Promise<void>;
  startBridgeOwnerLease?: (
    ensureOwner: () => Promise<void>,
    onOwnerUnavailable: () => void,
  ) => LocalBridgeOwnerLease;
  onReady?: (owner: { origin: string; buildHash: string }) => void;
  onLifecycleEvent?: LocalBridgeOwnerLifecycleReporter;
}

export async function runDetachedLocalBridgeMcpHttpOwner(
  options: DetachedLocalBridgeMcpHttpOwnerOptions = {},
): Promise<void> {
  const bearerToken = options.bearerToken ?? await readVerifiedLocalBridgeMcpHttpToken();
  if (!validateLocalBridgeMcpHttpToken(bearerToken)) throw unavailableOwner();
  const tokenFingerprint = options.tokenFingerprint ??
    fingerprintLocalBridgeMcpHttpToken(bearerToken);
  validateTokenFingerprint(tokenFingerprint);
  const ownerIdentity = options.ownerIdentity ?? loadLocalBridgeMcpHttpOwnerIdentity();
  validateOwnerIdentity(ownerIdentity);
  const port = options.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw unavailableOwner();
  const loadDesiredBuildHash = options.loadDesiredBuildHash ?? (
    port === MEANTHIS_MCP_HTTP_DEFAULT_PORT
      ? () => readLocalBridgeMcpHttpDesiredIdentity()
      : async () => ownerIdentity.buildHash
  );
  let desiredBuildHash: string;
  try {
    desiredBuildHash = await loadDesiredBuildHash();
    validateBuildHash(desiredBuildHash);
  } catch {
    throw unavailableOwner();
  }
  if (desiredBuildHash !== ownerIdentity.buildHash) throw unavailableOwner();
  const agentToken = options.agentToken ?? await readVerifiedLocalBridgeAgentToken();
  const browserOwnerIdentity = options.browserOwnerIdentity ?? (
    options.createReader && options.ensureBridgeOwner ? undefined : loadLocalBridgeOwnerIdentity()
  );
  const reader = options.createReader
    ? options.createReader(agentToken)
    : createHttpLocalBridgeReader(
      UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
      agentToken,
      { expectedOwnerIdentity: requireBrowserOwnerIdentity(browserOwnerIdentity) },
    );
  const startServer = options.startServer ?? startLocalBridgeMcpHttpServer;
  const checkIntervalMs = options.checkIntervalMs ?? OWNER_CHECK_INTERVAL_MS;
  if (!Number.isSafeInteger(checkIntervalMs) || checkIntervalMs < 1 || checkIntervalMs > 60_000) {
    throw unavailableOwner();
  }
  const fastCheckTimeoutMs = options.fastCheckTimeoutMs ?? OWNER_FAST_CHECK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(fastCheckTimeoutMs) ||
    fastCheckTimeoutMs < 1 ||
    fastCheckTimeoutMs > 60_000
  ) {
    throw unavailableOwner();
  }
  const loadOwnerIdentity = options.loadOwnerIdentity ?? loadLocalBridgeMcpHttpOwnerIdentityInWorker;
  const loadTokenFingerprint = options.loadTokenFingerprint;
  const readTokenCredential = options.readTokenCredential ?? readLocalBridgeMcpHttpToken;
  const buildCheckIntervalMs = options.buildCheckIntervalMs ?? OWNER_BUILD_CHECK_INTERVAL_MS;
  const minimumBuildCheckIntervalMs = options.loadOwnerIdentity
    ? 1
    : OWNER_BUILD_CHECK_INTERVAL_MS;
  if (
    !Number.isSafeInteger(buildCheckIntervalMs) ||
    buildCheckIntervalMs < minimumBuildCheckIntervalMs ||
    buildCheckIntervalMs > 24 * 60 * 60_000
  ) {
    throw unavailableOwner();
  }
  const slowCheckTimeoutMs = options.slowCheckTimeoutMs ?? OWNER_SLOW_CHECK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(slowCheckTimeoutMs) ||
    slowCheckTimeoutMs < 1 ||
    slowCheckTimeoutMs > OWNER_BUILD_CHECK_INTERVAL_MS
  ) {
    throw unavailableOwner();
  }
  const credentialCheckIntervalMs = options.credentialCheckIntervalMs ??
    OWNER_CREDENTIAL_CHECK_INTERVAL_MS;
  if (
    !Number.isSafeInteger(credentialCheckIntervalMs) ||
    credentialCheckIntervalMs < OWNER_CREDENTIAL_CHECK_INTERVAL_MS ||
    credentialCheckIntervalMs > 24 * 60 * 60_000
  ) {
    throw unavailableOwner();
  }
  const inspectTokenCredential = options.inspectTokenCredential ?? (async () => {
    const inspection = await inspectLocalBridgeMcpHttpToken();
    return inspection.status === "ready";
  });
  const ensureBridgeOwner = options.ensureBridgeOwner ?? (async (
    sharedReader,
    ensureOptions,
  ) => {
    await ensureLocalBridgeOwner({
      probe: async () => { await sharedReader.getStatus(); },
      spawnOwner: spawnDetachedLocalBridgeOwner,
      wait: waitForLocalBridgeOwner,
    }, {
      agentToken,
      expectedIdentity: requireBrowserOwnerIdentity(browserOwnerIdentity),
      publishDesiredIdentity: ensureOptions.publishDesiredIdentity,
      startupTimeoutMs: OWNER_STARTUP_TIMEOUT_MS,
      staleStartupTimeoutMs: OWNER_STARTUP_TIMEOUT_MS,
    });
  });
  const refreshBridgeOwner = (): Promise<void> =>
    ensureBridgeOwner(reader, { publishDesiredIdentity: false });
  try {
    await refreshBridgeOwner();
  } catch {
    throw unavailableOwner();
  }
  const http = await startServer(reader, {
    bearerToken,
    ownerIdentity: { buildHash: ownerIdentity.buildHash },
    port,
  });
  let bridgeOwnerLease: LocalBridgeOwnerLease;
  let closeOnBridgeOwnerUnavailable = (): void => undefined;
  try {
    const onBridgeOwnerUnavailable = (): void => closeOnBridgeOwnerUnavailable();
    bridgeOwnerLease = options.startBridgeOwnerLease?.(
      refreshBridgeOwner,
      onBridgeOwnerUnavailable,
    ) ?? startLocalBridgeOwnerLease({
      ensureOwner: refreshBridgeOwner,
      onOwnerUnavailable: onBridgeOwnerUnavailable,
    });
  } catch {
    await http.close().catch(() => undefined);
    throw unavailableOwner();
  }

  let fastTimer: ReturnType<typeof setInterval> | undefined;
  let buildTimer: ReturnType<typeof setInterval> | undefined;
  let credentialTimer: ReturnType<typeof setInterval> | undefined;
  let diagnosticHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let fastCheckInFlight = false;
  let buildCheckInFlight = false;
  let credentialCheckInFlight = false;
  let fastCheckTimeout: ReturnType<typeof setTimeout> | undefined;
  let buildCheckAbort: AbortController | undefined;
  let buildCheckTimeout: ReturnType<typeof setTimeout> | undefined;
  let credentialCheckTimeout: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  const startedAt = Date.now();
  const reportLifecycle = async (
    event: "ready" | "heartbeat" | "close",
    reason?: LocalBridgeOwnerLifecycleReason,
  ): Promise<void> => {
    await reportLocalBridgeOwnerLifecycleWithDeadline(options.onLifecycleEvent, {
      owner: "mcp_http",
      event,
      ...(reason ? { reason } : {}),
      pid: process.pid,
      port,
      at: new Date().toISOString(),
      uptimeMs: Math.max(0, Date.now() - startedAt),
    });
  };
  const close = (reason: LocalBridgeOwnerLifecycleReason): Promise<void> => {
    if (closePromise) return closePromise;
    if (fastTimer) clearInterval(fastTimer);
    if (buildTimer) clearInterval(buildTimer);
    if (credentialTimer) clearInterval(credentialTimer);
    if (fastCheckTimeout) clearTimeout(fastCheckTimeout);
    if (buildCheckTimeout) clearTimeout(buildCheckTimeout);
    if (credentialCheckTimeout) clearTimeout(credentialCheckTimeout);
    if (diagnosticHeartbeatTimer) clearInterval(diagnosticHeartbeatTimer);
    buildCheckAbort?.abort();
    buildCheckAbort = undefined;
    try {
      bridgeOwnerLease.stop();
    } catch {
      // The owner must still drain its authenticated HTTP sessions.
    }
    const diagnostic = reportLifecycle("close", reason).catch(() => undefined);
    closePromise = http.close().then(() => diagnostic).then(resolveDone, (error) => {
      rejectDone(error);
      throw error;
    });
    return closePromise;
  };
  closeOnBridgeOwnerUnavailable = () => {
    void close("bridge_lease_unavailable").catch(() => undefined);
  };
  const verifyCurrentOwner = (): void => {
    if (fastCheckInFlight || closePromise) return;
    fastCheckInFlight = true;
    fastCheckTimeout = setTimeout(() => {
      fastCheckTimeout = undefined;
      fastCheckInFlight = false;
      void close("mcp_identity_check_timeout").catch(() => undefined);
    }, fastCheckTimeoutMs);
    fastCheckTimeout.unref();
    void Promise.all([
      readTokenCredential(),
      loadDesiredBuildHash(),
      loadTokenFingerprint?.(),
    ]).then(([currentTokenCredential, currentDesiredBuildHash, currentTokenFingerprint]) => {
      if (currentTokenFingerprint !== undefined) {
        validateTokenFingerprint(currentTokenFingerprint);
      }
      validateBuildHash(currentDesiredBuildHash);
      if (
        !sameCredentialBytes(currentTokenCredential, bearerToken) ||
        (currentTokenFingerprint !== undefined && currentTokenFingerprint !== tokenFingerprint) ||
        currentDesiredBuildHash !== ownerIdentity.buildHash
      ) {
        return close(
          !sameCredentialBytes(currentTokenCredential, bearerToken) ||
              (currentTokenFingerprint !== undefined && currentTokenFingerprint !== tokenFingerprint)
            ? "mcp_token_changed"
            : "mcp_identity_changed",
        );
      }
    }).catch(() => close("mcp_identity_check_failed")).finally(() => {
      if (fastCheckTimeout) clearTimeout(fastCheckTimeout);
      fastCheckTimeout = undefined;
      fastCheckInFlight = false;
    });
  };

  const verifyBuild = (): void => {
    if (buildCheckInFlight || closePromise) return;
    buildCheckInFlight = true;
    const abort = new AbortController();
    buildCheckAbort = abort;
    buildCheckTimeout = setTimeout(() => {
      buildCheckTimeout = undefined;
      buildCheckInFlight = false;
      abort.abort();
      void close("mcp_identity_check_timeout").catch(() => undefined);
    }, slowCheckTimeoutMs);
    buildCheckTimeout.unref();
    void Promise.resolve().then(() => loadOwnerIdentity(abort.signal)).then((currentIdentity) => {
      validateOwnerIdentity(currentIdentity);
      if (!sameLocalBridgeMcpHttpOwnerIdentity(ownerIdentity, currentIdentity)) {
        return close("mcp_identity_changed");
      }
    }).catch(() => close("mcp_identity_check_failed")).finally(() => {
      if (buildCheckTimeout) clearTimeout(buildCheckTimeout);
      buildCheckTimeout = undefined;
      if (buildCheckAbort === abort) buildCheckAbort = undefined;
      buildCheckInFlight = false;
    });
  };

  const verifyCredential = (): void => {
    if (credentialCheckInFlight || closePromise) return;
    credentialCheckInFlight = true;
    credentialCheckTimeout = setTimeout(() => {
      credentialCheckTimeout = undefined;
      credentialCheckInFlight = false;
      void close("mcp_acl_check_timeout").catch(() => undefined);
    }, slowCheckTimeoutMs);
    credentialCheckTimeout.unref();
    void Promise.resolve().then(() => inspectTokenCredential()).then(async (ready) => {
      // A failed ACL/mode inspection is a potential credential disclosure. The
      // current token is never reused merely because a later inspection repairs
      // permissions; this owner drains and a rotation/restart is required.
      if (!ready) return close("mcp_acl_failed");
      const currentTokenCredential = await readTokenCredential();
      if (!sameCredentialBytes(currentTokenCredential, bearerToken)) {
        return close("mcp_token_changed");
      }
    }).catch(() => close("mcp_acl_check_failed")).finally(() => {
      if (credentialCheckTimeout) clearTimeout(credentialCheckTimeout);
      credentialCheckTimeout = undefined;
      credentialCheckInFlight = false;
    });
  };

  fastTimer = setInterval(() => { void verifyCurrentOwner(); }, checkIntervalMs);
  fastTimer.unref();
  buildTimer = setInterval(verifyBuild, buildCheckIntervalMs);
  buildTimer.unref();
  credentialTimer = setInterval(verifyCredential, credentialCheckIntervalMs);
  credentialTimer.unref();
  const onSignal = () => { void close("signal").catch(() => undefined); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await reportLifecycle("ready").catch(() => undefined);
    diagnosticHeartbeatTimer = setInterval(() => {
      void reportLifecycle("heartbeat").catch(() => undefined);
    }, OWNER_DIAGNOSTIC_HEARTBEAT_MS);
    diagnosticHeartbeatTimer.unref();
    options.onReady?.({ origin: http.origin, buildHash: ownerIdentity.buildHash });
    await done;
  } catch (error) {
    await close("server_error").catch(() => undefined);
    throw error;
  } finally {
    if (fastTimer) clearInterval(fastTimer);
    if (buildTimer) clearInterval(buildTimer);
    if (credentialTimer) clearInterval(credentialTimer);
    if (diagnosticHeartbeatTimer) clearInterval(diagnosticHeartbeatTimer);
    if (buildCheckTimeout) clearTimeout(buildCheckTimeout);
    if (credentialCheckTimeout) clearTimeout(credentialCheckTimeout);
    buildCheckAbort?.abort();
    buildCheckAbort = undefined;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function loadLocalBridgeMcpHttpOwnerIdentityInWorker(
  signal?: AbortSignal,
): Promise<LocalBridgeMcpHttpOwnerIdentity> {
  if (signal?.aborted) return Promise.reject(unavailableOwner());
  let worker: Worker;
  try {
    worker = new Worker(
      new URL(import.meta.url),
      createLocalBridgeMcpHttpOwnerIdentityWorkerOptions(),
    );
  } catch {
    return Promise.reject(unavailableOwner());
  }
  worker.unref();
  return new Promise<LocalBridgeMcpHttpOwnerIdentity>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const finish = (
      error: Error | null,
      identity?: LocalBridgeMcpHttpOwnerIdentity,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error || !identity) rejectPromise(unavailableOwner());
      else resolvePromise(identity);
    };
    const onAbort = (): void => { finish(unavailableOwner()); };
    const onMessage = (message: unknown): void => {
      if (!isOwnerIdentityWorkerResponse(message) || !message.ok) {
        finish(unavailableOwner());
        return;
      }
      try {
        validateOwnerIdentity(message.identity);
        finish(null, message.identity);
      } catch {
        finish(unavailableOwner());
      }
    };
    const onError = (): void => { finish(unavailableOwner()); };
    const onExit = (): void => { finish(unavailableOwner()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

export function createLocalBridgeMcpHttpOwnerIdentityWorkerOptions(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerOptions {
  return {
    execArgv: [],
    env: createSanitizedLocalBridgeOwnerEnvironment(environment),
    workerData: { kind: OWNER_IDENTITY_WORKER_KIND },
  };
}

export function loadLocalBridgeMcpHttpOwnerIdentity(
  options: {
    executablePath?: string;
    entryPath?: string;
    readFile?: (path: string) => Uint8Array;
    resolveModule?: (specifier: string, parentUrl?: string) => string;
    resolveDependencyPackage?: (packageName: string, parentUrl: string) => string;
    listPackageRuntimeFiles?: (
      entryUrl: string,
      packageName: string,
    ) => readonly PackageRuntimeFile[];
    loadPackageRuntimeManifest?: (
      entryUrl: string,
      packageName: string,
    ) => PackageRuntimeManifest;
    runtimeVersion?: string;
  } = {},
): LocalBridgeMcpHttpOwnerIdentity {
  const executablePath = options.executablePath ?? process.execPath;
  const entryPath = options.entryPath ?? fileURLToPath(new URL("./index.js", import.meta.url));
  const runtimeVersion = options.runtimeVersion ?? process.version;
  const readRuntimeFile = options.readFile ?? ((path: string) => readFileSync(path));
  const resolveModule = options.resolveModule ?? ((specifier, parentUrl) =>
    resolvePackageImport(specifier, parentUrl ?? import.meta.url));
  const resolveDependencyPackage = options.resolveDependencyPackage ??
    resolveRuntimeDependencyPackage;
  const listPackageRuntimeFiles = options.listPackageRuntimeFiles ?? collectPackageRuntimeFiles;
  const loadPackageRuntimeManifest = options.loadPackageRuntimeManifest ??
    readPackageRuntimeManifest;
  const entryUrl = pathToFileURL(entryPath).href;
  const hubCoreUrl = resolveModule("@meanthis/hub-core", entryUrl);
  const resolverUrl = resolveModule("@meanthis/source-resolver-mcp", entryUrl);
  const mcpSdkEntryUrl = resolveModule("@modelcontextprotocol/sdk/server/mcp.js", entryUrl);
  const mcpSdkStreamableHttpUrl = resolveModule(
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    mcpSdkEntryUrl,
  );
  const promptUrl = resolveModule("@meanthis/prompt", hubCoreUrl);
  const cliSchemaUrl = resolveModule("@meanthis/schema", entryUrl);
  const hubSchemaUrl = resolveModule("@meanthis/schema", hubCoreUrl);
  const webExtractorUrl = resolveModule("@meanthis/web-extractor", hubCoreUrl);
  const webExtractorSchemaUrl = resolveModule("@meanthis/schema", webExtractorUrl);
  const sourceMapCoreUrl = resolveModule("@meanthis/source-map-core", resolverUrl);
  const cliZodUrl = resolveModule("zod/v4", entryUrl);
  const resolverZodUrl = resolveModule("zod/v4", resolverUrl);
  const resolverMcpSdkEntryUrl = resolveModule(
    "@modelcontextprotocol/sdk/server/mcp.js",
    resolverUrl,
  );
  const resolverMcpSdkStdioUrl = resolveModule(
    "@modelcontextprotocol/sdk/server/stdio.js",
    resolverUrl,
  );
  const sourceMapSchemaUrl = resolveModule("@meanthis/schema", sourceMapCoreUrl);
  const buildFiles: Array<readonly [string, string]> = [
    ["cli/index.js", entryPath],
    ["cli/bridge-cli.js", runtimePath("./bridge-cli.js")],
    ["cli/capture-cli.js", runtimePath("./capture-cli.js")],
    ["cli/cli.js", runtimePath("./cli.js")],
    ["cli/mcp-host-config.js", runtimePath("./mcp-host-config.js")],
    ["cli/local-bridge-native-host.js", runtimePath("./local-bridge-native-host.js")],
    ["cli/local-bridge-native-host-contract.js", runtimePath("./local-bridge-native-host-contract.js")],
    ["cli/local-bridge-native-host-install.js", runtimePath("./local-bridge-native-host-install.js")],
    ["cli/local-bridge-mcp-http-owner.js", runtimePath("./local-bridge-mcp-http-owner.js")],
    ["cli/local-bridge-mcp-http.js", runtimePath("./local-bridge-mcp-http.js")],
    ["cli/local-bridge-mcp-http-control.js", runtimePath("./local-bridge-mcp-http-control.js")],
    [
      "cli/local-bridge-mcp-http-health-proof.js",
      runtimePath("./local-bridge-mcp-http-health-proof.js"),
    ],
    ["cli/local-bridge-mcp.js", runtimePath("./local-bridge-mcp.js")],
    ["cli/local-bridge-owner.js", runtimePath("./local-bridge-owner.js")],
    ["cli/local-bridge.js", runtimePath("./local-bridge.js")],
    ["cli/local-bridge-agent-auth.js", runtimePath("./local-bridge-agent-auth.js")],
    ["cli/local-bridge-agent-token.js", runtimePath("./local-bridge-agent-token.js")],
    ["cli/local-bridge-mcp-http-token.js", runtimePath("./local-bridge-mcp-http-token.js")],
    ["hub-core/index.js", runtimeModulePath(hubCoreUrl)],
    ["prompt/index.js", runtimeModulePath(promptUrl)],
    ["cli/schema/index.js", runtimeModulePath(cliSchemaUrl)],
    ["hub-core/schema/index.js", runtimeModulePath(hubSchemaUrl)],
    ["web-extractor/index.js", runtimeModulePath(webExtractorUrl)],
    ["web-extractor/schema/index.js", runtimeModulePath(webExtractorSchemaUrl)],
    ["source-resolver-mcp/index.js", runtimeModulePath(resolverUrl)],
    ["source-map-core/index.js", runtimeModulePath(sourceMapCoreUrl)],
    ["source-map-core/schema/index.js", runtimeModulePath(sourceMapSchemaUrl)],
    ["cli/zod-v4/index.js", runtimeModulePath(cliZodUrl)],
    ["source-resolver-mcp/zod-v4/index.js", runtimeModulePath(resolverZodUrl)],
    ["mcp-sdk/server/mcp.js", runtimeModulePath(mcpSdkEntryUrl)],
    ["mcp-sdk/server/streamableHttp.js", runtimeModulePath(mcpSdkStreamableHttpUrl)],
    ["mcp-sdk/server/index.js", runtimeModulePath(new URL("./index.js", mcpSdkEntryUrl).href)],
    ["mcp-sdk/server/webStandardStreamableHttp.js", runtimeModulePath(new URL("./webStandardStreamableHttp.js", mcpSdkEntryUrl).href)],
    ["mcp-sdk/types.js", runtimeModulePath(new URL("../types.js", mcpSdkEntryUrl).href)],
    ["source-resolver-mcp/mcp-sdk/server/mcp.js", runtimeModulePath(resolverMcpSdkEntryUrl)],
    ["source-resolver-mcp/mcp-sdk/server/stdio.js", runtimeModulePath(resolverMcpSdkStdioUrl)],
  ];
  appendRuntimePackageClosure(buildFiles, [
    { role: "cli/hub-core", entryUrl: hubCoreUrl, packageName: "@meanthis/hub-core" },
    { role: "hub-core/prompt", entryUrl: promptUrl, packageName: "@meanthis/prompt" },
    { role: "cli/schema", entryUrl: cliSchemaUrl, packageName: "@meanthis/schema" },
    { role: "hub-core/schema", entryUrl: hubSchemaUrl, packageName: "@meanthis/schema" },
    { role: "hub-core/web-extractor", entryUrl: webExtractorUrl, packageName: "@meanthis/web-extractor" },
    { role: "web-extractor/schema", entryUrl: webExtractorSchemaUrl, packageName: "@meanthis/schema" },
    { role: "cli/source-resolver-mcp", entryUrl: resolverUrl, packageName: "@meanthis/source-resolver-mcp" },
    { role: "source-resolver-mcp/source-map-core", entryUrl: sourceMapCoreUrl, packageName: "@meanthis/source-map-core" },
    { role: "source-map-core/schema", entryUrl: sourceMapSchemaUrl, packageName: "@meanthis/schema" },
    { role: "cli/zod", entryUrl: cliZodUrl, packageName: "zod" },
    { role: "source-resolver-mcp/zod", entryUrl: resolverZodUrl, packageName: "zod" },
    { role: "cli/mcp-sdk", entryUrl: mcpSdkEntryUrl, packageName: "@modelcontextprotocol/sdk" },
    { role: "source-resolver-mcp/mcp-sdk", entryUrl: resolverMcpSdkEntryUrl, packageName: "@modelcontextprotocol/sdk" },
  ], {
    resolveDependencyPackage,
    listPackageRuntimeFiles,
    loadPackageRuntimeManifest,
  });
  const uniqueBuildFiles = deduplicateBuildFiles(buildFiles);
  if (uniqueBuildFiles.length > MAX_FINGERPRINT_CLOSURE_FILES) throw unavailableOwner();
  const hash = createHash("sha256");
  for (const identityPart of [
    "meanthis-mcp-http-owner-build-v1",
    executablePath,
    entryPath,
    runtimeVersion,
  ]) {
    hash.update(identityPart, "utf8");
    hash.update("\0", "utf8");
  }
  let totalBytes = 0;
  for (const [label, path] of uniqueBuildFiles) {
    const bytes = readRuntimeFile(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_FINGERPRINT_CLOSURE_BYTES) throw unavailableOwner();
    hash.update(label, "utf8");
    hash.update("\0", "utf8");
    hash.update(createHash("sha256").update(bytes).digest());
    hash.update("\0", "utf8");
  }
  return { executablePath, entryPath, buildHash: hash.digest("hex") };
}

export function sameLocalBridgeMcpHttpOwnerIdentity(
  left: LocalBridgeMcpHttpOwnerIdentity,
  right: LocalBridgeMcpHttpOwnerIdentity,
): boolean {
  return left.executablePath === right.executablePath &&
    left.entryPath === right.entryPath &&
    left.buildHash === right.buildHash;
}

export type LocalBridgeMcpHttpOwnerInspection =
  | { status: "ready"; health: LocalBridgeMcpHttpHealth }
  | { status: "absent" }
  | { status: "stale"; health: LocalBridgeMcpHttpHealth }
  | { status: "legacy_foreground"; health: LocalBridgeMcpHttpHealth }
  | { status: "unverified_listener" }
  | { status: "unexpected" };

export async function inspectLocalBridgeMcpHttpOwner(
  bearerToken: string,
  expectedIdentity: LocalBridgeMcpHttpOwnerIdentity,
  options: {
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    isPortAvailable?: () => Promise<boolean>;
  } = {},
): Promise<LocalBridgeMcpHttpOwnerInspection> {
  try {
    if (!validateLocalBridgeMcpHttpToken(bearerToken)) return { status: "unexpected" };
    validateOwnerIdentity(expectedIdentity);
    const health = await fetchAuthenticatedHealth(bearerToken, options);
    if (!health.ownerIdentity) return { status: "legacy_foreground", health };
    return health.ownerIdentity.buildHash === expectedIdentity.buildHash
      ? { status: "ready", health }
      : { status: "stale", health };
  } catch {
    try {
      return await (options.isPortAvailable ?? isLocalBridgeMcpHttpPortAvailable)()
        ? { status: "absent" }
        : { status: "unverified_listener" };
    } catch {
      return { status: "unexpected" };
    }
  }
}

export async function probeLocalBridgeMcpHttpOwner(
  bearerToken: string,
  expectedIdentity: LocalBridgeMcpHttpOwnerIdentity,
  options: {
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    isPortAvailable?: () => Promise<boolean>;
  } = {},
): Promise<LocalBridgeMcpHttpHealth> {
  const inspection = await inspectLocalBridgeMcpHttpOwner(bearerToken, expectedIdentity, options);
  if (inspection.status === "ready") return inspection.health;
  if (inspection.status === "legacy_foreground") {
    throw new LocalBridgeMcpHttpLegacyForegroundOwnerError();
  }
  if (inspection.status === "unverified_listener") {
    throw new LocalBridgeMcpHttpUnverifiedListenerError();
  }
  throw unavailableOwner();
}

export function waitForLocalBridgeMcpHttpOwner(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function probeMatchingOwner(
  probe: () => Promise<LocalBridgeMcpHttpHealth>,
  expectedBuildHash: string,
): Promise<LocalBridgeMcpHttpHealth | null> {
  try {
    const status = await probe();
    return isLocalBridgeMcpHttpHealth(status) &&
      status.ownerIdentity?.buildHash === expectedBuildHash
      ? status
      : null;
  } catch (error) {
    if (
      error instanceof LocalBridgeMcpHttpLegacyForegroundOwnerError ||
      error instanceof LocalBridgeMcpHttpUnverifiedListenerError
    ) {
      throw error;
    }
    return null;
  }
}

async function isLocalBridgeMcpHttpPortAvailable(): Promise<boolean> {
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
    server.listen(MEANTHIS_MCP_HTTP_DEFAULT_PORT, MEANTHIS_MCP_HTTP_HOST);
  });
}

async function readBoundedHealth(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailableOwner();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HEALTH_BYTES) throw unavailableOwner();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((value) => Buffer.from(value))).toString("utf8");
}

async function fetchAuthenticatedHealth(
  bearerToken: string,
  options: { fetchImpl?: typeof fetch; requestTimeoutMs?: number },
): Promise<LocalBridgeMcpHttpHealth> {
  const requestTimeoutMs = options.requestTimeoutMs ?? OWNER_HEALTH_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 5_000) {
    throw unavailableOwner();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  timeout.unref();
  try {
    const proofRequest = createLocalBridgeMcpHttpHealthProofRequest(bearerToken, {
      port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
    });
    const response = await (options.fetchImpl ?? fetch)(
      `http://${MEANTHIS_MCP_HTTP_HOST}:${MEANTHIS_MCP_HTTP_DEFAULT_PORT}/health`,
      {
        headers: proofRequest.headers,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      },
    );
    if (response.status !== 200) throw unavailableOwner();
    const text = await readBoundedHealth(response);
    if (!verifyLocalBridgeMcpHttpHealthProofResponse(
      bearerToken,
      proofRequest,
      {
        port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
        status: response.status,
        headers: response.headers,
        body: text,
      },
    )) throw unavailableOwner();
    const value = JSON.parse(text) as unknown;
    if (!isLocalBridgeMcpHttpHealth(value)) throw unavailableOwner();
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function runtimePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function resolvePackageImport(specifier: string, parentUrl: string): string {
  const { packageName, subpath } = parsePackageSpecifier(specifier);
  const manifestPath = locatePackageManifest(specifier, parentUrl, packageName);
  let manifest: {
    name?: unknown;
    exports?: unknown;
    module?: unknown;
    main?: unknown;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw unavailableOwner();
  }
  if (manifest.name !== packageName) throw unavailableOwner();
  let target: string | null = null;
  const usesExports = manifest.exports !== undefined;
  if (usesExports) {
    const matched = matchPackageExport(manifest.exports, subpath);
    target = selectPackageImportTarget(matched.value);
    if (target && matched.wildcard !== null) {
      target = target.replaceAll("*", matched.wildcard);
    }
  } else if (subpath === ".") {
    target = typeof manifest.module === "string"
      ? manifest.module
      : typeof manifest.main === "string"
        ? manifest.main
        : "./index.js";
  } else {
    target = subpath;
  }
  if (!target || target.includes("\0") || target.includes("\\")) throw unavailableOwner();
  if (!target.startsWith("./")) {
    if (usesExports || target.startsWith("/") || target.startsWith("../")) {
      throw unavailableOwner();
    }
    // Node package.json permits legacy main/module targets such as
    // "dist/index.js". Normalize them without relying on newer module APIs.
    target = `./${target}`;
  }
  const packageRoot = dirname(manifestPath);
  const candidate = resolve(packageRoot, target);
  const candidateRelative = relative(packageRoot, candidate);
  if (
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  ) {
    throw unavailableOwner();
  }
  try {
    return pathToFileURL(realpathSync(candidate)).href;
  } catch {
    throw unavailableOwner();
  }
}

function locatePackageManifest(
  _specifier: string,
  parentUrl: string,
  packageName: string,
): string {
  let current: string;
  try {
    const parent = new URL(parentUrl);
    if (parent.protocol !== "file:") throw unavailableOwner();
    current = dirname(realpathSync(fileURLToPath(parent)));
  } catch {
    throw unavailableOwner();
  }
  const packageSegments = packageName.split("/");
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(current, "node_modules", ...packageSegments, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
      if (manifest.name === packageName) return realpathSync(candidate);
    } catch {
      // Continue toward the filesystem root to honor Node's parent-relative
      // node_modules lookup without relying on newer node:module APIs.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw unavailableOwner();
}

function resolveRuntimeDependencyPackage(packageName: string, parentUrl: string): string {
  validateBarePackageName(packageName);
  const manifestPath = locatePackageManifest(packageName, parentUrl, packageName);
  return pathToFileURL(manifestPath).href;
}

function collectPackageRuntimeFiles(
  entryUrl: string,
  packageName: string,
): readonly PackageRuntimeFile[] {
  const manifestPath = locatePackageManifestFromEntry(entryUrl, packageName);
  const packageRoot = dirname(manifestPath);
  const files: PackageRuntimeFile[] = [];
  let totalBytes = 0;
  let directoryCount = 0;
  let entryCount = 0;
  const visit = (directory: string, depth: number): void => {
    directoryCount += 1;
    if (
      depth > MAX_FINGERPRINT_PACKAGE_DIRECTORY_DEPTH ||
      directoryCount > MAX_FINGERPRINT_PACKAGE_DIRECTORIES
    ) {
      throw unavailableOwner();
    }
    const directoryHandle = opendirSync(directory);
    const entries: Dirent[] = [];
    try {
      while (true) {
        const entry = directoryHandle.readSync();
        if (!entry) break;
        entryCount += 1;
        if (
          entries.length >= MAX_FINGERPRINT_PACKAGE_DIRECTORY_ENTRIES ||
          entryCount > MAX_FINGERPRINT_PACKAGE_ENTRIES
        ) {
          throw unavailableOwner();
        }
        entries.push(entry);
      }
    } finally {
      directoryHandle.closeSync();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw unavailableOwner();
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:cjs|js|json|mjs)$/.test(entry.name)) continue;
      const stats = statSync(path);
      totalBytes += stats.size;
      if (
        files.length >= MAX_FINGERPRINT_PACKAGE_FILES ||
        totalBytes > MAX_FINGERPRINT_PACKAGE_BYTES
      ) {
        throw unavailableOwner();
      }
      files.push({
        relativePath: relative(packageRoot, path).replaceAll("\\", "/"),
        path,
      });
    }
  };
  visit(packageRoot, 0);
  return files;
}

function appendRuntimePackageClosure(
  buildFiles: Array<readonly [string, string]>,
  seeds: readonly RuntimePackageSeed[],
  options: {
    resolveDependencyPackage(packageName: string, parentUrl: string): string;
    listPackageRuntimeFiles(
      entryUrl: string,
      packageName: string,
    ): readonly PackageRuntimeFile[];
    loadPackageRuntimeManifest(
      entryUrl: string,
      packageName: string,
    ): PackageRuntimeManifest;
  },
): void {
  const queue = [...seeds];
  const visited = new Set<string>();
  let closureFileCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const manifest = validatePackageRuntimeManifest(
      options.loadPackageRuntimeManifest(current.entryUrl, current.packageName),
    );
    const identityKey = process.platform === "win32"
      ? manifest.identityKey.toLowerCase()
      : manifest.identityKey;
    if (visited.has(identityKey)) continue;
    visited.add(identityKey);
    if (visited.size > MAX_FINGERPRINT_CLOSURE_PACKAGES) throw unavailableOwner();

    const runtimeFiles = [...options.listPackageRuntimeFiles(
      current.entryUrl,
      current.packageName,
    )].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
    closureFileCount += runtimeFiles.length;
    if (closureFileCount > MAX_FINGERPRINT_CLOSURE_FILES) throw unavailableOwner();
    for (const file of runtimeFiles) {
      if (
        typeof file.relativePath !== "string" || file.relativePath.length === 0 ||
        file.relativePath.includes("\0") || file.relativePath.includes("\\") ||
        file.relativePath.startsWith("/") || file.relativePath.split("/").includes("..") ||
        typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\0")
      ) {
        throw unavailableOwner();
      }
      buildFiles.push([
        `${current.role}/runtime/${file.relativePath}`,
        file.path,
      ]);
    }

    const dependencyKinds = new Map<string, { optional: boolean }>();
    for (const dependency of manifest.dependencies) {
      dependencyKinds.set(dependency, { optional: false });
    }
    for (const dependency of manifest.optionalDependencies) {
      if (!dependencyKinds.has(dependency)) {
        dependencyKinds.set(dependency, { optional: true });
      }
    }
    for (const dependency of manifest.peerDependencies) {
      const optional = manifest.optionalPeerDependencies.has(dependency);
      const existing = dependencyKinds.get(dependency);
      dependencyKinds.set(dependency, { optional: optional && existing?.optional !== false });
    }
    if (dependencyKinds.size > MAX_FINGERPRINT_PACKAGE_DEPENDENCIES) {
      throw unavailableOwner();
    }

    for (const [dependency, { optional }] of [...dependencyKinds.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))) {
      let dependencyEntryUrl: string;
      try {
        dependencyEntryUrl = options.resolveDependencyPackage(dependency, current.entryUrl);
      } catch {
        if (optional) continue;
        throw unavailableOwner();
      }
      queue.push({
        role: `${current.role}/dependencies/${dependency}`,
        entryUrl: dependencyEntryUrl,
        packageName: dependency,
      });
    }
  }
}

function readPackageRuntimeManifest(
  entryUrl: string,
  packageName: string,
): PackageRuntimeManifest {
  const manifestPath = locatePackageManifestFromEntry(entryUrl, packageName);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw unavailableOwner();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailableOwner();
  const manifest = value as Record<string, unknown>;
  if (manifest.name !== packageName) throw unavailableOwner();
  const dependencies = readPackageDependencyNames(manifest.dependencies);
  const optionalDependencies = readPackageDependencyNames(manifest.optionalDependencies);
  const peerDependencies = readPackageDependencyNames(manifest.peerDependencies);
  const optionalPeerDependencies = readOptionalPeerDependencies(
    manifest.peerDependenciesMeta,
    peerDependencies,
  );
  return validatePackageRuntimeManifest({
    identityKey: realpathSync(manifestPath),
    dependencies,
    optionalDependencies,
    peerDependencies,
    optionalPeerDependencies,
  });
}

function readPackageDependencyNames(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailableOwner();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FINGERPRINT_PACKAGE_DEPENDENCIES) throw unavailableOwner();
  const names: string[] = [];
  for (const [name, version] of entries) {
    validateBarePackageName(name);
    if (typeof version !== "string" || version.length === 0 || version.includes("\0")) {
      throw unavailableOwner();
    }
    names.push(name);
  }
  return names.sort((left, right) => left.localeCompare(right, "en"));
}

function readOptionalPeerDependencies(
  value: unknown,
  peerDependencies: readonly string[],
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailableOwner();
  const peers = new Set(peerDependencies);
  const optional = new Set<string>();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FINGERPRINT_PACKAGE_DEPENDENCIES) throw unavailableOwner();
  for (const [name, metadata] of entries) {
    validateBarePackageName(name);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw unavailableOwner();
    }
    if (peers.has(name) && (metadata as Record<string, unknown>).optional === true) {
      optional.add(name);
    }
  }
  return optional;
}

function validatePackageRuntimeManifest(
  manifest: PackageRuntimeManifest,
): PackageRuntimeManifest {
  if (
    !manifest || typeof manifest !== "object" ||
    typeof manifest.identityKey !== "string" || manifest.identityKey.length === 0 ||
    manifest.identityKey.length > 32_768 || manifest.identityKey.includes("\0") ||
    !Array.isArray(manifest.dependencies) ||
    !Array.isArray(manifest.optionalDependencies) ||
    !Array.isArray(manifest.peerDependencies) ||
    !(manifest.optionalPeerDependencies instanceof Set)
  ) {
    throw unavailableOwner();
  }
  const allNames = [
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalPeerDependencies,
  ];
  if (allNames.length > MAX_FINGERPRINT_PACKAGE_DEPENDENCIES * 4) {
    throw unavailableOwner();
  }
  for (const name of allNames) validateBarePackageName(name);
  return manifest;
}

function validateBarePackageName(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 214) {
    throw unavailableOwner();
  }
  const parsed = parsePackageSpecifier(value);
  if (
    parsed.packageName !== value || parsed.subpath !== "." ||
    value.includes("\0") || value.includes("\\") || value.includes("%")
  ) {
    throw unavailableOwner();
  }
}

function locatePackageManifestFromEntry(entryUrl: string, packageName: string): string {
  let current: string;
  try {
    current = dirname(realpathSync(fileURLToPath(entryUrl)));
  } catch {
    throw unavailableOwner();
  }
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(current, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
      if (manifest.name === packageName) return candidate;
    } catch {
      // Continue toward the filesystem root from a package export subpath.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw unavailableOwner();
}

function deduplicateBuildFiles(
  files: readonly (readonly [string, string])[],
): Array<readonly [string, string]> {
  const seen = new Set<string>();
  const result: Array<readonly [string, string]> = [];
  for (const [label, path] of files) {
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([label, path]);
  }
  return result;
}

function parsePackageSpecifier(specifier: string): { packageName: string; subpath: string } {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  if (
    segments.length < packageSegmentCount ||
    segments.slice(0, packageSegmentCount).some((segment) => segment.length === 0)
  ) {
    throw unavailableOwner();
  }
  const packageName = segments.slice(0, packageSegmentCount).join("/");
  const remainder = segments.slice(packageSegmentCount).join("/");
  return { packageName, subpath: remainder ? `./${remainder}` : "." };
}

function matchPackageExport(
  exportsValue: unknown,
  subpath: string,
): { value: unknown; wildcard: string | null } {
  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
    if (subpath !== ".") throw unavailableOwner();
    return { value: exportsValue, wildcard: null };
  }
  if (!exportsValue || typeof exportsValue !== "object") throw unavailableOwner();
  const exportsRecord = exportsValue as Record<string, unknown>;
  const subpathKeys = Object.keys(exportsRecord).filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    if (subpath !== ".") throw unavailableOwner();
    return { value: exportsValue, wildcard: null };
  }
  if (Object.hasOwn(exportsRecord, subpath)) {
    return { value: exportsRecord[subpath], wildcard: null };
  }
  const matches = subpathKeys
    .filter((key) => key.includes("*"))
    .map((key) => {
      const [prefix, suffix] = key.split("*");
      return subpath.startsWith(prefix) && subpath.endsWith(suffix)
        ? { key, wildcard: subpath.slice(prefix.length, subpath.length - suffix.length) }
        : null;
    })
    .filter((match): match is { key: string; wildcard: string } => match !== null)
    .sort((left, right) => right.key.length - left.key.length);
  if (matches.length === 0) throw unavailableOwner();
  return { value: exportsRecord[matches[0].key], wildcard: matches[0].wildcard };
}

function selectPackageImportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = selectPackageImportTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of Object.keys(conditions)) {
    if (!PACKAGE_IMPORT_CONDITIONS.has(condition)) continue;
    const target = selectPackageImportTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}

function runtimeModulePath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:") throw unavailableOwner();
  return fileURLToPath(url);
}

function isOwnerIdentityWorkerRequest(value: unknown): value is { kind: string } {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === OWNER_IDENTITY_WORKER_KIND;
}

function isOwnerIdentityWorkerResponse(value: unknown): value is OwnerIdentityWorkerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false) return Object.keys(record).length === 1;
  return record.ok === true && !!record.identity && typeof record.identity === "object";
}

function validateOwnerIdentity(identity: LocalBridgeMcpHttpOwnerIdentity): void {
  if (
    typeof identity.executablePath !== "string" || identity.executablePath.length === 0 ||
    typeof identity.entryPath !== "string" || identity.entryPath.length === 0 ||
    !/^[0-9a-f]{64}$/.test(identity.buildHash)
  ) {
    throw unavailableOwner();
  }
}

function validateTokenFingerprint(value: string): void {
  if (!TOKEN_FINGERPRINT_PATTERN.test(value)) throw unavailableOwner();
}

function validateBuildHash(value: string): void {
  if (!OWNER_BUILD_HASH_PATTERN.test(value)) throw unavailableOwner();
}

function unavailableOwner(): Error {
  return new Error("Detached MeanThis MCP HTTP owner is unavailable.");
}

function sameCredentialBytes(currentCredential: string, expectedCredential: string): boolean {
  const currentBytes = Buffer.from(currentCredential, "utf8");
  const expectedBytes = Buffer.from(expectedCredential, "utf8");
  return currentBytes.length === expectedBytes.length &&
    timingSafeEqual(currentBytes, expectedBytes);
}

function requireBrowserOwnerIdentity(
  identity: ReturnType<typeof loadLocalBridgeOwnerIdentity> | undefined,
): ReturnType<typeof loadLocalBridgeOwnerIdentity> {
  if (!identity) throw unavailableOwner();
  return identity;
}
