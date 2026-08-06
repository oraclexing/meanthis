import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  runBridgeCli,
  type BridgeCliDependencies,
  type BridgeCliIo,
  type CodexProcessResult,
} from "./bridge-cli";

const NODE_PATH = resolve("fixtures", "MeanThis path & (test)", "node executable");
const ENTRY_PATH = resolve("fixtures", "MeanThis 路径 & (test)", "dist", "index.js");
const APPROVAL_KEY = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";

describe("meanthis bridge CLI", () => {
  test("approves one browser-created connection request without exposing credentials", async () => {
    const harness = createHarness();
    const requestId = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";

    const exitCode = await runBridgeCli(
      [
        "approve",
        "--request",
        requestId,
        "--mode",
        "ask",
        "--key",
        APPROVAL_KEY,
        "--json",
      ],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.approveConnectionRequest).toHaveBeenCalledWith(requestId, "ask", APPROVAL_KEY);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-connection-approved",
      ok: true,
      data: {
        requestId,
        approvalMode: "ask",
        expiresAt: "2026-07-17T04:32:00.000Z",
      },
    });
    expect(harness.io.stdout).not.toMatch(/token|requestSecret/);
  });

  test("reports missing setup without failing doctor or reading unrelated MCP configs", async () => {
    const harness = createHarness();

    const exitCode = await runBridgeCli(["doctor", "--json"], harness.io, harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.io.stderr).toBe("");
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-doctor",
      ok: true,
      data: {
        registrationReady: false,
        runtimeActive: false,
        checks: {
          cliBuilt: { status: "pass" },
          codexCli: { status: "pass" },
          registration: { status: "missing" },
          loopback: { status: "not_running" },
        },
      },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "get", "ui-attach", "--json"]);
    expect(harness.io.stdout).not.toContain("token");
  });

  test("previews an exact Codex registration without writing it", async () => {
    const harness = createHarness();

    const exitCode = await runBridgeCli(
      ["install", "--codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-install",
      ok: true,
      data: {
        action: "add",
        changed: false,
        dryRun: true,
        configBackup: null,
        registrationName: "ui-attach",
        command: { executable: NODE_PATH, args: [ENTRY_PATH, "mcp"] },
      },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
  });

  test("generates a host configuration from the shared MCP descriptor", async () => {
    const harness = createHarness();

    const exitCode = await runBridgeCli(
      ["config", "--host", "cursor", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-config",
      ok: true,
      data: {
        descriptor: {
          name: "ui-attach",
          transport: {
            type: "stdio",
            command: NODE_PATH,
            args: [ENTRY_PATH, "mcp"],
            env: null,
            cwd: null,
          },
        },
        setup: {
          host: "cursor",
          installation: "generated_only",
          verification: "manual_required",
          artifact: "config",
          command: null,
          config: {
            mcpServers: {
              "ui-attach": {
                command: NODE_PATH,
                args: [ENTRY_PATH, "mcp"],
              },
            },
          },
          configPath: "~/.cursor/mcp.json",
        },
      },
    });
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("accepts the explicit Codex host while retaining --codex compatibility", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(
      ["install", "--host", "codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    const explicitHostOutput = JSON.parse(harness.io.stdout);
    harness.io.reset();
    harness.runCodex.mockClear();
    expect(await runBridgeCli(
      ["install", "--codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toEqual(explicitHostOutput);
  });

  test.each([
    ["install", "claude-code"],
    ["uninstall", "claude-code"],
    ["install", "vscode"],
    ["uninstall", "vscode"],
    ["install", "cursor"],
    ["uninstall", "cursor"],
  ] as const)("does not pretend to automate %s for %s", async (command, host) => {
    const harness = createHarness();

    const exitCode = await runBridgeCli(
      [command, "--host", host, "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "HOST_INSTALL_NOT_AUTOMATED" },
    });
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test.each([
    ["config", "--host", "unknown", "--json"],
    ["install", "--codex", "--host", "codex", "--json"],
    ["doctor", "--host", "cursor", "--json"],
  ])("rejects invalid host arguments before starting a process", async (...args) => {
    const harness = createHarness();

    expect(await runBridgeCli(args, harness.io, harness.dependencies)).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(harness.runCodex).not.toHaveBeenCalled();
  });

  test("installs once and treats the exact registration as idempotent", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp",
      "add",
      "ui-attach",
      "--",
      NODE_PATH,
      ENTRY_PATH,
      "mcp",
    ]);
    expect(harness.backupCodexConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "add",
        changed: true,
        dryRun: false,
        configBackup: {
          status: "created",
          path: "C:\\Users\\fixture-user\\.codex\\config.toml.bak-ui-attach-test",
        },
      },
    });

    harness.io.reset();
    harness.runCodex.mockClear();
    harness.backupCodexConfig.mockClear();
    expect(await runBridgeCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: { action: "none", changed: false, dryRun: false, configBackup: null },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
  });

  test("fails closed on a conflicting registration", async () => {
    const harness = createHarness({
      registration: createRegistration("C:\\other\\ui-attach\\dist\\index.js"),
    });

    const exitCode = await runBridgeCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(5);
    expect(harness.io.stdout).toBe("");
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      kind: "ui-attach.error",
      ok: false,
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.io.stderr).not.toContain("C:\\other");
  });

  test("removes only the exact managed registration", async () => {
    const harness = createHarness({ registration: createRegistration(ENTRY_PATH) });

    expect(await runBridgeCli(
      ["uninstall", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(harness.runCodex).toHaveBeenCalledWith(["mcp", "remove", "ui-attach"]);
    expect(harness.backupCodexConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "ui-attach.bridge-uninstall",
      ok: true,
      data: {
        action: "remove",
        changed: true,
        dryRun: false,
        configBackup: { status: "created" },
      },
    });
  });

  test("fails closed before mutation when the Codex config backup fails", async () => {
    const harness = createHarness({ backupError: true });

    expect(await runBridgeCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);

    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "CONFIG_BACKUP_FAILED" },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.runCodex).not.toHaveBeenCalledWith(expect.arrayContaining(["add"]));
  });

  test("rejects incomplete or unsafe command arguments", async () => {
    const harness = createHarness();

    expect(await runBridgeCli(["install", "--json"], harness.io, harness.dependencies)).toBe(2);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(harness.runCodex).not.toHaveBeenCalled();
  });
});

interface HarnessOptions {
  registration?: ReturnType<typeof createRegistration> | null;
  health?: "ready" | "not_running" | "unexpected";
  backupError?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  let registration = options.registration ?? null;
  const io = createTestIo();
  const backupCodexConfig = vi.fn(async () => {
    if (options.backupError) throw new Error("backup failed");
    return {
      status: "created" as const,
      path: "C:\\Users\\fixture-user\\.codex\\config.toml.bak-ui-attach-test",
    };
  });
  const runCodex = vi.fn(async (args: string[]): Promise<CodexProcessResult> => {
    if (args.join(" ") === "mcp get ui-attach --json") {
      return registration
        ? { started: true, exitCode: 0, stdout: `${JSON.stringify(registration)}\n`, stderr: "" }
        : {
            started: true,
            exitCode: 1,
            stdout: "",
            stderr: "Error: No MCP server named 'ui-attach' found.\n",
          };
    }
    if (args.slice(0, 3).join(" ") === "mcp add ui-attach") {
      registration = createRegistration(ENTRY_PATH);
      return { started: true, exitCode: 0, stdout: "Added global MCP server 'ui-attach'.\n", stderr: "" };
    }
    if (args.join(" ") === "mcp remove ui-attach") {
      registration = null;
      return { started: true, exitCode: 0, stdout: "Removed global MCP server 'ui-attach'.\n", stderr: "" };
    }
    return { started: true, exitCode: 1, stdout: "", stderr: "Unexpected command.\n" };
  });
  const approveConnectionRequest = vi.fn(async (requestId: string) => ({
    requestId,
    approvalMode: "ask" as const,
    expiresAt: "2026-07-17T04:32:00.000Z",
  }));
  const dependencies: BridgeCliDependencies = {
    nodePath: NODE_PATH,
    entryPath: ENTRY_PATH,
    pathExists: vi.fn(async () => true),
    probeLoopback: vi.fn(async () => options.health ?? "not_running"),
    backupCodexConfig,
    runCodex,
    approveConnectionRequest,
  };
  return { approveConnectionRequest, backupCodexConfig, dependencies, io, runCodex };
}

function createRegistration(entryPath: string) {
  return {
    name: "ui-attach",
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: NODE_PATH,
      args: [entryPath, "mcp"],
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "unsupported",
  };
}

function createTestIo(): BridgeCliIo & { stdout: string; stderr: string; reset(): void } {
  return {
    stdout: "",
    stderr: "",
    writeStdout(value) {
      this.stdout += value;
    },
    writeStderr(value) {
      this.stderr += value;
    },
    reset() {
      this.stdout = "";
      this.stderr = "";
    },
  };
}
