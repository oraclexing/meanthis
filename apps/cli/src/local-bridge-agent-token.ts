import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyLocalBridgeWindowsProtectedAcl,
  inspectLocalBridgeWindowsProtectedAcl,
  inspectLocalBridgeWindowsProtectedAclBatch,
  type ApplyLocalBridgeMcpHttpAcl,
  type InspectLocalBridgeMcpHttpAcl,
  type LocalBridgeMcpHttpAclTargetKind,
} from "./local-bridge-mcp-http-token.js";

export const LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_REQUIRED = "rotation_required" as const;
export const LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED =
  "rotation_committed_but_unverified" as const;
export const MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND = "bridge-agent-key-v2" as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORED_TOKEN_PATTERN = /^([A-Za-z0-9_-]{43})(?:\r?\n)?$/;
const MAX_STORED_TOKEN_BYTES = 45;
const CONCURRENT_CREATOR_RETRY_COUNT = 50;
const CONCURRENT_CREATOR_RETRY_DELAY_MS = 10;

export interface LocalBridgeAgentTokenOptions {
  codexHome?: string;
  randomBytes?: (size: number) => Uint8Array;
  processPlatform?: NodeJS.Platform;
  applyAcl?: ApplyLocalBridgeMcpHttpAcl;
  inspectAcl?: InspectLocalBridgeMcpHttpAcl;
  /** @internal Deterministic seam for credential readback and replacement tests. */
  readCredentialFile?: (path: string) => Promise<string>;
}

export type LocalBridgeAgentTokenInspection =
  | {
    kind: typeof MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND;
    status: "ready";
    fingerprint: string;
  }
  | {
    kind: typeof MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND;
    status: "missing" | "invalid" | "insecure" | "unavailable";
  };

export class LocalBridgeAgentTokenRotationRequiredError extends Error {
  readonly code = "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED";
  readonly status = LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_REQUIRED;
  readonly rotationRequired = true;
  readonly credentialReused = false;
  readonly credentialMayHaveBeenExposed = true;

  constructor() {
    super(
      "Existing local bridge agent credential permissions are insecure or unverifiable; the credential may have been exposed and explicit rotation is required.",
    );
    this.name = "LocalBridgeAgentTokenRotationRequiredError";
  }
}

export class LocalBridgeAgentTokenUnavailableError extends Error {
  readonly code = "BRIDGE_AGENT_CREDENTIAL_UNAVAILABLE";

  constructor() {
    super("Local bridge agent credential is unavailable.");
    this.name = "LocalBridgeAgentTokenUnavailableError";
  }
}

export class LocalBridgeAgentTokenRotationCommittedButUnverifiedError extends Error {
  readonly code = "BRIDGE_AGENT_CREDENTIAL_ROTATION_COMMITTED_BUT_UNVERIFIED";
  readonly status = LOCAL_BRIDGE_AGENT_TOKEN_ROTATION_COMMITTED_BUT_UNVERIFIED;
  readonly rotationCommitted = true;
  readonly credentialVerified = false;

  constructor() {
    super("Local bridge agent credential rotation committed but could not be verified.");
    this.name = "LocalBridgeAgentTokenRotationCommittedButUnverifiedError";
  }
}

class InvalidLocalBridgeAgentTokenError extends Error {
  constructor(message = "Existing local bridge credential is invalid.") {
    super(message);
    this.name = "InvalidLocalBridgeAgentTokenError";
  }
}

class LocalBridgeAgentCredentialPermissionError extends Error {
  constructor() {
    super("Local bridge agent credential permissions are invalid.");
    this.name = "LocalBridgeAgentCredentialPermissionError";
  }
}

interface CredentialPaths {
  directory: string;
  path: string;
}

interface OwnedDirectory {
  path: string;
  identity: Stats;
}

export function getLocalBridgeAgentTokenPath(codexHome = resolveCodexHome()): string {
  return join(resolve(codexHome), "ui-attach", MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND);
}

export function validateLocalBridgeAgentToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const decoded = Buffer.from(token, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === token;
}

