import { describe, expect, test, vi } from "vitest";
import { dirname, isAbsolute } from "node:path";
import { createHttpLocalBridgeReader } from "./local-bridge-mcp";
import {
  createDetachedLocalBridgeOwnerSpawn,
  createLocalBridgeOwnerLifecycle,
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  runDetachedLocalBridgeOwner,
  sameLocalBridgeOwnerIdentity,
} from "./local-bridge-owner";

const AGENT_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};

describe("detached local bridge owner startup", () => {
  test("starts the detached owner from the stable CLI directory", () => {
    const launch = createDetachedLocalBridgeOwnerSpawn();

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([expect.stringMatching(/index\.js$/), "bridge-owner"]);
    expect(isAbsolute(launch.options.cwd)).toBe(true);
    expect(launch.options.cwd).toBe(dirname(launch.args[0]));
    expect(launch.options).toMatchObject({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  test("reuses an already authenticated detached owner", async () => {
    const probe = vi.fn(async () => undefined);
    const spawnOwner = vi.fn();
    const wait = vi.fn(async () => undefined);

    await ensureLocalBridgeOwner({ probe, spawnOwner, wait });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawnOwner).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  test("spawns once and waits for the owner instead of owning state in the MCP process", async () => {
    let probes = 0;
    const probe = vi.fn(async () => {
      probes += 1;
      if (probes < 3) throw new Error("not ready");
    });
    const spawnOwner = vi.fn();
    let now = 0;
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });

    await ensureLocalBridgeOwner(
      { probe, spawnOwner, wait },
      { startupTimeoutMs: 100, delayMs: 10, now: () => now },
    );

    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  test("fails closed after bounded authenticated probes", async () => {
    const probe = vi.fn(async () => { throw new Error("foreign or unavailable"); });
    const spawnOwner = vi.fn();
    let now = 0;
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });

    await expect(ensureLocalBridgeOwner(
      { probe, spawnOwner, wait },
      { startupTimeoutMs: 25, delayMs: 10, now: () => now },
    )).rejects.toThrow("unavailable");
    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  test("aborts a hanging foreign listener within the wall-clock startup budget", async () => {
    let abortedRequests = 0;
    const hangingFetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        const rejectAborted = () => {
          abortedRequests += 1;
          reject(new Error("aborted"));
        };
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      }));
    const hangingFetch = hangingFetchMock as typeof fetch;
    const reader = createHttpLocalBridgeReader("http://127.0.0.1:38471", AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 20,
    });
    const startedAt = Date.now();

    await expect(ensureLocalBridgeOwner({
      probe: async () => { await reader.getStatus(); },
      spawnOwner: vi.fn(),
      wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    }, { startupTimeoutMs: 80, delayMs: 5 })).rejects.toThrow("unavailable");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(hangingFetchMock).toHaveBeenCalled();
    expect(abortedRequests).toBe(hangingFetchMock.mock.calls.length);
  });

  test("does not idle-close across a successful in-flight request", () => {
    let now = 0;
    const lifecycle = createLocalBridgeOwnerLifecycle({ now: () => now, idleMs: 100 });
    now = 100;
    lifecycle.startRequest();
    expect(lifecycle.shouldBeginIdleDrain()).toBe(true);
    lifecycle.beginIdleDrain();
    expect(lifecycle.isRejectingNewRequests()).toBe(true);
    expect(lifecycle.shouldCloseAfterDrain()).toBe(false);

    lifecycle.recordActivity();
    lifecycle.endRequest();
    expect(lifecycle.isRejectingNewRequests()).toBe(false);
    expect(lifecycle.shouldCloseAfterDrain()).toBe(false);
    now = 200;
    expect(lifecycle.shouldBeginIdleDrain()).toBe(true);
    lifecycle.beginIdleDrain();
    expect(lifecycle.shouldCloseAfterDrain()).toBe(true);
    expect(lifecycle.beginClose()).toBe(true);
    expect(lifecycle.isClosing()).toBe(true);
    expect(lifecycle.beginClose()).toBe(false);
  });

  test("drains unauthenticated in-flight work instead of extending owner lifetime", () => {
    let now = 0;
    const lifecycle = createLocalBridgeOwnerLifecycle({ now: () => now, idleMs: 100 });
    lifecycle.startRequest();
    now = 100;
    lifecycle.beginIdleDrain();
    expect(lifecycle.isRejectingNewRequests()).toBe(true);
    expect(lifecycle.shouldCloseAfterDrain()).toBe(false);

    lifecycle.endRequest();
    expect(lifecycle.shouldCloseAfterDrain()).toBe(true);
  });

  test("binds owner identity to the executable, entry, and loaded build bytes", () => {
    let changed = false;
    const readFile = (path: string) => Buffer.from(
      path.endsWith("local-bridge.js") && changed ? "changed" : `bytes:${path}`,
    );
    const first = loadLocalBridgeOwnerIdentity(
      OWNER_IDENTITY.executablePath,
      OWNER_IDENTITY.entryPath,
      readFile,
    );
    changed = true;
    const second = loadLocalBridgeOwnerIdentity(
      OWNER_IDENTITY.executablePath,
      OWNER_IDENTITY.entryPath,
      readFile,
    );

    expect(first).toMatchObject({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      buildHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second.buildHash).not.toBe(first.buildHash);
    expect(sameLocalBridgeOwnerIdentity(first, first)).toBe(true);
    expect(sameLocalBridgeOwnerIdentity(first, second)).toBe(false);
  });

  test("supports an isolated loopback owner runtime without changing production defaults", async () => {
    let origin = "";
    const signalListenersBefore = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      idleMs: 30,
      idleCheckMs: 5,
      onReady: (owner) => { origin = owner.origin; },
    });

    await vi.waitFor(() => expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/));
    await expect(run).resolves.toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(signalListenersBefore.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(signalListenersBefore.sigterm);
  });

  test("closes an isolated owner when its ready callback fails", async () => {
    let origin = "";
    await expect(runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      idleMs: 1_000,
      idleCheckMs: 10,
      onReady: (owner) => {
        origin = owner.origin;
        throw new Error("ready IPC closed");
      },
    })).rejects.toThrow("ready IPC closed");

    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(fetch(`${origin}/health`)).rejects.toThrow();
  });

  test("rejects an invalid isolated owner check interval", async () => {
    await expect(runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      idleCheckMs: 0,
    })).rejects.toThrow("idle check interval");
  });
});
