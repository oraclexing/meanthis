/**
 * A deliberately small, metadata-only sidecar for one capture.
 *
 * This module is a pure schema boundary.  It does not collect diagnostics,
 * inspect a browser, or infer authority from a record supplied by a caller.
 */

export const UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_METADATA_DIAGNOSTICS_KIND =
  "ui-attach.metadata-only-diagnostics" as const;
export const UI_ATTACH_METADATA_DIAGNOSTICS_MAX_BYTES = 16_384 as const;

// Short aliases keep the package convenient for consumers that do not use the
// UI_ATTACH prefix used by the older schema constants.
export const METADATA_DIAGNOSTICS_SCHEMA_VERSION =
  UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION;
export const METADATA_DIAGNOSTICS_KIND = UI_ATTACH_METADATA_DIAGNOSTICS_KIND;
export const METADATA_DIAGNOSTICS_MAX_BYTES = UI_ATTACH_METADATA_DIAGNOSTICS_MAX_BYTES;

export const UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND =
  "ui-attach.private-debug-summary" as const;
export const UI_ATTACH_PRIVATE_DEBUG_SUMMARY_MAX_BYTES = 2_048 as const;
export const PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION =
  UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION;
export const PRIVATE_DEBUG_SUMMARY_KIND = UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND;
export const PRIVATE_DEBUG_SUMMARY_MAX_BYTES = UI_ATTACH_PRIVATE_DEBUG_SUMMARY_MAX_BYTES;

export type MetadataDiagnosticsAuthority =
  | "capture_time"
  | "live_page"
  | "not_rechecked";

export type MetadataDiagnosticsStatus =
  | "not_requested"
  | "not_available"
  | "collected"
  | "malformed"
  | "overbound";

export type MetadataDiagnosticsNonCollectedStatus = Exclude<
  MetadataDiagnosticsStatus,
  "collected"
>;

export interface MetadataDiagnosticsReplayCollectedV1 {
  status: "collected";
  attemptCount: number;
  verifiedCount: number;
  ambiguousCount: number;
  missingCount: number;
}

export interface MetadataDiagnosticsReplayUnavailableV1 {
  status: MetadataDiagnosticsNonCollectedStatus;
}

export type MetadataDiagnosticsReplayV1 =
  | MetadataDiagnosticsReplayCollectedV1
  | MetadataDiagnosticsReplayUnavailableV1;

export interface MetadataDiagnosticsDeviceCollectedV1 {
  status: "collected";
  deviceClass: "desktop" | "tablet" | "mobile";
  viewportClass: "small" | "medium" | "large";
  touch: "none" | "coarse" | "unknown";
}

export interface MetadataDiagnosticsDeviceUnavailableV1 {
  status: MetadataDiagnosticsNonCollectedStatus;
}

export type MetadataDiagnosticsDeviceV1 =
  | MetadataDiagnosticsDeviceCollectedV1
  | MetadataDiagnosticsDeviceUnavailableV1;

export interface MetadataDiagnosticsNetworkCollectedV1 {
  status: "collected";
  requestCount: number;
  failureCount: number;
  windowMs: number;
}

export interface MetadataDiagnosticsNetworkUnavailableV1 {
  status: MetadataDiagnosticsNonCollectedStatus;
}

export type MetadataDiagnosticsNetworkV1 =
  | MetadataDiagnosticsNetworkCollectedV1
  | MetadataDiagnosticsNetworkUnavailableV1;

export interface MetadataDiagnosticsConsoleCollectedV1 {
  status: "collected";
  logCount: number;
  warnCount: number;
  errorCount: number;
  windowMs: number;
}

export interface MetadataDiagnosticsConsoleUnavailableV1 {
  status: MetadataDiagnosticsNonCollectedStatus;
}

export type MetadataDiagnosticsConsoleV1 =
  | MetadataDiagnosticsConsoleCollectedV1
  | MetadataDiagnosticsConsoleUnavailableV1;

export interface MetadataDiagnosticsExecutionAuthorityV1 {
  grantedByCapture: false;
  browserControl: false;
  liveDomMutation: false;
}

