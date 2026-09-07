import type { LocatorReplayAttempt } from "@meanthis/replay";
import {
  type MetadataDiagnosticsV1,
  UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS,
  validateMetadataDiagnosticsV1,
} from "@meanthis/schema";

/** Maximum number of existing replay attempts that may be summarized. */
export const METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS = 64;

/** Maximum viewport width accepted before coarse classification fails closed. */
export const METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH = 100_000;

/** Maximum touch-point count accepted before coarse classification fails closed. */
export const METADATA_DIAGNOSTICS_MAX_TOUCH_POINTS = 1_024;

/** Widths below this boundary are classified as mobile and small. */
export const METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN = 768;

/** Widths at or above this boundary are classified as desktop and large. */
export const METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN = 1_200;

export interface MetadataDiagnosticsEnvironmentInput {
  readonly viewportWidth: number;
  readonly coarsePointer?: boolean;
  readonly touchPoints?: number;
}

export interface MetadataDiagnosticsInput {
  readonly optIn: boolean;
  readonly captureId: string;
  readonly observedAt: string;
  readonly replayAttempts: readonly LocatorReplayAttempt[];
  readonly environment: MetadataDiagnosticsEnvironmentInput;
}

export interface CaptureReplayMetadataDiagnosticsInput {
  readonly captureId: string;
  readonly observedAt: string;
  readonly replayAttemptGroups: readonly (readonly unknown[] | undefined)[];
}

export type MetadataDiagnosticsResult =
  | { ok: true; value: MetadataDiagnosticsV1 | null }
  | { ok: false; status: "malformed" | "overbound" };

type DiagnosticFailure = Extract<MetadataDiagnosticsResult, { ok: false }>;
export type CaptureReplayMetadataDiagnosticsResult =
  | { ok: true; value: MetadataDiagnosticsV1 }
  | DiagnosticFailure;
type CollectedReplay = Extract<MetadataDiagnosticsV1["replay"], { status: "collected" }>;
type CollectedDevice = Extract<MetadataDiagnosticsV1["device"], { status: "collected" }>;

const INPUT_KEYS = [
  "optIn",
  "captureId",
  "observedAt",
  "replayAttempts",
  "environment",
] as const;
const CAPTURE_REPLAY_INPUT_KEYS = [
  "captureId",
  "observedAt",
  "replayAttemptGroups",
] as const;
const REPLAY_ATTEMPT_KEYS = [
  "strategy",
  "value",
  "replayVerified",
  "uniqueness",
  "failureReason",
  "matchCount",
  "visible",
] as const;
const ENVIRONMENT_REQUIRED_KEYS = ["viewportWidth"] as const;
const ENVIRONMENT_OPTIONAL_KEYS = ["coarsePointer", "touchPoints"] as const;
const LOCATOR_STRATEGIES = new Set([
  "playwright.role",
  "playwright.label",
  "playwright.text",
  "playwright.testId",
  "playwright.altText",
  "playwright.title",
  "playwright.placeholder",
  "css",
  "xpath",
  "coordinates",
]);

/**
 * Derive one explicitly opted-in, capture-time metadata sidecar.
 *
 * This adapter deliberately receives all environment facts from its caller. It
 * has no browser/global observation path and never persists or publishes a
 * sidecar itself.
 */
