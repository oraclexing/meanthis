import { describe, expect, test, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  fingerprintLocalBridgeAgentToken,
  MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
} from "./local-bridge-agent-token";
import { createHttpLocalBridgeReader, startLocalBridgeOwnerLease } from "./local-bridge-mcp";
import { MEANTHIS_MCP_HTTP_TOKEN_ENV } from "./local-bridge-mcp-http-token";
import {
  AuthenticatedLocalBridgeOwnerIdentityMismatchError,
  createDetachedLocalBridgeOwnerSpawn,
  createDetachedLocalBridgeProcessSpawn,
  createLocalBridgeOwnerLifecycleReporter,
  createLocalBridgeOwnerLifecycle,
  ensureLocalBridgeOwner,
  fingerprintLocalBridgeOwnerIdentity,
  getLocalBridgeOwnerLifecycleDiagnosticPath,
  loadLocalBridgeOwnerIdentity,
  runDetachedLocalBridgeOwner,
  sameLocalBridgeOwnerIdentity,
} from "./local-bridge-owner";

const AGENT_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const ROTATED_AGENT_TOKEN = "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const AGENT_TOKEN_FINGERPRINT = fingerprintLocalBridgeAgentToken(AGENT_TOKEN);
const WINDOWS_FIXTURE_SYSTEM_ROOT = process.platform === "win32"
  ? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  : "/windows-fixture";
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};
const REPLACEMENT_OWNER_IDENTITY = {
  ...OWNER_IDENTITY,
  entryPath: "C:\\fixtures\\ui-attach-next\\apps\\cli\\dist\\index.js",
  buildHash: "b".repeat(64),
};
const OWNER_IDENTITY_FINGERPRINT = fingerprintLocalBridgeOwnerIdentity(
  OWNER_IDENTITY,
  AGENT_TOKEN,
);

function desiredIdentityDependencies() {
  return {
    isPortAvailable: vi.fn(async () => true),
    publishDesiredIdentity: vi.fn(async () => undefined),
    readDesiredIdentity: vi.fn(async () => OWNER_IDENTITY_FINGERPRINT),
  };
}

function isOriginPortAvailable(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise<boolean>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.once("listening", () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
    server.listen(Number(url.port), url.hostname);
  });
}

async function reserveRandomLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("random port unavailable")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.listen(0, "127.0.0.1");
  });
}

interface WindowsFixtureProcessSnapshot {
  launcher: Array<{ pid: number; parentPid: number }>;
  launcherIdentity: "absent" | "match" | "mismatch" | "unknown";
  owner: Array<{ pid: number; parentPid: number }>;
  attributableConsoleHelpers: Array<{ name: string; pid: number; parentPid: number }>;
}

interface WindowsFixtureProcessSnapshotRaw {
  launcherCandidates: Array<{
    pid: number;
    parentPid: number;
    name: string;
    executablePath: string | null;
    commandLine: string | null;
  }>;
  owner: Array<{ pid: number; parentPid: number }>;
  attributableConsoleHelpers: Array<{ name: string; pid: number; parentPid: number }>;
}

type WindowsLauncherIdentityMatch = "match" | "mismatch" | "unknown";

interface WindowsLauncherIdentityCandidate {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
}

interface WindowsLauncherIdentityExpectation {
  pid: number;
  executablePath: string;
  launchToken: string;
}