export interface MetadataDiagnosticsV1 {
  schemaVersion: typeof UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION;
  kind: typeof UI_ATTACH_METADATA_DIAGNOSTICS_KIND;
  captureId: string;
  scope: "capture";
  observedAt: string;
  consent: "explicit_capture";
  authority: MetadataDiagnosticsAuthority;
  replay: MetadataDiagnosticsReplayV1;
  device: MetadataDiagnosticsDeviceV1;
  network: MetadataDiagnosticsNetworkV1;
  console: MetadataDiagnosticsConsoleV1;
  executionAuthority: MetadataDiagnosticsExecutionAuthorityV1;
}

/**
 * A non-identifying, user-copyable projection of one explicitly requested
 * diagnostics sidecar. It intentionally omits capture identity, time, page
 * identity, source content, and network/console fields.
 */
export interface PrivateDebugSummaryV1 {
  schemaVersion: typeof UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION;
  kind: typeof UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND;
  scope: "one_capture";
  consent: "explicit_one_shot";
  replay: MetadataDiagnosticsReplayV1;
  device: MetadataDiagnosticsDeviceV1;
  executionAuthority: MetadataDiagnosticsExecutionAuthorityV1;
}

export type MetadataDiagnosticsIssueCode =
  | "invalid_type"
  | "missing_field"
  | "unknown_field"
  | "forbidden_field"
  | "invalid_value"
  | "overbound"
  | "invalid_json"
  | "non_canonical";

/**
 * Issues deliberately contain only schema paths and fixed codes.  They never
 * echo an input value, an unknown key, a URL, or text from a malformed record.
 */
export interface MetadataDiagnosticsIssue {
  code: MetadataDiagnosticsIssueCode;
  path: string;
}

export interface MetadataDiagnosticsValidationSuccess {
  ok: true;
  value: MetadataDiagnosticsV1;
}

export interface MetadataDiagnosticsValidationFailure {
  ok: false;
  issues: MetadataDiagnosticsIssue[];
}

export type MetadataDiagnosticsValidationResult =
  | MetadataDiagnosticsValidationSuccess
  | MetadataDiagnosticsValidationFailure;

export type MetadataDiagnosticsSerializationResult =
  | {
      ok: true;
      value: string;
    }
  | MetadataDiagnosticsValidationFailure;

export type MetadataDiagnosticsParseResult =
  | MetadataDiagnosticsValidationSuccess
  | MetadataDiagnosticsValidationFailure;

export type PrivateDebugSummaryValidationResult =
  | { ok: true; value: PrivateDebugSummaryV1 }
  | MetadataDiagnosticsValidationFailure;

export type PrivateDebugSummarySerializationResult =
  | { ok: true; value: string }
  | MetadataDiagnosticsValidationFailure;

export type PrivateDebugSummaryParseResult = PrivateDebugSummaryValidationResult;

const MAX_ISSUES = 32;
const MAX_SCAN_NODES = 2048;
const REPLAY_COUNT_MAX = 64;
const NETWORK_CONSOLE_COUNT_MAX = 1024;
const DURATION_MAX_MS = 600_000;
const encoder = new TextEncoder();

const FORBIDDEN_KEYS = new Set([
  "text",
  "stack",
  "url",
  "query",
  "headers",
  "body",
  "cookies",
  "har",
  "screenshot",
  "useragent",
  "path",
  "localpath",
]);

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "captureId",
  "scope",
  "observedAt",
  "consent",
  "authority",
  "replay",
  "device",
  "network",
  "console",
  "executionAuthority",
] as const;

const PRIVATE_DEBUG_SUMMARY_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "scope",
  "consent",
  "replay",
  "device",
  "executionAuthority",
] as const;

const EXECUTION_AUTHORITY_KEYS = [
  "grantedByCapture",
  "browserControl",
  "liveDomMutation",
] as const;

