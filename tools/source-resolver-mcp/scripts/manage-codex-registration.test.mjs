import { describe, expect, test, vi } from "vitest";
import { runSourceResolverCodexCli } from "./manage-codex-registration.mjs";

const NODE_PATH = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY_PATH = "C:\\fixtures\\meanthis\\tools\\source-resolver-mcp\\dist\\cli.js";
const REGISTRATION_NAME = "meanthis-source-resolver";

describe("standalone source resolver Codex registration manager", () => {
  test("reports a missing registration without mutating Codex config", async () => {
    const harness = createHarness();

    const exitCode = await runSourceResolverCodexCli(
      ["doctor", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      schemaVersion: "0.1.0",
      kind: "meanthis.source-resolver-codex-doctor",
      ok: true,
      data: {
        ready: false,
        registrationName: REGISTRATION_NAME,
        checks: {
          entry: { status: "pass" },
          codexCli: { status: "pass" },
          registration: { status: "missing" },
        },
      },
    });
    expect(harness.runCodex).toHaveBeenCalledExactlyOnceWith([
      "mcp",
      "get",
      REGISTRATION_NAME,
      "--json",
    ]);
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
  });

  test("previews the exact absolute registration without writing", async () => {
    const harness = createHarness();

    const exitCode = await runSourceResolverCodexCli(
      ["install", "--codex", "--dry-run", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "meanthis.source-resolver-codex-install",
      ok: true,
      data: {
        action: "add",
        changed: false,
        dryRun: true,
        configBackup: null,
        registrationName: REGISTRATION_NAME,
        command: { executable: NODE_PATH, args: [ENTRY_PATH] },
      },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
  });

  test("installs once, verifies readback, and treats an exact registration as idempotent", async () => {
    const harness = createHarness();

    expect(await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp",
      "add",
      REGISTRATION_NAME,
      "--",
      NODE_PATH,
      ENTRY_PATH,
    ]);
    expect(harness.backupCodexConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: {
        action: "add",
        changed: true,
        dryRun: false,
        configBackup: { status: "created" },
      },
    });

    harness.io.reset();
    harness.runCodex.mockClear();
    harness.backupCodexConfig.mockClear();
    expect(await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      data: { action: "none", changed: false, configBackup: null },
    });
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
  });

  test("fails closed on a same-name registration owned by another checkout", async () => {
    const harness = createHarness({
      registration: createRegistration("C:\\other\\checkout\\dist\\cli.js"),
    });

    const exitCode = await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(5);
    expect(harness.io.stdout).toBe("");
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      kind: "meanthis.error",
      ok: false,
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.io.stderr).not.toContain("C:\\other");
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
  });

  test.each([
    { enabled_tools: ["another_tool"] },
    { disabled_tools: ["ui_attach_resolve_source"] },
  ])("treats incompatible tool policy as registration drift", async (policy) => {
    const harness = createHarness({
      registration: { ...createRegistration(ENTRY_PATH), ...policy },
    });

    expect(await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
    expect(harness.runCodex).toHaveBeenCalledTimes(1);
  });

  test("treats forwarded environment variables as registration drift", async () => {
    const registration = createRegistration(ENTRY_PATH);
    registration.transport.env_vars = ["LOCAL_TOKEN"];
    const harness = createHarness({ registration });

    expect(await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(5);
    expect(JSON.parse(harness.io.stderr)).toMatchObject({
      error: { code: "REGISTRATION_CONFLICT" },
    });
    expect(harness.backupCodexConfig).not.toHaveBeenCalled();
  });

  test("removes only the exact registration managed by this checkout", async () => {
    const harness = createHarness({ registration: createRegistration(ENTRY_PATH) });

    expect(await runSourceResolverCodexCli(
      ["uninstall", "--codex", "--json"],
      harness.io,
      harness.dependencies,
    )).toBe(0);
    expect(harness.runCodex).toHaveBeenCalledWith([
      "mcp",
      "remove",
      REGISTRATION_NAME,
    ]);
    expect(harness.backupCodexConfig).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.io.stdout)).toMatchObject({
      kind: "meanthis.source-resolver-codex-uninstall",
      data: { action: "remove", changed: true },
    });
  });

  test("fails before mutation when config backup fails", async () => {
    const harness = createHarness({ backupError: true });

    expect(await runSourceResolverCodexCli(
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

  test("rejects unsafe arguments and a missing built entry before reading Codex", async () => {
    const invalid = createHarness();
    expect(await runSourceResolverCodexCli(
      ["install", "--json"],
      invalid.io,
      invalid.dependencies,
    )).toBe(2);
    expect(JSON.parse(invalid.io.stderr)).toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(invalid.runCodex).not.toHaveBeenCalled();

    const missing = createHarness({ entryExists: false });
    expect(await runSourceResolverCodexCli(
      ["install", "--codex", "--json"],
      missing.io,
      missing.dependencies,
    )).toBe(5);
    expect(JSON.parse(missing.io.stderr)).toMatchObject({
      error: { code: "RESOLVER_NOT_BUILT" },
    });
    expect(missing.runCodex).not.toHaveBeenCalled();
  });
});

function createHarness(options = {}) {
  let registration = options.registration ?? null;
  const io = createTestIo();
  const backupCodexConfig = vi.fn(async () => {
    if (options.backupError) throw new Error("backup failed");
    return {
      status: "created",
      path: "C:\\Users\\fixture-user\\.codex\\config.toml.bak-meanthis-source-resolver-test",
    };
  });
  const runCodex = vi.fn(async (args) => {
    if (args.join(" ") === `mcp get ${REGISTRATION_NAME} --json`) {
      return registration
        ? { started: true, exitCode: 0, stdout: `${JSON.stringify(registration)}\n`, stderr: "" }
        : {
            started: true,
            exitCode: 1,
            stdout: "",
            stderr: `Error: No MCP server named '${REGISTRATION_NAME}' found.\n`,
          };
    }
    if (args.slice(0, 3).join(" ") === `mcp add ${REGISTRATION_NAME}`) {
      registration = createRegistration(ENTRY_PATH);
      return { started: true, exitCode: 0, stdout: "Added global MCP server.\n", stderr: "" };
    }
    if (args.join(" ") === `mcp remove ${REGISTRATION_NAME}`) {
      registration = null;
      return { started: true, exitCode: 0, stdout: "Removed global MCP server.\n", stderr: "" };
    }
    return { started: true, exitCode: 1, stdout: "", stderr: "Unexpected command.\n" };
  });
  return {
    backupCodexConfig,
    dependencies: {
      nodePath: NODE_PATH,
      entryPath: ENTRY_PATH,
      pathExists: vi.fn(async () => options.entryExists !== false),
      backupCodexConfig,
      runCodex,
    },
    io,
    runCodex,
  };
}

function createRegistration(entryPath) {
  return {
    name: REGISTRATION_NAME,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: NODE_PATH,
      args: [entryPath],
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "unsupported",
  };
}

function createTestIo() {
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
