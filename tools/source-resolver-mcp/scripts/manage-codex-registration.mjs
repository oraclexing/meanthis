import { spawn } from "node:child_process";
import { access, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA_VERSION = "0.1.0";
const REGISTRATION_NAME = "meanthis-source-resolver";
const TOOL_NAME = "meanthis_resolve_source";
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_048_576;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

const defaultIo = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  writeStderr(value) {
    process.stderr.write(value);
  },
};

export async function runSourceResolverCodexCli(
  args,
  io = defaultIo,
  dependencies = createDefaultDependencies(),
) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.writeStdout(renderHelp());
    return 0;
  }

  let parsed;
  try {
    parsed = parseArguments(args);
  } catch {
    return writeError(io, 2, "INVALID_ARGUMENTS", "Invalid source resolver setup arguments.");
  }

  if (parsed.command === "doctor") return runDoctor(io, dependencies);
  if (parsed.command === "install") return runInstall(io, dependencies, parsed.dryRun);
  return runUninstall(io, dependencies, parsed.dryRun);
}

function renderHelp() {
  return [
    "MeanThis standalone source resolver Codex setup",
    "",
    "Usage:",
    "  node manage-codex-registration.mjs doctor --codex --json",
    "  node manage-codex-registration.mjs install --codex [--dry-run] --json",
    "  node manage-codex-registration.mjs uninstall --codex [--dry-run] --json",
    "",
    "The manager changes only the exact meanthis-source-resolver registration.",
    "It backs up the active Codex config before a real add or remove.",
    "",
  ].join("\n");
}

function parseArguments(args) {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      codex: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (
    parsed.positionals.length !== 1
    || !["doctor", "install", "uninstall"].includes(parsed.positionals[0])
    || parsed.values.codex !== true
  ) {
    throw new Error("Invalid command.");
  }
  if (parsed.positionals[0] === "doctor" && parsed.values["dry-run"] === true) {
    throw new Error("Doctor does not mutate state.");
  }
  return {
    command: parsed.positionals[0],
    dryRun: parsed.values["dry-run"] === true,
  };
}

async function runDoctor(io, dependencies) {
  const [entryExists, registration] = await Promise.all([
    dependencies.pathExists(dependencies.entryPath),
    readRegistration(dependencies),
  ]);
  const codexAvailable = registration.status !== "unavailable";
  return writeJson(io, {
    schemaVersion: SCHEMA_VERSION,
    kind: "meanthis.source-resolver-codex-doctor",
    ok: true,
    data: {
      ready: entryExists && registration.status === "current",
      registrationName: REGISTRATION_NAME,
      command: expectedCommand(dependencies),
      checks: {
        entry: {
          status: entryExists ? "pass" : "missing",
          next: entryExists
            ? null
            : "Run npm --workspace @meanthis/source-resolver-mcp run build.",
        },
        codexCli: {
          status: codexAvailable ? "pass" : "missing",
          next: codexAvailable ? null : "Install Codex CLI or make codex available on PATH.",
        },
        registration: {
          status: registration.status,
          next: registration.status === "missing"
            ? "Run npm run setup:codex-source-resolver."
            : registration.status === "drifted"
              ? "Resolve the existing meanthis-source-resolver registration before installing this checkout."
              : registration.status === "error"
                ? "Inspect the Codex MCP registration readback."
                : null,
        },
      },
    },
  });
}

async function runInstall(io, dependencies, dryRun) {
  if (!await dependencies.pathExists(dependencies.entryPath)) {
    return writeError(
      io,
      5,
      "RESOLVER_NOT_BUILT",
      "Build the standalone source resolver before installing its Codex registration.",
    );
  }
  const registration = await readRegistration(dependencies);
  const readError = registrationReadError(io, registration);
  if (readError !== null) return readError;
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "A different meanthis-source-resolver registration already exists.",
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
    return writeError(io, 5, "REGISTRATION_WRITE_FAILED", "Unable to add the source resolver registration.");
  }
  const verified = await readRegistration(dependencies);
  if (verified.status !== "current") {
    return writeError(io, 5, "REGISTRATION_VERIFY_FAILED", "The source resolver registration did not verify.");
  }
  return writeSetupResult(io, "install", "add", true, false, dependencies, backup);
}