const REPLAY_NON_COLLECTED_KEYS = ["status"] as const;
const REPLAY_COLLECTED_KEYS = [
  "status",
  "attemptCount",
  "verifiedCount",
  "ambiguousCount",
  "missingCount",
] as const;
const DEVICE_NON_COLLECTED_KEYS = ["status"] as const;
const DEVICE_COLLECTED_KEYS = ["status", "deviceClass", "viewportClass", "touch"] as const;
const NETWORK_NON_COLLECTED_KEYS = ["status"] as const;
const NETWORK_COLLECTED_KEYS = ["status", "requestCount", "failureCount", "windowMs"] as const;
const CONSOLE_NON_COLLECTED_KEYS = ["status"] as const;
const CONSOLE_COLLECTED_KEYS = ["status", "logCount", "warnCount", "errorCount", "windowMs"] as const;

/** Validate an unknown sidecar without exposing input values in the result. */
export function validateMetadataDiagnosticsV1(
  value: unknown,
): MetadataDiagnosticsValidationResult {
  const issues = new IssueCollector();
  let detached: Record<string, unknown> | null = null;
  try {
    const descriptorCache = new WeakMap<object, DescriptorMap>();
    const scan = scanForbiddenKeys(value, descriptorCache);
    if (scan === "forbidden") {
      issues.add("forbidden_field", "$" );
      return issues.failure();
    }
    if (scan === "overbound") {
      issues.add("overbound", "$" );
      return issues.failure();
    }
    if (scan === "invalid") {
      issues.add("invalid_type", "$" );
      return issues.failure();
    }

    if (!isRecord(value)) {
      issues.add("invalid_type", "$" );
      return issues.failure();
    }

    // Snapshot only descriptor values into plain records before any further
    // validation.  The serializer must never re-read an untrusted object
    // after validation (not even through a Proxy get trap).
    detached = detachForValidation(value, descriptorCache);
    if (!detached) {
      issues.add("invalid_type", "$" );
      return issues.failure();
    }

    checkExactKeys(detached, TOP_LEVEL_KEYS, "$", issues);
    checkRequiredOwnFields(detached, TOP_LEVEL_KEYS, "$", issues);

    checkExactLiteral(detached, "schemaVersion", UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION, issues);
    checkExactLiteral(detached, "kind", UI_ATTACH_METADATA_DIAGNOSTICS_KIND, issues);
    checkOpaqueCaptureId(readOwnData(detached, "captureId"), "captureId", issues);
    checkExactLiteral(detached, "scope", "capture", issues);
    checkCanonicalObservedAt(readOwnData(detached, "observedAt"), "observedAt", issues);
    checkExactLiteral(detached, "consent", "explicit_capture", issues);
    checkEnum(readOwnData(detached, "authority"), ["capture_time", "live_page", "not_rechecked"], "authority", issues);

    validateReplay(readOwnData(detached, "replay"), "replay", issues);
    validateDevice(readOwnData(detached, "device"), "device", issues);
    validateNetwork(readOwnData(detached, "network"), "network", issues);
    validateConsole(readOwnData(detached, "console"), "console", issues);
    validateExecutionAuthority(readOwnData(detached, "executionAuthority"), "executionAuthority", issues);
  } catch {
    // Proxies/getters/cyclic objects must fail closed without exposing data.
    issues.add("invalid_type", "$" );
  }

  if (!detached) return failure("invalid_type", "$");
  const result = issues.result(detached);
  if (!result.ok) return result;
  try {
    // Return the detached fixed-order record.  This is the frozen snapshot
    // consumed by serializers and callers; the original input is not reused.
    return { ok: true, value: toCanonicalRecord(detached) };
  } catch {
    return failure("invalid_type", "$" );
  }
}

/** A type guard over the same fail-closed validator used by serializers. */
export function isMetadataDiagnosticsV1(value: unknown): value is MetadataDiagnosticsV1 {
  return validateMetadataDiagnosticsV1(value).ok;
}

/** Serialize only validated records into the one canonical JSON representation. */
export function serializeMetadataDiagnosticsV1(
  value: unknown,
): MetadataDiagnosticsSerializationResult {
  const validation = validateMetadataDiagnosticsV1(value);
  if (!validation.ok) return validation;

  try {
    // `validateMetadataDiagnosticsV1` returns a detached canonical snapshot.
    // JSON.stringify therefore cannot execute a getter or Proxy get trap on
    // the caller-supplied object, and cannot observe post-validation changes.
    const canonical = JSON.stringify(validation.value);
    if (typeof canonical !== "string") {
      return failure("invalid_type", "$" );
    }
    if (utf8ByteLength(canonical) > UI_ATTACH_METADATA_DIAGNOSTICS_MAX_BYTES) {
      return failure("overbound", "$" );
    }
    return { ok: true, value: canonical };
  } catch {
    return failure("invalid_type", "$" );
  }
}