function matchWindowsLauncherIdentity(
  candidate: WindowsLauncherIdentityCandidate,
  expected: WindowsLauncherIdentityExpectation,
): WindowsLauncherIdentityMatch {
  if (candidate.pid !== expected.pid) return "mismatch";
  if (candidate.commandLine === null || candidate.commandLine.length === 0 ||
      expected.launchToken.length === 0 ||
      candidate.executablePath === null || candidate.executablePath.length === 0) {
    return "unknown";
  }
  const expectedExecutableName = expected.executablePath.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (!expectedExecutableName || candidate.name.toLowerCase() !== expectedExecutableName ||
      normalizeWindowsPath(candidate.executablePath) !== normalizeWindowsPath(expected.executablePath)) {
    return "mismatch";
  }
  return candidate.commandLine.includes(expected.launchToken) ? "match" : "mismatch";
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

describe("Windows launcher identity matching", () => {
  const expected = {
    pid: 43748,
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    launchToken: "observed-encoded-command-a",
  };

  test("requires the same pid, PowerShell executable, and launch token", () => {
    const candidate = {
      pid: expected.pid,
      parentPid: 38_644,
      name: "powershell.exe",
      executablePath: expected.executablePath,
      commandLine: `powershell.exe -EncodedCommand ${expected.launchToken}`,
    };
    expect(matchWindowsLauncherIdentity(candidate, expected)).toBe("match");
    expect(matchWindowsLauncherIdentity(candidate, {
      ...expected,
      launchToken: "different-encoded-command",
    })).toBe("mismatch");
    expect(matchWindowsLauncherIdentity({ ...candidate, pid: expected.pid + 1 }, expected))
      .toBe("mismatch");
  });

  test("fails closed with an explicit unknown result when CommandLine is missing", () => {
    expect(matchWindowsLauncherIdentity({
      pid: expected.pid,
      parentPid: 38_644,
      name: "powershell.exe",
      executablePath: expected.executablePath,
      commandLine: null,
    }, expected)).toBe("unknown");
  });
});

interface WindowsLauncherObserverProcess {
  name: string;
  pid: number;
  parentPid: number;
}

interface WindowsLauncherObserverSample {
  launchers: WindowsLauncherObserverProcess[];
  descendants: WindowsLauncherObserverProcess[];
  observerConsoleHelpers: WindowsLauncherObserverProcess[];
}

interface WindowsLauncherObserverEvidence {
  observerPid: number;
  seenLaunchers: WindowsLauncherObserverProcess[];
  samples: WindowsLauncherObserverSample[];
  final: WindowsLauncherObserverSample;
}

interface WindowsLauncherObserverHandle {
  pid: number;
  stop(): Promise<WindowsLauncherObserverEvidence>;
}

async function startWindowsLauncherObserver(options: {
  root: string;
  targetEncodedCommand: string;
}): Promise<WindowsLauncherObserverHandle> {
  const powershellPath = join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const observerPath = join(options.root, "process observer.ps1");
  const readyPath = join(options.root, "observer-ready");
  const stopPath = join(options.root, "observer-stop");
  const outputPath = join(options.root, "observer-evidence.json");
  await writeFile(observerPath, [
    "$ErrorActionPreference = 'Stop'",
    "$needle = $env:MEANTHIS_OBSERVER_ENCODED_COMMAND",
    "$readyPath = $env:MEANTHIS_OBSERVER_READY_PATH",
    "$stopPath = $env:MEANTHIS_OBSERVER_STOP_PATH",
    "$outputPath = $env:MEANTHIS_OBSERVER_OUTPUT_PATH",
    "$deadline = [DateTime]::UtcNow.AddSeconds(15)",
    "$samples = [System.Collections.Generic.List[object]]::new()",
    "$seenLaunchers = @{}",
    "Set-Content -LiteralPath $readyPath -Value $PID -Encoding ascii",
    "do {",
    "  $processes = @(Get-CimInstance Win32_Process)",
    "  $launchers = @($processes | Where-Object { ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') -and $null -ne $_.CommandLine -and $_.CommandLine.Contains($needle) })",
    "  foreach ($launcher in $launchers) { $seenLaunchers[[string]$launcher.ProcessId] = [pscustomobject]@{ name = [string]$launcher.Name; pid = [int]$launcher.ProcessId; parentPid = [int]$launcher.ParentProcessId } }",
    "  $rootPids = @($seenLaunchers.Keys | ForEach-Object { [int]$_ })",
    "  $descendants = [System.Collections.Generic.List[object]]::new()",
    "  $knownPids = @{}",
    "  $frontier = @($rootPids)",
    "  while ($frontier.Count -gt 0) {",
    "    $next = [System.Collections.Generic.List[int]]::new()",
    "    foreach ($candidate in $processes) {",
    "      if ($knownPids.ContainsKey([string]$candidate.ProcessId)) { continue }",
    "      if ($frontier -notcontains [int]$candidate.ParentProcessId) { continue }",
    "      $knownPids[[string]$candidate.ProcessId] = $true",
    "      $descendants.Add([pscustomobject]@{ name = [string]$candidate.Name; pid = [int]$candidate.ProcessId; parentPid = [int]$candidate.ParentProcessId })",
    "      $next.Add([int]$candidate.ProcessId)",
    "    }",
    "    $frontier = @($next)",
    "  }",
    "  $samples.Add([pscustomobject]@{",
    "    launchers = @($launchers | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId } })",
    "    descendants = @($descendants)",
    "    observerConsoleHelpers = @($processes | Where-Object { ($_.Name -eq 'WindowsTerminal.exe' -or $_.Name -eq 'OpenConsole.exe') -and $_.ParentProcessId -eq $PID } | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId } })",
    "  })",
    "  if (Test-Path -LiteralPath $stopPath) { break }",
    "  Start-Sleep -Milliseconds 20",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "$final = if ($samples.Count -gt 0) { $samples[$samples.Count - 1] } else { [pscustomobject]@{ launchers = @(); descendants = @(); observerConsoleHelpers = @() } }",
    "$evidence = [pscustomobject]@{ observerPid = [int]$PID; seenLaunchers = @($seenLaunchers.Values); samples = @($samples); final = $final }",
    "$evidence | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $outputPath -Encoding utf8",
  ].join("\n"), "utf8");
  const child = spawn(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    observerPath,
  ], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MEANTHIS_OBSERVER_ENCODED_COMMAND: options.targetEncodedCommand,
      MEANTHIS_OBSERVER_OUTPUT_PATH: outputPath,
      MEANTHIS_OBSERVER_READY_PATH: readyPath,
      MEANTHIS_OBSERVER_STOP_PATH: stopPath,
    },
  });
  if (!child.pid) throw new Error("observer process did not start");
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`observer exited with ${code}`)));
  });
  await vi.waitFor(async () => {
    expect(Number((await readFile(readyPath, "utf8")).trim())).toBe(child.pid);
  }, { timeout: 5_000 });
  let stopped = false;
  return {
    pid: child.pid,
    async stop() {
      if (!stopped) {
        stopped = true;
        await writeFile(stopPath, "stop\n", "utf8");
      }
      await exit;
      const evidence = JSON.parse(
        (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, ""),
      ) as WindowsLauncherObserverEvidence;
      await vi.waitFor(() => {
        let alive = true;
        try {
          process.kill(child.pid!, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          alive = false;
        }
        expect(alive).toBe(false);
      }, { timeout: 5_000 });
      return evidence;
    },
  };
}

function expectObservedSingleHiddenLaunch(
  evidence: WindowsLauncherObserverEvidence,
  options: { launcherPid: number; ownerPid?: number },
): void {
  expect(evidence.seenLaunchers).toEqual([
    expect.objectContaining({ name: "powershell.exe", pid: options.launcherPid }),
  ]);
  expect(evidence.samples.some((sample) =>
    sample.launchers.some((process) => process.pid === options.launcherPid))).toBe(true);
  const uniqueDescendants = new Map<number, WindowsLauncherObserverProcess>();
  for (const sample of evidence.samples) {
    for (const descendant of sample.descendants) {
      uniqueDescendants.set(descendant.pid, descendant);
    }
  }
  if (options.ownerPid) {
    expect(evidence.samples.some((sample) =>
      sample.descendants.some((process) =>
        process.name === "node.exe" &&
        process.pid === options.ownerPid &&
        process.parentPid === options.launcherPid))).toBe(true);
    expect([...uniqueDescendants.values()].filter((process) =>
      process.name === "node.exe")).toEqual([{
        name: "node.exe",
        pid: options.ownerPid,
        parentPid: options.launcherPid,
      }]);
  } else {
    expect([...uniqueDescendants.values()].filter((process) =>
      process.name === "node.exe")).toEqual([]);
  }
  for (const sample of evidence.samples) {
    expect(sample.descendants.filter((process) =>
      process.name === "powershell.exe" || process.name === "pwsh.exe")).toEqual([]);
    expect(sample.descendants.filter((process) =>
      process.name === "WindowsTerminal.exe" || process.name === "OpenConsole.exe")).toEqual([]);
    expect(sample.observerConsoleHelpers).toEqual([]);
  }
  expect(evidence.final.launchers).toEqual([]);
  expect(evidence.final.descendants).toEqual([]);
  expect(evidence.final.observerConsoleHelpers).toEqual([]);
}

