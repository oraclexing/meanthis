import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

export const MEANTHIS_MCP_HTTP_TOKEN_ENV = "MEANTHIS_MCP_HTTP_TOKEN";
export const MEANTHIS_MCP_HTTP_KEY_KIND = "mcp-http-key-v1";
export const MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME =
  "mcp-http-owner-desired-build-v1" as const;
export const MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME =
  "bridge-owner-desired-identity-v1" as const;
export const LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED =
  "rotation_committed_but_unverified" as const;
export const LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_REQUIRED = "rotation_required" as const;
export const LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE =
  "LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE" as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORED_TOKEN_PATTERN = /^([A-Za-z0-9_-]{43})(?:\r?\n)?$/;
const MAX_STORED_TOKEN_BYTES = 45;
const MAX_DESIRED_IDENTITY_BYTES = 65;
const DESIRED_BUILD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_MARKER_ACL_CACHE_MAX_ENTRIES = 32;
const WINDOWS_MARKER_ACL_CACHE_TTL_MS = 30_000;
const WINDOWS_PROTECTED_ACL_CACHE_MAX_ENTRIES = 32;
const WINDOWS_PROTECTED_ACL_CACHE_TTL_MS = 30_000;
const WINDOWS_PROTECTED_ACL_BATCH_MAX_TARGETS = 8;
const WINDOWS_PROTECTED_ACL_BATCH_MAX_JSON_BYTES = 16 * 1024;
const execFile = promisify(execFileCallback);

export type LocalBridgeMcpHttpAclTargetKind = "directory" | "file";

export interface LocalBridgeWindowsProtectedAclTarget {
  path: string;
  kind: LocalBridgeMcpHttpAclTargetKind;
}

export type LocalBridgeWindowsAclExecFile = (
  file: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
  },
) => Promise<unknown>;

export interface LocalBridgeWindowsProtectedAclOptions {
  /** @internal Deterministic seam for ACL subprocess contract tests. */
  execFile?: LocalBridgeWindowsAclExecFile;
}

export type ApplyLocalBridgeMcpHttpAcl = (
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
) => Promise<void>;

export type InspectLocalBridgeMcpHttpAcl = ApplyLocalBridgeMcpHttpAcl;

interface WindowsMarkerAclInspectionCacheEntry {
  identity: Stats;
  inspector: InspectLocalBridgeMcpHttpAcl | undefined;
  validatedAtMs: number;
}

const windowsMarkerAclInspectionCache =
  new Map<string, WindowsMarkerAclInspectionCacheEntry>();

interface WindowsProtectedAclInspectionCacheEntry {
  identity: Stats;
  runner: LocalBridgeWindowsAclExecFile;
  validatedAtMs: number;
}

interface WindowsProtectedAclInspectionPendingEntry {
  identity: Stats;
  runner: LocalBridgeWindowsAclExecFile;
  operation: Promise<void>;
}

interface WindowsProtectedAclInspectionTarget extends LocalBridgeWindowsProtectedAclTarget {
  key: string;
  identity: Stats;
}