/** Parse exactly canonical JSON bytes; whitespace, duplicate keys, and escapes are rejected. */
export function parseMetadataDiagnosticsV1(
  input: unknown,
): MetadataDiagnosticsParseResult {
  if (typeof input !== "string") return failure("invalid_type", "$" );
  if (utf8ByteLength(input) > UI_ATTACH_METADATA_DIAGNOSTICS_MAX_BYTES) {
    return failure("overbound", "$" );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failure("invalid_json", "$" );
  }

  const validation = validateMetadataDiagnosticsV1(parsed);
  if (!validation.ok) return validation;

  const canonical = serializeMetadataDiagnosticsV1(validation.value);
  if (!canonical.ok || canonical.value !== input) {
    return failure("non_canonical", "$" );
  }
  return validation;
}

/** Project an explicit capture-time sidecar to the non-identifying copy surface. */
export function projectPrivateDebugSummaryV1(
  value: unknown,
): PrivateDebugSummaryValidationResult {
  const diagnostics = validateMetadataDiagnosticsV1(value);
  if (!diagnostics.ok) return diagnostics;
  if (diagnostics.value.authority !== "capture_time") {
    return failure("invalid_value", "authority");
  }
  if (diagnostics.value.network.status !== "not_requested") {
    return failure("invalid_value", "network.status");
  }
  if (diagnostics.value.console.status !== "not_requested") {
    return failure("invalid_value", "console.status");
  }
  return validatePrivateDebugSummaryV1({
    schemaVersion: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION,
    kind: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND,
    scope: "one_capture",
    consent: "explicit_one_shot",
    replay: diagnostics.value.replay,
    device: diagnostics.value.device,
    executionAuthority: {
      grantedByCapture: false,
      browserControl: false,
      liveDomMutation: false,
    },
  });
}

/** Validate a private summary without retaining or echoing caller-supplied values. */
export function validatePrivateDebugSummaryV1(
  value: unknown,
): PrivateDebugSummaryValidationResult {
  const issues = new IssueCollector();
  let detached: Record<string, unknown> | null = null;
  try {
    const descriptorCache = new WeakMap<object, DescriptorMap>();
    const scan = scanForbiddenKeys(value, descriptorCache);
    if (scan === "forbidden") return failure("forbidden_field", "$");
    if (scan === "overbound") return failure("overbound", "$");
    if (scan === "invalid") return failure("invalid_type", "$");
    if (!isRecord(value)) return failure("invalid_type", "$");

    detached = detachForValidation(value, descriptorCache);
    if (!detached) return failure("invalid_type", "$");

    checkExactKeys(detached, PRIVATE_DEBUG_SUMMARY_TOP_LEVEL_KEYS, "$", issues);
    checkRequiredOwnFields(detached, PRIVATE_DEBUG_SUMMARY_TOP_LEVEL_KEYS, "$", issues);
    checkExactLiteral(
      detached,
      "schemaVersion",
      UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION,
      issues,
    );
    checkExactLiteral(detached, "kind", UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND, issues);
    checkExactLiteral(detached, "scope", "one_capture", issues);
    checkExactLiteral(detached, "consent", "explicit_one_shot", issues);
    validateReplay(readOwnData(detached, "replay"), "replay", issues);
    validateDevice(readOwnData(detached, "device"), "device", issues);
    validateExecutionAuthority(
      readOwnData(detached, "executionAuthority"),
      "executionAuthority",
      issues,
    );
  } catch {
    return failure("invalid_type", "$");
  }

  if (!detached) return failure("invalid_type", "$");
  const checked = issues.result(detached);
  if (!checked.ok) return checked;
  return { ok: true, value: toCanonicalPrivateDebugSummary(checked.value) };
}