function readWindowsFixtureProcessSnapshot(options: {
  entryPath: string;
  launcherPid: number;
  launcherToken?: string;
  ownerPid?: number;
}): WindowsFixtureProcessSnapshot {
  if (options.launcherPid > 0 && !options.launcherToken) {
    throw new Error("launcher token is required for a nonzero launcher PID");
  }
  const powershellPath = join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$launcherPid = [int]$env:MEANTHIS_FIXTURE_LAUNCHER_PID",
    "$ownerPid = [int]$env:MEANTHIS_FIXTURE_OWNER_PID",
    "$entryPath = $env:MEANTHIS_FIXTURE_ENTRY_PATH",
    "$processes = @(Get-CimInstance Win32_Process)",
    "$snapshot = [pscustomobject]@{",
    "  launcherCandidates = @($processes | Where-Object { $launcherPid -gt 0 -and $_.ProcessId -eq $launcherPid } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; executablePath = if ($null -eq $_.ExecutablePath) { $null } else { [string]$_.ExecutablePath }; commandLine = if ($null -eq $_.CommandLine) { $null } else { [string]$_.CommandLine } } })",
    "  owner = @($processes | Where-Object { $_.Name -eq 'node.exe' -and $null -ne $_.CommandLine -and $_.CommandLine.Contains($entryPath) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId } })",
    "  attributableConsoleHelpers = @($processes | Where-Object { ($_.Name -eq 'WindowsTerminal.exe' -or $_.Name -eq 'OpenConsole.exe') -and (($launcherPid -gt 0 -and $_.ParentProcessId -eq $launcherPid) -or ($ownerPid -gt 0 -and $_.ParentProcessId -eq $ownerPid)) } | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId } })",
    "}",
    "$snapshot | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const result = spawnSync(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      MEANTHIS_FIXTURE_ENTRY_PATH: options.entryPath,
      MEANTHIS_FIXTURE_LAUNCHER_PID: String(options.launcherPid),
      MEANTHIS_FIXTURE_OWNER_PID: String(options.ownerPid ?? 0),
    },
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`process snapshot failed with ${result.status}`);
  }
  const raw = JSON.parse(result.stdout) as WindowsFixtureProcessSnapshotRaw;
  const launcherCandidates = Array.isArray(raw.launcherCandidates)
    ? raw.launcherCandidates.map((candidate) => ({
        pid: candidate.pid,
        parentPid: candidate.parentPid,
        name: typeof candidate.name === "string" ? candidate.name : "",
        executablePath: typeof candidate.executablePath === "string"
          ? candidate.executablePath
          : null,
        commandLine: typeof candidate.commandLine === "string"
          ? candidate.commandLine
          : null,
      }))
    : [];
  const expectedLauncher = {
    pid: options.launcherPid,
    executablePath: powershellPath,
    launchToken: options.launcherToken ?? "",
  };
  const launcherMatches = launcherCandidates.filter((candidate) => {
    const match = matchWindowsLauncherIdentity(candidate, expectedLauncher);
    if (match === "unknown") {
      throw new Error("launcher identity is unknown; missing process identity cannot be ignored");
    }
    return match === "match";
  });
  const launcherIdentity: WindowsFixtureProcessSnapshot["launcherIdentity"] =
    launcherCandidates.length === 0
      ? "absent"
      : launcherMatches.length > 0
        ? "match"
        : "mismatch";
  return {
    launcherIdentity,
    launcher: launcherMatches.map(({ pid, parentPid }) => ({ pid, parentPid })),
    owner: raw.owner,
    attributableConsoleHelpers: raw.attributableConsoleHelpers,
  };
}