interface WindowsProtectedAclInspectionBatchRequest {
  targets: WindowsProtectedAclInspectionTarget[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

const windowsProtectedAclInspectionCache =
  new Map<string, WindowsProtectedAclInspectionCacheEntry>();
const windowsProtectedAclInspectionPending =
  new Map<string, WindowsProtectedAclInspectionPendingEntry>();
const windowsProtectedAclInspectionBatchQueue =
  new Map<LocalBridgeWindowsAclExecFile, WindowsProtectedAclInspectionBatchRequest[]>();
const windowsProtectedAclInspectionBatchFlush =
  new Map<LocalBridgeWindowsAclExecFile, NodeJS.Immediate>();

export type LocalBridgeProtectedBuildMarkerFileName =
  | typeof MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME
  | typeof MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME;

export interface LocalBridgeMcpHttpPathSecurityOptions {
  processPlatform?: NodeJS.Platform;
  applyAcl?: ApplyLocalBridgeMcpHttpAcl;
  inspectAcl?: InspectLocalBridgeMcpHttpAcl;
}

export interface LocalBridgeMcpHttpTokenOptions
  extends LocalBridgeMcpHttpPathSecurityOptions {
  codexHome?: string;
  randomBytes?: (size: number) => Uint8Array;
  /** @internal Deterministic seam for credential readback failure tests. */
  readCredentialFile?: (path: string) => Promise<string>;
}

export interface LocalBridgeMcpHttpDesiredIdentityOptions
  extends LocalBridgeMcpHttpPathSecurityOptions {
  codexHome?: string;
  randomBytes?: (size: number) => Uint8Array;
  /** @internal Deterministic seam for desired-identity read race tests. */
  readIdentityFile?: (path: string) => Promise<string>;
  /** @internal Deterministic seam for Windows ACL drift and cache tests. */
  disableAclInspectionCache?: boolean;
}

export class LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError extends Error {
  readonly status = LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED;
  readonly rotationCommitted = true;
  readonly credentialVerified = false;

  constructor() {
    super("MCP HTTP credential rotation committed but could not be verified.");
    this.name = "LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError";
  }
}

export class LocalBridgeMcpHttpTokenRotationRequiredError extends Error {
  readonly status = LOCAL_BRIDGE_MCP_HTTP_TOKEN_ROTATION_REQUIRED;
  readonly rotationRequired = true;
  readonly credentialReused = false;
  readonly credentialMayHaveBeenExposed = true;

  constructor() {
    super(
      "Existing MCP HTTP credential permissions are insecure or unverifiable; the credential may have been exposed and explicit rotation is required.",
    );
    this.name = "LocalBridgeMcpHttpTokenRotationRequiredError";
  }
}

export class LocalBridgeMcpHttpTokenReadError extends Error {
  readonly code = "MCP_HTTP_CREDENTIAL_UNAVAILABLE";

  constructor() {
    super("MCP HTTP credential is unavailable.");
    this.name = "LocalBridgeMcpHttpTokenReadError";
  }
}

export class LocalBridgeProtectedAclError extends Error {
  readonly code = LOCAL_BRIDGE_PROTECTED_ACL_UNAVAILABLE;
  readonly operation: "apply" | "inspect";

  constructor(operation: "apply" | "inspect") {
    super(
      operation === "apply"
        ? "Unable to secure the local bridge protected ACL."
        : "Unable to verify the local bridge protected ACL.",
    );
    this.name = "LocalBridgeProtectedAclError";
    this.operation = operation;
  }
}

export class LocalBridgeMcpHttpDesiredIdentityReadError extends Error {
  readonly code = "MCP_HTTP_DESIRED_IDENTITY_UNAVAILABLE";

  constructor() {
    super("MCP HTTP desired identity is unavailable.");
    this.name = "LocalBridgeMcpHttpDesiredIdentityReadError";
  }
}

export type LocalBridgeMcpHttpTokenInspection =
  | {
    kind: typeof MEANTHIS_MCP_HTTP_KEY_KIND;
    status: "ready";
    fingerprint: string;
  }
  | {
    kind: typeof MEANTHIS_MCP_HTTP_KEY_KIND;
    status: "missing" | "invalid" | "insecure" | "unavailable";
  };

export function getLocalBridgeMcpHttpTokenPath(codexHome = resolveCodexHome()): string {
  return join(resolve(codexHome), "ui-attach", MEANTHIS_MCP_HTTP_KEY_KIND);
}

export function getLocalBridgeMcpHttpDesiredIdentityPath(codexHome = resolveCodexHome()): string {
  return getLocalBridgeProtectedBuildMarkerPath(
    MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME,
    codexHome,
  );
}

export function getLocalBridgeProtectedBuildMarkerPath(
  fileName: LocalBridgeProtectedBuildMarkerFileName,
  codexHome = resolveCodexHome(),
): string {
  assertSupportedProtectedBuildMarkerFileName(fileName);
  return join(dirname(getLocalBridgeMcpHttpTokenPath(resolve(codexHome))), fileName);
}

export async function writeLocalBridgeMcpHttpDesiredIdentity(
  buildHash: string,
  options: LocalBridgeMcpHttpDesiredIdentityOptions = {},
): Promise<void> {
  return writeLocalBridgeProtectedBuildMarker(
    buildHash,
    MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME,
    options,
  );
}

export async function writeLocalBridgeProtectedBuildMarker(
  buildHash: string,
  fileName: LocalBridgeProtectedBuildMarkerFileName,
  options: LocalBridgeMcpHttpDesiredIdentityOptions = {},
): Promise<void> {
  if (!DESIRED_BUILD_HASH_PATTERN.test(buildHash)) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
  const markerPath = getLocalBridgeProtectedBuildMarkerPath(fileName, options.codexHome);
  const directory = dirname(markerPath);
  let temporaryPath: string;
  try {
    await prepareProtectedBuildMarkerDirectory(directory, options);
    await assertReplaceableDesiredIdentity(markerPath);
    const suffixBytes = (options.randomBytes ?? secureRandomBytes)(12);
    if (suffixBytes.byteLength !== 12) {
      throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    }
    temporaryPath = join(
      directory,
      `.${fileName}.${process.pid}.${Buffer.from(suffixBytes).toString("hex")}.tmp`,
    );
  } catch {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
  try {
    await writeFile(temporaryPath, `${buildHash}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await assertDesiredIdentityFile(temporaryPath, options.processPlatform);
    await securePath(temporaryPath, "file", options);
    await assertDesiredIdentityFile(temporaryPath, options.processPlatform);
    const directoryBeforeCommit = await lstat(directory);
    assertDesiredIdentityDirectoryStats(directoryBeforeCommit, options.processPlatform);
    await inspectDesiredIdentityPathPermissions(
      directory,
      "directory",
      directoryBeforeCommit,
      options,
    );
    await assertReplaceableDesiredIdentity(markerPath);
    await rename(temporaryPath, markerPath);
    const stored = await readVerifiedLocalBridgeProtectedBuildMarker(fileName, options);
    if (stored !== buildHash) throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  } catch {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readVerifiedLocalBridgeMcpHttpDesiredIdentity(
  options: LocalBridgeMcpHttpDesiredIdentityOptions = {},
): Promise<string> {
  return readVerifiedLocalBridgeProtectedBuildMarker(
    MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME,
    options,
  );
}

export async function readVerifiedLocalBridgeProtectedBuildMarker(
  fileName: LocalBridgeProtectedBuildMarkerFileName,
  options: LocalBridgeMcpHttpDesiredIdentityOptions = {},
): Promise<string> {
  const markerPath = getLocalBridgeProtectedBuildMarkerPath(fileName, options.codexHome);
  const directory = dirname(markerPath);
  try {
    const directoryBefore = await lstat(directory);
    assertDesiredIdentityDirectoryStats(directoryBefore, options.processPlatform);
    await inspectDesiredIdentityPathPermissions(
      directory,
      "directory",
      directoryBefore,
      options,
    );
    const fileBefore = await lstat(markerPath);
    assertDesiredIdentityFileStats(fileBefore, options.processPlatform);
    await inspectDesiredIdentityPathPermissions(markerPath, "file", fileBefore, options);
    const raw = await (options.readIdentityFile ?? ((path: string) => readFile(path, "utf8")))(
      markerPath,
    );
    const [directoryAfter, fileAfter] = await Promise.all([
      lstat(directory),
      lstat(markerPath),
    ]);
    assertDesiredIdentityDirectoryStats(directoryAfter, options.processPlatform);
    assertDesiredIdentityFileStats(fileAfter, options.processPlatform);
    if (
      !sameCredentialIdentity(directoryBefore, directoryAfter) ||
      !sameCredentialIdentity(fileBefore, fileAfter)
    ) {
      throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    }
    await inspectDesiredIdentityPathPermissions(
      directory,
      "directory",
      directoryAfter,
      options,
    );
    await inspectDesiredIdentityPathPermissions(markerPath, "file", fileAfter, options);
    const [directoryFinal, fileFinal] = await Promise.all([
      lstat(directory),
      lstat(markerPath),
    ]);
    assertDesiredIdentityDirectoryStats(directoryFinal, options.processPlatform);
    assertDesiredIdentityFileStats(fileFinal, options.processPlatform);
    if (
      !sameCredentialIdentity(directoryBefore, directoryFinal) ||
      !sameCredentialIdentity(fileBefore, fileFinal)
    ) {
      throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    }
    const match = /^([0-9a-f]{64})\n?$/.exec(raw);
    if (!match) throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    return match[1];
  } catch {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
}

/** @deprecated Use the verified read; kept as a source-compatible owner API alias. */
export const readLocalBridgeMcpHttpDesiredIdentity =
  readVerifiedLocalBridgeMcpHttpDesiredIdentity;

export function validateLocalBridgeMcpHttpToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const decoded = Buffer.from(token, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === token;
}

export function fingerprintLocalBridgeMcpHttpToken(token: string): string {
  if (!validateLocalBridgeMcpHttpToken(token)) {
    throw new Error("MCP HTTP credential is invalid.");
  }
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)}`;
}

export async function loadOrCreateLocalBridgeMcpHttpToken(
  options: LocalBridgeMcpHttpTokenOptions = {},
): Promise<string> {
  const paths = resolveCredentialPaths(options);
  if (await credentialExists(paths)) {
    return readExistingCredentialForReuse(paths, options);
  }

  await prepareCredentialDirectory(options);

  const token = generateToken(options.randomBytes);
  try {
    await writeFile(paths.path, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return readExistingCredentialForReuse(paths, options);
  }

  const createdIdentity = await lstat(paths.path);
  try {
    return await readCredential(paths.path, options);
  } catch (error) {
    await removeCreatedCredentialIfUnchanged(paths.path, createdIdentity, `${token}\n`);
    throw error;
  }
}

export async function readLocalBridgeMcpHttpToken(
  options: Pick<LocalBridgeMcpHttpTokenOptions, "codexHome"> = {},
): Promise<string> {
  const codexHome = options.codexHome ? resolve(options.codexHome) : resolveCodexHome();
  const directory = join(codexHome, "ui-attach");
  await assertDirectory(directory);
  return readCredentialWithoutHardening(getLocalBridgeMcpHttpTokenPath(codexHome));
}

export async function readVerifiedLocalBridgeMcpHttpToken(
  options: LocalBridgeMcpHttpTokenOptions = {},
): Promise<string> {
  try {
    const paths = resolveCredentialPaths(options);
    const [directoryBefore, fileBefore] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    assertCredentialDirectoryStats(directoryBefore);
    assertCredentialFileStats(fileBefore);
    await inspectVerifiedPathPermissions([
      { path: paths.directory, kind: "directory" },
      { path: paths.path, kind: "file" },
    ], options);

    const token = await readCredentialWithoutHardening(
      paths.path,
      options.readCredentialFile,
    );
    const [directoryAfterRead, fileAfterRead] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    if (
      !sameCredentialIdentity(directoryBefore, directoryAfterRead) ||
      !sameCredentialIdentity(fileBefore, fileAfterRead)
    ) {
      throw new Error("credential identity changed");
    }

    await inspectVerifiedPathPermissions([
      { path: paths.directory, kind: "directory" },
      { path: paths.path, kind: "file" },
    ], options);
    const [directoryFinal, fileFinal] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    if (
      !sameCredentialIdentity(directoryBefore, directoryFinal) ||
      !sameCredentialIdentity(fileBefore, fileFinal)
    ) {
      throw new Error("credential identity changed");
    }
    return token;
  } catch {
    throw new LocalBridgeMcpHttpTokenReadError();
  }
}

export async function inspectLocalBridgeMcpHttpToken(
  options: LocalBridgeMcpHttpTokenOptions = {},
): Promise<LocalBridgeMcpHttpTokenInspection> {
  const base = { kind: MEANTHIS_MCP_HTTP_KEY_KIND } as const;
  try {
    const codexHome = options.codexHome ? resolve(options.codexHome) : resolveCodexHome();
    const directory = join(codexHome, "ui-attach");
    const path = getLocalBridgeMcpHttpTokenPath(codexHome);
    await assertDirectory(directory);
    await inspectPathPermissions(directory, "directory", options);
    await assertCredentialFile(path);
    await inspectPathPermissions(path, "file", options);
    const token = await readCredentialWithoutHardening(path);
    return {
      ...base,
      status: "ready",
      fingerprint: fingerprintLocalBridgeMcpHttpToken(token),
    };
  } catch (error) {
    if (isMissing(error)) return { ...base, status: "missing" };
    if (error instanceof InvalidMcpHttpCredentialError) {
      return { ...base, status: "invalid" };
    }
    if (error instanceof McpHttpCredentialPermissionError) {
      return { ...base, status: "insecure" };
    }
    return { ...base, status: "unavailable" };
  }
}

export async function rotateLocalBridgeMcpHttpToken(
  options: LocalBridgeMcpHttpTokenOptions = {},
): Promise<string> {
  const paths = await prepareCredentialDirectory(options);
  const token = generateToken(options.randomBytes);
  const temporaryPath = await createTemporaryCredential(paths.directory, token);
  let rotationCommitted = false;

  try {
    const preparedToken = await readCredential(temporaryPath, options);
    if (preparedToken !== token) throw invalidExistingCredential();

    await rename(temporaryPath, paths.path);
    rotationCommitted = true;
    try {
      const committedToken = await readCredentialWithoutHardening(
        paths.path,
        options.readCredentialFile,
      );
      if (committedToken !== token) throw invalidExistingCredential();
      return committedToken;
    } catch {
      throw new LocalBridgeMcpHttpTokenRotationCommittedButUnverifiedError();
    }
  } finally {
    if (!rotationCommitted) await rm(temporaryPath, { force: true });
  }
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
}

function resolveCredentialPaths(
  options: Pick<LocalBridgeMcpHttpTokenOptions, "codexHome">,
): { directory: string; path: string } {
  const codexHome = options.codexHome ? resolve(options.codexHome) : resolveCodexHome();
  return {
    directory: join(codexHome, "ui-attach"),
    path: getLocalBridgeMcpHttpTokenPath(codexHome),
  };
}

async function credentialExists(paths: { directory: string; path: string }): Promise<boolean> {
  try {
    await assertDirectory(paths.directory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }

  try {
    await lstat(paths.path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readExistingCredentialForReuse(
  paths: { directory: string; path: string },
  options: LocalBridgeMcpHttpTokenOptions,
): Promise<string> {
  try {
    await assertDirectory(paths.directory);
    await inspectPathPermissions(paths.directory, "directory", options);
    await assertCredentialFile(paths.path);
    await inspectPathPermissions(paths.path, "file", options);
    return readCredentialWithoutHardening(paths.path, options.readCredentialFile);
  } catch (error) {
    if (error instanceof McpHttpCredentialPermissionError) {
      throw new LocalBridgeMcpHttpTokenRotationRequiredError();
    }
    throw error;
  }
}

async function prepareCredentialDirectory(
  options: LocalBridgeMcpHttpTokenOptions,
): Promise<{ directory: string; path: string }> {
  const { directory, path } = resolveCredentialPaths(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertDirectory(directory);
  await securePath(directory, "directory", options);
  await assertDirectory(directory);
  return { directory, path };
}

async function createTemporaryCredential(directory: string, token: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = secureRandomBytes(12).toString("hex");
    const temporaryPath = join(
      directory,
      `.${MEANTHIS_MCP_HTTP_KEY_KIND}.${process.pid}.${suffix}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${token}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return temporaryPath;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error("Unable to allocate a temporary MCP HTTP credential file.");
}

async function removeCreatedCredentialIfUnchanged(
  path: string,
  createdIdentity: Awaited<ReturnType<typeof lstat>>,
  expectedRaw: string,
): Promise<void> {
  try {
    let current = await lstat(path);
    if (!sameFileIdentity(createdIdentity, current) || !current.isFile() || current.isSymbolicLink()) {
      return;
    }
    if (await readFile(path, "utf8") !== expectedRaw) return;
    current = await lstat(path);
    if (!sameFileIdentity(createdIdentity, current) || !current.isFile() || current.isSymbolicLink()) {
      return;
    }
    await rm(path);
  } catch {
    // Best effort only: never widen a failed hardening path by deleting another file.
  }
}

function sameFileIdentity(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.birthtimeMs === actual.birthtimeMs;
}

function generateToken(randomBytes?: (size: number) => Uint8Array): string {
  const bytes = (randomBytes ?? ((size: number) => secureRandomBytes(size)))(32);
  if (bytes.byteLength !== 32) {
    throw new Error("Generated MCP HTTP credential is invalid.");
  }
  const token = Buffer.from(bytes).toString("base64url");
  if (!validateLocalBridgeMcpHttpToken(token)) {
    throw new Error("Generated MCP HTTP credential is invalid.");
  }
  return token;
}

async function readCredential(
  path: string,
  options: LocalBridgeMcpHttpTokenOptions,
): Promise<string> {
  await assertCredentialFile(path);

  await securePath(path, "file", options);
  return readCredentialWithoutHardening(path, options.readCredentialFile);
}

async function readCredentialWithoutHardening(
  path: string,
  readCredentialFile: (path: string) => Promise<string> = (candidatePath) =>
    readFile(candidatePath, "utf8"),
): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORED_TOKEN_BYTES) {
    throw invalidExistingCredential();
  }

  const raw = await readCredentialFile(path);
  const match = STORED_TOKEN_PATTERN.exec(raw);
  if (!match || !validateLocalBridgeMcpHttpToken(match[1])) {
    throw invalidExistingCredential();
  }
  return match[1];
}

async function assertCredentialFile(path: string): Promise<void> {
  const stats = await lstat(path);
  assertCredentialFileStats(stats);
}

function assertCredentialDirectoryStats(stats: Stats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalidExistingCredential();
}

function assertCredentialFileStats(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORED_TOKEN_BYTES) {
    throw invalidExistingCredential();
  }
}

function sameCredentialIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

async function inspectDesiredIdentityPathPermissions(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  identity: Stats,
  options: LocalBridgeMcpHttpDesiredIdentityOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  if (platform !== "win32" || options.disableAclInspectionCache) {
    await inspectPathPermissions(path, kind, options);
    return;
  }

  // Owner polling is frequent. Reuse only a recent inspection bound to the
  // exact Windows metadata identity; DACL changes advance ctime and force a miss.
  const cacheKey = `${kind}\0${path}`;
  const cached = windowsMarkerAclInspectionCache.get(cacheKey);
  if (
    cached &&
    cached.inspector === options.inspectAcl &&
    performance.now() - cached.validatedAtMs <= WINDOWS_MARKER_ACL_CACHE_TTL_MS &&
    sameCredentialIdentity(cached.identity, identity)
  ) {
    windowsMarkerAclInspectionCache.delete(cacheKey);
    windowsMarkerAclInspectionCache.set(cacheKey, cached);
    return;
  }
  windowsMarkerAclInspectionCache.delete(cacheKey);

  await inspectPathPermissions(path, kind, options);
  const verifiedIdentity = await lstat(path);
  const validType = kind === "directory"
    ? verifiedIdentity.isDirectory()
    : verifiedIdentity.isFile();
  if (
    !validType ||
    verifiedIdentity.isSymbolicLink() ||
    !sameCredentialIdentity(identity, verifiedIdentity)
  ) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }

  windowsMarkerAclInspectionCache.set(cacheKey, {
    identity: verifiedIdentity,
    inspector: options.inspectAcl,
    validatedAtMs: performance.now(),
  });
  if (windowsMarkerAclInspectionCache.size > WINDOWS_MARKER_ACL_CACHE_MAX_ENTRIES) {
    const oldestKey = windowsMarkerAclInspectionCache.keys().next().value;
    if (oldestKey !== undefined) windowsMarkerAclInspectionCache.delete(oldestKey);
  }
}

async function prepareProtectedBuildMarkerDirectory(
  path: string,
  options: LocalBridgeMcpHttpDesiredIdentityOptions,
): Promise<void> {
  try {
    const existingIdentity = await lstat(path);
    assertDesiredIdentityDirectoryStats(existingIdentity, options.processPlatform);
    await inspectDesiredIdentityPathPermissions(
      path,
      "directory",
      existingIdentity,
      options,
    );
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const racedIdentity = await lstat(path);
    assertDesiredIdentityDirectoryStats(racedIdentity, options.processPlatform);
    await inspectDesiredIdentityPathPermissions(
      path,
      "directory",
      racedIdentity,
      options,
    );
    return;
  }

  let createdIdentity: Stats | undefined;
  try {
    createdIdentity = await lstat(path);
    assertDesiredIdentityDirectoryStats(createdIdentity, options.processPlatform);
    await securePath(path, "directory", options);
    const securedIdentity = await lstat(path);
    assertDesiredIdentityDirectoryStats(securedIdentity, options.processPlatform);
    if (!sameFileIdentity(createdIdentity, securedIdentity)) {
      throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    }
    await inspectDesiredIdentityPathPermissions(
      path,
      "directory",
      securedIdentity,
      options,
    );
  } catch (error) {
    if (createdIdentity) {
      await removeCreatedDirectoryIfEmptyAndUnchanged(path, createdIdentity);
    }
    throw error;
  }
}

async function removeCreatedDirectoryIfEmptyAndUnchanged(
  path: string,
  createdIdentity: Stats,
): Promise<void> {
  try {
    const currentIdentity = await lstat(path);
    if (!sameFileIdentity(createdIdentity, currentIdentity)) return;
    await rmdir(path);
  } catch {
    // Best effort only: never remove a replaced or non-empty profile directory.
  }
}

function assertDesiredIdentityDirectoryStats(
  stats: Stats,
  processPlatform = process.platform,
): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
  if (processPlatform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
}

async function assertReplaceableDesiredIdentity(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DESIRED_IDENTITY_BYTES) {
      throw new LocalBridgeMcpHttpDesiredIdentityReadError();
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
}

async function assertDesiredIdentityFile(
  path: string,
  processPlatform = process.platform,
): Promise<void> {
  const stats = await lstat(path);
  assertDesiredIdentityFileStats(stats, processPlatform);
}

function assertDesiredIdentityFileStats(
  stats: Stats,
  processPlatform = process.platform,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DESIRED_IDENTITY_BYTES) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
  if (processPlatform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
}

async function securePath(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeMcpHttpPathSecurityOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  if (platform === "win32") {
    if (options.applyAcl) {
      await options.applyAcl(path, kind);
      return;
    }
    try {
      await inspectLocalBridgeWindowsProtectedAcl(path, kind);
    } catch {
      await applyLocalBridgeWindowsProtectedAcl(path, kind);
    }
    return;
  }

  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  await chmod(path, expectedMode);
  const stats = await lstat(path);
  const validType = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!validType || stats.isSymbolicLink() || (stats.mode & 0o777) !== expectedMode) {
    throw new Error(`MCP HTTP credential ${kind} permissions are invalid.`);
  }
}

async function inspectPathPermissions(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeMcpHttpPathSecurityOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  try {
    if (platform === "win32") {
      await (options.inspectAcl ?? inspectLocalBridgeWindowsProtectedAcl)(path, kind);
      return;
    }

    const expectedMode = kind === "directory" ? 0o700 : 0o600;
    const stats = await lstat(path);
    const validType = kind === "directory" ? stats.isDirectory() : stats.isFile();
    if (!validType || stats.isSymbolicLink() || (stats.mode & 0o777) !== expectedMode) {
      throw new Error("permissions mismatch");
    }
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new McpHttpCredentialPermissionError({ cause: error });
  }
}

async function inspectVerifiedPathPermissions(
  targets: readonly LocalBridgeWindowsProtectedAclTarget[],
  options: LocalBridgeMcpHttpPathSecurityOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  if (platform === "win32" && !options.inspectAcl) {
    await inspectLocalBridgeWindowsProtectedAclBatch(targets);
    return;
  }
  for (const target of targets) {
    await inspectPathPermissions(target.path, target.kind, options);
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new InvalidMcpHttpCredentialError("MCP HTTP credential directory is invalid.");
  }
}

export async function applyLocalBridgeWindowsProtectedAcl(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeWindowsProtectedAclOptions = {},
): Promise<void> {
  const cacheKey = windowsProtectedAclCacheKey(path, kind);
  windowsProtectedAclInspectionCache.delete(cacheKey);
  try {
    const identityBefore = await lstat(path);
    assertLocalBridgeAclTargetStats(identityBefore, kind);
    await runWindowsAclScript(
      WINDOWS_PROTECTED_ACL_SCRIPT,
      path,
      kind,
      options.execFile ?? execFile,
    );
    const identityAfter = await lstat(path);
    assertLocalBridgeAclTargetStats(identityAfter, kind);
    if (!sameFileIdentity(identityBefore, identityAfter)) {
      throw new Error("ACL target identity changed");
    }
  } catch {
    throw new LocalBridgeProtectedAclError("apply");
  } finally {
    windowsProtectedAclInspectionCache.delete(cacheKey);
  }
}

export async function inspectLocalBridgeWindowsProtectedAcl(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeWindowsProtectedAclOptions = {},
): Promise<void> {
  const cacheKey = windowsProtectedAclCacheKey(path, kind);
  const runner = options.execFile ?? execFile;
  try {
    const identityBefore = await lstat(path);
    assertLocalBridgeAclTargetStats(identityBefore, kind);

    const cached = windowsProtectedAclInspectionCache.get(cacheKey);
    if (
      cached &&
      cached.runner === runner &&
      performance.now() - cached.validatedAtMs <= WINDOWS_PROTECTED_ACL_CACHE_TTL_MS &&
      sameCredentialIdentity(cached.identity, identityBefore)
    ) {
      windowsProtectedAclInspectionCache.delete(cacheKey);
      windowsProtectedAclInspectionCache.set(cacheKey, cached);
      return;
    }
    windowsProtectedAclInspectionCache.delete(cacheKey);

    const pending = windowsProtectedAclInspectionPending.get(cacheKey);
    if (
      pending &&
      pending.runner === runner &&
      sameCredentialIdentity(pending.identity, identityBefore)
    ) {
      await pending.operation;
      const identityAfterPending = await lstat(path);
      assertLocalBridgeAclTargetStats(identityAfterPending, kind);
      if (!sameCredentialIdentity(identityBefore, identityAfterPending)) {
        throw new Error("ACL target identity changed");
      }
      return;
    }

    let operation!: Promise<void>;
    operation = (async () => {
      await runWindowsAclScript(
        WINDOWS_INSPECT_ACL_SCRIPT,
        path,
        kind,
        runner,
      );
      const identityAfter = await lstat(path);
      assertLocalBridgeAclTargetStats(identityAfter, kind);
      if (!sameCredentialIdentity(identityBefore, identityAfter)) {
        throw new Error("ACL target identity changed");
      }
      windowsProtectedAclInspectionCache.set(cacheKey, {
        identity: identityAfter,
        runner,
        validatedAtMs: performance.now(),
      });
      trimWindowsProtectedAclInspectionCache();
    })();
    windowsProtectedAclInspectionPending.set(cacheKey, {
      identity: identityBefore,
      runner,
      operation,
    });
    try {
      await operation;
    } finally {
      if (windowsProtectedAclInspectionPending.get(cacheKey)?.operation === operation) {
        windowsProtectedAclInspectionPending.delete(cacheKey);
      }
    }
  } catch {
    windowsProtectedAclInspectionCache.delete(cacheKey);
    throw new LocalBridgeProtectedAclError("inspect");
  }
}

/**
 * Read-only Windows ACL verification for several protected paths. The request
 * is coalesced within this process for the current turn so concurrent owners
 * can share one PowerShell startup while each target keeps its own metadata
 * and runner-bound cache entry.
 */
export async function inspectLocalBridgeWindowsProtectedAclBatch(
  targets: readonly LocalBridgeWindowsProtectedAclTarget[],
  options: LocalBridgeWindowsProtectedAclOptions = {},
): Promise<void> {
  if (targets.length === 0 || targets.length > WINDOWS_PROTECTED_ACL_BATCH_MAX_TARGETS) {
    throw new LocalBridgeProtectedAclError("inspect");
  }
  const uniqueTargets = new Map<string, LocalBridgeWindowsProtectedAclTarget>();
  const targetKindsByPath = new Map<string, LocalBridgeMcpHttpAclTargetKind>();
  for (const target of targets) {
    if (
      !target ||
      typeof target.path !== "string" ||
      (target.kind !== "directory" && target.kind !== "file")
    ) {
      throw new LocalBridgeProtectedAclError("inspect");
    }
    const existingKind = targetKindsByPath.get(target.path);
    if (existingKind !== undefined && existingKind !== target.kind) {
      throw new LocalBridgeProtectedAclError("inspect");
    }
    if (existingKind !== undefined) {
      throw new LocalBridgeProtectedAclError("inspect");
    }
    targetKindsByPath.set(target.path, target.kind);
    uniqueTargets.set(windowsProtectedAclCacheKey(target.path, target.kind), target);
  }

  const runner = options.execFile ?? execFile;
  try {
    const inspectedTargets = await Promise.all(
      [...uniqueTargets.values()].map(async (target): Promise<WindowsProtectedAclInspectionTarget> => {
        const identity = await lstat(target.path);
        assertLocalBridgeAclTargetStats(identity, target.kind);
        return {
          ...target,
          key: windowsProtectedAclCacheKey(target.path, target.kind),
          identity,
        };
      }),
    );
    await queueWindowsProtectedAclInspection(inspectedTargets, runner);
  } catch (error) {
    if (error instanceof LocalBridgeProtectedAclError) throw error;
    throw new LocalBridgeProtectedAclError("inspect");
  }
}

async function queueWindowsProtectedAclInspection(
  targets: WindowsProtectedAclInspectionTarget[],
  runner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  const waits: Promise<void>[] = [];
  const queuedTargets: WindowsProtectedAclInspectionTarget[] = [];
  const pendingTargets: Array<{
    target: WindowsProtectedAclInspectionTarget;
    pending: WindowsProtectedAclInspectionPendingEntry;
  }> = [];

  for (const target of targets) {
    const cached = windowsProtectedAclInspectionCache.get(target.key);
    if (
      cached &&
      cached.runner === runner &&
      performance.now() - cached.validatedAtMs <= WINDOWS_PROTECTED_ACL_CACHE_TTL_MS &&
      sameCredentialIdentity(cached.identity, target.identity)
    ) {
      windowsProtectedAclInspectionCache.delete(target.key);
      windowsProtectedAclInspectionCache.set(target.key, cached);
      continue;
    }
    if (cached) windowsProtectedAclInspectionCache.delete(target.key);

    const pending = windowsProtectedAclInspectionPending.get(target.key);
    if (pending && pending.runner === runner) {
      if (!sameCredentialIdentity(pending.identity, target.identity)) {
        throw new Error("ACL target identity changed");
      }
      pendingTargets.push({ target, pending });
      continue;
    }
    queuedTargets.push(target);
  }

  for (const { target, pending } of pendingTargets) {
    waits.push(pending.operation.then(async () => {
      const identityAfterPending = await lstat(target.path);
      assertLocalBridgeAclTargetStats(identityAfterPending, target.kind);
      if (!sameCredentialIdentity(target.identity, identityAfterPending)) {
        throw new Error("ACL target identity changed");
      }
    }));
  }

  if (queuedTargets.length > 0) {
    waits.push(scheduleWindowsProtectedAclInspection(queuedTargets, runner));
  }
  await Promise.all(waits);
}

function scheduleWindowsProtectedAclInspection(
  targets: WindowsProtectedAclInspectionTarget[],
  runner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const requests = windowsProtectedAclInspectionBatchQueue.get(runner) ?? [];
    requests.push({ targets, resolve, reject });
    windowsProtectedAclInspectionBatchQueue.set(runner, requests);
    if (windowsProtectedAclInspectionBatchFlush.has(runner)) return;

    const flush = setImmediate(() => {
      windowsProtectedAclInspectionBatchFlush.delete(runner);
      flushWindowsProtectedAclInspection(runner);
    });
    windowsProtectedAclInspectionBatchFlush.set(runner, flush);
  });
}

function flushWindowsProtectedAclInspection(runner: LocalBridgeWindowsAclExecFile): void {
  const requests = windowsProtectedAclInspectionBatchQueue.get(runner);
  windowsProtectedAclInspectionBatchQueue.delete(runner);
  if (!requests || requests.length === 0) return;

  const groups: Array<{
    requests: WindowsProtectedAclInspectionBatchRequest[];
    targets: Map<string, WindowsProtectedAclInspectionTarget>;
  }> = [];
  for (const request of requests) {
    if (!canFitWindowsProtectedAclBatch(request.targets)) {
      request.reject(new LocalBridgeProtectedAclError("inspect"));
      continue;
    }

    let group = groups.find((candidate) => {
      const mergedTargets = mergeWindowsProtectedAclTargets(
        candidate.targets,
        request.targets,
      );
      return canFitWindowsProtectedAclBatch([...mergedTargets.values()]);
    });
    if (!group) {
      group = { requests: [], targets: new Map() };
      groups.push(group);
    }
    for (const target of request.targets) {
      const existing = group.targets.get(target.key);
      if (!existing) {
        group.targets.set(target.key, target);
      }
    }
    group.requests.push(request);
  }

  // Keep groups on one runner sequential. This avoids overlapping ACL reads
  // when a later group shares a target with an earlier group that could not
  // fit under the bounded target/JSON limits.
  let previous = Promise.resolve();
  for (const group of groups) {
    const batchTargets = [...group.targets.values()];
    const hasIdentityConflict = batchTargets.some((target) => {
      return group.requests.some((request) => request.targets.some((candidate) => {
        return candidate.key === target.key &&
          !sameCredentialIdentity(candidate.identity, target.identity);
      }));
    });
    const operation = hasIdentityConflict
      ? previous.then(() => { throw new Error("ACL target identity changed"); })
      : previous.then(() => executeWindowsProtectedAclInspection(batchTargets, runner));
    previous = operation.catch(() => undefined);
    for (const target of batchTargets) {
      windowsProtectedAclInspectionPending.set(target.key, {
        identity: target.identity,
        runner,
        operation,
      });
    }
    operation.then(
      () => clearWindowsProtectedAclPending(batchTargets, operation),
      () => clearWindowsProtectedAclPending(batchTargets, operation),
    );
    for (const request of group.requests) {
      operation.then(request.resolve, request.reject);
    }
  }
}

function mergeWindowsProtectedAclTargets(
  existing: Map<string, WindowsProtectedAclInspectionTarget>,
  additional: readonly WindowsProtectedAclInspectionTarget[],
): Map<string, WindowsProtectedAclInspectionTarget> {
  const merged = new Map(existing);
  for (const target of additional) {
    if (!merged.has(target.key)) merged.set(target.key, target);
  }
  return merged;
}

function canFitWindowsProtectedAclBatch(
  targets: readonly LocalBridgeWindowsProtectedAclTarget[],
): boolean {
  if (targets.length === 0 || targets.length > WINDOWS_PROTECTED_ACL_BATCH_MAX_TARGETS) {
    return false;
  }
  const serializedTargets = JSON.stringify(
    targets.map((target) => ({ path: target.path, kind: target.kind })),
  );
  if (typeof serializedTargets !== "string") {
    throw new Error("ACL target batch is invalid.");
  }
  return Buffer.byteLength(serializedTargets, "utf8") <=
    WINDOWS_PROTECTED_ACL_BATCH_MAX_JSON_BYTES;
}

function clearWindowsProtectedAclPending(
  targets: WindowsProtectedAclInspectionTarget[],
  operation: Promise<void>,
): void {
  for (const target of targets) {
    if (windowsProtectedAclInspectionPending.get(target.key)?.operation === operation) {
      windowsProtectedAclInspectionPending.delete(target.key);
    }
  }
}

async function executeWindowsProtectedAclInspection(
  targets: WindowsProtectedAclInspectionTarget[],
  runner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  if (targets.length === 1) {
    const [target] = targets;
    await runWindowsAclScript(WINDOWS_INSPECT_ACL_SCRIPT, target.path, target.kind, runner);
  } else {
    await runWindowsAclBatchScript(targets, runner);
  }

  const identitiesAfter = await Promise.all(
    targets.map(async (target) => {
      const identity = await lstat(target.path);
      assertLocalBridgeAclTargetStats(identity, target.kind);
      return identity;
    }),
  );
  for (let index = 0; index < targets.length; index += 1) {
    if (!sameCredentialIdentity(targets[index].identity, identitiesAfter[index])) {
      throw new Error("ACL target identity changed");
    }
  }

  const validatedAtMs = performance.now();
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    windowsProtectedAclInspectionCache.set(target.key, {
      identity: identitiesAfter[index],
      runner,
      validatedAtMs,
    });
  }
  trimWindowsProtectedAclInspectionCache();
}

function windowsProtectedAclCacheKey(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
): string {
  return `${kind}\0${path}`;
}

function trimWindowsProtectedAclInspectionCache(): void {
  while (windowsProtectedAclInspectionCache.size > WINDOWS_PROTECTED_ACL_CACHE_MAX_ENTRIES) {
    const oldestKey = windowsProtectedAclInspectionCache.keys().next().value;
    if (oldestKey === undefined) return;
    windowsProtectedAclInspectionCache.delete(oldestKey);
  }
}

async function runWindowsAclScript(
  script: string,
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  execFileRunner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  await runWindowsAclCommand(
    script,
    {
      MEANTHIS_MCP_ACL_TARGET_PATH: path,
      MEANTHIS_MCP_ACL_TARGET_KIND: kind,
    },
    execFileRunner,
  );
}

async function runWindowsAclBatchScript(
  targets: readonly LocalBridgeWindowsProtectedAclTarget[],
  execFileRunner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  if (targets.length === 0 || targets.length > WINDOWS_PROTECTED_ACL_BATCH_MAX_TARGETS) {
    throw new Error("ACL target batch is too large.");
  }
  const serializedTargets = JSON.stringify(
    targets.map(({ path, kind }) => ({ path, kind })),
  );
  if (Buffer.byteLength(serializedTargets, "utf8") > WINDOWS_PROTECTED_ACL_BATCH_MAX_JSON_BYTES) {
    throw new Error("ACL target batch is too large.");
  }
  await runWindowsAclCommand(
    WINDOWS_INSPECT_ACL_BATCH_SCRIPT,
    {
      MEANTHIS_MCP_ACL_TARGETS_JSON: serializedTargets,
    },
    execFileRunner,
  );
}

async function runWindowsAclCommand(
  script: string,
  extraEnvironment: Record<string, string>,
  execFileRunner: LocalBridgeWindowsAclExecFile,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnvironment,
  };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === MEANTHIS_MCP_HTTP_TOKEN_ENV) {
      delete environment[key];
    }
  }

  for (const host of ["pwsh.exe", "powershell.exe"]) {
    try {
      await execFileRunner(host, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ], {
        env: environment,
        timeout: 15_000,
        windowsHide: true,
      });
      return;
    } catch (error) {
      if (isMissingExecutable(error)) continue;
      throw new Error("Windows ACL command failed.");
    }
  }

  throw new Error("PowerShell is required for the local bridge protected ACL.");
}

function assertLocalBridgeAclTargetStats(
  stats: Stats,
  kind: LocalBridgeMcpHttpAclTargetKind,
): void {
  const validType = kind === "directory"
    ? stats.isDirectory()
    : kind === "file" && stats.isFile();
  if (!validType || stats.isSymbolicLink()) {
    throw new Error("Local bridge protected ACL target is invalid.");
  }
}

const WINDOWS_INSPECT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPath = $env:MEANTHIS_MCP_ACL_TARGET_PATH
$targetKind = $env:MEANTHIS_MCP_ACL_TARGET_KIND
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'Missing ACL target path.' }
if ($targetKind -ne 'directory' -and $targetKind -ne 'file') { throw 'Invalid ACL target kind.' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')
$inheritance = if ($targetKind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$readback = Get-Acl -LiteralPath $targetPath
if (-not $readback.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled.' }
$rules = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'ACL rule count is invalid.' }
$expectedSids = @($currentSid.Value, $systemSid.Value) | Sort-Object
$actualSids = @()
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains.' }
  if ($rule.AccessControlType -ne $allow) { throw 'Non-allow ACL rule remains.' }
  if ([int64]$rule.FileSystemRights -ne [int64]$rights) { throw 'ACL rights are not FullControl.' }
  if ([int64]$rule.InheritanceFlags -ne [int64]$inheritance) { throw 'ACL inheritance flags are invalid.' }
  if ([int64]$rule.PropagationFlags -ne [int64]$propagation) { throw 'ACL propagation flags are invalid.' }
  $actualSids += $rule.IdentityReference.Value
}
$actualSids = $actualSids | Sort-Object
if ((Compare-Object -ReferenceObject $expectedSids -DifferenceObject $actualSids).Count -ne 0) {
  throw 'ACL principals are invalid.'
}
`;

const WINDOWS_INSPECT_ACL_BATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rawTargets = $env:MEANTHIS_MCP_ACL_TARGETS_JSON
if ([string]::IsNullOrWhiteSpace($rawTargets)) { throw 'Missing ACL targets.' }
$targets = @($rawTargets | ConvertFrom-Json)
if ($targets.Count -lt 1) { throw 'ACL targets are empty.' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($target in $targets) {
  $targetPath = [string]$target.path
  $targetKind = [string]$target.kind
  if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'Missing ACL target path.' }
  if ($targetKind -ne 'directory' -and $targetKind -ne 'file') { throw 'Invalid ACL target kind.' }
  $inheritance = if ($targetKind -eq 'directory') {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  $readback = Get-Acl -LiteralPath $targetPath
  if (-not $readback.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled.' }
  $rules = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'ACL rule count is invalid.' }
  $expectedSids = @($currentSid.Value, $systemSid.Value) | Sort-Object
  $actualSids = @()
  foreach ($rule in $rules) {
    if ($rule.IsInherited) { throw 'Inherited ACL rule remains.' }
    if ($rule.AccessControlType -ne $allow) { throw 'Non-allow ACL rule remains.' }
    if ([int64]$rule.FileSystemRights -ne [int64]$rights) { throw 'ACL rights are not FullControl.' }
    if ([int64]$rule.InheritanceFlags -ne [int64]$inheritance) { throw 'ACL inheritance flags are invalid.' }
    if ([int64]$rule.PropagationFlags -ne [int64]$propagation) { throw 'ACL propagation flags are invalid.' }
    $actualSids += $rule.IdentityReference.Value
  }
  $actualSids = $actualSids | Sort-Object
  if ((Compare-Object -ReferenceObject $expectedSids -DifferenceObject $actualSids).Count -ne 0) {
    throw 'ACL principals are invalid.'
  }
}
`;

const WINDOWS_PROTECTED_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPath = $env:MEANTHIS_MCP_ACL_TARGET_PATH
$targetKind = $env:MEANTHIS_MCP_ACL_TARGET_KIND
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'Missing ACL target path.' }
if ($targetKind -ne 'directory' -and $targetKind -ne 'file') { throw 'Invalid ACL target kind.' }

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')
$acl = Get-Acl -LiteralPath $targetPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}

$inheritance = if ($targetKind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($sid in @($currentSid, $systemSid)) {
  $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, $allow)
  [void]$acl.AddAccessRule($accessRule)
}
Set-Acl -LiteralPath $targetPath -AclObject $acl

$readback = Get-Acl -LiteralPath $targetPath
if (-not $readback.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled.' }
$rules = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'ACL rule count is invalid.' }
$expectedSids = @($currentSid.Value, $systemSid.Value) | Sort-Object
$actualSids = @()
foreach ($rule in $rules) {
  if ($rule.IsInherited) { throw 'Inherited ACL rule remains.' }
  if ($rule.AccessControlType -ne $allow) { throw 'Non-allow ACL rule remains.' }
  if ([int64]$rule.FileSystemRights -ne [int64]$rights) { throw 'ACL rights are not FullControl.' }
  if ([int64]$rule.InheritanceFlags -ne [int64]$inheritance) { throw 'ACL inheritance flags are invalid.' }
  if ([int64]$rule.PropagationFlags -ne [int64]$propagation) { throw 'ACL propagation flags are invalid.' }
  $actualSids += $rule.IdentityReference.Value
}
$actualSids = $actualSids | Sort-Object
if ((Compare-Object -ReferenceObject $expectedSids -DifferenceObject $actualSids).Count -ne 0) {
  throw 'ACL principals are invalid.'
}
`;

function assertSupportedProtectedBuildMarkerFileName(
  fileName: string,
): asserts fileName is LocalBridgeProtectedBuildMarkerFileName {
  if (
    fileName !== MEANTHIS_MCP_HTTP_DESIRED_IDENTITY_FILE_NAME &&
    fileName !== MEANTHIS_LOCAL_BRIDGE_OWNER_DESIRED_IDENTITY_FILE_NAME
  ) {
    throw new LocalBridgeMcpHttpDesiredIdentityReadError();
  }
}

function invalidExistingCredential(): Error {
  return new InvalidMcpHttpCredentialError("Existing MCP HTTP credential is invalid.");
}

class InvalidMcpHttpCredentialError extends Error {}

class McpHttpCredentialPermissionError extends Error {
  constructor(options: ErrorOptions) {
    super("MCP HTTP credential permissions are invalid.", options);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