export function deriveMetadataDiagnosticsV1(
  input: MetadataDiagnosticsInput,
): MetadataDiagnosticsResult {
  // Read only the opt-in data descriptor before the privacy gate. Accessors are
  // rejected without invocation, and disabled input never exposes any other
  // property value to this adapter.
  const optInResult = readOwnEnumerableDataProperty(input, "optIn");
  if (!optInResult.ok) return malformedResult();
  const optIn = optInResult.value;

  if (optIn === false) return { ok: true, value: null };
  if (optIn !== true) return malformedResult();

  try {
    const inputRecord = readExactPlainDataRecord(input, INPUT_KEYS);
    if (!inputRecord.ok || inputRecord.value.optIn !== true) return malformedResult();

    const captureId = inputRecord.value.captureId;
    const observedAt = inputRecord.value.observedAt;
    const replayAttempts = inputRecord.value.replayAttempts;
    const environment = inputRecord.value.environment;

    // Let the production schema validator own the canonical identifier and
    // timestamp rules; reject non-strings before constructing a candidate so a
    // malformed value can never be reflected in a failure result.
    if (typeof captureId !== "string" || typeof observedAt !== "string") {
      return malformedResult();
    }

    const replay = summarizeReplayAttempts(replayAttempts);
    if (!replay.ok) return replay;

    const device = summarizeDevice(environment);
    if (!device.ok) return device;

    const candidate: MetadataDiagnosticsV1 = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId,
      scope: "capture",
      observedAt,
      consent: "explicit_capture",
      authority: "capture_time",
      replay: replay.value,
      device: device.value,
      network: { status: "not_requested" },
      console: { status: "not_requested" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };

    // A sidecar is usable only when the production schema accepts the exact
    // object. Validator details are intentionally not returned to callers.
    const validation = validateMetadataDiagnosticsV1(candidate);
    if (!validation.ok) return malformedResult();
    return { ok: true, value: validation.value };
  } catch {
    // Accessors, proxies, and validator failures all fail closed without
    // echoing an input value or diagnostic string.
    return malformedResult();
  }
}

/**
 * Project replay facts that are already part of an explicit canonical capture.
 *
 * This path does not observe the browser or device. It accepts both production
 * attempts and the agent-safe disclosure form, retains only bounded counters,
 * and marks every new observation domain as not requested.
 */