async function expectFileAbsent(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeOptionalLauncherEvidence(
  section: "success" | "timeout" | "failure",
  evidence: Record<string, unknown>,
): Promise<void> {
  const evidencePath = process.env.MEANTHIS_OWNER_LAUNCHER_EVIDENCE_PATH;
  if (!evidencePath) return;
  let existing: Record<string, unknown> = {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-owner-launcher-evidence",
  };
  try {
    existing = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    ...existing,
    [section]: evidence,
  }, null, 2)}\n`, "utf8");
}

const fetchWithConnectionClose: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
};

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe("detached local bridge owner startup", () => {
  test("persists only the bounded lifecycle event needed to diagnose an external termination", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-owner-diagnostic-"));
    try {
      const report = createLocalBridgeOwnerLifecycleReporter(codexHome);
      await report({
        owner: "browser",
        event: "heartbeat",
        pid: 1234,
        port: 38471,
        at: "2026-08-22T07:30:00.000Z",
        uptimeMs: 30_000,
      });

      const path = getLocalBridgeOwnerLifecycleDiagnosticPath("browser", codexHome);
      expect(dirname(path)).toBe(join(codexHome, "ui-attach", "diagnostics"));
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        owner: "browser",
        event: "heartbeat",
        pid: 1234,
        port: 38471,
        at: "2026-08-22T07:30:00.000Z",
        uptimeMs: 30_000,
      });
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("coalesces lifecycle backlog and preserves a queued close event", async () => {
    let releaseFirst!: () => void;
    const observed: string[] = [];
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const report = createLocalBridgeOwnerLifecycleReporter(join(tmpdir(), "unused"), {
      persist: async (event) => {
        observed.push(`${event.event}:${event.reason ?? "none"}`);
        if (observed.length === 1) await firstWrite;
      },
    });
    const base = {
      owner: "browser" as const,
      pid: 1234,
      port: 38471,
      at: "2026-08-22T07:30:00.000Z",
      uptimeMs: 30_000,
    };

    const running = report({ ...base, event: "heartbeat" });
    void report({ ...base, event: "heartbeat", uptimeMs: 60_000 });
    void report({ ...base, event: "close", reason: "signal", uptimeMs: 61_000 });
    void report({ ...base, event: "heartbeat", uptimeMs: 62_000 });
    releaseFirst();
    await running;

    expect(observed).toEqual(["heartbeat:none", "close:signal"]);
  });

  test("removes a temporary lifecycle file when atomic replacement fails", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "meanthis-owner-diagnostic-failure-"));
    try {
      const path = getLocalBridgeOwnerLifecycleDiagnosticPath("browser", codexHome);
      await mkdir(path, { recursive: true });
      const report = createLocalBridgeOwnerLifecycleReporter(codexHome);
      await report({
        owner: "browser",
        event: "heartbeat",
        pid: 1234,
        port: 38471,
        at: "2026-08-22T07:30:00.000Z",
        uptimeMs: 30_000,
      });

      expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("starts the detached owner without inheriting an ambient MCP bearer", () => {
    const parentEnvironment = {
      ...process.env,
      SystemRoot: WINDOWS_FIXTURE_SYSTEM_ROOT,
      [MEANTHIS_MCP_HTTP_TOKEN_ENV]: AGENT_TOKEN,
      mEaNtHiS_mCp_HtTp_ToKeN: ROTATED_AGENT_TOKEN,
      MEANTHIS_OWNER_TEST_SENTINEL: "preserved",
    };
    const launch = createDetachedLocalBridgeOwnerSpawn(parentEnvironment, "win32");
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
    expect(powerShellScript).toContain("bridge-owner");
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
    expect(parentEnvironment[MEANTHIS_MCP_HTTP_TOKEN_ENV]).toBe(AGENT_TOKEN);
    expect(parentEnvironment.mEaNtHiS_mCp_HtTp_ToKeN).toBe(ROTATED_AGENT_TOKEN);
    expect(JSON.stringify(launch)).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(launch)).not.toContain(ROTATED_AGENT_TOKEN);
  });

  test.runIf(process.platform === "win32")(
    "launches a hidden detached Node fixture without an intermediate PowerShell process",
    { tags: ["platform"], timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "meanthis owner's launcher "));
      const dist = join(root, "fixture dist");
      await mkdir(dist, { recursive: true });
      const entryPath = join(dist, "fixture entry.cjs");
      const receiptPath = join(root, "receipt.json");
      const releasePath = join(root, "release-owner");
      const randomPort = await reserveRandomLocalPort();
      let launchedPid = 0;
      let launchedParentPid = 0;
      let observer: WindowsLauncherObserverHandle | undefined;
      try {
        await writeFile(entryPath, [
          'const { existsSync, writeFileSync } = require("node:fs");',
          'const { createServer } = require("node:net");',
          'const server = createServer();',
          'server.listen(Number(process.env.MEANTHIS_LAUNCHER_PORT), "127.0.0.1", () => {',
          '  writeFileSync(process.env.MEANTHIS_LAUNCHER_RECEIPT, JSON.stringify({ pid: process.pid, parentPid: process.ppid, port: server.address().port, args: process.argv.slice(2) }));',
          '  const timer = setInterval(() => {',
          '    if (!existsSync(process.env.MEANTHIS_LAUNCHER_RELEASE)) return;',
          '    clearInterval(timer);',
          '    server.close();',
          '  }, 10);',
          '});',
        ].join("\n"));
        const before = readWindowsFixtureProcessSnapshot({
          entryPath,
          launcherPid: 0,
        });
        expect(before.owner).toEqual([]);
        const launch = createDetachedLocalBridgeProcessSpawn(
          entryPath,
          "bridge-owner",
          {
            ...process.env,
            MEANTHIS_LAUNCHER_PORT: String(randomPort),
            MEANTHIS_LAUNCHER_RECEIPT: receiptPath,
            MEANTHIS_LAUNCHER_RELEASE: releasePath,
          },
          "win32",
        );
        expect(launch.options.cwd).toBe(root);
        expect(launch.options.cwd).toContain(" ");
        expect(launch.options.cwd).toContain("'");
        expect(entryPath).toContain(" ");
        expect(entryPath).toContain("'");
        const encodedCommand = launch.args.at(-1);
        expect(typeof encodedCommand).toBe("string");
        const powerShellScript = Buffer.from(encodedCommand as string, "base64").toString("utf16le");
        const observedScript = `${powerShellScript}\nStart-Sleep -Milliseconds 800`;
        const observedEncodedCommand = Buffer.from(observedScript, "utf16le").toString("base64");
        const observedArgs = [...launch.args.slice(0, -1), observedEncodedCommand];
        observer = await startWindowsLauncherObserver({
          root,
          targetEncodedCommand: observedEncodedCommand,
        });
        const result = spawnSync(launch.command, observedArgs, {
          cwd: launch.options.cwd,
          shell: launch.options.shell,
          stdio: launch.options.stdio,
          windowsHide: launch.options.windowsHide,
          env: launch.options.env,
          timeout: 15_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.pid).toBeGreaterThan(0);
        let launchedPort = 0;
        await vi.waitFor(async () => {
          const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
            pid: number;
            parentPid: number;
            port: number;
            args: string[];
          };
          expect(receipt.pid).toBeGreaterThan(0);
          expect(receipt.parentPid).toBe(result.pid);
          expect(receipt.port).toBeGreaterThan(0);
          expect(receipt.port).not.toBe(38_471);
          expect(receipt.port).not.toBe(38_472);
          expect(receipt.args).toEqual(["bridge-owner"]);
          launchedPid = receipt.pid;
          launchedParentPid = receipt.parentPid;
          launchedPort = receipt.port;
        }, { timeout: 5_000 });
        expect(launchedPort).toBeGreaterThan(0);
        expect(await isOriginPortAvailable(`http://127.0.0.1:${launchedPort}`)).toBe(false);
        const during = readWindowsFixtureProcessSnapshot({
          entryPath,
          launcherPid: result.pid,
          launcherToken: observedEncodedCommand,
          ownerPid: launchedPid,
        });
        expect(during.launcher).toEqual([]);
        expect(during.owner).toEqual([{
          pid: launchedPid,
          parentPid: result.pid,
        }]);
        expect(during.attributableConsoleHelpers).toEqual([]);
        await writeFile(releasePath, "release\n", "utf8");
        await vi.waitFor(() => {
          let alive = true;
          try {
            process.kill(launchedPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            alive = false;
          }
          expect(alive).toBe(false);
        }, { timeout: 5_000 });
        await vi.waitFor(async () => {
          expect(await isOriginPortAvailable(`http://127.0.0.1:${launchedPort}`)).toBe(true);
        }, { timeout: 5_000 });
        const after = readWindowsFixtureProcessSnapshot({
          entryPath,
          launcherPid: result.pid,
          launcherToken: observedEncodedCommand,
          ownerPid: launchedPid,
        });
        expect(after.launcher).toEqual([]);
        expect(after.owner).toEqual([]);
        expect(after.attributableConsoleHelpers).toEqual([]);
        const externalObserver = await observer.stop();
        expectObservedSingleHiddenLaunch(externalObserver, {
          launcherPid: result.pid,
          ownerPid: launchedPid,
        });
        await writeOptionalLauncherEvidence("success", {
          pathProfile: {
              entryHasApostrophe: entryPath.includes("'"),
              entryHasSpace: entryPath.includes(" "),
              workingDirectoryHasApostrophe: launch.options.cwd.includes("'"),
              workingDirectoryHasSpace: launch.options.cwd.includes(" "),
          },
          randomPort: {
            isFixedProductionPort: launchedPort === 38_471 || launchedPort === 38_472,
            port: launchedPort,
          },
          directAncestry: {
            launcherPid: result.pid,
            ownerParentPid: launchedParentPid,
            ownerPid: launchedPid,
          },
          snapshots: { before, during, after },
          externalObserver,
          cleanup: {
            listenerReleased: true,
            ownerProcessReleased: after.owner.length === 0,
          },
        });
      } finally {
        await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
        if (launchedPid > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await observer?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform === "win32")(
    "does not launch a late owner after the hidden PowerShell launcher times out",
    { tags: ["platform"], timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "meanthis owner's timeout "));
      const dist = join(root, "fixture dist");
      await mkdir(dist, { recursive: true });
      const entryPath = join(dist, "fixture entry.cjs");
      const receiptPath = join(root, "receipt.json");
      const releasePath = join(root, "release-owner");
      const randomPort = await reserveRandomLocalPort();
      let observer: WindowsLauncherObserverHandle | undefined;
      try {
        await writeFile(entryPath, [
          'const { existsSync, writeFileSync } = require("node:fs");',
          'const { createServer } = require("node:net");',
          'const server = createServer();',
          'server.listen(Number(process.env.MEANTHIS_LAUNCHER_PORT), "127.0.0.1", () => {',
          '  writeFileSync(process.env.MEANTHIS_LAUNCHER_RECEIPT, JSON.stringify({ pid: process.pid, port: server.address().port }));',
          '  const timer = setInterval(() => {',
          '    if (!existsSync(process.env.MEANTHIS_LAUNCHER_RELEASE)) return;',
          '    clearInterval(timer);',
          '    server.close();',
          '  }, 10);',
          '  setTimeout(() => { clearInterval(timer); server.close(); }, 2000);',
          '});',
        ].join("\n"));
        const launch = createDetachedLocalBridgeProcessSpawn(
          entryPath,
          "bridge-owner",
          {
            ...process.env,
            MEANTHIS_LAUNCHER_PORT: String(randomPort),
            MEANTHIS_LAUNCHER_RECEIPT: receiptPath,
            MEANTHIS_LAUNCHER_RELEASE: releasePath,
          },
          "win32",
        );
        const encodedCommand = launch.args.at(-1);
        expect(typeof encodedCommand).toBe("string");
        const powerShellScript = Buffer.from(encodedCommand as string, "base64").toString("utf16le");
        const delayedScript = `Start-Sleep -Milliseconds 2000\n${powerShellScript}`;
        const delayedEncodedCommand = Buffer.from(delayedScript, "utf16le").toString("base64");
        observer = await startWindowsLauncherObserver({
          root,
          targetEncodedCommand: delayedEncodedCommand,
        });
        const result = spawnSync(launch.command, [
          ...launch.args.slice(0, -1),
          delayedEncodedCommand,
        ], {
          cwd: launch.options.cwd,
          shell: launch.options.shell,
          stdio: launch.options.stdio,
          windowsHide: launch.options.windowsHide,
          env: launch.options.env,
          timeout: 800,
        });

        expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
        expect(result.pid).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        await expectFileAbsent(receiptPath);
        expect(await isOriginPortAvailable(`http://127.0.0.1:${randomPort}`)).toBe(true);
        const after = readWindowsFixtureProcessSnapshot({
          entryPath,
          launcherPid: result.pid,
          launcherToken: delayedEncodedCommand,
        });
        expect(after.launcher).toEqual([]);
        expect(after.owner).toEqual([]);
        expect(after.attributableConsoleHelpers).toEqual([]);
        const externalObserver = await observer.stop();
        expectObservedSingleHiddenLaunch(externalObserver, {
          launcherPid: result.pid,
        });
        await writeOptionalLauncherEvidence("timeout", {
          failureBoundaryMs: 800,
          waitedAfterBoundaryMs: 2_200,
          launcherErrorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
          launcherPid: result.pid,
          randomPort,
          receiptAbsent: true,
          listenerAbsent: true,
          snapshot: after,
          externalObserver,
        });
      } finally {
        await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await observer?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform === "win32")(
    "does not launch a late owner after Start-Process fails",
    { tags: ["platform"], timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "meanthis owner's failure "));
      const dist = join(root, "fixture dist");
      await mkdir(dist, { recursive: true });
      const entryPath = join(dist, "fixture entry.cjs");
      const receiptPath = join(root, "receipt.json");
      const randomPort = await reserveRandomLocalPort();
      let observer: WindowsLauncherObserverHandle | undefined;
      try {
        await writeFile(entryPath, "throw new Error('must not run');\n");
        const launch = createDetachedLocalBridgeProcessSpawn(
          entryPath,
          "bridge-owner",
          {
            ...process.env,
            MEANTHIS_LAUNCHER_PORT: String(randomPort),
            MEANTHIS_LAUNCHER_RECEIPT: receiptPath,
          },
          "win32",
        );
        const encodedCommand = launch.args.at(-1);
        expect(typeof encodedCommand).toBe("string");
        const powerShellScript = Buffer.from(encodedCommand as string, "base64").toString("utf16le");
        const missingExecutable = join(root, "missing node.exe");
        const failingScript = powerShellScript.replace(
          /^\$nodePath = .*$/m,
          `$nodePath = '${missingExecutable.replaceAll("'", "''")}'`,
        );
        expect(failingScript).not.toBe(powerShellScript);
        const observedFailingScript = `Start-Sleep -Milliseconds 800\n${failingScript}`;
        const observedFailingEncodedCommand = Buffer.from(observedFailingScript, "utf16le").toString("base64");
        observer = await startWindowsLauncherObserver({
          root,
          targetEncodedCommand: observedFailingEncodedCommand,
        });
        const result = spawnSync(launch.command, [
          ...launch.args.slice(0, -1),
          observedFailingEncodedCommand,
        ], {
          cwd: launch.options.cwd,
          shell: launch.options.shell,
          stdio: launch.options.stdio,
          windowsHide: launch.options.windowsHide,
          env: launch.options.env,
          timeout: 15_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.pid).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await expectFileAbsent(receiptPath);
        expect(await isOriginPortAvailable(`http://127.0.0.1:${randomPort}`)).toBe(true);
        const after = readWindowsFixtureProcessSnapshot({
          entryPath,
          launcherPid: result.pid,
          launcherToken: observedFailingEncodedCommand,
        });
        expect(after.launcher).toEqual([]);
        expect(after.owner).toEqual([]);
        expect(after.attributableConsoleHelpers).toEqual([]);
        const externalObserver = await observer.stop();
        expectObservedSingleHiddenLaunch(externalObserver, {
          launcherPid: result.pid,
        });
        await writeOptionalLauncherEvidence("failure", {
          launcherExitStatus: result.status,
          launcherPid: result.pid,
          randomPort,
          receiptAbsent: true,
          listenerAbsent: true,
          snapshot: after,
          externalObserver,
        });
      } finally {
        await observer?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("keeps the direct detached Node launch outside Windows", () => {
    const launch = createDetachedLocalBridgeOwnerSpawn(process.env, "linux");

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([expect.stringMatching(/index\.js$/), "bridge-owner"]);
    expect(launch.options.cwd).toBe(dirname(dirname(launch.args[0])));
  });

  test("reuses an authenticated owner with the same build and agent credential", async () => {
    const probe = vi.fn(async () => undefined);
    const spawnOwner = vi.fn();
    const wait = vi.fn(async () => undefined);
    const desiredIdentity = desiredIdentityDependencies();

    await ensureLocalBridgeOwner({
      probe,
      spawnOwner,
      wait,
      ...desiredIdentity,
    }, { agentToken: AGENT_TOKEN, expectedIdentity: OWNER_IDENTITY });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawnOwner).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(desiredIdentity.publishDesiredIdentity).not.toHaveBeenCalled();
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
      { probe, spawnOwner, wait, ...desiredIdentityDependencies() },
      {
        agentToken: AGENT_TOKEN,
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 100,
        staleStartupTimeoutMs: 100,
        delayMs: 10,
        now: () => now,
      },
    );

    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  test("starts a fresh full readiness window after a slow owner launcher resolves", async () => {
    let now = 0;
    let spawned = false;
    const probe = vi.fn(async () => {
      if (spawned && now >= 150) return;
      throw new Error("owner is still starting");
    });
    const spawnOwner = vi.fn(async () => {
      now = 150;
      spawned = true;
    });

    await ensureLocalBridgeOwner(
      {
        probe,
        spawnOwner,
        wait: vi.fn(async (delayMs: number) => { now += delayMs; }),
        ...desiredIdentityDependencies(),
      },
      {
        agentToken: AGENT_TOKEN,
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 100,
        staleStartupTimeoutMs: 100,
        delayMs: 10,
        now: () => now,
      },
    );

    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(now).toBe(160);
  });

  test("fails closed after bounded authenticated probes", async () => {
    const probe = vi.fn(async () => { throw new Error("foreign or unavailable"); });
    const spawnOwner = vi.fn();
    let now = 0;
    const wait = vi.fn(async (delayMs: number) => { now += delayMs; });

    await expect(ensureLocalBridgeOwner(
      { probe, spawnOwner, wait, ...desiredIdentityDependencies() },
      {
        agentToken: AGENT_TOKEN,
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 25,
        staleStartupTimeoutMs: 25,
        delayMs: 10,
        now: () => now,
      },
    )).rejects.toThrow("unavailable");
    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  test("waits for an authenticated stale owner to drain before spawning its replacement", async () => {
    let now = 0;
    let portChecks = 0;
    let replacementStarted = false;
    const desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
      REPLACEMENT_OWNER_IDENTITY,
      AGENT_TOKEN,
    );
    let storedDesiredIdentity = OWNER_IDENTITY_FINGERPRINT;
    const publishDesiredIdentity = vi.fn(async (identityFingerprint: string) => {
      storedDesiredIdentity = identityFingerprint;
    });
    const spawnOwner = vi.fn(() => { replacementStarted = true; });
    const probe = vi.fn(async () => {
      if (replacementStarted) return;
      throw new AuthenticatedLocalBridgeOwnerIdentityMismatchError();
    });

    await ensureLocalBridgeOwner({
      probe,
      spawnOwner,
      wait: async (delayMs) => { now += delayMs; },
      isPortAvailable: async () => {
        portChecks += 1;
        return portChecks >= 3;
      },
      publishDesiredIdentity,
      readDesiredIdentity: async () => storedDesiredIdentity,
    }, {
      agentToken: AGENT_TOKEN,
      expectedIdentity: REPLACEMENT_OWNER_IDENTITY,
      startupTimeoutMs: 100,
      staleStartupTimeoutMs: 100,
      delayMs: 10,
      now: () => now,
    });

    expect(publishDesiredIdentity).toHaveBeenCalledWith(desiredFingerprint);
    expect(spawnOwner).toHaveBeenCalledTimes(1);
    expect(portChecks).toBe(3);
  });

  test("an old credential lease cannot overwrite or probe past a rotated desired identity", async () => {
    const publishDesiredIdentity = vi.fn(async () => undefined);
    const probe = vi.fn(async () => undefined);

    await expect(ensureLocalBridgeOwner({
      probe,
      spawnOwner: vi.fn(),
      wait: vi.fn(async () => undefined),
      isPortAvailable: vi.fn(async () => true),
      publishDesiredIdentity,
      readDesiredIdentity: async () => fingerprintLocalBridgeOwnerIdentity(
        OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      ),
    }, {
      agentToken: AGENT_TOKEN,
      expectedIdentity: OWNER_IDENTITY,
      publishDesiredIdentity: false,
    })).rejects.toThrow("unavailable");

    expect(publishDesiredIdentity).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
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
      ...desiredIdentityDependencies(),
    }, {
      agentToken: AGENT_TOKEN,
      expectedIdentity: OWNER_IDENTITY,
      startupTimeoutMs: 80,
      staleStartupTimeoutMs: 80,
      delayMs: 5,
    })).rejects.toThrow("unavailable");

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

  test("binds owner identity to the protected desired-marker runtime", () => {
    let changed = false;
    const readFile = (path: string) => Buffer.from(
      path.endsWith("local-bridge-mcp-http-token.js") && changed
        ? "changed-marker-runtime"
        : `bytes:${path}`,
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

    expect(second.buildHash).not.toBe(first.buildHash);
  });

  test("binds owner identity to the native bootstrap runtime", () => {
    let changed = false;
    const readFile = (path: string) => Buffer.from(
      path.endsWith("local-bridge-native-host.js") && changed
        ? "changed-native-host-runtime"
        : `bytes:${path}`,
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

    expect(second.buildHash).not.toBe(first.buildHash);
  });

  test("binds the opaque desired fingerprint to the agent credential", () => {
    const current = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const rotated = fingerprintLocalBridgeOwnerIdentity(
      OWNER_IDENTITY,
      ROTATED_AGENT_TOKEN,
    );

    expect(current).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(current);
    expect(current).not.toContain(AGENT_TOKEN);
    expect(rotated).not.toContain(ROTATED_AGENT_TOKEN);
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

  test("drains an old build despite an active authenticated MCP owner lease", async () => {
    let origin = "";
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    let leaseRefreshes = 0;
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      desiredIdentityCheckMs: 10,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onReady: (owner) => { origin = owner.origin; },
    });
    await vi.waitFor(() => expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/));
    const reader = createHttpLocalBridgeReader(origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
    });
    const lease = startLocalBridgeOwnerLease({
      ensureOwner: async () => {
        leaseRefreshes += 1;
        await reader.getStatus();
      },
    }, { intervalMs: 2 });
    try {
      await lease.refresh();
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        AGENT_TOKEN,
      );
      await expect(run).resolves.toBeUndefined();
      expect(leaseRefreshes).toBeGreaterThan(0);
    } finally {
      lease.stop();
    }
    await expect(fetch(`${origin}/health`)).rejects.toThrow();
  });

  test("replaces a same-build owner after agent credential rotation", async () => {
    let origin = "";
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    let replacementRun: Promise<void> | undefined;
    const oldRun = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onReady: (owner) => { origin = owner.origin; },
    });
    await vi.waitFor(() => expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/));
    const oldReader = createHttpLocalBridgeReader(origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
      fetchImpl: fetchWithConnectionClose,
    });
    const replacementReader = createHttpLocalBridgeReader(origin, ROTATED_AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
      fetchImpl: fetchWithConnectionClose,
    });
    const publishDesiredIdentity = vi.fn(async (fingerprint: string) => {
      desiredFingerprint = fingerprint;
    });
    const oldLease = startLocalBridgeOwnerLease({
      ensureOwner: async () => { await oldReader.getStatus(); },
    }, { intervalMs: 2 });
    const spawnOwner = vi.fn(() => {
      replacementRun = runDetachedLocalBridgeOwner({
        agentToken: ROTATED_AGENT_TOKEN,
        port: Number(new URL(origin).port),
        ownerIdentity: OWNER_IDENTITY,
        loadOwnerIdentity: () => OWNER_IDENTITY,
        loadDesiredIdentity: async () => desiredFingerprint,
        desiredIdentityCheckMs: 5,
        idleMs: 60_000,
        idleCheckMs: 1_000,
      });
    });

    try {
      await oldLease.refresh();
      await ensureLocalBridgeOwner({
        probe: async () => { await replacementReader.getStatus(); },
        isPortAvailable: () => isOriginPortAvailable(origin),
        publishDesiredIdentity,
        readDesiredIdentity: async () => desiredFingerprint,
        spawnOwner,
        wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      }, {
        agentToken: ROTATED_AGENT_TOKEN,
        expectedIdentity: OWNER_IDENTITY,
        startupTimeoutMs: 500,
        staleStartupTimeoutMs: 500,
        delayMs: 5,
      });

      await expect(oldRun).resolves.toBeUndefined();
      expect(publishDesiredIdentity).toHaveBeenCalledWith(
        fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, ROTATED_AGENT_TOKEN),
      );
      expect(publishDesiredIdentity).not.toHaveBeenCalledWith(ROTATED_AGENT_TOKEN);
      expect(spawnOwner).toHaveBeenCalledTimes(1);
      const status = await replacementReader.getStatus();
      expect(status).toMatchObject({ kind: "ui-attach.local-bridge-status" });
      expect(JSON.stringify(status)).not.toContain(ROTATED_AGENT_TOKEN);
    } finally {
      oldLease.stop();
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await oldRun.catch(() => undefined);
      await replacementRun?.catch(() => undefined);
    }
  });

  test("fails closed when a desired identity inspection does not settle", async () => {
    let reads = 0;
    const lifecycleEvents: Array<{ event: string; reason?: string }> = [];
    const ownerFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(ownerFingerprint)
          : new Promise<string>(() => undefined);
      },
      desiredIdentityCheckMs: 5,
      desiredIdentityCheckTimeoutMs: 10,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onLifecycleEvent: (event) => { lifecycleEvents.push(event); },
    });

    await expect(run).resolves.toBeUndefined();
    expect(reads).toBe(2);
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      event: "close",
      reason: "desired_identity_check_timeout",
    }));
  });

  test("closes the listener even when lifecycle persistence never settles", async () => {
    let reads = 0;
    const ownerFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(ownerFingerprint)
          : Promise.resolve("different-owner");
      },
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onLifecycleEvent: (event) => event.event === "close"
        ? new Promise<void>(() => undefined)
        : undefined,
    });

    await expect(settlesWithin(run, 1_500)).resolves.toBe(true);
  });

  test("drains after the fast agent credential bytes are replaced", async () => {
    let origin = "";
    let currentAgentToken = AGENT_TOKEN;
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const lifecycleEvents: Array<{ event: string; reason?: string }> = [];
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => currentAgentToken,
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onReady: (owner) => { origin = owner.origin; },
      onLifecycleEvent: (event) => { lifecycleEvents.push(event); },
    });
    await vi.waitFor(() => expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/));

    try {
      currentAgentToken = ROTATED_AGENT_TOKEN;
      expect(await settlesWithin(run, 250)).toBe(true);
      expect(lifecycleEvents).toContainEqual(expect.objectContaining({
        event: "close",
        reason: "agent_token_changed",
      }));
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("drains when the fast agent credential read fails", async () => {
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => { throw new Error("credential read failed"); },
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });

    try {
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test.each([
    {
      label: "an insecure ACL",
      inspection: {
        kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
        status: "insecure",
      } as const,
    },
    {
      label: "a mismatched fingerprint",
      inspection: {
        kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
        status: "ready",
        fingerprint: fingerprintLocalBridgeAgentToken(ROTATED_AGENT_TOKEN),
      } as const,
    },
  ])("drains when slow agent credential inspection reports $label", async ({ inspection }) => {
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => AGENT_TOKEN,
      inspectAgentToken: async () => inspection,
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });

    try {
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("drains when a matching diagnostic fingerprint hides different credential bytes", async () => {
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => ROTATED_AGENT_TOKEN,
      inspectAgentToken: async () => ({
        kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
        status: "ready",
        fingerprint: AGENT_TOKEN_FINGERPRINT,
      }),
      agentTokenCheckMs: 1_000,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });

    try {
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("drains when slow agent credential inspection fails", async () => {
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => AGENT_TOKEN,
      inspectAgentToken: async () => { throw new Error("credential inspection failed"); },
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });

    try {
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("drains when slow agent credential inspection times out", async () => {
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => AGENT_TOKEN,
      inspectAgentToken: () => new Promise(() => undefined),
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 20,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });

    try {
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("lets fast rotation close while slow credential inspection is hung", async () => {
    let currentAgentToken = AGENT_TOKEN;
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    let signalSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => { signalSlowStarted = resolve; });
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => currentAgentToken,
      inspectAgentToken: () => {
        signalSlowStarted();
        return new Promise(() => undefined);
      },
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 1_000,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
    });
    await slowStarted;

    try {
      currentAgentToken = ROTATED_AGENT_TOKEN;
      expect(await settlesWithin(run, 250)).toBe(true);
    } finally {
      desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
        REPLACEMENT_OWNER_IDENTITY,
        ROTATED_AGENT_TOKEN,
      );
      await run.catch(() => undefined);
    }
  });

  test("keeps a secure matching credential alive and clears its watchers on close", async () => {
    let origin = "";
    let fastReads = 0;
    let slowInspections = 0;
    let desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(OWNER_IDENTITY, AGENT_TOKEN);
    const run = runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      loadOwnerIdentity: () => OWNER_IDENTITY,
      loadDesiredIdentity: async () => desiredFingerprint,
      readAgentToken: async () => {
        fastReads += 1;
        return AGENT_TOKEN;
      },
      inspectAgentToken: async () => {
        slowInspections += 1;
        return {
          kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND,
          status: "ready",
          fingerprint: AGENT_TOKEN_FINGERPRINT,
        };
      },
      agentTokenCheckMs: 5,
      agentTokenCheckTimeoutMs: 50,
      agentTokenInspectionMs: 5,
      agentTokenInspectionTimeoutMs: 50,
      desiredIdentityCheckMs: 5,
      idleMs: 60_000,
      idleCheckMs: 1_000,
      onReady: (owner) => { origin = owner.origin; },
    });
    await vi.waitFor(() => expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/));
    await vi.waitFor(() => {
      expect(fastReads).toBeGreaterThan(1);
      expect(slowInspections).toBeGreaterThan(1);
    });
    const reader = createHttpLocalBridgeReader(origin, AGENT_TOKEN, {
      expectedOwnerIdentity: OWNER_IDENTITY,
      fetchImpl: fetchWithConnectionClose,
    });
    await expect(reader.getStatus()).resolves.toMatchObject({
      kind: "ui-attach.local-bridge-status",
    });

    desiredFingerprint = fingerprintLocalBridgeOwnerIdentity(
      REPLACEMENT_OWNER_IDENTITY,
      ROTATED_AGENT_TOKEN,
    );
    await expect(run).resolves.toBeUndefined();
    const readsAfterClose = fastReads;
    const inspectionsAfterClose = slowInspections;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fastReads).toBe(readsAfterClose);
    expect(slowInspections).toBe(inspectionsAfterClose);
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

  test("rejects a production slow credential inspection interval below thirty seconds", async () => {
    await expect(runDetachedLocalBridgeOwner({
      agentToken: AGENT_TOKEN,
      port: 0,
      ownerIdentity: OWNER_IDENTITY,
      agentTokenInspectionMs: 29_999,
    })).rejects.toThrow("credential inspection interval");
  });
});