export function fingerprintLocalBridgeAgentToken(token: string): string {
  if (!validateLocalBridgeAgentToken(token)) {
    throw new Error("Local bridge agent credential is invalid.");
  }
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Fast byte/identity watcher read for an owner that already completed a secure
 * startup load. ACL drift belongs to the independent inspect path below.
 */
export async function readLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<string> {
  const paths = resolveCredentialPaths(options);
  try {
    const directoryBefore = await lstat(paths.directory);
    const fileBefore = await lstat(paths.path);
    assertDirectoryStats(directoryBefore);
    assertCredentialFileStats(fileBefore);

    const token = await readCredentialWithoutMutation(
      paths.path,
      options.readCredentialFile,
    );
    const [directoryAfter, fileAfter] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    assertDirectoryStats(directoryAfter);
    assertCredentialFileStats(fileAfter);
    if (
      !sameCredentialIdentity(directoryBefore, directoryAfter) ||
      !sameCredentialIdentity(fileBefore, fileAfter)
    ) {
      throw new Error("credential identity changed");
    }
    return token;
  } catch {
    throw new LocalBridgeAgentTokenUnavailableError();
  }
}

/**
 * Secure startup read for an already-installed credential. Unlike
 * loadOrCreateLocalBridgeAgentToken, this path never creates or repairs
 * credential storage.
 */
export async function readVerifiedLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<string> {
  try {
    return await readExistingCredentialForReuse(resolveCredentialPaths(options), options);
  } catch (error) {
    if (
      error instanceof LocalBridgeAgentTokenRotationRequiredError ||
      error instanceof LocalBridgeAgentTokenUnavailableError
    ) {
      throw error;
    }
    throw new LocalBridgeAgentTokenUnavailableError();
  }
}

export async function inspectLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<LocalBridgeAgentTokenInspection> {
  const base = { kind: MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND } as const;
  const paths = resolveCredentialPaths(options);

  let directory: Stats;
  try {
    directory = await lstat(paths.directory);
  } catch (error) {
    return isMissing(error)
      ? { ...base, status: "missing" }
      : { ...base, status: "unavailable" };
  }
  try {
    assertDirectoryStats(directory);
  } catch {
    return { ...base, status: "invalid" };
  }

  let file: Stats;
  try {
    file = await lstat(paths.path);
  } catch (error) {
    return isMissing(error)
      ? { ...base, status: "missing" }
      : { ...base, status: "unavailable" };
  }
  try {
    assertCredentialFileStats(file);
  } catch {
    return { ...base, status: "invalid" };
  }

  try {
    const token = await readExistingCredentialForReuse(paths, options);
    return {
      ...base,
      status: "ready",
      fingerprint: fingerprintLocalBridgeAgentToken(token),
    };
  } catch (error) {
    if (error instanceof LocalBridgeAgentTokenRotationRequiredError) {
      return { ...base, status: "insecure" };
    }
    if (error instanceof InvalidLocalBridgeAgentTokenError) {
      return { ...base, status: "invalid" };
    }
    return { ...base, status: "unavailable" };
  }
}

export async function loadOrCreateLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<string> {
  const paths = resolveCredentialPaths(options);
  if (await credentialExists(paths)) {
    return readExistingCredentialForReuse(paths, options);
  }

  const ownedDirectory = await prepareCredentialDirectoryForCreation(paths, options);
  let completed = false;
  try {
    const token = generateToken(options.randomBytes);
    try {
      await writeFile(paths.path, `${token}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw new LocalBridgeAgentTokenUnavailableError();
      const winner = await readConcurrentCreatorCredential(paths, options);
      completed = true;
      return winner;
    }

    const createdIdentity = await lstat(paths.path);
    try {
      await secureCreatedPath(paths.path, "file", options);
      const stored = await readCredentialWithoutMutation(
        paths.path,
        options.readCredentialFile,
      );
      const verifiedIdentity = await lstat(paths.path);
      if (!sameFileIdentity(createdIdentity, verifiedIdentity) || stored !== token) {
        throw new Error("credential identity changed");
      }
      completed = true;
      return token;
    } catch {
      await removeCreatedCredentialIfUnchanged(paths.path, createdIdentity, `${token}\n`);
      throw new LocalBridgeAgentTokenUnavailableError();
    }
  } finally {
    if (!completed && ownedDirectory) {
      await removeOwnedDirectoryIfEmpty(ownedDirectory);
    }
  }
}

async function readConcurrentCreatorCredential(
  paths: CredentialPaths,
  options: LocalBridgeAgentTokenOptions,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONCURRENT_CREATOR_RETRY_COUNT; attempt += 1) {
    try {
      return await readExistingCredentialForReuse(paths, options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < CONCURRENT_CREATOR_RETRY_COUNT) {
        await delay(CONCURRENT_CREATOR_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

/**
 * Explicitly replaces a credential that may already have been exposed. Callers
 * must coordinate process turnover around this operation before reusing it.
 */
export async function rotateLocalBridgeAgentToken(
  options: LocalBridgeAgentTokenOptions = {},
): Promise<string> {
  const paths = resolveCredentialPaths(options);
  const ownedDirectory = await prepareCredentialDirectoryForCreation(paths, options);
  const token = generateToken(options.randomBytes);
  const temporaryPath = join(
    paths.directory,
    `.${MEANTHIS_LOCAL_BRIDGE_AGENT_KEY_KIND}.${process.pid}.${secureRandomBytes(12).toString("hex")}.tmp`,
  );
  let temporaryIdentity: Stats | undefined;
  let committed = false;

  try {
    await writeFile(temporaryPath, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryIdentity = await lstat(temporaryPath);
    await secureCreatedPath(temporaryPath, "file", options);
    const prepared = await readCredentialWithoutMutation(
      temporaryPath,
      options.readCredentialFile,
    );
    const verifiedIdentity = await lstat(temporaryPath);
    if (!sameFileIdentity(temporaryIdentity, verifiedIdentity) || prepared !== token) {
      throw new LocalBridgeAgentTokenUnavailableError();
    }

    await rename(temporaryPath, paths.path);
    committed = true;
    try {
      const stored = await readExistingCredentialForReuse(paths, options);
      if (stored !== token) throw new Error("credential mismatch");
      return stored;
    } catch {
      throw new LocalBridgeAgentTokenRotationCommittedButUnverifiedError();
    }
  } catch (error) {
    if (
      error instanceof LocalBridgeAgentTokenRotationCommittedButUnverifiedError ||
      error instanceof LocalBridgeAgentTokenUnavailableError
    ) {
      throw error;
    }
    throw new LocalBridgeAgentTokenUnavailableError();
  } finally {
    if (!committed && temporaryIdentity) {
      await removeCreatedCredentialIfUnchanged(
        temporaryPath,
        temporaryIdentity,
        `${token}\n`,
      );
    }
    if (!committed && ownedDirectory) {
      await removeOwnedDirectoryIfEmpty(ownedDirectory);
    }
  }
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
}

function resolveCredentialPaths(
  options: Pick<LocalBridgeAgentTokenOptions, "codexHome">,
): CredentialPaths {
  const codexHome = options.codexHome ? resolve(options.codexHome) : resolveCodexHome();
  return {
    directory: join(codexHome, "ui-attach"),
    path: getLocalBridgeAgentTokenPath(codexHome),
  };
}

async function credentialExists(paths: CredentialPaths): Promise<boolean> {
  try {
    const directory = await lstat(paths.directory);
    assertDirectoryStats(directory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw invalidExistingCredential();
  }

  try {
    await lstat(paths.path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw invalidExistingCredential();
  }
}

async function prepareCredentialDirectoryForCreation(
  paths: CredentialPaths,
  options: LocalBridgeAgentTokenOptions,
): Promise<OwnedDirectory | undefined> {
  let directoryExisted = true;
  try {
    const existing = await lstat(paths.directory);
    assertDirectoryStats(existing);
  } catch (error) {
    if (!isMissing(error)) throw invalidExistingCredential();
    directoryExisted = false;
  }

  let ownedDirectory: OwnedDirectory | undefined;
  try {
    const createdPath = await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const identity = await lstat(paths.directory);
    assertDirectoryStats(identity);
    if (!directoryExisted && createdPath !== undefined) {
      ownedDirectory = { path: paths.directory, identity };
    }
    await secureCredentialDirectoryForCreation(
      paths.directory,
      directoryExisted,
      options,
    );
    return ownedDirectory;
  } catch {
    if (ownedDirectory) await removeOwnedDirectoryIfEmpty(ownedDirectory);
    throw new LocalBridgeAgentTokenUnavailableError();
  }
}

async function secureCredentialDirectoryForCreation(
  path: string,
  directoryExisted: boolean,
  options: LocalBridgeAgentTokenOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  if (platform === "win32" && directoryExisted) {
    try {
      await (options.inspectAcl ?? inspectLocalBridgeWindowsProtectedAcl)(path, "directory");
      return;
    } catch {
      // Explicit creation or rotation may repair an existing insecure profile directory.
    }
  }
  await secureCreatedPath(path, "directory", options);
}

async function readExistingCredentialForReuse(
  paths: CredentialPaths,
  options: LocalBridgeAgentTokenOptions,
): Promise<string> {
  try {
    const [directoryBefore, fileBefore] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    assertDirectoryStats(directoryBefore);
    assertCredentialFileStats(fileBefore);
    await inspectExistingPaths(paths, options);

    const token = await readCredentialWithoutMutation(
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
      throw invalidExistingCredential();
    }

    await inspectExistingPaths(paths, options);
    const [directoryFinal, fileFinal] = await Promise.all([
      lstat(paths.directory),
      lstat(paths.path),
    ]);
    if (
      !sameCredentialIdentity(directoryBefore, directoryFinal) ||
      !sameCredentialIdentity(fileBefore, fileFinal)
    ) {
      throw invalidExistingCredential();
    }
    return token;
  } catch (error) {
    if (error instanceof LocalBridgeAgentCredentialPermissionError) {
      throw new LocalBridgeAgentTokenRotationRequiredError();
    }
    if (error instanceof InvalidLocalBridgeAgentTokenError) throw error;
    if (error instanceof LocalBridgeAgentTokenUnavailableError) throw error;
    throw new LocalBridgeAgentTokenUnavailableError();
  }
}

async function secureCreatedPath(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeAgentTokenOptions,
): Promise<void> {
  const platform = options.processPlatform ?? process.platform;
  if (platform === "win32") {
    await (options.applyAcl ?? applyLocalBridgeWindowsProtectedAcl)(path, kind);
    await (options.inspectAcl ?? inspectLocalBridgeWindowsProtectedAcl)(path, kind);
    return;
  }

  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  await chmod(path, expectedMode);
  const stats = await lstat(path);
  assertPathType(stats, kind);
  if ((stats.mode & 0o777) !== expectedMode) {
    throw new Error("permissions mismatch");
  }
}

async function inspectExistingPath(
  path: string,
  kind: LocalBridgeMcpHttpAclTargetKind,
  options: LocalBridgeAgentTokenOptions,
): Promise<void> {
  try {
    const platform = options.processPlatform ?? process.platform;
    if (platform === "win32") {
      await (options.inspectAcl ?? inspectLocalBridgeWindowsProtectedAcl)(path, kind);
      return;
    }

    const expectedMode = kind === "directory" ? 0o700 : 0o600;
    const stats = await lstat(path);
    assertPathType(stats, kind);
    if ((stats.mode & 0o777) !== expectedMode) {
      throw new Error("permissions mismatch");
    }
  } catch {
    throw new LocalBridgeAgentCredentialPermissionError();
  }
}

async function inspectExistingPaths(
  paths: CredentialPaths,
  options: LocalBridgeAgentTokenOptions,
): Promise<void> {
  try {
    const platform = options.processPlatform ?? process.platform;
    if (platform === "win32" && !options.inspectAcl) {
      await inspectLocalBridgeWindowsProtectedAclBatch([
        { path: paths.directory, kind: "directory" },
        { path: paths.path, kind: "file" },
      ]);
      return;
    }
    await inspectExistingPath(paths.directory, "directory", options);
    await inspectExistingPath(paths.path, "file", options);
  } catch {
    throw new LocalBridgeAgentCredentialPermissionError();
  }
}

async function readCredentialWithoutMutation(
  path: string,
  readCredentialFile: (path: string) => Promise<string> = (candidatePath) =>
    readFile(candidatePath, "utf8"),
): Promise<string> {
  const stats = await lstat(path);
  assertCredentialFileStats(stats);
  const raw = await readCredentialFile(path);
  const match = STORED_TOKEN_PATTERN.exec(raw);
  if (!match || !validateLocalBridgeAgentToken(match[1])) {
    throw invalidExistingCredential();
  }
  return match[1];
}

function generateToken(randomBytes?: (size: number) => Uint8Array): string {
  const bytes = (randomBytes ?? ((size: number) => secureRandomBytes(size)))(32);
  if (bytes.byteLength !== 32) {
    throw new InvalidLocalBridgeAgentTokenError(
      "Generated local bridge credential is invalid.",
    );
  }
  const token = Buffer.from(bytes).toString("base64url");
  if (!validateLocalBridgeAgentToken(token)) {
    throw new InvalidLocalBridgeAgentTokenError(
      "Generated local bridge credential is invalid.",
    );
  }
  return token;
}

function assertDirectoryStats(stats: Stats): void {
  assertPathType(stats, "directory");
}

function assertCredentialFileStats(stats: Stats): void {
  assertPathType(stats, "file");
  if (stats.size > MAX_STORED_TOKEN_BYTES) throw invalidExistingCredential();
}

function assertPathType(stats: Stats, kind: LocalBridgeMcpHttpAclTargetKind): void {
  const validType = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!validType || stats.isSymbolicLink()) throw invalidExistingCredential();
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

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.birthtimeMs === actual.birthtimeMs;
}

function sameDirectoryIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeMs === actual.birthtimeMs;
}

async function removeCreatedCredentialIfUnchanged(
  path: string,
  createdIdentity: Stats,
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
    // Best effort only: never delete another creator's credential.
  }
}

async function removeOwnedDirectoryIfEmpty(owned: OwnedDirectory): Promise<void> {
  try {
    let current = await lstat(owned.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(owned.identity, current) ||
      (await readdir(owned.path)).length !== 0
    ) {
      return;
    }
    current = await lstat(owned.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(owned.identity, current) ||
      (await readdir(owned.path)).length !== 0
    ) {
      return;
    }
    await rmdir(owned.path);
  } catch {
    // Best effort only: an identity or contents change belongs to another actor.
  }
}

function invalidExistingCredential(): InvalidLocalBridgeAgentTokenError {
  return new InvalidLocalBridgeAgentTokenError();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
