export const CAPTURE_CLEAR_AUTHORITY_STORAGE_KEY = "ui-attach:clear-authority:v1";

export const CAPTURE_CLEAR_MAX_ACTIVE_OPERATIONS = 16;
export const CAPTURE_CLEAR_MAX_ORIGINS = 64;

export interface CaptureClearAuthorityV1 {
  version: 1;
  authorityId: string;
  generation: number;
  activeOperations: CaptureClearOperationV1[];
}

export type CaptureClearCanonicalState = "pending" | "committed" | "conflict";
export type CaptureClearCanonicalPhase =
  | "prepared"
  | "canonical_partial"
  | "canonical_committed";

export interface CaptureClearOriginV1 {
  origin: string;
  beforeEpoch: string | null;
  afterEpoch: string;
  canonical: CaptureClearCanonicalState;
}

export interface CaptureClearOperationV1 {
  version: 1;
  operationId: string;
  authorityId: string;
  generation: number;
  phase: CaptureClearCanonicalPhase;
  origins: CaptureClearOriginV1[];
  createdAt: string;
  updatedAt: string;
}

export interface CaptureClearOriginRequest {
  origin: string;
  epoch: string | null;
}

export interface CaptureClearOperationRequest {
  operationId: string;
  origins: CaptureClearOriginRequest[];
}

export interface CaptureClearOperationReference {
  authorityId: string;
  operationId: string;
  generation: number;
}

export function deriveCaptureClearCanonicalPhase(
  origins: readonly CaptureClearOriginV1[],
): CaptureClearCanonicalPhase {
  if (origins.length > 0 && origins.every((entry) => entry.canonical === "committed")) {
    return "canonical_committed";
  }
  if (origins.some((entry) => entry.canonical === "committed")) {
    return "canonical_partial";
  }
  return "prepared";
}

export function parseCaptureClearAuthority(value: unknown): CaptureClearAuthorityV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "authorityId",
    "generation",
    "activeOperations",
  ]) || value.version !== 1 || !isBoundedId(value.authorityId) ||
      !isPositiveSafeInteger(value.generation) || !Array.isArray(value.activeOperations) ||
      value.activeOperations.length > CAPTURE_CLEAR_MAX_ACTIVE_OPERATIONS) {
    return null;
  }
  const activeOperations: CaptureClearOperationV1[] = [];
  const operationIds = new Set<string>();
  const ownedOrigins = new Set<string>();
  let previousGeneration = 0;
  for (const candidate of value.activeOperations) {
    const parsed = parseCaptureClearOperation(candidate);
    if (!parsed || operationIds.has(parsed.operationId) ||
        parsed.authorityId !== value.authorityId ||
        parsed.generation <= previousGeneration || parsed.generation > value.generation ||
        parsed.origins.some((entry) => ownedOrigins.has(entry.origin))) {
      return null;
    }
    operationIds.add(parsed.operationId);
    for (const entry of parsed.origins) ownedOrigins.add(entry.origin);
    previousGeneration = parsed.generation;
    activeOperations.push(parsed);
  }
  return {
    version: 1,
    authorityId: value.authorityId,
    generation: value.generation,
    activeOperations,
  };
}

export function parseCaptureClearOperation(value: unknown): CaptureClearOperationV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "operationId",
    "authorityId",
    "generation",
    "phase",
    "origins",
    "createdAt",
    "updatedAt",
  ]) || value.version !== 1 || !isBoundedId(value.operationId) ||
      !isBoundedId(value.authorityId) || !isPositiveSafeInteger(value.generation) ||
      !isCaptureClearPhase(value.phase) || !Array.isArray(value.origins) ||
      value.origins.length === 0 || value.origins.length > CAPTURE_CLEAR_MAX_ORIGINS ||
      !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    return null;
  }
  const origins: CaptureClearOriginV1[] = [];
  const seen = new Set<string>();
  for (const candidate of value.origins) {
    const parsed = parseCaptureClearOrigin(candidate);
    if (!parsed || seen.has(parsed.origin)) return null;
    seen.add(parsed.origin);
    origins.push(parsed);
  }
  if (!isOrdinalSorted(origins.map((entry) => entry.origin)) ||
      deriveCaptureClearCanonicalPhase(origins) !== value.phase) {
    return null;
  }
  return {
    version: 1,
    operationId: value.operationId,
    authorityId: value.authorityId,
    generation: value.generation,
    phase: value.phase,
    origins,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeCaptureClearRequest(
  request: CaptureClearOperationRequest,
): CaptureClearOperationRequest | null {
  if (!isBoundedId(request.operationId) || !Array.isArray(request.origins) ||
      request.origins.length === 0 || request.origins.length > CAPTURE_CLEAR_MAX_ORIGINS) {
    return null;
  }
  const origins: CaptureClearOriginRequest[] = [];
  const seen = new Set<string>();
  for (const entry of request.origins) {
    if (!isCanonicalHttpOrigin(entry.origin) ||
        (entry.epoch !== null && !isBoundedId(entry.epoch)) || seen.has(entry.origin)) {
      return null;
    }
    seen.add(entry.origin);
    origins.push({ origin: entry.origin, epoch: entry.epoch });
  }
  origins.sort((left, right) => ordinalCompare(left.origin, right.origin));
  return { operationId: request.operationId, origins };
}

export function parseCaptureClearOperationReference(
  value: unknown,
): CaptureClearOperationReference | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "authorityId",
    "operationId",
    "generation",
  ]) || !isBoundedId(value.authorityId) || !isBoundedId(value.operationId) ||
      !isPositiveSafeInteger(value.generation)) return null;
  return {
    authorityId: value.authorityId,
    operationId: value.operationId,
    generation: value.generation,
  };
}

export function sameCaptureClearRequest(
  operation: CaptureClearOperationV1,
  request: CaptureClearOperationRequest,
): boolean {
  return operation.operationId === request.operationId &&
    operation.origins.length === request.origins.length &&
    operation.origins.every((entry, index) => {
      const requested = request.origins[index];
      return requested !== undefined && entry.origin === requested.origin &&
        entry.beforeEpoch === requested.epoch;
    });
}

function parseCaptureClearOrigin(value: unknown): CaptureClearOriginV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "origin",
    "beforeEpoch",
    "afterEpoch",
    "canonical",
  ]) || !isCanonicalHttpOrigin(value.origin) ||
      (value.beforeEpoch !== null && !isBoundedId(value.beforeEpoch)) ||
      !isBoundedId(value.afterEpoch) || !isCaptureClearState(value.canonical)) {
    return null;
  }
  return {
    origin: value.origin,
    beforeEpoch: value.beforeEpoch,
    afterEpoch: value.afterEpoch,
    canonical: value.canonical,
  };
}

function isCaptureClearState(value: unknown): value is CaptureClearCanonicalState {
  return value === "pending" || value === "committed" || value === "conflict";
}

function isCaptureClearPhase(value: unknown): value is CaptureClearCanonicalPhase {
  return value === "prepared" || value === "canonical_partial" ||
    value === "canonical_committed";
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isOrdinalSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || ordinalCompare(values[index - 1]!, value) < 0);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}
