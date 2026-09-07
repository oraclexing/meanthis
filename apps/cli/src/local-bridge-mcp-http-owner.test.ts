import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { LocalBridgeReader } from "./local-bridge-mcp";
import type {
  LocalBridgeMcpHttpHealth,
  LocalBridgeMcpHttpServer,
} from "./local-bridge-mcp-http";
import {
  createLocalBridgeMcpHttpHealthProofResponse,
  MEANTHIS_MCP_HTTP_DEFAULT_PORT,
  MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER,
  MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER,
} from "./local-bridge-mcp-http";
import { MEANTHIS_MCP_HTTP_TOKEN_ENV } from "./local-bridge-mcp-http-token";
import {
  LocalBridgeMcpHttpLegacyForegroundOwnerError,
  LocalBridgeMcpHttpUnverifiedListenerError,
  createDetachedLocalBridgeMcpHttpOwnerSpawn,
  createLocalBridgeMcpHttpOwnerIdentityWorkerOptions,
  ensureLocalBridgeMcpHttpOwner,
  getLocalBridgeMcpHttpDesiredIdentityPath,
  inspectLocalBridgeMcpHttpOwner,
  loadLocalBridgeMcpHttpOwnerIdentity,
  probeLocalBridgeMcpHttpOwner,
  readLocalBridgeMcpHttpDesiredIdentity,
  runDetachedLocalBridgeMcpHttpOwner,
  sameLocalBridgeMcpHttpOwnerIdentity,
  writeLocalBridgeMcpHttpDesiredIdentity,
  type EnsureLocalBridgeMcpHttpOwnerDependencies,
  type LocalBridgeMcpHttpOwnerIdentity,
} from "./local-bridge-mcp-http-owner";

const BEARER_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const ROTATED_BEARER_TOKEN = "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const AGENT_TOKEN = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
const WINDOWS_FIXTURE_SYSTEM_ROOT = process.platform === "win32"
  ? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  : "/windows-fixture";
const OWNER_IDENTITY: LocalBridgeMcpHttpOwnerIdentity = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\meanthis\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};
const resolveFromWorkspace = (specifier: string) => import.meta.resolve(specifier);

function health(buildHash = OWNER_IDENTITY.buildHash): LocalBridgeMcpHttpHealth {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.mcp-http-health",
    ok: true,
    transport: "streamable-http",
    endpoint: "/mcp",
    pid: 1234,
    startCount: 1,
    startedAt: "2026-08-10T00:00:00.000Z",
    activeSessions: 0,
    retainedSessions: 0,
    maxSessions: 64,
    ownerIdentity: { buildHash },
  };
}

function fakeReader(): LocalBridgeReader {
  return {
    getStatus: vi.fn(async () => ({ instances: [] })),
    listInstances: vi.fn(async () => []),
    readInstance: vi.fn(async () => null),
  } as unknown as LocalBridgeReader;
}