async function runUninstall(io, dependencies, dryRun) {
  const registration = await readRegistration(dependencies);
  const readError = registrationReadError(io, registration);
  if (readError !== null) return readError;
  if (registration.status === "drifted") {
    return writeError(
      io,
      5,
      "REGISTRATION_CONFLICT",
      "The existing meanthis-source-resolver registration is not managed by this checkout.",
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
    return writeError(io, 5, "REGISTRATION_WRITE_FAILED", "Unable to remove the source resolver registration.");
  }
  const verified = await readRegistration(dependencies);
  if (verified.status !== "missing") {
    return writeError(io, 5, "REGISTRATION_VERIFY_FAILED", "The source resolver removal did not verify.");
  }
  return writeSetupResult(io, "uninstall", "remove", true, false, dependencies, backup);
}

function registrationReadError(io, registration) {
  if (registration.status === "unavailable") {
    return writeError(io, 5, "CODEX_CLI_UNAVAILABLE", "Codex CLI is not available.");
  }
  if (registration.status === "error") {
    return writeError(io, 5, "REGISTRATION_READ_FAILED", "Unable to read the source resolver registration.");
  }
  return null;
}

async function createConfigBackup(io, dependencies) {
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

async function readRegistration(dependencies) {
  const result = await dependencies.runCodex([
    "mcp",
    "get",
    REGISTRATION_NAME,
    "--json",
  ]);
  if (!result.started) return { status: "unavailable", registration: null };
  if (result.exitCode !== 0) {
    return /No MCP server named ['"]meanthis-source-resolver['"] found\.?/iu.test(result.stderr)
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

function parseRegistration(value) {
  try {
    const registration = JSON.parse(value);
    const transport = registration?.transport;
    if (
      !isObject(registration)
      || !isObject(transport)
      || typeof registration.name !== "string"
      || typeof registration.enabled !== "boolean"
      || transport.type !== "stdio"
      || typeof transport.command !== "string"
      || !Array.isArray(transport.args)
      || !transport.args.every((item) => typeof item === "string")
      || (transport.cwd != null && typeof transport.cwd !== "string")
      || (transport.env != null && !isStringRecord(transport.env))
      || (transport.env_vars != null && !Array.isArray(transport.env_vars))
      || (registration.enabled_tools != null && !isStringArray(registration.enabled_tools))
      || (registration.disabled_tools != null && !isStringArray(registration.disabled_tools))
    ) {
      return null;
    }
    return {
      name: registration.name,
      enabled: registration.enabled,
      enabledTools: registration.enabled_tools ?? null,
      disabledTools: registration.disabled_tools ?? null,
      transport: {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        env: isStringRecord(transport.env) ? transport.env : null,
        envVars: transport.env_vars ?? [],
        cwd: typeof transport.cwd === "string" ? transport.cwd : null,
      },
    };
  } catch {
    return null;
  }
}

function isExpectedRegistration(registration, dependencies) {
  const expected = expectedCommand(dependencies);
  return (
    registration.name === REGISTRATION_NAME
    && registration.enabled
    && samePath(registration.transport.command, expected.executable)
    && registration.transport.args.length === expected.args.length
    && registration.transport.args.every((arg, index) => samePath(arg, expected.args[index] ?? ""))
    && registration.transport.cwd === null
    && (registration.transport.env === null || Object.keys(registration.transport.env).length === 0)
    && registration.transport.envVars.length === 0
    && (registration.enabledTools === null || registration.enabledTools.includes(TOOL_NAME))
    && (registration.disabledTools === null || !registration.disabledTools.includes(TOOL_NAME))
  );
}

function expectedCommand(dependencies) {
  return {
    executable: resolve(dependencies.nodePath),
    args: [resolve(dependencies.entryPath)],
  };
}

function samePath(left, right) {
  const normalizePath = (value) => normalize(resolve(value)).replaceAll("\\", "/");
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value) {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function writeSetupResult(io, command, action, changed, dryRun, dependencies, configBackup) {
  return writeJson(io, {
    schemaVersion: SCHEMA_VERSION,
    kind: `meanthis.source-resolver-codex-${command}`,
    ok: true,
    data: {
      action,
      changed,
      dryRun,
      configBackup,
      registrationName: REGISTRATION_NAME,
      command: expectedCommand(dependencies),
      next: command === "install"
        ? "Start a fresh Codex task so MCP discovery can read the registration."
        : null,
    },
  });
}

function writeJson(io, value) {
  io.writeStdout(`${JSON.stringify(value)}\n`);
  return 0;
}

function writeError(io, exitCode, code, message) {
  io.writeStderr(`${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "meanthis.error",
    ok: false,
    error: { code, message },
  })}\n`);
  return exitCode;
}

function createDefaultDependencies() {
  let codexCommand = null;
  return {
    nodePath: process.execPath,
    entryPath: resolve(SCRIPT_DIRECTORY, "..", "dist", "cli.js"),
    pathExists,
    backupCodexConfig,
    async runCodex(args) {
      codexCommand ??= resolveCodexCommand();
      const command = await codexCommand;
      if (!command) return { started: false, exitCode: null, stdout: "", stderr: "" };
      return runProcess(command.executable, [...command.prefixArgs, ...args], PROCESS_TIMEOUT_MS);
    },
  };
}

async function backupCodexConfig() {
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  const source = join(codexHome, "config.toml");
  if (!await pathExists(source)) return { status: "not_found", path: null };
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/gu, "");
  const destination = join(
    codexHome,
    `config.toml.bak-meanthis-source-resolver-${timestamp}-${process.pid}`,
  );
  await copyFile(source, destination);
  return { status: "created", path: destination };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexCommand() {
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
    ? commands.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
    : undefined;
  return executable ? { executable, prefixArgs: [] } : null;
}

async function findCommands(name) {
  const result = await runProcess("where.exe", [name], 2_000);
  return result.started && result.exitCode === 0
    ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : [];
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") <= MAX_PROCESS_OUTPUT_BYTES ? next : null;
    };
    child.stdout.on("data", (chunk) => {
      const next = append(stdout, chunk);
      if (next === null) child.kill();
      else stdout = next;
    });
    child.stderr.on("data", (chunk) => {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSourceResolverCodexCli(process.argv.slice(2));
}