export function isPrivateDebugSummaryV1(value: unknown): value is PrivateDebugSummaryV1 {
  return validatePrivateDebugSummaryV1(value).ok;
}

/** Serialize only the fixed allowlist projection to canonical JSON. */
export function serializePrivateDebugSummaryV1(
  value: unknown,
): PrivateDebugSummarySerializationResult {
  const validation = validatePrivateDebugSummaryV1(value);
  if (!validation.ok) return validation;
  try {
    const canonical = JSON.stringify(validation.value);
    if (utf8ByteLength(canonical) > UI_ATTACH_PRIVATE_DEBUG_SUMMARY_MAX_BYTES) {
      return failure("overbound", "$");
    }
    return { ok: true, value: canonical };
  } catch {
    return failure("invalid_type", "$");
  }
}

/** Parse only the exact canonical bytes produced by the private summary serializer. */
export function parsePrivateDebugSummaryV1(
  input: unknown,
): PrivateDebugSummaryParseResult {
  if (typeof input !== "string") return failure("invalid_type", "$");
  if (utf8ByteLength(input) > UI_ATTACH_PRIVATE_DEBUG_SUMMARY_MAX_BYTES) {
    return failure("overbound", "$");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failure("invalid_json", "$");
  }
  const validation = validatePrivateDebugSummaryV1(parsed);
  if (!validation.ok) return validation;
  const canonical = serializePrivateDebugSummaryV1(validation.value);
  if (!canonical.ok || canonical.value !== input) return failure("non_canonical", "$");
  return validation;
}

function validateReplay(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("invalid_type", path);
    return;
  }
  const status = validateStatusRecord(value, path, issues, REPLAY_NON_COLLECTED_KEYS, REPLAY_COLLECTED_KEYS);
  if (status === null) return;
  if (status !== "collected") return;

  const attemptCount = readOwnData(value, "attemptCount");
  const verifiedCount = readOwnData(value, "verifiedCount");
  const ambiguousCount = readOwnData(value, "ambiguousCount");
  const missingCount = readOwnData(value, "missingCount");
  checkBoundedSafeInteger(attemptCount, REPLAY_COUNT_MAX, `${path}.attemptCount`, issues);
  checkBoundedSafeInteger(verifiedCount, REPLAY_COUNT_MAX, `${path}.verifiedCount`, issues);
  checkBoundedSafeInteger(ambiguousCount, REPLAY_COUNT_MAX, `${path}.ambiguousCount`, issues);
  checkBoundedSafeInteger(missingCount, REPLAY_COUNT_MAX, `${path}.missingCount`, issues);
  const counts = [attemptCount, verifiedCount, ambiguousCount, missingCount];
  if (counts.every((count) =>
    Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= REPLAY_COUNT_MAX
  )) {
    const attempts = attemptCount as number;
    const categorized = (verifiedCount as number) +
      (ambiguousCount as number) +
      (missingCount as number);
    if (
      (verifiedCount as number) > attempts ||
      (ambiguousCount as number) > attempts ||
      (missingCount as number) > attempts ||
      categorized > attempts
    ) {
      issues.add("invalid_value", `${path}.attemptCount`);
    }
  }
}

function validateDevice(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("invalid_type", path);
    return;
  }
  const status = validateStatusRecord(value, path, issues, DEVICE_NON_COLLECTED_KEYS, DEVICE_COLLECTED_KEYS);
  if (status === null || status !== "collected") return;

  checkEnum(readOwnData(value, "deviceClass"), ["desktop", "tablet", "mobile"], `${path}.deviceClass`, issues);
  checkEnum(readOwnData(value, "viewportClass"), ["small", "medium", "large"], `${path}.viewportClass`, issues);
  checkEnum(readOwnData(value, "touch"), ["none", "coarse", "unknown"], `${path}.touch`, issues);
}

function validateNetwork(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("invalid_type", path);
    return;
  }
  const status = validateStatusRecord(value, path, issues, NETWORK_NON_COLLECTED_KEYS, NETWORK_COLLECTED_KEYS);
  if (status === null || status !== "collected") return;

  checkBoundedSafeInteger(readOwnData(value, "requestCount"), NETWORK_CONSOLE_COUNT_MAX, `${path}.requestCount`, issues);
  checkBoundedSafeInteger(readOwnData(value, "failureCount"), NETWORK_CONSOLE_COUNT_MAX, `${path}.failureCount`, issues);
  checkBoundedSafeInteger(readOwnData(value, "windowMs"), DURATION_MAX_MS, `${path}.windowMs`, issues);
}