describe("detached MeanThis MCP HTTP owner", () => {
  test("starts a hidden detached singleton without inheriting an ambient MCP bearer", () => {
    const parentEnvironment = {
      ...process.env,
      SystemRoot: WINDOWS_FIXTURE_SYSTEM_ROOT,
      [MEANTHIS_MCP_HTTP_TOKEN_ENV]: BEARER_TOKEN,
      mEaNtHiS_mCp_HtTp_ToKeN: AGENT_TOKEN,
      MEANTHIS_OWNER_TEST_SENTINEL: "preserved",
    };
    const launch = createDetachedLocalBridgeMcpHttpOwnerSpawn(parentEnvironment, "win32");
    const encodedCommand = launch.args.at(-1);
    const powerShellScript = typeof encodedCommand === "string"
      ? Buffer.from(encodedCommand, "base64").toString("utf16le")
      : "";

    expect(isAbsolute(launch.command)).toBe(true);
    expect(launch.command).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    expect(launch.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
    ]);
    expect(powerShellScript).toContain("$ownerProcess = Start-Process");
    expect(powerShellScript).toContain("-WindowStyle Hidden -PassThru");
    expect(powerShellScript).toContain("$null -eq $ownerProcess");
    expect(powerShellScript).toContain("$ownerProcess.Id -le 0");
    expect(powerShellScript).toContain(process.execPath.replaceAll("'", "''"));
    expect(powerShellScript).toMatch(/index\.js/);
    expect(powerShellScript).toContain("mcp-http-owner");
    expect(powerShellScript).not.toContain("Invoke-CimMethod");
    expect(powerShellScript).not.toContain("powershell.exe");
    expect(isAbsolute(launch.options.cwd)).toBe(true);
    expect(basename(launch.options.cwd)).not.toBe("dist");
    expect(launch.options).toMatchObject({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(launch.options.env).toEqual(expect.objectContaining({
      MEANTHIS_OWNER_TEST_SENTINEL: "preserved",
    }));
    expect(launch.options.env).not.toHaveProperty(MEANTHIS_MCP_HTTP_TOKEN_ENV);
    expect(launch.options.env).not.toHaveProperty("mEaNtHiS_mCp_HtTp_ToKeN");
    expect(parentEnvironment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBe(BEARER_TOKEN);
    expect(parentEnvironment.mEaNtHiS_mCp_HtTp_ToKeN).toBe(AGENT_TOKEN);
    expect(JSON.stringify(launch)).not.toContain(BEARER_TOKEN);
    expect(JSON.stringify(launch)).not.toContain(AGENT_TOKEN);

    const workerOptions = createLocalBridgeMcpHttpOwnerIdentityWorkerOptions(
      parentEnvironment,
    );
    expect(workerOptions.env).toEqual(expect.objectContaining({
      MEANTHIS_OWNER_TEST_SENTINEL: "preserved",
    }));
    expect(workerOptions.env).not.toHaveProperty(MEANTHIS_MCP_HTTP_TOKEN_ENV);
    expect(workerOptions.env).not.toHaveProperty("mEaNtHiS_mCp_HtTp_ToKeN");
    expect(parentEnvironment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBe(BEARER_TOKEN);
    expect(parentEnvironment.mEaNtHiS_mCp_HtTp_ToKeN).toBe(AGENT_TOKEN);
    expect(JSON.stringify(workerOptions)).not.toContain(BEARER_TOKEN);
    expect(JSON.stringify(workerOptions)).not.toContain(AGENT_TOKEN);
  });

  test("reuses an authenticated owner only when the exact build matches", async () => {
    const probe = vi.fn(async () => health());
    const isPortAvailable = vi.fn(async () => false);
    const spawnOwner = vi.fn();

    await ensureLocalBridgeMcpHttpOwner(
      { probe, isPortAvailable, spawnOwner, wait: vi.fn(async () => undefined) },
      { expectedIdentity: OWNER_IDENTITY },
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect(isPortAvailable).not.toHaveBeenCalled();
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("surfaces an authenticated legacy foreground owner without spawning a replacement", async () => {
    const isPortAvailable = vi.fn(async () => false);
    const spawnOwner = vi.fn();

    await expect(ensureLocalBridgeMcpHttpOwner({
      probe: vi.fn(async () => { throw new LocalBridgeMcpHttpLegacyForegroundOwnerError(); }),
      isPortAvailable,
      spawnOwner,
      wait: vi.fn(async () => undefined),
    }, { expectedIdentity: OWNER_IDENTITY })).rejects.toBeInstanceOf(
      LocalBridgeMcpHttpLegacyForegroundOwnerError,
    );

    expect(isPortAvailable).not.toHaveBeenCalled();
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("surfaces a persistent unverified listener after the bounded turnover window", async () => {
    let now = 0;
    const isPortAvailable = vi.fn(async () => false);
    const spawnOwner = vi.fn();
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });

    const ensure = ensureLocalBridgeMcpHttpOwner({
      probe: vi.fn(async () => { throw new LocalBridgeMcpHttpUnverifiedListenerError(); }),
      isPortAvailable,
      spawnOwner,
      wait,
    }, {
      expectedIdentity: OWNER_IDENTITY,
      startupTimeoutMs: 100,
      delayMs: 10,
      now: () => now,
    });

    await expect(ensure).rejects.toMatchObject({
      code: "MCP_HTTP_UNVERIFIED_LISTENER",
      next: expect.stringContaining("Stop the process"),
    });
    await expect(ensure).rejects.not.toThrow(BEARER_TOKEN);
    expect(now).toBe(100);
    expect(isPortAvailable).toHaveBeenCalledTimes(10);
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("allows a transient unverified listener to converge on an authenticated owner", async () => {
    let now = 0;
    const probe = vi
      .fn<() => Promise<LocalBridgeMcpHttpHealth>>()
      .mockRejectedValueOnce(new LocalBridgeMcpHttpUnverifiedListenerError())
      .mockRejectedValueOnce(new LocalBridgeMcpHttpUnverifiedListenerError())
      .mockResolvedValueOnce(health());
    const spawnOwner = vi.fn();

    await expect(ensureLocalBridgeMcpHttpOwner({
      probe,
      isPortAvailable: vi.fn(async () => false),
      spawnOwner,
      wait: vi.fn(async (delayMs: number) => { now += delayMs; }),
    }, {
      expectedIdentity: OWNER_IDENTITY,
      startupTimeoutMs: 100,
      delayMs: 10,
      now: () => now,
    })).resolves.toMatchObject({ ownerIdentity: { buildHash: OWNER_IDENTITY.buildHash } });

    expect(now).toBe(10);
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("waits for a stale owner to release the port before spawning and verifying", async () => {
    let now = 0;
    const probe = vi
      .fn<() => Promise<LocalBridgeMcpHttpHealth>>()
      .mockResolvedValueOnce(health("b".repeat(64)))
      .mockRejectedValueOnce(new Error("old owner draining"))
      .mockRejectedValueOnce(new Error("old owner still draining"))
      .mockResolvedValueOnce(health());
    const isPortAvailable = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const spawnOwner = vi.fn();
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });

    await ensureLocalBridgeMcpHttpOwner(
      { probe, isPortAvailable, spawnOwner, wait },
      {
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 100,
        delayMs: 10,
        now: () => now,
      },
    );

    expect(isPortAvailable).toHaveBeenCalledTimes(2);
    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  test("allows a cold Windows owner more than fifteen seconds to publish authenticated health", async () => {
    let now = 0;
    let spawned = false;
    const probe = vi.fn(async () => {
      if (spawned && now >= 20_000) return health();
      throw new Error("owner is still computing its exact build identity");
    });
    const spawnOwner = vi.fn(() => { spawned = true; });

    await expect(ensureLocalBridgeMcpHttpOwner({
      probe,
      isPortAvailable: vi.fn(async () => true),
      spawnOwner,
      wait: vi.fn(async (delayMs: number) => { now += delayMs; }),
    }, {
      expectedIdentity: OWNER_IDENTITY,
      delayMs: 1_000,
      now: () => now,
    })).resolves.toMatchObject({ ownerIdentity: { buildHash: OWNER_IDENTITY.buildHash } });

    expect(now).toBe(20_000);
    expect(spawnOwner).toHaveBeenCalledTimes(1);
  });

  test("starts a fresh full readiness window after a slow owner launcher resolves", async () => {
    let now = 0;
    let spawned = false;
    const probe = vi.fn(async () => {
      if (spawned && now >= 150) return health();
      throw new Error("owner is still starting");
    });
    const spawnOwner = vi.fn(async () => {
      now = 150;
      spawned = true;
    });

    await expect(ensureLocalBridgeMcpHttpOwner(
      {
        probe,
        isPortAvailable: vi.fn(async () => true),
        spawnOwner,
        wait: vi.fn(async (delayMs: number) => { now += delayMs; }),
      },
      {
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 100,
        delayMs: 10,
        now: () => now,
      },
    )).resolves.toMatchObject({ ownerIdentity: { buildHash: OWNER_IDENTITY.buildHash } });

    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(now).toBe(160);
  });

  test("reuses a matching concurrent winner while the singleton port remains occupied", async () => {
    const probe = vi
      .fn<() => Promise<LocalBridgeMcpHttpHealth>>()
      .mockRejectedValueOnce(new Error("replacement not ready"))
      .mockResolvedValueOnce(health());
    const spawnOwner = vi.fn();

    await expect(ensureLocalBridgeMcpHttpOwner(
      {
        probe,
        isPortAvailable: vi.fn(async () => false),
        spawnOwner,
        wait: vi.fn(async () => undefined),
      },
      { expectedIdentity: OWNER_IDENTITY },
    )).resolves.toMatchObject({ ownerIdentity: { buildHash: OWNER_IDENTITY.buildHash } });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("converges simultaneous free-port callers on one listener while the losing child exits", async () => {
    let portChecks = 0;
    let releasePortChecks!: () => void;
    const bothCheckedPort = new Promise<void>((resolve) => { releasePortChecks = resolve; });
    let listenerStarted = false;
    let spawned = 0;
    let losingChildrenExited = 0;
    const dependencies: EnsureLocalBridgeMcpHttpOwnerDependencies = {
      probe: vi.fn(async () => {
        if (!listenerStarted) throw new Error("listener not ready");
        return health();
      }),
      isPortAvailable: vi.fn(async () => {
        portChecks += 1;
        if (portChecks === 2) releasePortChecks();
        await bothCheckedPort;
        return true;
      }),
      spawnOwner: vi.fn(() => {
        spawned += 1;
        listenerStarted = true;
        if (spawned > 1) queueMicrotask(() => { losingChildrenExited += 1; });
      }),
      wait: vi.fn(async () => undefined),
    };

    const results = await Promise.all([
      ensureLocalBridgeMcpHttpOwner(dependencies, { expectedIdentity: OWNER_IDENTITY }),
      ensureLocalBridgeMcpHttpOwner(dependencies, { expectedIdentity: OWNER_IDENTITY }),
    ]);
    await Promise.resolve();

    // A free-port observation is not a cross-process lock: both detached children
    // may be spawned. The OS admits one listener, the losing entrypoint exits on
    // EADDRINUSE, and both callers must converge on the authenticated winner.
    expect(spawned).toBe(2);
    expect(losingChildrenExited).toBe(1);
    expect(results.map((result) => result.pid)).toEqual([1234, 1234]);
  });

  test("the last desired identity writer prevents an obsolete concurrent ensure from spawning", async () => {
    let now = 0;
    let desiredBuildHash = OWNER_IDENTITY.buildHash;
    const spawnOwner = vi.fn();
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });
    const obsoleteIdentity = { ...OWNER_IDENTITY, buildHash: "b".repeat(64) };

    const ensure = ensureLocalBridgeMcpHttpOwner(
      {
        probe: vi.fn(async () => { throw new Error("old owner draining"); }),
        isPortAvailable: vi.fn(async () => true),
        isDesiredIdentityCurrent: vi.fn(async () =>
          desiredBuildHash === obsoleteIdentity.buildHash),
        spawnOwner,
        wait,
      },
      {
        expectedIdentity: obsoleteIdentity,
        startupTimeoutMs: 100,
        delayMs: 10,
        now: () => now,
      },
    );
    desiredBuildHash = "c".repeat(64);

    await expect(ensure).rejects.toThrow("unavailable");
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("a new desired build drains the old checkout before starting its replacement", async () => {
    vi.useFakeTimers();
    const replacementIdentity = { ...OWNER_IDENTITY, buildHash: "b".repeat(64) };
    let desiredBuildHash = OWNER_IDENTITY.buildHash;
    let portAvailable = false;
    let replacementStarted = false;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const close = vi.fn(async () => { portAvailable = true; });
    const oldOwner = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      loadDesiredBuildHash: async () => desiredBuildHash,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
      onReady: resolveReady,
    });
    await ready;

    desiredBuildHash = replacementIdentity.buildHash;
    const replacement = ensureLocalBridgeMcpHttpOwner(
      {
        probe: vi.fn(async () => replacementStarted
          ? health(replacementIdentity.buildHash)
          : health(OWNER_IDENTITY.buildHash)),
        isPortAvailable: vi.fn(async () => portAvailable),
        isDesiredIdentityCurrent: vi.fn(async () =>
          desiredBuildHash === replacementIdentity.buildHash),
        spawnOwner: vi.fn(() => { replacementStarted = true; }),
        wait: async (delayMs) => { await vi.advanceTimersByTimeAsync(delayMs); },
      },
      {
        expectedIdentity: replacementIdentity,
        startupTimeoutMs: 100,
        delayMs: 10,
        now: () => Date.now(),
      },
    );

    await expect(replacement).resolves.toMatchObject({
      ownerIdentity: { buildHash: replacementIdentity.buildHash },
    });
    await expect(oldOwner).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(replacementStarted).toBe(true);
    vi.useRealTimers();
  });

  test("fails closed when a foreign listener never releases the singleton port", async () => {
    let now = 0;
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });
    const spawnOwner = vi.fn();

    await expect(ensureLocalBridgeMcpHttpOwner(
      {
        probe: vi.fn(async () => { throw new Error("foreign response body / secret"); }),
        isPortAvailable: vi.fn(async () => false),
        spawnOwner,
        wait,
      },
      {
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 25,
        delayMs: 10,
        now: () => now,
      },
    )).rejects.toThrow("unavailable");

    expect(spawnOwner).not.toHaveBeenCalled();
  });

  test("binds identity to the owner, bridge, schema, and resolver runtime artifacts", () => {
    let changed = false;
    const reads: string[] = [];
    const readFile = (path: string) => {
      reads.push(path);
      return Buffer.from(
        path.endsWith("local-bridge-mcp-http-control.js") && changed
          ? "changed"
          : `bytes:${path}`,
      );
    };
    const first = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });
    const repeated = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });
    changed = true;
    const second = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });

    expect(first).toMatchObject({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      buildHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(repeated).toEqual(first);
    expect(second.buildHash).not.toBe(first.buildHash);
    expect(sameLocalBridgeMcpHttpOwnerIdentity(first, first)).toBe(true);
    expect(sameLocalBridgeMcpHttpOwnerIdentity(first, second)).toBe(false);
    expect(reads.map((path) => path.replaceAll("\\", "/"))).toEqual(expect.arrayContaining([
      expect.stringMatching(/cli\/dist\/index\.js$/),
      expect.stringMatching(/local-bridge-mcp-http-owner\.js$/),
      expect.stringMatching(/local-bridge-mcp-http\.js$/),
      expect.stringMatching(/local-bridge-mcp-http-control\.js$/),
      expect.stringMatching(/local-bridge-mcp-http-health-proof\.js$/),
      expect.stringMatching(/local-bridge-mcp\.js$/),
      expect.stringMatching(/local-bridge-owner\.js$/),
      expect.stringMatching(/local-bridge-agent-auth\.js$/),
      expect.stringMatching(/local-bridge-agent-token\.js$/),
      expect.stringMatching(/local-bridge-mcp-http-token\.js$/),
      expect.stringMatching(/bridge-cli\.js$/),
      expect.stringMatching(/capture-cli\.js$/),
      expect.stringMatching(/cli\.js$/),
      expect.stringMatching(/mcp-host-config\.js$/),
      expect.stringMatching(/local-bridge-native-host\.js$/),
      expect.stringMatching(/local-bridge-native-host-contract\.js$/),
      expect.stringMatching(/local-bridge-native-host-install\.js$/),
      expect.stringMatching(/hub-core\/dist\/index\.js$/),
      expect.stringMatching(/prompt\/dist\/index\.js$/),
      expect.stringMatching(/schema\/dist\/index\.js$/),
      expect.stringMatching(/web-extractor\/dist\/index\.js$/),
      expect.stringMatching(/source-resolver-mcp\/dist\/index\.js$/),
      expect.stringMatching(/source-map-core\/dist\/index\.js$/),
    ]));
  });

  test("opaque build identity binds the executable, entry, and runtime without exposing paths", () => {
    const readFile = (path: string) => Buffer.from(`same-bytes:${path.split(/[\\/]/).at(-1)}`);
    const base = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: "C:\\runtime-a\\node.exe",
      entryPath: "C:\\install-a\\dist\\index.js",
      runtimeVersion: "v24.1.0",
      readFile,
      resolveModule: resolveFromWorkspace,
    });
    const moved = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: "C:\\runtime-b\\node.exe",
      entryPath: "C:\\install-b\\dist\\index.js",
      runtimeVersion: "v24.1.0",
      readFile,
      resolveModule: resolveFromWorkspace,
    });
    const upgraded = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: "C:\\runtime-a\\node.exe",
      entryPath: "C:\\install-a\\dist\\index.js",
      runtimeVersion: "v24.2.0",
      readFile,
      resolveModule: resolveFromWorkspace,
    });

    expect(moved.buildHash).not.toBe(base.buildHash);
    expect(upgraded.buildHash).not.toBe(base.buildHash);
    expect(base.buildHash).not.toContain("runtime-a");
    expect(base.buildHash).not.toContain("install-a");
  });

  test("changes the exact build identity when hub-core business logic changes", () => {
    let changed = false;
    const readFile = (path: string) => Buffer.from(
      path.replaceAll("\\", "/").includes("hub-core/dist/index.js") && changed
        ? "changed-hub-core"
        : `bytes:${path}`,
    );
    const first = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });
    changed = true;
    const second = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });

    expect(second.buildHash).not.toBe(first.buildHash);
  });

  test("resolves nested runtime dependencies from their actual package parents", () => {
    // Keep the fixture path absolute according to the host running the test.
    // A Windows-looking path is relative on POSIX, so pathToFileURL would
    // silently bind the identity to the checkout instead of this fixture.
    const strictRoot = process.platform === "win32" ? "C:\\strict" : "/strict";
    const strictFixtureBaseUrl = pathToFileURL(strictRoot).href;
    const strictFixture = (value: string) =>
      value.replaceAll("file:///C:/strict", strictFixtureBaseUrl);
    const entryPath = join(strictRoot, "cli", "dist", "index.js");
    const entryUrl = pathToFileURL(entryPath).href;
    const sdkMcpUrl = `${strictFixtureBaseUrl}/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`;
    const resolutions = new Map<string, string>([
      [`@meanthis/hub-core|${entryUrl}`, "file:///C:/strict/hub/dist/index.js"],
      [`@meanthis/source-resolver-mcp|${entryUrl}`, "file:///C:/strict/resolver/dist/index.js"],
      [`@modelcontextprotocol/sdk/server/mcp.js|${entryUrl}`, sdkMcpUrl],
      [`@modelcontextprotocol/sdk/server/streamableHttp.js|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js"],
      [`@meanthis/prompt|file:///C:/strict/hub/dist/index.js`, "file:///C:/strict/prompt/dist/index.js"],
      [`@meanthis/schema|${entryUrl}`, "file:///C:/strict/cli/node_modules/@meanthis/schema/dist/index.js"],
      [`@meanthis/schema|file:///C:/strict/hub/dist/index.js`, "file:///C:/strict/schema/dist/index.js"],
      [`@meanthis/web-extractor|file:///C:/strict/hub/dist/index.js`, "file:///C:/strict/web-extractor/dist/index.js"],
      [`@meanthis/schema|file:///C:/strict/web-extractor/dist/index.js`, "file:///C:/strict/web-extractor/node_modules/@meanthis/schema/dist/index.js"],
      [`@meanthis/source-map-core|file:///C:/strict/resolver/dist/index.js`, "file:///C:/strict/source-map/dist/index.js"],
      [`@meanthis/schema|file:///C:/strict/source-map/dist/index.js`, "file:///C:/strict/source-map/node_modules/@meanthis/schema/dist/index.js"],
      [`zod/v4|${entryUrl}`, "file:///C:/strict/cli/node_modules/zod/v4/index.js"],
      [`zod/package.json|${entryUrl}`, "file:///C:/strict/cli/node_modules/zod/package.json"],
      [`zod/v4|file:///C:/strict/resolver/dist/index.js`, "file:///C:/strict/resolver/node_modules/zod/v4/index.js"],
      [`zod/package.json|file:///C:/strict/resolver/dist/index.js`, "file:///C:/strict/resolver/node_modules/zod/package.json"],
      [`zod|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/zod/index.js"],
      [`zod/package.json|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/zod/package.json"],
      [`@hono/node-server|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/@hono/node-server/dist/index.mjs"],
      [`ajv|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/ajv/dist/ajv.js"],
      [`ajv-formats|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/dist/index.js"],
      [`zod-to-json-schema|${sdkMcpUrl}`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/dist/esm/index.js"],
      [`ajv|file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/dist/index.js`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/node_modules/ajv/dist/ajv.js"],
      [`zod|file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/dist/esm/index.js`, "file:///C:/strict/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/node_modules/zod/index.js"],
      [`@modelcontextprotocol/sdk/server/mcp.js|file:///C:/strict/resolver/dist/index.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"],
      [`@modelcontextprotocol/sdk/server/stdio.js|file:///C:/strict/resolver/dist/index.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"],
      [`zod|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/zod/index.js"],
      [`zod/package.json|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/zod/package.json"],
      [`@hono/node-server|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/@hono/node-server/dist/index.mjs"],
      [`ajv|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/ajv/dist/ajv.js"],
      [`ajv-formats|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/dist/index.js"],
      [`zod-to-json-schema|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/dist/esm/index.js"],
      [`ajv|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/dist/index.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/ajv-formats/node_modules/ajv/dist/ajv.js"],
      [`zod|file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/dist/esm/index.js`, "file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/node_modules/zod/index.js"],
    ].map(([key, value]): [string, string] => [
      strictFixture(key),
      strictFixture(value),
    ]));
    const calls: string[] = [];
    const resolveModule = (specifier: string, parentUrl?: string) => {
      const key = `${specifier}|${parentUrl ?? ""}`;
      calls.push(key);
      const resolved = resolutions.get(key);
      if (!resolved) throw new Error(`unexpected resolution: ${key}`);
      return resolved;
    };
    const dependencyCalls: Array<readonly [string, string]> = [];
    const listedPackages: string[] = [];
    const dependencyGraph: Record<string, {
      dependencies?: readonly string[];
      peerDependencies?: readonly string[];
    }> = {
      "@modelcontextprotocol/sdk": {
        dependencies: ["@hono/node-server", "ajv"],
      },
      "@hono/node-server": { peerDependencies: ["hono"] },
      ajv: {
        dependencies: [
          "fast-deep-equal",
          "fast-uri",
          "json-schema-traverse",
          "require-from-string",
        ],
      },
      "fast-uri": { dependencies: ["ajv"] },
    };
    const packageScope = (entryUrl: string) =>
      entryUrl.includes("/strict/resolver/") ? "resolver" : "cli";
    let resolverTransitiveChanged = false;
    const loadStrictIdentity = () => loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath,
      resolveModule,
      resolveDependencyPackage: (packageName, parentUrl) => {
        dependencyCalls.push([packageName, parentUrl]);
        return `${strictFixtureBaseUrl}/${packageScope(parentUrl)}/node_modules/${packageName}/package.json`;
      },
      listPackageRuntimeFiles: (entryUrl, packageName) => {
        listedPackages.push(`${packageScope(entryUrl)}:${packageName}`);
        return [{
        relativePath: "transitive-runtime.js",
        path: fileURLToPath(new URL("./transitive-runtime.js", entryUrl)),
        }];
      },
      loadPackageRuntimeManifest: (entryUrl, packageName) => ({
        identityKey: `${packageScope(entryUrl)}|${packageName}`,
        dependencies: dependencyGraph[packageName]?.dependencies ?? [],
        optionalDependencies: [],
        peerDependencies: dependencyGraph[packageName]?.peerDependencies ?? [],
        optionalPeerDependencies: new Set(),
      }),
      readFile: (path) => Buffer.from(
        resolverTransitiveChanged &&
          path.replaceAll("\\", "/").includes("strict/resolver/node_modules") &&
          path.endsWith("transitive-runtime.js")
          ? `changed:${path}`
          : `bytes:${path}`,
      ),
    });

    const first = loadStrictIdentity();
    resolverTransitiveChanged = true;
    const second = loadStrictIdentity();
    expect(second.buildHash).not.toBe(first.buildHash);
    expect(calls).toEqual(expect.arrayContaining([
      strictFixture(`@meanthis/prompt|file:///C:/strict/hub/dist/index.js`),
      strictFixture(`@meanthis/web-extractor|file:///C:/strict/hub/dist/index.js`),
      strictFixture(`@meanthis/source-map-core|file:///C:/strict/resolver/dist/index.js`),
      strictFixture(`@modelcontextprotocol/sdk/server/mcp.js|file:///C:/strict/resolver/dist/index.js`),
      strictFixture(`@modelcontextprotocol/sdk/server/stdio.js|file:///C:/strict/resolver/dist/index.js`),
    ]));
    expect(dependencyCalls).toEqual(expect.arrayContaining([
      ["@hono/node-server", sdkMcpUrl],
      ["@hono/node-server", strictFixture("file:///C:/strict/resolver/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")],
      ["hono", strictFixture("file:///C:/strict/cli/node_modules/@hono/node-server/package.json")],
      ["hono", strictFixture("file:///C:/strict/resolver/node_modules/@hono/node-server/package.json")],
      ["fast-uri", strictFixture("file:///C:/strict/cli/node_modules/ajv/package.json")],
      ["fast-uri", strictFixture("file:///C:/strict/resolver/node_modules/ajv/package.json")],
    ]));
    expect(listedPackages.filter((value) => value === "cli:ajv")).toHaveLength(2);
    expect(listedPackages.filter((value) => value === "resolver:ajv")).toHaveLength(2);
  });

  test("resolves the installed ESM package closure without an experimental Node flag", () => {
    expect(() => loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: process.execPath,
      entryPath: join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js"),
      readFile: (path) => Buffer.from(`bytes:${path}`),
    })).not.toThrow();
  });

  test.each([
    ["CLI bridge command", "bridge-cli.js"],
    ["SDK Hono", "@hono/node-server"],
    ["Hono runtime peer", "/node_modules/hono/"],
    ["SDK Zod", "/zod/"],
    ["SDK Ajv", "/ajv/"],
    ["SDK Ajv formats", "/ajv-formats/"],
    ["SDK Zod JSON schema adapter", "/zod-to-json-schema/"],
    ["Ajv fast-uri runtime", "/fast-uri/"],
    ["Ajv fast-deep-equal runtime", "/fast-deep-equal/"],
    ["Ajv json-schema-traverse runtime", "/json-schema-traverse/"],
    ["Ajv require-from-string runtime", "/require-from-string/"],
  ])("changes identity when %s runtime bytes change", (_label, changedDependency) => {
    const readFile = (path: string) => Buffer.from(
      path.replaceAll("\\", "/").includes(changedDependency)
        ? `changed:${path}`
        : `bytes:${path}`,
    );
    const base = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile: (path) => Buffer.from(`bytes:${path}`),
      resolveModule: resolveFromWorkspace,
    });
    const changed = loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      readFile,
      resolveModule: resolveFromWorkspace,
    });

    expect(changed.buildHash).not.toBe(base.buildHash);
  });

  test("atomically stores a bounded desired identity and rejects non-files", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-owner-marker-"));
    const directory = join(codexHome, "ui-attach");
    const pathSecurity = {
      applyAcl: vi.fn(async () => undefined),
      inspectAcl: vi.fn(async () => undefined),
    };
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeLocalBridgeMcpHttpDesiredIdentity(OWNER_IDENTITY.buildHash, {
        codexHome,
        ...pathSecurity,
      });
      await expect(readLocalBridgeMcpHttpDesiredIdentity({ codexHome, ...pathSecurity }))
        .resolves.toBe(OWNER_IDENTITY.buildHash);
      const markerPath = getLocalBridgeMcpHttpDesiredIdentityPath(codexHome);
      const marker = await lstat(markerPath);
      expect(marker.isFile()).toBe(true);
      expect(marker.isSymbolicLink()).toBe(false);
      expect((await readFile(markerPath, "utf8")).length).toBe(65);
      if (process.platform !== "win32") expect(marker.mode & 0o777).toBe(0o600);

      await expect(readLocalBridgeMcpHttpDesiredIdentity({
        codexHome,
        ...pathSecurity,
        readIdentityFile: async (path) => {
          const original = await readFile(path, "utf8");
          await writeFile(path, `${"b".repeat(64)}\n`, "utf8");
          return original;
        },
      })).rejects.toThrow("MCP HTTP desired identity is unavailable.");

      await rm(markerPath);
      await mkdir(markerPath);
      await expect(writeLocalBridgeMcpHttpDesiredIdentity("b".repeat(64), {
        codexHome,
        ...pathSecurity,
      }))
        .rejects.toThrow("unavailable");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("fails closed when an expected npm runtime artifact is missing", () => {
    expect(() => loadLocalBridgeMcpHttpOwnerIdentity({
      executablePath: OWNER_IDENTITY.executablePath,
      entryPath: OWNER_IDENTITY.entryPath,
      resolveModule: resolveFromWorkspace,
      readFile: (path) => {
        if (path.replaceAll("\\", "/").includes("source-map-core/dist/index.js")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return Buffer.from(`bytes:${path}`);
      },
    })).toThrow();
  });

  test("bounds package directory traversal depth before hashing runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "meanthis-owner-tree-"));
    const packageNames = [
      "@meanthis/hub-core",
      "@meanthis/prompt",
      "@meanthis/schema",
      "@meanthis/source-map-core",
      "@meanthis/source-resolver-mcp",
      "@meanthis/web-extractor",
      "@modelcontextprotocol/sdk",
      "zod",
    ];
    const packageRoots = new Map<string, string>();
    try {
      for (const packageName of packageNames) {
        const packageRoot = join(root, "packages", ...packageName.split("/"));
        packageRoots.set(packageName, packageRoot);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: packageName, version: "1.0.0" }),
          "utf8",
        );
      }
      let deepDirectory = packageRoots.get("zod")!;
      for (let depth = 0; depth < 66; depth += 1) deepDirectory = join(deepDirectory, "d");
      await mkdir(deepDirectory, { recursive: true });
      await writeFile(join(deepDirectory, "runtime.js"), "export {};", "utf8");
      const resolveModule = (specifier: string) => {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        const packageRoot = packageRoots.get(packageName);
        if (!packageRoot) throw new Error(`unexpected package: ${packageName}`);
        return pathToFileURL(join(packageRoot, "package.json")).href;
      };

      expect(() => loadLocalBridgeMcpHttpOwnerIdentity({
        executablePath: OWNER_IDENTITY.executablePath,
        entryPath: join(root, "index.js"),
        resolveModule,
        readFile: (path) => Buffer.from(`bytes:${path}`),
      })).toThrow("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["build", {
      buildHash: "b".repeat(64),
      bearerToken: BEARER_TOKEN,
      tokenFingerprint: "sha256:1111111111111111",
    }],
    ["token", {
      buildHash: OWNER_IDENTITY.buildHash,
      bearerToken: ROTATED_BEARER_TOKEN,
      tokenFingerprint: "sha256:2222222222222222",
    }],
  ])("closes every HTTP session after periodic %s identity change", async (kind, current) => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (): Promise<LocalBridgeMcpHttpServer> => ({
      origin: "http://127.0.0.1:38472",
      url: "http://127.0.0.1:38472/mcp",
      port: 38472,
      pid: process.pid,
      startCount: 1,
      close,
    }));
    let tokenChecks = 0;
    let tokenReads = 0;
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      checkIntervalMs: 10,
      buildCheckIntervalMs: 10,
      slowCheckTimeoutMs: 1_000,
      loadOwnerIdentity: () => ({
        ...OWNER_IDENTITY,
        buildHash: kind === "build" ? current.buildHash : OWNER_IDENTITY.buildHash,
      }),
      loadTokenFingerprint: async () => {
        tokenChecks += 1;
        return kind === "token" && tokenChecks > 1
          ? current.tokenFingerprint
          : "sha256:1111111111111111";
      },
      readTokenCredential: async () => {
        tokenReads += 1;
        return kind === "token" && tokenReads > 1
          ? current.bearerToken
          : BEARER_TOKEN;
      },
      createReader: fakeReader,
      startServer,
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(kind === "build" ? 10 : 20);
    await expect(run).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("drains when a matching diagnostic fingerprint hides different bearer bytes", async () => {
    vi.useFakeTimers();
    let desiredBuildHash = OWNER_IDENTITY.buildHash;
    const close = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => ROTATED_BEARER_TOKEN,
      loadDesiredBuildHash: async () => desiredBuildHash,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      desiredBuildHash = "b".repeat(64);
      await vi.advanceTimersByTimeAsync(10);
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test.each(["missing", "invalid"])(
    "drains when the desired identity marker becomes %s",
    async (condition) => {
      vi.useFakeTimers();
      let reads = 0;
      const close = vi.fn(async () => undefined);
      const run = runDetachedLocalBridgeMcpHttpOwner({
        bearerToken: BEARER_TOKEN,
        agentToken: AGENT_TOKEN,
        ownerIdentity: OWNER_IDENTITY,
        tokenFingerprint: "sha256:1111111111111111",
        checkIntervalMs: 10,
        loadOwnerIdentity: () => OWNER_IDENTITY,
        loadTokenFingerprint: async () => "sha256:1111111111111111",
        readTokenCredential: async () => BEARER_TOKEN,
        loadDesiredBuildHash: async () => {
          reads += 1;
          if (reads === 1) return OWNER_IDENTITY.buildHash;
          if (condition === "missing") throw new Error("missing marker path");
          return "invalid";
        },
        createReader: fakeReader,
        startServer: vi.fn(async () => ({
          origin: "http://127.0.0.1:38472",
          url: "http://127.0.0.1:38472/mcp",
          port: 38472,
          pid: process.pid,
          startCount: 1,
          close,
        })),
        ensureBridgeOwner: vi.fn(async () => undefined),
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(run).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    },
  );

  test("drains on the bounded low-frequency credential permission inspection", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const inspectTokenCredential = vi.fn(async () => false);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 1_000,
      credentialCheckIntervalMs: 30_000,
      inspectTokenCredential,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(inspectTokenCredential).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toBeUndefined();
    expect(inspectTokenCredential).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("token rotation drains promptly while a slow ACL inspection remains pending", async () => {
    vi.useFakeTimers();
    let resolveInspection!: (ready: boolean) => void;
    const inspectTokenCredential = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveInspection = resolve;
    }));
    let currentBearerToken = BEARER_TOKEN;
    const close = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 1_000,
      credentialCheckIntervalMs: 30_000,
      inspectTokenCredential,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => currentBearerToken,
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspectTokenCredential).toHaveBeenCalledTimes(1);
    currentBearerToken = ROTATED_BEARER_TOKEN;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(run).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    resolveInspection(true);
    await vi.runAllTicks();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("bounds a hung fast bearer read and drains the owner", async () => {
    vi.useFakeTimers();
    let credentialReady = true;
    const close = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 1_000,
      fastCheckTimeoutMs: 100,
      credentialCheckIntervalMs: 30_000,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: () => new Promise<string>(() => undefined),
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      inspectTokenCredential: async () => credentialReady,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    try {
      await vi.advanceTimersByTimeAsync(1_100);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      credentialReady = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("lets the slow secure lane detect rotation while the fast bearer read is hung", async () => {
    vi.useFakeTimers();
    let credentialReady = true;
    let bearerReads = 0;
    const close = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 1_000,
      fastCheckTimeoutMs: 60_000,
      credentialCheckIntervalMs: 30_000,
      slowCheckTimeoutMs: 10_000,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: () => {
        bearerReads += 1;
        return bearerReads === 1
          ? new Promise<string>(() => undefined)
          : Promise.resolve(ROTATED_BEARER_TOKEN);
      },
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      inspectTokenCredential: async () => credentialReady,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bearerReads).toBe(2);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      credentialReady = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  test("fast token turnover drains while a full build identity check is hung", async () => {
    vi.useFakeTimers();
    let currentBearerToken = BEARER_TOKEN;
    const loadOwnerIdentity = vi.fn(() => new Promise<LocalBridgeMcpHttpOwnerIdentity>(() => {}));
    const close = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 1_000,
      buildCheckIntervalMs: 30_000,
      credentialCheckIntervalMs: 30_000,
      slowCheckTimeoutMs: 10_000,
      loadOwnerIdentity,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => currentBearerToken,
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      inspectTokenCredential: async () => true,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(loadOwnerIdentity).toHaveBeenCalledTimes(1);
    currentBearerToken = ROTATED_BEARER_TOKEN;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(run).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test.each(["build", "credential"])(
    "bounds a hung slow %s watcher and drains the owner",
    async (kind) => {
      vi.useFakeTimers();
      const close = vi.fn(async () => undefined);
      let buildSignal: AbortSignal | undefined;
      const run = runDetachedLocalBridgeMcpHttpOwner({
        bearerToken: BEARER_TOKEN,
        agentToken: AGENT_TOKEN,
        ownerIdentity: OWNER_IDENTITY,
        tokenFingerprint: "sha256:1111111111111111",
        checkIntervalMs: 1_000,
        buildCheckIntervalMs: 30_000,
        credentialCheckIntervalMs: 30_000,
        slowCheckTimeoutMs: 100,
        loadOwnerIdentity: (signal) => {
          buildSignal = signal;
          return kind === "build"
            ? new Promise<LocalBridgeMcpHttpOwnerIdentity>(() => {})
            : OWNER_IDENTITY;
        },
        loadTokenFingerprint: async () => "sha256:1111111111111111",
        readTokenCredential: async () => BEARER_TOKEN,
        loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
        inspectTokenCredential: () => kind === "credential"
          ? new Promise<boolean>(() => {})
          : Promise.resolve(true),
        createReader: fakeReader,
        startServer: vi.fn(async () => ({
          origin: "http://127.0.0.1:38472",
          url: "http://127.0.0.1:38472/mcp",
          port: 38472,
          pid: process.pid,
          startCount: 1,
          close,
        })),
        ensureBridgeOwner: vi.fn(async () => undefined),
      });

      await vi.advanceTimersByTimeAsync(30_100);
      await expect(run).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      if (kind === "build") expect(buildSignal?.aborted).toBe(true);
      vi.useRealTimers();
    },
  );

  test("keeps the process alive until slow session cleanup settles", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    let changed = false;
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      loadDesiredBuildHash: async () => changed ? "b".repeat(64) : OWNER_IDENTITY.buildHash,
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
    });
    let settled = false;
    void run.finally(() => { settled = true; });
    changed = true;

    await vi.advanceTimersByTimeAsync(10);
    expect(close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    resolveClose();
    await expect(run).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  test("keeps browser identity non-authoritative, then stops the lease before slow HTTP drain", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const httpClose = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    let refreshBrowserOwner!: () => Promise<void>;
    const leaseRefresh = vi.fn(() => refreshBrowserOwner());
    const leaseStop = vi.fn();
    const startBridgeOwnerLease = vi.fn((ensureOwner: () => Promise<void>) => {
      refreshBrowserOwner = ensureOwner;
      return { refresh: leaseRefresh, stop: leaseStop };
    });
    const ensureBridgeOwner = vi.fn(async () => undefined);
    const browserReader = fakeReader();
    let changed = false;
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      loadDesiredBuildHash: async () => changed ? "b".repeat(64) : OWNER_IDENTITY.buildHash,
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      createReader: () => browserReader,
      startServer: vi.fn(async (_reader, options) => {
        expect(options.port).toBe(38472);
        return {
          origin: "http://127.0.0.1:38472",
          url: "http://127.0.0.1:38472/mcp",
          port: 38472,
          pid: process.pid,
          startCount: 1,
          close: httpClose,
        };
      }),
      ensureBridgeOwner,
      startBridgeOwnerLease,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureBridgeOwner).toHaveBeenNthCalledWith(1, browserReader, {
      publishDesiredIdentity: false,
    });
    await leaseRefresh();
    expect(ensureBridgeOwner).toHaveBeenNthCalledWith(2, browserReader, {
      publishDesiredIdentity: false,
    });
    changed = true;

    await vi.advanceTimersByTimeAsync(10);
    expect(startBridgeOwnerLease).toHaveBeenCalledTimes(1);
    expect(leaseRefresh).toHaveBeenCalledTimes(1);
    expect(leaseStop).toHaveBeenCalledTimes(1);
    expect(httpClose).toHaveBeenCalledTimes(1);
    resolveClose();
    await expect(run).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  test("does not bind HTTP before the initial browser owner lease succeeds", async () => {
    const onReady = vi.fn();
    const lifecycleEvents: Array<{ event: string; reason?: string }> = [];
    const startServer = vi.fn();
    const startBridgeOwnerLease = vi.fn((
      ensureOwner: () => Promise<void>,
      onOwnerUnavailable: () => void,
    ) => ({
      refresh: async () => {
        try {
          await ensureOwner();
        } catch {
          onOwnerUnavailable();
        }
      },
      stop: vi.fn(),
    }));
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      createReader: fakeReader,
      startServer,
      ensureBridgeOwner: vi.fn(async () => {
        throw new Error("browser owner unavailable");
      }),
      startBridgeOwnerLease,
      onReady,
      onLifecycleEvent: (event) => { lifecycleEvents.push(event); },
    });

    await expect(run).rejects.toThrow("Detached MeanThis MCP HTTP owner is unavailable.");
    expect(onReady).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(startBridgeOwnerLease).not.toHaveBeenCalled();
    expect(lifecycleEvents).not.toContainEqual(expect.objectContaining({ event: "ready" }));
    expect(lifecycleEvents).not.toContainEqual(expect.objectContaining({ event: "close" }));
  });

  test("closes MCP HTTP even when lifecycle persistence never settles", async () => {
    let desiredBuildHash = OWNER_IDENTITY.buildHash;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const httpClose = vi.fn(async () => undefined);
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 5,
      fastCheckTimeoutMs: 100,
      buildCheckIntervalMs: 10_000,
      loadDesiredBuildHash: async () => desiredBuildHash,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      createReader: fakeReader,
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close: httpClose,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
      startBridgeOwnerLease: vi.fn(() => ({
        refresh: vi.fn(async () => undefined),
        stop: vi.fn(),
      })),
      onReady: resolveReady,
      onLifecycleEvent: (event) => event.event === "close"
        ? new Promise<void>(() => undefined)
        : undefined,
    });
    await ready;
    desiredBuildHash = "b".repeat(64);

    const settled = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    expect(settled).toBe(true);
    expect(httpClose).toHaveBeenCalledTimes(1);
  });

  test("cannot overwrite a pinned browser identity after the agent credential drifts", async () => {
    vi.useFakeTimers();
    let desiredBuildChanged = false;
    let pinnedBrowserIdentity = "agent-token-A2";
    const currentAgentCredential = "agent-token-A3";
    const httpClose = vi.fn(async () => undefined);
    const ensureBridgeOwner = vi.fn(async (
      _reader: LocalBridgeReader,
      options: { publishDesiredIdentity: boolean },
    ) => {
      if (options.publishDesiredIdentity) pinnedBrowserIdentity = currentAgentCredential;
      if (pinnedBrowserIdentity !== currentAgentCredential) {
        throw new Error("pinned browser owner is unavailable");
      }
    });
    const startBridgeOwnerLease = vi.fn((
      ensureOwner: () => Promise<void>,
      onOwnerUnavailable: () => void,
    ) => ({
      refresh: async () => {
        try {
          await ensureOwner();
        } catch {
          onOwnerUnavailable();
        }
      },
      stop: vi.fn(),
    }));
    const startServer = vi.fn(async () => ({
      origin: "http://127.0.0.1:38472",
      url: "http://127.0.0.1:38472/mcp",
      port: 38472,
      pid: process.pid,
      startCount: 1,
      close: httpClose,
    }));
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      loadDesiredBuildHash: async () => desiredBuildChanged
        ? "b".repeat(64)
        : OWNER_IDENTITY.buildHash,
      createReader: fakeReader,
      startServer,
      ensureBridgeOwner,
      startBridgeOwnerLease,
    });

    await expect(run).rejects.toThrow("Detached MeanThis MCP HTTP owner is unavailable.");
    expect(pinnedBrowserIdentity).toBe("agent-token-A2");
    expect(startServer).not.toHaveBeenCalled();
    expect(startBridgeOwnerLease).not.toHaveBeenCalled();
    expect(httpClose).not.toHaveBeenCalled();
    desiredBuildChanged = true;
    vi.useRealTimers();
  });

  test("drains when the browser owner lease rejects a stale agent credential", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const httpClose = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    let signalOwnerUnavailable!: () => void;
    const leaseStop = vi.fn();
    const startBridgeOwnerLease = vi.fn((
      _ensureOwner: () => Promise<void>,
      onOwnerUnavailable: () => void,
    ) => {
      signalOwnerUnavailable = onOwnerUnavailable;
      return { refresh: vi.fn(async () => undefined), stop: leaseStop };
    });
    const run = runDetachedLocalBridgeMcpHttpOwner({
      bearerToken: BEARER_TOKEN,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      tokenFingerprint: "sha256:1111111111111111",
      loadDesiredBuildHash: async () => OWNER_IDENTITY.buildHash,
      checkIntervalMs: 10,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadTokenFingerprint: async () => "sha256:1111111111111111",
      readTokenCredential: async () => BEARER_TOKEN,
      createReader: () => fakeReader(),
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:38472",
        url: "http://127.0.0.1:38472/mcp",
        port: 38472,
        pid: process.pid,
        startCount: 1,
        close: httpClose,
      })),
      ensureBridgeOwner: vi.fn(async () => undefined),
      startBridgeOwnerLease,
    });
    await vi.advanceTimersByTimeAsync(0);

    signalOwnerUnavailable();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseStop).toHaveBeenCalledTimes(1);
    expect(httpClose).toHaveBeenCalledTimes(1);

    resolveClose();
    await expect(run).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  test("classifies a foreign port occupant without revealing the bearer", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get(MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER)).toMatch(/^\d+$/);
      expect(headers.get(MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(headers.get(MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify([...headers])).not.toContain(BEARER_TOKEN);
      return new Response(JSON.stringify(health()), { status: 200 });
    }) as typeof fetch;

    await expect(probeLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl,
      requestTimeoutMs: 50,
      isPortAvailable: vi.fn(async () => false),
    })).rejects.toMatchObject({
      code: "MCP_HTTP_UNVERIFIED_LISTENER",
      next: expect.stringContaining("Stop the process"),
    });
    await expect(probeLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl,
      requestTimeoutMs: 50,
      isPortAvailable: vi.fn(async () => false),
    })).rejects.not.toThrow(BEARER_TOKEN);
  });

  test("classifies authenticated exact, stale, legacy, absent, and unexpected owner states", async () => {
    const responseFor = (value: unknown, status = 200) => vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const requestHeaders = new Headers(init?.headers);
      const requestProof = {
        timestamp: requestHeaders.get(MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER) ?? "",
        nonce: requestHeaders.get(MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER) ?? "",
        proof: requestHeaders.get(MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER) ?? "",
      };
      const body = typeof value === "string" ? value : JSON.stringify(value);
      const responseProof = createLocalBridgeMcpHttpHealthProofResponse(
        BEARER_TOKEN,
        requestProof,
        body,
        {
          port: MEANTHIS_MCP_HTTP_DEFAULT_PORT,
          status,
          now: () => Date.now(),
          randomBytes: () => Buffer.alloc(32, 9),
        },
      );
      return new Response(body, {
        status,
        headers: {
          "content-type": "application/json",
          ...responseProof.headers,
        },
      });
    }) as typeof fetch;

    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: responseFor(health()),
    })).resolves.toMatchObject({ status: "ready", health: { pid: 1234 } });
    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: responseFor(health("b".repeat(64))),
    })).resolves.toMatchObject({ status: "stale", health: { pid: 1234 } });
    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: responseFor({ ...health(), ownerIdentity: null }),
    })).resolves.toMatchObject({ status: "legacy_foreground", health: { pid: 1234 } });
    await expect(probeLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: responseFor({ ...health(), ownerIdentity: null }),
    })).rejects.toBeInstanceOf(LocalBridgeMcpHttpLegacyForegroundOwnerError);
    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }) as typeof fetch,
      isPortAvailable: vi.fn(async () => true),
    })).resolves.toEqual({ status: "absent" });
    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: vi.fn(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch,
      isPortAvailable: vi.fn(async () => false),
    })).resolves.toEqual({ status: "unverified_listener" });
    await expect(inspectLocalBridgeMcpHttpOwner(BEARER_TOKEN, OWNER_IDENTITY, {
      fetchImpl: vi.fn(async () => { throw new Error("probe failed"); }) as typeof fetch,
      isPortAvailable: vi.fn(async () => { throw new Error("port check failed"); }),
    })).resolves.toEqual({ status: "unexpected" });
  });
});