export function deriveCaptureReplayMetadataDiagnosticsV1(
  input: CaptureReplayMetadataDiagnosticsInput,
): CaptureReplayMetadataDiagnosticsResult {
  try {
    const inputRecord = readExactPlainDataRecord(input, CAPTURE_REPLAY_INPUT_KEYS);
    if (!inputRecord.ok) return malformedResult();
    const captureId = inputRecord.value.captureId;
    const observedAt = inputRecord.value.observedAt;
    if (typeof captureId !== "string" || typeof observedAt !== "string") {
      return malformedResult();
    }

    const replay = summarizeReplayAttemptGroups(inputRecord.value.replayAttemptGroups);
    const candidate: MetadataDiagnosticsV1 = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId,
      scope: "capture",
      observedAt,
      consent: "explicit_capture",
      authority: "capture_time",
      replay,
      device: { status: "not_requested" },
      network: { status: "not_requested" },
      console: { status: "not_requested" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
    const validation = validateMetadataDiagnosticsV1(candidate);
    return validation.ok
      ? { ok: true, value: validation.value }
      : malformedResult();
  } catch {
    return malformedResult();
  }
}

/**
 * Collect the coarse device sidecar for the frame that owns a selected target.
 *
 * The content-side caller supplies the selected element so this adapter never
 * consults the panel or the extension/global window.  Browser values are read
 * only during the call and are immediately reduced to the schema's fixed
 * coarse shape; no raw dimensions, touch-point count, user agent, URL, or path
 * can cross this boundary.
 */
export function collectMetadataDiagnosticsDevice(
  target: HTMLElement | null | undefined,
): MetadataDiagnosticsV1["device"] {
  try {
    if (target === null || target === undefined ||
      (typeof target !== "object" && typeof target !== "function")) {
      return { status: "not_available" };
    }

    const ownerDocument = target.ownerDocument;
    if (ownerDocument === null || ownerDocument === undefined ||
      (typeof ownerDocument !== "object" && typeof ownerDocument !== "function")) {
      return { status: "not_available" };
    }

    const view = ownerDocument.defaultView;
    if (view === null || view === undefined ||
      (typeof view !== "object" && typeof view !== "function")) {
      return { status: "not_available" };
    }

    const documentElement = ownerDocument.documentElement;
    let viewportWidth: unknown = documentElement === null || documentElement === undefined
      ? undefined
      : documentElement.clientWidth;
    if (viewportWidth === undefined || viewportWidth === null || viewportWidth === 0) {
      viewportWidth = view.innerWidth;
    }

    // Keep the unavailable classification distinct from malformed values.  A
    // missing/zero/negative viewport is an unavailable observation.  Numeric
    // type and maximum-bound checks follow the existing summarizer's rules,
    // before optional browser APIs are consulted.
    if (viewportWidth === undefined || viewportWidth === null) {
      return { status: "not_available" };
    }
    if (typeof viewportWidth !== "number") return { status: "malformed" };
    if (viewportWidth <= 0) return { status: "not_available" };
    if (!Number.isSafeInteger(viewportWidth)) return { status: "malformed" };
    if (viewportWidth > METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH) {
      return { status: "overbound" };
    }

    const matchMedia = view.matchMedia;
    if (typeof matchMedia !== "function") return { status: "not_available" };
    const coarsePointer = Reflect.apply(matchMedia, view, ["(pointer: coarse)"]).matches;

    const navigator = view.navigator;
    if (navigator === null || navigator === undefined ||
      (typeof navigator !== "object" && typeof navigator !== "function")) {
      return { status: "not_available" };
    }
    const touchPoints = navigator.maxTouchPoints;

    const summarized = summarizeDevice({ viewportWidth, coarsePointer, touchPoints });
    return summarized.ok ? summarized.value : { status: summarized.status };
  } catch {
    // Host objects, accessors, and browser APIs can fail (for example while a
    // frame is being torn down).  Do not expose the exception or any input.
    return { status: "not_available" };
  }
}

function summarizeReplayAttemptGroups(value: unknown): MetadataDiagnosticsV1["replay"] {
  const groups = readExactDenseDataArray(value);
  if (!groups.ok) return { status: groups.status };
  if (groups.value.length === 0) return { status: "not_available" };

  let attemptCount = 0;
  let verifiedCount = 0;
  let ambiguousCount = 0;
  let missingCount = 0;
  for (const group of groups.value) {
    if (group === undefined) return { status: "not_available" };
    const summary = summarizeAgentSafeReplayAttempts(group);
    if (!summary.ok) return { status: summary.status };
    attemptCount += summary.value.attemptCount;
    verifiedCount += summary.value.verifiedCount;
    ambiguousCount += summary.value.ambiguousCount;
    missingCount += summary.value.missingCount;
    if (attemptCount > METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS) {
      return { status: "overbound" };
    }
  }
  return {
    status: "collected",
    attemptCount,
    verifiedCount,
    ambiguousCount,
    missingCount,
  };
}

function summarizeAgentSafeReplayAttempts(
  value: unknown,
): { ok: true; value: CollectedReplay } | DiagnosticFailure {
  const attempts = readExactDenseDataArray(value);
  if (!attempts.ok) return attempts;
  let verifiedCount = 0;
  let ambiguousCount = 0;
  let missingCount = 0;
  for (const value of attempts.value) {
    const attemptResult = readExactPlainDataRecord(value, REPLAY_ATTEMPT_KEYS);
    if (!attemptResult.ok) return malformedResult();
    const attempt = attemptResult.value;
    const strategy = attempt.strategy;
    const locatorValue = attempt.value;
    const replayVerified = attempt.replayVerified;
    const uniqueness = attempt.uniqueness;
    const failureReason = attempt.failureReason;
    const matchCount = attempt.matchCount;
    const visible = attempt.visible;
    if (
      typeof strategy !== "string" ||
      (!LOCATOR_STRATEGIES.has(strategy) && strategy !== "unknown") ||
      typeof locatorValue !== "string" ||
      typeof replayVerified !== "boolean" ||
      (uniqueness !== null && typeof uniqueness !== "boolean") ||
      (failureReason !== null && typeof failureReason !== "string") ||
      (matchCount !== null && (!Number.isSafeInteger(matchCount) || (matchCount as number) < 0)) ||
      (visible !== null && typeof visible !== "boolean")
    ) return malformedResult();
    if (
      locatorValue.length > UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS ||
      (typeof failureReason === "string" &&
        failureReason.length > UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS)
    ) return overboundResult();
    const normalizedMatchCount = matchCount as number | null;
    if (!isProductionReplayAttemptState(
      replayVerified,
      uniqueness,
      failureReason,
      normalizedMatchCount,
      visible,
    )) return malformedResult();
    if (replayVerified) verifiedCount += 1;
    if (normalizedMatchCount === 0) missingCount += 1;
    else if (uniqueness === false) ambiguousCount += 1;
  }
  return {
    ok: true,
    value: {
      status: "collected",
      attemptCount: attempts.value.length,
      verifiedCount,
      ambiguousCount,
      missingCount,
    },
  };
}

function summarizeReplayAttempts(
  value: unknown,
): { ok: true; value: CollectedReplay } | DiagnosticFailure {
  const attempts = readExactDenseDataArray(value);
  if (!attempts.ok) return attempts;
  const attemptCount = attempts.value.length;

  let verifiedCount = 0;
  let ambiguousCount = 0;
  let missingCount = 0;

  // The exact production attempt shape is validated through data descriptors.
  // Raw locator and failure strings are type/bound checked but never copied to
  // the sidecar or any error result.
  for (let index = 0; index < attemptCount; index += 1) {
    const attemptResult = readExactPlainDataRecord(attempts.value[index], REPLAY_ATTEMPT_KEYS);
    if (!attemptResult.ok) return malformedResult();
    const attempt = attemptResult.value;
    const strategy = attempt.strategy;
    const locatorValue = attempt.value;
    const replayVerified = attempt.replayVerified;
    const uniqueness = attempt.uniqueness;
    const failureReason = attempt.failureReason;
    const matchCount = attempt.matchCount;
    const visible = attempt.visible;

    if (
      typeof strategy !== "string" ||
      !LOCATOR_STRATEGIES.has(strategy) ||
      typeof locatorValue !== "string" ||
      typeof replayVerified !== "boolean" ||
      (uniqueness !== null && typeof uniqueness !== "boolean") ||
      (failureReason !== null && typeof failureReason !== "string") ||
      (
        matchCount !== null &&
        (!Number.isSafeInteger(matchCount) || (matchCount as number) < 0)
      ) ||
      (visible !== null && typeof visible !== "boolean")
    ) {
      return malformedResult();
    }
    if (
      locatorValue.length > UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS ||
      (typeof failureReason === "string" &&
        failureReason.length > UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS)
    ) {
      return overboundResult();
    }
    const normalizedMatchCount = matchCount as number | null;
    if (!isProductionReplayAttemptState(
      replayVerified,
      uniqueness,
      failureReason,
      normalizedMatchCount,
      visible,
    )) return malformedResult();

    if (replayVerified === true) verifiedCount += 1;
    if (normalizedMatchCount === 0) missingCount += 1;
    else if (uniqueness === false) ambiguousCount += 1;
  }

  return {
    ok: true,
    value: {
      status: "collected",
      attemptCount,
      verifiedCount,
      ambiguousCount,
      missingCount,
    },
  };
}

function summarizeDevice(
  value: unknown,
): { ok: true; value: CollectedDevice } | DiagnosticFailure {
  const environment = readExactPlainDataRecord(
    value,
    ENVIRONMENT_REQUIRED_KEYS,
    ENVIRONMENT_OPTIONAL_KEYS,
  );
  if (!environment.ok) return malformedResult();
  const viewportWidth = environment.value.viewportWidth;
  const coarsePointer = environment.value.coarsePointer;
  const touchPoints = environment.value.touchPoints;

  if (!Number.isSafeInteger(viewportWidth) || (viewportWidth as number) <= 0) {
    return malformedResult();
  }
  if ((viewportWidth as number) > METADATA_DIAGNOSTICS_MAX_VIEWPORT_WIDTH) {
    return overboundResult();
  }
  if (coarsePointer !== undefined && typeof coarsePointer !== "boolean") {
    return malformedResult();
  }
  if (
    touchPoints !== undefined &&
    (!Number.isSafeInteger(touchPoints) || (touchPoints as number) < 0)
  ) {
    return malformedResult();
  }
  if (
    typeof touchPoints === "number" &&
    touchPoints > METADATA_DIAGNOSTICS_MAX_TOUCH_POINTS
  ) {
    return overboundResult();
  }

  const width = viewportWidth as number;
  const deviceClass = width < METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN
    ? "mobile"
    : width < METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN
      ? "tablet"
      : "desktop";
  const viewportClass = width < METADATA_DIAGNOSTICS_TABLET_VIEWPORT_MIN
    ? "small"
    : width < METADATA_DIAGNOSTICS_DESKTOP_VIEWPORT_MIN
      ? "medium"
      : "large";
  const touch = coarsePointer === true || (typeof touchPoints === "number" && touchPoints > 0)
    ? "coarse"
    : coarsePointer === false && touchPoints === 0
      ? "none"
      : "unknown";

  return {
    ok: true,
    value: {
      status: "collected",
      deviceClass,
      viewportClass,
      touch,
    },
  };
}

function malformedResult(): DiagnosticFailure {
  return { ok: false, status: "malformed" };
}

function overboundResult(): DiagnosticFailure {
  return { ok: false, status: "overbound" };
}

function isProductionReplayAttemptState(
  replayVerified: boolean,
  uniqueness: boolean | null,
  failureReason: string | null,
  matchCount: number | null,
  visible: boolean | null,
): boolean {
  if (replayVerified) {
    return uniqueness === true &&
      failureReason === null &&
      matchCount === 1 &&
      visible === true;
  }
  if (matchCount === null) {
    return uniqueness === null && visible === null && typeof failureReason === "string";
  }
  if (matchCount === 0 || matchCount > 1) {
    return uniqueness === false && visible === null && typeof failureReason === "string";
  }
  return matchCount === 1 &&
    uniqueness === true &&
    visible === false &&
    typeof failureReason === "string";
}

interface DataPropertyRead {
  readonly ok: true;
  readonly value: unknown;
}

interface DataPropertyReadFailure {
  readonly ok: false;
}

function readOwnEnumerableDataProperty(
  value: unknown,
  key: string,
): DataPropertyRead | DataPropertyReadFailure {
  if (!isPlainRecord(value)) return { ok: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value === undefined
    ) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function readExactPlainDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): { ok: true; value: Record<string, unknown> } | DataPropertyReadFailure {
  if (!isPlainRecord(value)) return { ok: false };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return { ok: false };
    const names = ownKeys as string[];
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      names.some((key) => !allowed.has(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) return { ok: false };
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of names) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value === undefined
      ) return { ok: false };
      snapshot[key] = descriptor.value;
    }
    return { ok: true, value: snapshot };
  } catch {
    return { ok: false };
  }
}

function readExactDenseDataArray(
  value: unknown,
): { ok: true; value: unknown[] } | DiagnosticFailure {
  if (!Array.isArray(value)) return malformedResult();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return malformedResult();
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return malformedResult();
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0
    ) return malformedResult();
    const length = lengthDescriptor.value as number;
    if (length > METADATA_DIAGNOSTICS_MAX_REPLAY_ATTEMPTS) return overboundResult();
    const expectedNames = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const names = ownKeys as string[];
    if (names.length !== expectedNames.size || names.some((key) => !expectedNames.has(key))) {
      return malformedResult();
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return malformedResult();
      }
      snapshot.push(descriptor.value);
    }
    return { ok: true, value: snapshot };
  } catch {
    return malformedResult();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