function validateConsole(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("invalid_type", path);
    return;
  }
  const status = validateStatusRecord(value, path, issues, CONSOLE_NON_COLLECTED_KEYS, CONSOLE_COLLECTED_KEYS);
  if (status === null || status !== "collected") return;

  checkBoundedSafeInteger(readOwnData(value, "logCount"), NETWORK_CONSOLE_COUNT_MAX, `${path}.logCount`, issues);
  checkBoundedSafeInteger(readOwnData(value, "warnCount"), NETWORK_CONSOLE_COUNT_MAX, `${path}.warnCount`, issues);
  checkBoundedSafeInteger(readOwnData(value, "errorCount"), NETWORK_CONSOLE_COUNT_MAX, `${path}.errorCount`, issues);
  checkBoundedSafeInteger(readOwnData(value, "windowMs"), DURATION_MAX_MS, `${path}.windowMs`, issues);
}

function validateExecutionAuthority(value: unknown, path: string, issues: IssueCollector): void {
  if (!isRecord(value)) {
    issues.add("invalid_type", path);
    return;
  }
  checkExactKeys(value, EXECUTION_AUTHORITY_KEYS, path, issues);
  checkRequiredOwnFields(value, EXECUTION_AUTHORITY_KEYS, path, issues);
  checkExactLiteral(value, "grantedByCapture", false, issues);
  checkExactLiteral(value, "browserControl", false, issues);
  checkExactLiteral(value, "liveDomMutation", false, issues);
}

function validateStatusRecord(
  value: Record<string, unknown>,
  path: string,
  issues: IssueCollector,
  nonCollectedKeys: readonly string[],
  collectedKeys: readonly string[],
): MetadataDiagnosticsStatus | null {
  if (!hasOwn(value, "status")) {
    issues.add("missing_field", `${path}.status`);
    return null;
  }
  const status = readOwnData(value, "status");
  if (!isStatus(status)) {
    issues.add("invalid_value", `${path}.status`);
    return null;
  }
  checkExactKeys(value, status === "collected" ? collectedKeys : nonCollectedKeys, path, issues);
  checkRequiredOwnFields(value, status === "collected" ? collectedKeys : nonCollectedKeys, path, issues);
  return status;
}

function checkExactLiteral(
  value: Record<string, unknown>,
  key: string,
  expected: unknown,
  issues: IssueCollector,
): void {
  if (!hasOwn(value, key)) {
    issues.add("missing_field", key);
    return;
  }
  if (readOwnData(value, key) !== expected) issues.add("invalid_value", key);
}

function checkOpaqueCaptureId(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add("invalid_type", path);
    return;
  }
  // Opaque means the schema does not assign semantics to the id.  Keep it to
  // a bounded identifier alphabet so it cannot carry arbitrary text or paths.
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) issues.add("invalid_value", path);
}

function checkCanonicalObservedAt(value: unknown, path: string, issues: IssueCollector): void {
  if (typeof value !== "string") {
    issues.add("invalid_type", path);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    issues.add("invalid_value", path);
    return;
  }
  try {
    if (new Date(value).toISOString() !== value) issues.add("invalid_value", path);
  } catch {
    issues.add("invalid_value", path);
  }
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  if (typeof value !== "string") {
    issues.add("invalid_type", path);
    return;
  }
  if (!allowed.includes(value)) issues.add("invalid_value", path);
}

function checkBoundedSafeInteger(
  value: unknown,
  max: number,
  path: string,
  issues: IssueCollector,
): void {
  if (!Number.isSafeInteger(value)) {
    issues.add("invalid_value", path);
    return;
  }
  if ((value as number) < 0) {
    issues.add("invalid_value", path);
    return;
  }
  if ((value as number) > max) issues.add("overbound", path);
}

function checkExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  let actual: string[];
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      issues.add("unknown_field", path);
      return;
    }
    actual = Object.getOwnPropertyNames(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        issues.add(expected.includes(key) ? "invalid_type" : "unknown_field", path);
        return;
      }
    }
  } catch {
    issues.add("invalid_type", path);
    return;
  }
  const expectedSet = new Set(expected);
  if (actual.length !== expected.length || actual.some((key) => !expectedSet.has(key))) {
    issues.add("unknown_field", path);
  }
}

function checkRequiredOwnFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: IssueCollector,
): void {
  for (const key of expected) {
    if (!hasOwn(value, key)) issues.add("missing_field", `${path}.${key}`);
    else if (readOwnData(value, key) === undefined) issues.add("invalid_value", `${path}.${key}`);
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readOwnData(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isStatus(value: unknown): value is MetadataDiagnosticsStatus {
  return value === "not_requested" ||
    value === "not_available" ||
    value === "collected" ||
    value === "malformed" ||
    value === "overbound";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function canonicalizeForbiddenKey(key: string): string {
  try {
    return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
  } catch {
    return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  }
}

type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

function detachForValidation(
  value: Record<string, unknown>,
  descriptorCache: WeakMap<object, DescriptorMap>,
): Record<string, unknown> | null {
  const detached = cloneRecordFromDescriptors(value, descriptorCache);
  if (!detached) return null;

  // These are the only object-valued fields in a valid sidecar.  Clone plain
  // records, but leave non-plain values in place so nested validation rejects
  // them instead of accidentally projecting Date/Map/custom objects to `{}`.
  for (const key of ["replay", "device", "network", "console", "executionAuthority"]) {
    const child = readOwnData(detached, key);
    if (!isRecord(child)) continue;
    const detachedChild = cloneRecordFromDescriptors(child, descriptorCache);
    if (!detachedChild || !defineOwnData(detached, key, detachedChild)) return null;
  }
  return detached;
}

function cloneRecordFromDescriptors(
  value: Record<string, unknown>,
  descriptorCache: WeakMap<object, DescriptorMap>,
): Record<string, unknown> | null {
  const descriptors = descriptorCache.get(value);
  if (!descriptors) return null;
  const detached: Record<string, unknown> = {};
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      Object.defineProperty(detached, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: descriptor.value,
      });
    }
  } catch {
    return null;
  }
  return detached;
}

function defineOwnData(
  value: Record<string, unknown>,
  key: string,
  child: unknown,
): boolean {
  try {
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: child,
    });
    return true;
  } catch {
    return false;
  }
}

function scanForbiddenKeys(
  value: unknown,
  descriptorCache: WeakMap<object, DescriptorMap>,
): "ok" | "forbidden" | "overbound" | "invalid" {
  if (typeof value !== "object" || value === null) return "ok";
  const seen = new WeakSet<object>();
  const pending: object[] = [value];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    nodes += 1;
    if (nodes > MAX_SCAN_NODES) return "overbound";

    let descriptors: DescriptorMap | undefined;
    try {
      descriptors = descriptorCache.get(current);
      if (!descriptors) {
        descriptors = Object.getOwnPropertyDescriptors(current) as DescriptorMap;
        descriptorCache.set(current, descriptors);
      }
    } catch {
      return "invalid";
    }
    if (!descriptors) return "invalid";
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "string" && FORBIDDEN_KEYS.has(canonicalizeForbiddenKey(key))) {
        return "forbidden";
      }
      if (typeof key !== "string") return "invalid";
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return "invalid";
      }
      const child = descriptor.value;
      if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return "ok";
}

function toCanonicalRecord(value: Record<string, unknown>): MetadataDiagnosticsV1 {
  return {
    schemaVersion: readOwnData(value, "schemaVersion") as MetadataDiagnosticsV1["schemaVersion"],
    kind: readOwnData(value, "kind") as MetadataDiagnosticsV1["kind"],
    captureId: readOwnData(value, "captureId") as string,
    scope: readOwnData(value, "scope") as "capture",
    observedAt: readOwnData(value, "observedAt") as string,
    consent: readOwnData(value, "consent") as "explicit_capture",
    authority: readOwnData(value, "authority") as MetadataDiagnosticsAuthority,
    replay: toCanonicalReplay(readOwnData(value, "replay")),
    device: toCanonicalDevice(readOwnData(value, "device")),
    network: toCanonicalNetwork(readOwnData(value, "network")),
    console: toCanonicalConsole(readOwnData(value, "console")),
    executionAuthority: {
      grantedByCapture: false,
      browserControl: false,
      liveDomMutation: false,
    },
  };
}

