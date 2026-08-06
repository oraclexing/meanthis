import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isUIAttachmentSourceAnchor,
  type UIAttachmentSourceAnchor,
} from "@meanthis/schema";

export const UI_ATTACH_SOURCE_MAP_SIDECAR_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_SOURCE_MAP_SIDECAR_KIND = "ui-attach.source-map-sidecar" as const;
export const UI_ATTACH_SOURCE_MAP_DEFAULT_PATH = ".ui-attach/source-map.json" as const;
export const UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_SOURCE_RESOLUTION_KIND = "ui-attach.source-resolution" as const;

const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const INTRINSIC_TAG_NAME = /^[a-z][A-Za-z0-9-]*$/;
const MAX_SOURCE_MAP_ENTRIES = 100_000;
const MAX_SIDECAR_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 5;
const MAX_WORKSPACE_ROOTS = 32;

export interface UIAttachSourceMapEntry {
  sourceId: string;
  path: string;
  line: number;
  column: number;
  tagName: string;
  componentName: string | null;
  contentHash: string;
}

export interface UIAttachSourceMapSidecarV1 {
  schemaVersion: typeof UI_ATTACH_SOURCE_MAP_SIDECAR_SCHEMA_VERSION;
  kind: typeof UI_ATTACH_SOURCE_MAP_SIDECAR_KIND;
  buildId: string;
  entries: UIAttachSourceMapEntry[];
}

export type UIAttachSourceExactFailureReason =
  | "source_anchor_missing"
  | "source_anchor_invalid"
  | "workspace_unavailable"
  | "workspace_limit_exceeded"
  | "workspace_no_match"
  | "workspace_ambiguous"
  | "sidecar_missing"
  | "sidecar_unreadable"
  | "sidecar_outside_workspace"
  | "sidecar_too_large"
  | "sidecar_invalid"
  | "build_mismatch"
  | "source_id_not_found"
  | "source_path_outside_workspace"
  | "source_file_missing"
  | "source_file_unreadable"
  | "source_file_too_large"
  | "source_hash_mismatch";

export interface UIAttachSourceCandidate {
  path: string;
  line: number | null;
  column: number | null;
  confidence: number;
}

export type UIAttachSourceResolutionV1 =
  | {
      schemaVersion: typeof UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION;
      kind: typeof UI_ATTACH_SOURCE_RESOLUTION_KIND;
      status: "verified";
      buildId: string;
      sourceId: string;
      location: Omit<UIAttachSourceMapEntry, "sourceId" | "contentHash">;
    }
  | {
      schemaVersion: typeof UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION;
      kind: typeof UI_ATTACH_SOURCE_RESOLUTION_KIND;
      status: "candidate";
      exactFailureReason: UIAttachSourceExactFailureReason;
      candidates: UIAttachSourceCandidate[];
    }
  | {
      schemaVersion: typeof UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION;
      kind: typeof UI_ATTACH_SOURCE_RESOLUTION_KIND;
      status: "unavailable";
      reason: UIAttachSourceExactFailureReason;
    };

export interface ResolveUIAttachSourceOptions {
  workspaceRoot: string;
  anchor: unknown;
  candidates?: readonly unknown[];
}

export interface ResolveUIAttachSourceAcrossWorkspacesOptions {
  workspaceRoots: readonly string[];
  anchor: unknown;
  candidates?: readonly unknown[];
}

export function createSourceContentHash(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("base64url");
}

export function createSourceMapSidecar(
  buildId: string,
  mappings: readonly UIAttachSourceMapEntry[],
): UIAttachSourceMapSidecarV1 {
  assertOpaqueId(buildId, "buildId");
  if (mappings.length > MAX_SOURCE_MAP_ENTRIES) {
    throw new Error(`MeanThis source sidecar exceeded ${MAX_SOURCE_MAP_ENTRIES} entries.`);
  }
  const entries = mappings
    .map((entry) => ({ ...entry }))
    .sort(compareSourceMapEntries);
  const sidecar: UIAttachSourceMapSidecarV1 = {
    schemaVersion: UI_ATTACH_SOURCE_MAP_SIDECAR_SCHEMA_VERSION,
    kind: UI_ATTACH_SOURCE_MAP_SIDECAR_KIND,
    buildId,
    entries,
  };
  if (!isUIAttachSourceMapSidecar(sidecar)) {
    throw new Error("MeanThis source sidecar contains invalid mapping data.");
  }
  return sidecar;
}

