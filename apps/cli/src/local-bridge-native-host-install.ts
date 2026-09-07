import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN,
  MEANTHIS_NATIVE_HOST_NAME,
} from "./local-bridge-native-host-contract.js";

const execFileAsync = promisify(execFile);
const MCP_BEARER_ENV = "MEANTHIS_MCP_HTTP_TOKEN";

export const MEANTHIS_NATIVE_HOST_REGISTRY_KEYS = [
  {
    browser: "chrome" as const,
    key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${MEANTHIS_NATIVE_HOST_NAME}`,
  },
  {
    browser: "edge" as const,
    key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${MEANTHIS_NATIVE_HOST_NAME}`,
  },
] as const;

export class LocalBridgeNativeHostInstallError extends Error {
  constructor(readonly code: "UNSUPPORTED_PLATFORM" | "RUNTIME_UNAVAILABLE" | "REGISTRATION_DRIFT" | "INSTALL_FAILED") {
    super("Unable to install the MeanThis local companion.");
    this.name = "LocalBridgeNativeHostInstallError";
  }
}

export interface LocalBridgeNativeHostArtifacts {
  directory: string;
  launcherPath: string;
  launcherBytes: Buffer;
  manifestPath: string;
  manifestBytes: Buffer;
}

export interface InstallLocalBridgeNativeHostOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  nodePath: string;
  entryPath: string;
  pathExists?(path: string): Promise<boolean>;
  writeExactFile?(path: string, bytes: Buffer): Promise<void>;
  ensureDirectory?(path: string): Promise<void>;
  readRegistryValue?(key: string): Promise<string | null>;
  writeRegistryValue?(key: string, value: string): Promise<void>;
  readExactFile?(path: string): Promise<Buffer>;
}

export function createLocalBridgeNativeHostArtifacts(options: {
  localAppData: string;
  nodePath: string;
  entryPath: string;
}): LocalBridgeNativeHostArtifacts {
  return createVersionedArtifacts(options, "meanthis-native-host-v2", true);
}

function createVersionedArtifacts(options: {
  localAppData: string;
  nodePath: string;
  entryPath: string;
}, identityVersion: string, sanitizeLauncher: boolean): LocalBridgeNativeHostArtifacts {
  if (![options.localAppData, options.nodePath, options.entryPath].every(isSafeAbsoluteWindowsPath)) {
    throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  }
  const identity = createHash("sha256")
    .update(`${identityVersion}\0`, "utf8")
    .update(options.nodePath, "utf8")
    .update("\0", "utf8")
    .update(options.entryPath, "utf8")
    .digest("hex");
  const directory = join(options.localAppData, "MeanThis", "NativeMessaging", identity);
  const launcherPath = join(directory, "meanthis-native-host.cmd");
  const manifestPath = join(directory, "app.meanthis.bridge.json");
  const launcherLines = [
    "@echo off",
    ...(sanitizeLauncher ? [
      'set "MEANTHIS_MCP_HTTP_TOKEN="',
      'set "NODE_OPTIONS="',
      'set "NODE_PATH="',
    ] : []),
    `"${escapeCmdPath(options.nodePath)}" "${escapeCmdPath(options.entryPath)}" native-host %*`,
    "",
  ];
  const launcherBytes = Buffer.from(launcherLines.join("\r\n"), "utf8");
  const manifestBytes = Buffer.from(`${JSON.stringify({
    name: MEANTHIS_NATIVE_HOST_NAME,
    description: "MeanThis local bridge starter",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN],
  }, null, 2)}\n`, "utf8");
  return { directory, launcherPath, launcherBytes, manifestPath, manifestBytes };
}