function toCanonicalPrivateDebugSummary(
  value: Record<string, unknown>,
): PrivateDebugSummaryV1 {
  return {
    schemaVersion: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION,
    kind: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND,
    scope: "one_capture",
    consent: "explicit_one_shot",
    replay: toCanonicalReplay(readOwnData(value, "replay")),
    device: toCanonicalDevice(readOwnData(value, "device")),
    executionAuthority: {
      grantedByCapture: false,
      browserControl: false,
      liveDomMutation: false,
    },
  };
}

function toCanonicalReplay(value: unknown): MetadataDiagnosticsReplayV1 {
  const record = value as Record<string, unknown>;
  const status = readOwnData(record, "status") as MetadataDiagnosticsStatus;
  if (status !== "collected") return { status };
  return {
    status,
    attemptCount: readOwnData(record, "attemptCount") as number,
    verifiedCount: readOwnData(record, "verifiedCount") as number,
    ambiguousCount: readOwnData(record, "ambiguousCount") as number,
    missingCount: readOwnData(record, "missingCount") as number,
  };
}

function toCanonicalDevice(value: unknown): MetadataDiagnosticsDeviceV1 {
  const record = value as Record<string, unknown>;
  const status = readOwnData(record, "status") as MetadataDiagnosticsStatus;
  if (status !== "collected") return { status };
  return {
    status,
    deviceClass: readOwnData(record, "deviceClass") as MetadataDiagnosticsDeviceCollectedV1["deviceClass"],
    viewportClass: readOwnData(record, "viewportClass") as MetadataDiagnosticsDeviceCollectedV1["viewportClass"],
    touch: readOwnData(record, "touch") as MetadataDiagnosticsDeviceCollectedV1["touch"],
  };
}

function toCanonicalNetwork(value: unknown): MetadataDiagnosticsNetworkV1 {
  const record = value as Record<string, unknown>;
  const status = readOwnData(record, "status") as MetadataDiagnosticsStatus;
  if (status !== "collected") return { status };
  return {
    status,
    requestCount: readOwnData(record, "requestCount") as number,
    failureCount: readOwnData(record, "failureCount") as number,
    windowMs: readOwnData(record, "windowMs") as number,
  };
}

function toCanonicalConsole(value: unknown): MetadataDiagnosticsConsoleV1 {
  const record = value as Record<string, unknown>;
  const status = readOwnData(record, "status") as MetadataDiagnosticsStatus;
  if (status !== "collected") return { status };
  return {
    status,
    logCount: readOwnData(record, "logCount") as number,
    warnCount: readOwnData(record, "warnCount") as number,
    errorCount: readOwnData(record, "errorCount") as number,
    windowMs: readOwnData(record, "windowMs") as number,
  };
}

function failure(
  code: MetadataDiagnosticsIssueCode,
  path: string,
): MetadataDiagnosticsValidationFailure {
  return { ok: false, issues: [{ code, path }] };
}

class IssueCollector {
  private readonly entries: MetadataDiagnosticsIssue[] = [];
  private readonly seen = new Set<string>();

  add(code: MetadataDiagnosticsIssueCode, path: string): void {
    if (this.entries.length >= MAX_ISSUES) return;
    const boundedPath = path.length <= 96 ? path : "$";
    const key = `${code}:${boundedPath}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.entries.push({ code, path: boundedPath });
  }

  failure(): MetadataDiagnosticsValidationFailure {
    return { ok: false, issues: this.entries.length > 0
      ? [...this.entries]
      : [{ code: "invalid_type", path: "$" }] };
  }

  result<T>(value: T): { ok: true; value: T } | MetadataDiagnosticsValidationFailure {
    if (this.entries.length > 0) return this.failure();
    return { ok: true, value };
  }
}