export function isUIAttachSourceMapSidecar(
  value: unknown,
): value is UIAttachSourceMapSidecarV1 {
  if (
    !hasExactKeys(value, ["schemaVersion", "kind", "buildId", "entries"]) ||
    value.schemaVersion !== UI_ATTACH_SOURCE_MAP_SIDECAR_SCHEMA_VERSION ||
    value.kind !== UI_ATTACH_SOURCE_MAP_SIDECAR_KIND ||
    !isOpaqueId(value.buildId) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_SOURCE_MAP_ENTRIES
  ) {
    return false;
  }
  const sourceIds = new Set<string>();
  for (const entry of value.entries) {
    if (!isSourceMapEntry(entry) || sourceIds.has(entry.sourceId)) return false;
    sourceIds.add(entry.sourceId);
  }
  return true;
}

export async function resolveUIAttachSource(
  options: ResolveUIAttachSourceOptions,
): Promise<UIAttachSourceResolutionV1> {
  const candidates = normalizeCandidates(options.candidates);
  if (options.anchor === undefined || options.anchor === null) {
    return fallback("source_anchor_missing", candidates);
  }
  if (!isUIAttachmentSourceAnchor(options.anchor)) {
    return fallback("source_anchor_invalid", candidates);
  }
  const anchor: UIAttachmentSourceAnchor = options.anchor;

  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(resolve(options.workspaceRoot));
    if (!(await stat(workspaceRoot)).isDirectory()) {
      return fallback("workspace_unavailable", candidates);
    }
  } catch {
    return fallback("workspace_unavailable", candidates);
  }

  const sidecarResult = await readSidecar(workspaceRoot);
  if (!sidecarResult.ok) return fallback(sidecarResult.reason, candidates);
  const sidecar = sidecarResult.sidecar;
  if (sidecar.buildId !== anchor.buildId) {
    return fallback("build_mismatch", candidates);
  }
  const entry = sidecar.entries.find((candidate) => candidate.sourceId === anchor.sourceId);
  if (!entry) return fallback("source_id_not_found", candidates);

  const sourcePath = resolve(workspaceRoot, ...entry.path.split("/"));
  if (!isPathInside(workspaceRoot, sourcePath)) {
    return fallback("source_path_outside_workspace", candidates);
  }
  let sourceRealPath: string;
  try {
    sourceRealPath = await realpath(sourcePath);
  } catch (error) {
    return fallback(isMissingFileError(error) ? "source_file_missing" : "source_file_unreadable", candidates);
  }
  if (!isPathInside(workspaceRoot, sourceRealPath)) {
    return fallback("source_path_outside_workspace", candidates);
  }

  let sourceBytes: Uint8Array;
  try {
    const sourceStat = await stat(sourceRealPath);
    if (!sourceStat.isFile()) return fallback("source_file_unreadable", candidates);
    if (sourceStat.size > MAX_SOURCE_FILE_BYTES) {
      return fallback("source_file_too_large", candidates);
    }
    sourceBytes = await readFile(sourceRealPath);
    if (sourceBytes.byteLength > MAX_SOURCE_FILE_BYTES) {
      return fallback("source_file_too_large", candidates);
    }
  } catch {
    return fallback("source_file_unreadable", candidates);
  }
  if (createSourceContentHash(sourceBytes) !== entry.contentHash) {
    return fallback("source_hash_mismatch", candidates);
  }

  const {
    sourceId: _entrySourceId,
    contentHash: _entryContentHash,
    ...location
  } = entry;
  return {
    schemaVersion: UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION,
    kind: UI_ATTACH_SOURCE_RESOLUTION_KIND,
    status: "verified",
    buildId: anchor.buildId,
    sourceId: anchor.sourceId,
    location,
  };
}

export async function resolveUIAttachSourceAcrossWorkspaces(
  options: ResolveUIAttachSourceAcrossWorkspacesOptions,
): Promise<UIAttachSourceResolutionV1> {
  const candidates = normalizeCandidates(options.candidates);
  if (options.anchor === undefined || options.anchor === null) {
    return fallback("source_anchor_missing", candidates);
  }
  if (!isUIAttachmentSourceAnchor(options.anchor)) {
    return fallback("source_anchor_invalid", candidates);
  }
  if (options.workspaceRoots.length > MAX_WORKSPACE_ROOTS) {
    return fallback("workspace_limit_exceeded", candidates);
  }

  const workspaceRoots = await canonicalWorkspaceRoots(options.workspaceRoots);
  if (workspaceRoots.length === 0) {
    return fallback("workspace_unavailable", candidates);
  }

  const exactResults: UIAttachSourceResolutionV1[] = [];
  for (const workspaceRoot of workspaceRoots) {
    exactResults.push(await resolveUIAttachSource({ workspaceRoot, anchor: options.anchor }));
  }
  const verified = exactResults.filter((result) => result.status === "verified");
  if (verified.length === 1) return verified[0];
  if (verified.length > 1) return fallback("workspace_ambiguous", candidates);
  if (exactResults.length === 1 && exactResults[0].status === "unavailable") {
    return fallback(exactResults[0].reason, candidates);
  }
  return fallback("workspace_no_match", candidates);
}