export async function installLocalBridgeNativeHost(
  options: InstallLocalBridgeNativeHostOptions,
): Promise<{ status: "installed" | "current"; browsers: Array<"chrome" | "edge"> }> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new LocalBridgeNativeHostInstallError("UNSUPPORTED_PLATFORM");
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  const pathExists = options.pathExists ?? defaultPathExists;
  if (!await pathExists(options.nodePath) || !await pathExists(options.entryPath)) {
    throw new LocalBridgeNativeHostInstallError("RUNTIME_UNAVAILABLE");
  }
  const artifacts = createLocalBridgeNativeHostArtifacts({
    localAppData,
    nodePath: options.nodePath,
    entryPath: options.entryPath,
  });
  const legacyArtifacts = createVersionedArtifacts({
    localAppData,
    nodePath: options.nodePath,
    entryPath: options.entryPath,
  }, "meanthis-native-host-v1", false);
  const readRegistryValue = options.readRegistryValue ?? readWindowsRegistryValue;
  const writeRegistryValue = options.writeRegistryValue ?? writeWindowsRegistryValue;
  const existing = await Promise.all(MEANTHIS_NATIVE_HOST_REGISTRY_KEYS.map(async ({ key }) => ({
    key,
    value: await readRegistryValue(key),
  })));
  const readExactFile = options.readExactFile ?? defaultReadExactFile;
  const registrationValuesAreOwned = await Promise.all(existing.map(({ value }) =>
    isExactRegisteredArtifact(value, artifacts, legacyArtifacts, readExactFile)));
  if (registrationValuesAreOwned.some((owned) => !owned)) {
    throw new LocalBridgeNativeHostInstallError("REGISTRATION_DRIFT");
  }
  const writeExactFile = options.writeExactFile ?? defaultWriteExactFile;
  const ensureDirectory = options.ensureDirectory ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  try {
    await ensureDirectory(artifacts.directory);
    await writeExactFile(artifacts.launcherPath, artifacts.launcherBytes);
    await writeExactFile(artifacts.manifestPath, artifacts.manifestBytes);
    let changed = false;
    for (const { key, value } of existing) {
      if (value === artifacts.manifestPath) continue;
      const currentValue = await readRegistryValue(key);
      if (currentValue !== value ||
          !await isExactRegisteredArtifact(
            currentValue,
            artifacts,
            legacyArtifacts,
            readExactFile,
          )) {
        throw new LocalBridgeNativeHostInstallError("REGISTRATION_DRIFT");
      }
      await writeRegistryValue(key, artifacts.manifestPath);
      changed = true;
    }
    const finalValues = await Promise.all(
      MEANTHIS_NATIVE_HOST_REGISTRY_KEYS.map(({ key }) => readRegistryValue(key)),
    );
    if (finalValues.some((value) => value !== artifacts.manifestPath)) {
      throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
    }
    const [finalManifest, finalLauncher] = await Promise.all([
      readExactFile(artifacts.manifestPath),
      readExactFile(artifacts.launcherPath),
    ]);
    if (!finalManifest.equals(artifacts.manifestBytes) ||
        !finalLauncher.equals(artifacts.launcherBytes)) {
      throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
    }
    return {
      status: changed ? "installed" : "current",
      browsers: MEANTHIS_NATIVE_HOST_REGISTRY_KEYS.map(({ browser }) => browser),
    };
  } catch (error) {
    if (error instanceof LocalBridgeNativeHostInstallError) throw error;
    throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  }
}

async function isExactRegisteredArtifact(
  value: string | null,
  current: LocalBridgeNativeHostArtifacts,
  legacy: LocalBridgeNativeHostArtifacts,
  readExactFile: (path: string) => Promise<Buffer>,
): Promise<boolean> {
  if (value === null) return true;
  const expected = value === current.manifestPath
    ? current
    : value === legacy.manifestPath
      ? legacy
      : null;
  if (!expected) return false;
  try {
    const [manifest, launcher] = await Promise.all([
      readExactFile(expected.manifestPath),
      readExactFile(expected.launcherPath),
    ]);
    return manifest.equals(expected.manifestBytes) && launcher.equals(expected.launcherBytes);
  } catch {
    return false;
  }
}

async function defaultWriteExactFile(path: string, bytes: Buffer): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  }
  const current = await readFile(path);
  if (!current.equals(bytes)) throw new LocalBridgeNativeHostInstallError("REGISTRATION_DRIFT");
}

async function defaultReadExactFile(path: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new LocalBridgeNativeHostInstallError("REGISTRATION_DRIFT");
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      after.size !== BigInt(bytes.length)) {
    throw new LocalBridgeNativeHostInstallError("REGISTRATION_DRIFT");
  }
  return bytes;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readWindowsRegistryValue(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], childOptions());
    const match = stdout.match(/\bREG_SZ\s+([^\r\n]+)\s*$/m);
    return match?.[1]?.trim() ?? null;
  } catch (error) {
    if (isExecError(error) && error.code === 1) return null;
    throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  }
}

async function writeWindowsRegistryValue(key: string, value: string): Promise<void> {
  await execFileAsync("reg.exe", [
    "add",
    key,
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    value,
    "/f",
  ], childOptions()).catch(() => {
    throw new LocalBridgeNativeHostInstallError("INSTALL_FAILED");
  });
}

function childOptions() {
  return {
    windowsHide: true,
    encoding: "utf8" as const,
    env: sanitizedEnvironment(process.env),
    maxBuffer: 64 * 1024,
  };
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(
    ([key]) => key.toUpperCase() !== MCP_BEARER_ENV,
  ));
}

function isSafeAbsoluteWindowsPath(value: string): boolean {
  return isAbsolute(value) && !/[\r\n"]/.test(value);
}

function escapeCmdPath(value: string): string {
  return value.replaceAll("%", "%%");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function isExecError(value: unknown): value is Error & { code: number } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "number";
}
