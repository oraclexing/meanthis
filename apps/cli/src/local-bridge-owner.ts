import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  createLocalBridgeState,
  startLocalBridgeHttpServer,
  type LocalBridgeOwnerIdentity,
} from "./local-bridge.js";

const OWNER_IDLE_MS = 30 * 60_000;
const OWNER_IDLE_CHECK_MS = 30_000;

export interface EnsureLocalBridgeOwnerDependencies {
  probe(): Promise<void>;
  spawnOwner(): void;
  wait(delayMs: number): Promise<void>;
}

export async function ensureLocalBridgeOwner(
  dependencies: EnsureLocalBridgeOwnerDependencies,
  options: { startupTimeoutMs?: number; delayMs?: number; now?: () => number } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.startupTimeoutMs ?? 3_000);
  try {
    await dependencies.probe();
    return;
  } catch {
    // Start one detached candidate, then authenticate the winner of any startup race.
  }

  dependencies.spawnOwner();
  const delayMs = options.delayMs ?? 50;
  while (now() < deadline) {
    await dependencies.wait(Math.min(delayMs, Math.max(0, deadline - now())));
    try {
      await dependencies.probe();
      return;
    } catch {
      // Continue only for the bounded startup window.
    }
  }
  throw new Error("Detached local bridge owner is unavailable.");
}

export function spawnDetachedLocalBridgeOwner(): void {
  const launch = createDetachedLocalBridgeOwnerSpawn();
  const child = spawn(launch.command, launch.args, launch.options);
  child.once("error", () => {
    // The bounded authenticated probe reports startup failure to the MCP client.
  });
  child.unref();
}

export function createDetachedLocalBridgeOwnerSpawn() {
  const entryPath = fileURLToPath(new URL("./index.js", import.meta.url));
  return {
    command: process.execPath,
    args: [entryPath, "bridge-owner"],
    options: {
      cwd: dirname(entryPath),
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    } as const,
  };
}

export interface DetachedLocalBridgeOwnerOptions {
  agentToken?: string;
  port?: number;
  ownerIdentity?: LocalBridgeOwnerIdentity;
  loadOwnerIdentity?: () => LocalBridgeOwnerIdentity;
  idleMs?: number;
  idleCheckMs?: number;
  onReady?: (owner: { origin: string }) => void;
}

export async function runDetachedLocalBridgeOwner(
  options: DetachedLocalBridgeOwnerOptions = {},
): Promise<void> {
  const agentToken = options.agentToken ?? await loadOrCreateLocalBridgeAgentToken();
  const state = createLocalBridgeState();
  const ownerIdentity = options.ownerIdentity ?? loadLocalBridgeOwnerIdentity();
  const loadOwnerIdentity = options.loadOwnerIdentity ?? loadLocalBridgeOwnerIdentity;
  const lifecycle = createLocalBridgeOwnerLifecycle({ idleMs: options.idleMs });
  const idleCheckMs = options.idleCheckMs ?? OWNER_IDLE_CHECK_MS;
  if (!Number.isSafeInteger(idleCheckMs) || idleCheckMs < 1) {
    throw new Error("Invalid local bridge owner idle check interval.");
  }
  let http: Awaited<ReturnType<typeof startLocalBridgeHttpServer>> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const close = async (): Promise<void> => {
    if (!lifecycle.beginClose()) return;
    if (timer) clearInterval(timer);
    if (http) await http.close();
    resolveDone?.();
  };
  http = await startLocalBridgeHttpServer(state, {
    port: options.port,
    agentToken,
    ownerIdentity,
    onActivity: lifecycle.recordActivity,
    onRequestStart: lifecycle.startRequest,
    onRequestEnd: () => {
      lifecycle.endRequest();
      if (lifecycle.shouldCloseAfterDrain()) void close();
    },
    isClosing: lifecycle.isRejectingNewRequests,
  });
  timer = setInterval(() => {
    try {
      if (!sameLocalBridgeOwnerIdentity(ownerIdentity, loadOwnerIdentity())) {
        void close();
        return;
      }
    } catch {
      void close();
      return;
    }
    if (!lifecycle.shouldBeginIdleDrain()) return;
    lifecycle.beginIdleDrain();
    if (lifecycle.shouldCloseAfterDrain()) void close();
  }, idleCheckMs);
  timer.unref();
  const onSignal = () => void close();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    options.onReady?.({ origin: http.origin });
    await done;
  } catch (error) {
    await close();
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function waitForLocalBridgeOwner(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
    ["cli/local-bridge-owner.js", fileURLToPath(new URL("./local-bridge-owner.js", import.meta.url))],
    ["cli/local-bridge-mcp.js", fileURLToPath(new URL("./local-bridge-mcp.js", import.meta.url))],
    ["cli/local-bridge.js", fileURLToPath(new URL("./local-bridge.js", import.meta.url))],
    ["cli/local-bridge-agent-auth.js", fileURLToPath(new URL("./local-bridge-agent-auth.js", import.meta.url))],
    ["cli/local-bridge-agent-token.js", fileURLToPath(new URL("./local-bridge-agent-token.js", import.meta.url))],
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