async function canonicalWorkspaceRoots(values: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 32_768) continue;
    try {
      const root = await realpath(resolve(value));
      if (!(await stat(root)).isDirectory()) continue;
      const key = process.platform === "win32" ? root.toLowerCase() : root;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    } catch {
      // Ignore roots that are no longer available; resolution remains fail closed.
    }
  }
  return roots;
}

async function readSidecar(
  workspaceRoot: string,
): Promise<
  | { ok: true; sidecar: UIAttachSourceMapSidecarV1 }
  | { ok: false; reason: UIAttachSourceExactFailureReason }
> {
  const sidecarPath = resolve(workspaceRoot, ...UI_ATTACH_SOURCE_MAP_DEFAULT_PATH.split("/"));
  let sidecarRealPath: string;
  try {
    sidecarRealPath = await realpath(sidecarPath);
  } catch (error) {
    return { ok: false, reason: isMissingFileError(error) ? "sidecar_missing" : "sidecar_unreadable" };
  }
  if (!isPathInside(workspaceRoot, sidecarRealPath)) {
    return { ok: false, reason: "sidecar_outside_workspace" };
  }
  let bytes: Uint8Array;
  try {
    const sidecarStat = await stat(sidecarRealPath);
    if (!sidecarStat.isFile()) return { ok: false, reason: "sidecar_unreadable" };
    if (sidecarStat.size > MAX_SIDECAR_BYTES) return { ok: false, reason: "sidecar_too_large" };
    bytes = await readFile(sidecarRealPath);
    if (bytes.byteLength > MAX_SIDECAR_BYTES) return { ok: false, reason: "sidecar_too_large" };
  } catch {
    return { ok: false, reason: "sidecar_unreadable" };
  }

  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "sidecar_invalid" };
  }
  return isUIAttachSourceMapSidecar(value)
    ? { ok: true, sidecar: value }
    : { ok: false, reason: "sidecar_invalid" };
}

function fallback(
  reason: UIAttachSourceExactFailureReason,
  candidates: UIAttachSourceCandidate[],
): UIAttachSourceResolutionV1 {
  return candidates.length > 0
    ? {
        schemaVersion: UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION,
        kind: UI_ATTACH_SOURCE_RESOLUTION_KIND,
        status: "candidate",
        exactFailureReason: reason,
        candidates,
      }
    : {
        schemaVersion: UI_ATTACH_SOURCE_RESOLUTION_SCHEMA_VERSION,
        kind: UI_ATTACH_SOURCE_RESOLUTION_KIND,
        status: "unavailable",
        reason,
      };
}

function normalizeCandidates(values: readonly unknown[] | undefined): UIAttachSourceCandidate[] {
  if (!values) return [];
  const normalized: UIAttachSourceCandidate[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isCandidate(value)) continue;
    const key = `${value.path}\0${value.line ?? ""}\0${value.column ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      path: value.path,
      line: value.line,
      column: value.column,
      confidence: value.confidence,
    });
  }
  return normalized
    .sort((left, right) =>
      right.confidence - left.confidence ||
      left.path.localeCompare(right.path) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
      (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, MAX_CANDIDATES);
}

function isCandidate(value: unknown): value is UIAttachSourceCandidate {
  return isRecord(value) &&
    isSafeRelativePath(value.path) &&
    isNullablePositiveSafeInteger(value.line) &&
    isNullablePositiveSafeInteger(value.column) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1;
}

function isSourceMapEntry(value: unknown): value is UIAttachSourceMapEntry {
  return (
    hasExactKeys(value, [
      "sourceId",
      "path",
      "line",
      "column",
      "tagName",
      "componentName",
      "contentHash",
    ]) &&
    isOpaqueId(value.sourceId) &&
    isSafeRelativePath(value.path) &&
    isPositiveSafeInteger(value.line) &&
    isPositiveSafeInteger(value.column) &&
    typeof value.tagName === "string" &&
    INTRINSIC_TAG_NAME.test(value.tagName) &&
    (value.componentName === null || (
      typeof value.componentName === "string" &&
      /^[A-Z][A-Za-z0-9_$]*$/.test(value.componentName)
    )) &&
    isOpaqueId(value.contentHash)
  );
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    !/[\0\r\n]/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function assertOpaqueId(value: string, field: string): void {
  if (!isOpaqueId(value)) throw new Error(`MeanThis ${field} must be a 43-character base64url value.`);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value);
}

function compareSourceMapEntries(
  left: UIAttachSourceMapEntry,
  right: UIAttachSourceMapEntry,
): number {
  return left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.sourceId.localeCompare(right.sourceId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[],
): value is Record<T, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
