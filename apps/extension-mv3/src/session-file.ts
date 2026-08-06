import {
  createCaptureHub,
  hydrateCaptureSessionFile,
  isCaptureSessionFileByteLimitIssue,
  sanitizeCaptureSessionFileValidationIssues,
  validateCaptureSessionFile,
  type CapturePromptBundleFormat,
  type CaptureRouteSegmentV1,
  type CaptureSessionFileSourceRecordV1,
  type CaptureSessionFileV1,
  type SavedSnapshotPromptBundle,
} from "@meanthis/hub-core";
import type { UIAttachment } from "@meanthis/schema";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";

export const EXTENSION_SESSION_MAX_ITEMS = 26;
export const EXTENSION_SESSION_MAX_BYTES = 1_048_576;
export const EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES = 262_144;
export const EXTENSION_SAVED_SNAPSHOT_MAX_BUNDLE_JSON_BYTES = 1_048_576;

export type SessionFileResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "INVALID_SESSION_FILE" | "SESSION_TOO_LARGE";
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

export interface StoredSessionReviewItem {
  label: string;
  target: string;
  intent: string;
  capturedAt: string;
  sourceDisclosureMode: UIAttachmentDisclosureMode;
}

export interface StoredSessionRouteData {
  origin: string;
  pathname: string;
  frameKind: "top" | "embedded";
  targetCount: number;
  topPage?: CaptureRouteSegmentV1;
  frameChain?: CaptureRouteSegmentV1[];
}

export interface StoredSessionReviewData {
  origin: string;
  epoch: string;
  routes: StoredSessionRouteData[];
  items: StoredSessionReviewItem[];
}

export interface StoredSessionHandoffData {
  origin: string;
  epoch: string;
  format: CapturePromptBundleFormat;
  bundle: SavedSnapshotPromptBundle;
}

export function serializeSavedSnapshotPromptBundleJson(
  bundle: SavedSnapshotPromptBundle,
): string {
  return JSON.stringify(bundle, null, 2);
}

export function deriveStoredSessionReview(
  file: CaptureSessionFileV1,
  origin: string,
  epoch: string,
): SessionFileResult<StoredSessionReviewData> {
  if (file.session.origin !== origin || epoch.length === 0) {
    return {
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is unavailable.",
    };
  }
  const items: StoredSessionReviewItem[] = [];
  const routes = new Map<string, StoredSessionRouteData>();
  for (const [index, item] of file.session.attachments.entries()) {
    const sourceRecord = item.sourceRecord as OriginCaptureRecord;
    const hub = createCaptureHub();
    const session = hub.createSession({
      id: `stored-session-review-${index}`,
      title: sourceRecord.pageTitle,
      origin: sourceRecord.origin,
    });
    const added = hub.addAttachment(session.id, sourceRecord);
    if (!added.ok) {
      return {
        ok: false,
        code: "INVALID_SESSION_FILE",
        error: "Stored capture session cannot be reviewed safely.",
      };
    }
    const disclosure = hub.getAttachment(session.id, sourceRecord.attachment.id, {
      disclosureMode: "agent_safe",
    });
    if (!disclosure.ok) {
      return {
        ok: false,
        code: "INVALID_SESSION_FILE",
        error: "Stored capture session cannot be reviewed safely.",
      };
    }
    const attachment = disclosure.record.attachment;
    const role = attachment.element.role ?? attachment.element.tagName;
    const name = attachment.element.accessibleName ?? attachment.element.text ?? "unnamed";
    items.push({
      label: item.labels.find((label) => label.trim().length > 0)?.trim() || formatItemLabel(index),
      target: `${role} - ${name}`,
      intent: sourceRecord.intent,
      capturedAt: sourceRecord.capturedAt,
      sourceDisclosureMode: sourceRecord.attachment.policy.disclosureMode,
    });
    const route = deriveStoredSessionRoute(disclosure.record as OriginCaptureRecord);
    if (route) {
      const key = JSON.stringify([
        route.frameKind,
        route.origin,
        route.pathname,
        route.topPage ?? null,
        route.frameChain ?? null,
      ]);
      const existing = routes.get(key);
      routes.set(key, existing
        ? { ...existing, targetCount: existing.targetCount + 1 }
        : route);
    }
  }
  return { ok: true, value: { origin, epoch, routes: [...routes.values()], items } };
}

export function deriveStoredSessionHandoff(
  file: CaptureSessionFileV1,
  origin: string,
  epoch: string,
): SessionFileResult<StoredSessionHandoffData> {
  if (
    file.session.origin !== origin ||
    epoch.trim().length === 0 ||
    file.session.attachments.length === 0
  ) {
    return {
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is unavailable.",
    };
  }
  const hydrated = hydrateCaptureSessionFile(file);
  if (!hydrated.ok) {
    return {
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session cannot be handed off safely.",
      issues: sanitizeCaptureSessionFileValidationIssues(hydrated.issues),
    };
  }
  const attachmentIds = file.session.attachments.map((item) => item.id);
  const attachmentLabels = Object.fromEntries(file.session.attachments.map((item, index) => [
    item.id,
    item.labels.find((label) => label.trim().length > 0)?.trim() || formatItemLabel(index),
  ]));
  const attachmentIntents = Object.fromEntries(file.session.attachments.map((item) => [
    item.id,
    item.sourceRecord.intent,
  ]));
  const format: CapturePromptBundleFormat = attachmentIds.length === 1 ? "exact" : "compact";
  const bundle = hydrated.hub.buildSavedSnapshotPromptBundle({
    sessionId: hydrated.sessionId,
    attachmentIds,
    attachmentLabels,
    attachmentIntents,
    format,
  });
  if (!bundle.ok) {
    return {
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session cannot be handed off safely.",
    };
  }
  const { ok: _ok, ...acceptedBundle } = bundle;
  if (
    new TextEncoder().encode(acceptedBundle.markdown).byteLength >
      EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES ||
    new TextEncoder().encode(serializeSavedSnapshotPromptBundleJson(acceptedBundle)).byteLength >
      EXTENSION_SAVED_SNAPSHOT_MAX_BUNDLE_JSON_BYTES
  ) {
    return {
      ok: false,
      code: "SESSION_TOO_LARGE",
      error: "Stored capture session is too large for a structured handoff.",
    };
  }
  return {
    ok: true,
    value: {
      origin,
      epoch,
      format,
      bundle: acceptedBundle,
    },
  };
}

export function toSessionFileSourceRecord(
  record: OriginCaptureRecord,
): CaptureSessionFileSourceRecordV1 {
  return {
    origin: record.origin,
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    attachment: projectAttachment(record.attachment),
    intent: record.intent,
    ...(record.replayAttempts !== undefined
      ? { replayAttempts: record.replayAttempts.map(projectReplayValue) }
      : {}),
    capturedAt: record.capturedAt,
    ...(record.tabId !== undefined ? { tabId: record.tabId } : {}),
    ...(record.frameId !== undefined ? { frameId: record.frameId } : {}),
    ...(record.routeChain !== undefined
      ? { routeChain: record.routeChain.map((route) => ({ ...route })) }
      : {}),
  };
}

export function projectCaptureSessionFile(
  file: CaptureSessionFileV1,
): CaptureSessionFileV1 {
  return {
    schemaVersion: file.schemaVersion,
    kind: file.kind,
    session: {
      id: file.session.id,
      title: file.session.title,
      createdAt: file.session.createdAt,
      updatedAt: file.session.updatedAt,
      origin: file.session.origin,
      attachments: file.session.attachments.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        labels: [...item.labels],
        sourceRecord: projectSourceRecord(item.sourceRecord),
      })),
    },
  };
}

export function serializeCaptureSessionFile(
  value: unknown,
): SessionFileResult<{
  file: CaptureSessionFileV1;
  text: string;
  byteLength: number;
}> {
  const validation = validateCaptureSessionFile(value);
  if (!validation.ok) {
    if (
      validation.issues.length === 1 &&
      isCaptureSessionFileByteLimitIssue(validation.issues[0])
    ) {
      return {
        ok: false,
        code: "SESSION_TOO_LARGE",
        error: "Capture session exceeds the 1 MiB export limit.",
      };
    }
    return {
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is invalid.",
      issues: sanitizeCaptureSessionFileValidationIssues(validation.issues),
    };
  }
  const file = projectCaptureSessionFile(validation.file);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > EXTENSION_SESSION_MAX_BYTES) {
    return {
      ok: false,
      code: "SESSION_TOO_LARGE",
      error: "Capture session exceeds the 1 MiB export limit.",
    };
  }
  return { ok: true, value: { file, text, byteLength } };
}

export function createSessionExportFilename(origin: string, now: Date): string {
  const hostSlug =
    new URL(origin).host
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "origin";
  const truncatedHostSlug = hostSlug.slice(0, 80);
  const timestamp = [
    now.getUTCFullYear().toString().padStart(4, "0"),
    (now.getUTCMonth() + 1).toString().padStart(2, "0"),
    now.getUTCDate().toString().padStart(2, "0"),
    "-",
    now.getUTCHours().toString().padStart(2, "0"),
    now.getUTCMinutes().toString().padStart(2, "0"),
    now.getUTCSeconds().toString().padStart(2, "0"),
    "-",
    now.getUTCMilliseconds().toString().padStart(3, "0"),
  ].join("");

  return `meanthis-${truncatedHostSlug}-${timestamp}.capture-session.json`;
}

function projectSourceRecord(
  record: CaptureSessionFileSourceRecordV1,
): CaptureSessionFileSourceRecordV1 {
  return {
    origin: record.origin,
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    attachment: projectAttachment(record.attachment),
    intent: record.intent,
    ...(record.replayAttempts !== undefined
      ? { replayAttempts: record.replayAttempts.map(projectReplayValue) }
      : {}),
    capturedAt: record.capturedAt,
    ...(record.tabId !== undefined ? { tabId: record.tabId } : {}),
    ...(record.frameId !== undefined ? { frameId: record.frameId } : {}),
    ...(record.routeChain !== undefined
      ? { routeChain: record.routeChain.map((route) => ({ ...route })) }
      : {}),
  };
}

function formatItemLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function deriveStoredSessionRoute(record: OriginCaptureRecord): StoredSessionRouteData | null {
  if (
    !record.pageUrl ||
    typeof record.frameId !== "number" ||
    !Number.isSafeInteger(record.frameId) ||
    record.frameId < 0
  ) return null;
  try {
    const url = new URL(record.pageUrl);
    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== record.origin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      decodedPathname.toLowerCase().includes("[redacted:")
    ) return null;
    const selectedRoute = { origin: url.origin, pathname: url.pathname };
    const frameChain = sanitizeStoredFrameChain(record.routeChain, selectedRoute, record.frameId);
    return {
      origin: url.origin,
      pathname: url.pathname,
      frameKind: record.frameId === 0 ? "top" : "embedded",
      targetCount: 1,
      ...(frameChain
        ? { topPage: frameChain[0], frameChain }
        : {}),
    };
  } catch {
    return null;
  }
}

function sanitizeStoredFrameChain(
  value: OriginCaptureRecord["routeChain"],
  selectedRoute: CaptureRouteSegmentV1,
  frameId: number,
): CaptureRouteSegmentV1[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 33) return null;
  if ((frameId === 0 && value.length !== 1) || (frameId > 0 && value.length < 2)) return null;
  const routes = value.flatMap((route) => {
    const sanitized = sanitizeStoredRouteSegment(route);
    return sanitized ? [sanitized] : [];
  });
  const last = routes.at(-1);
  return routes.length === value.length &&
      last?.origin === selectedRoute.origin &&
      last.pathname === selectedRoute.pathname
    ? routes
    : null;
}

function sanitizeStoredRouteSegment(value: CaptureRouteSegmentV1): CaptureRouteSegmentV1 | null {
  try {
    const url = new URL(`${value.origin}${value.pathname}`);
    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== value.origin ||
      url.pathname !== value.pathname ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      decodedPathname.toLowerCase().includes("[redacted:")
    ) return null;
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
}

function projectAttachment(attachment: UIAttachment): UIAttachment {
  return {
    schemaVersion: attachment.schemaVersion,
    id: attachment.id,
    capturedAt: attachment.capturedAt,
    source: projectSource(attachment.source),
    ...(attachment.sourceAnchor === undefined
      ? {}
      : { sourceAnchor: { ...attachment.sourceAnchor } }),
    element: projectElement(attachment.element),
    style: projectStyle(attachment.style),
    context: projectContext(attachment.context),
    locatorBundle: projectLocatorBundle(attachment.locatorBundle),
    policy: projectPolicy(attachment.policy),
    artifacts: projectArtifacts(attachment.artifacts),
    ...(attachment.boundary === undefined
      ? {}
      : { boundary: { ...attachment.boundary } }),
  };
}

function projectSource(source: UIAttachment["source"]): UIAttachment["source"] {
  return {
    kind: source.kind,
    url: source.url,
    title: source.title,
  };
}

function projectElement(element: UIAttachment["element"]): UIAttachment["element"] {
  return {
    tagName: element.tagName,
    role: element.role,
    text: element.text,
    accessibleName: element.accessibleName,
    bbox: projectBbox(element.bbox),
    visible: element.visible,
    enabled: element.enabled,
  };
}

function projectBbox(bbox: UIAttachment["element"]["bbox"]): UIAttachment["element"]["bbox"] {
  return {
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
  };
}

function projectStyle(style: UIAttachment["style"]): UIAttachment["style"] {
  return {
    display: style.display,
    color: style.color,
    backgroundColor: style.backgroundColor,
  };
}

function projectContext(context: UIAttachment["context"]): UIAttachment["context"] {
  return {
    parentSummary: context.parentSummary,
    nearbyText: [...context.nearbyText],
    selectorHints: [...context.selectorHints],
  };
}

function projectLocatorBundle(
  locatorBundle: UIAttachment["locatorBundle"],
): UIAttachment["locatorBundle"] {
  return {
    primary: locatorBundle.primary === null ? null : projectLocator(locatorBundle.primary),
    candidates: locatorBundle.candidates.map(projectLocator),
    stability: projectStability(locatorBundle.stability),
  };
}

function projectLocator(
  locator: UIAttachment["locatorBundle"]["candidates"][number],
): UIAttachment["locatorBundle"]["candidates"][number] {
  return {
    strategy: locator.strategy,
    value: locator.value,
    confidence: locator.confidence,
    ...(locator.notes !== undefined ? { notes: locator.notes } : {}),
  };
}

function projectStability(
  stability: UIAttachment["locatorBundle"]["stability"],
): UIAttachment["locatorBundle"]["stability"] {
  return {
    score: stability.score,
    uniqueness: stability.uniqueness,
    replayVerified: stability.replayVerified,
    failureReason: stability.failureReason,
    ...(stability.verifiedBy !== undefined ? { verifiedBy: stability.verifiedBy } : {}),
    ...(stability.verifiedValue !== undefined
      ? { verifiedValue: stability.verifiedValue }
      : {}),
  };
}

function projectPolicy(policy: UIAttachment["policy"]): UIAttachment["policy"] {
  return {
    disclosureMode: policy.disclosureMode,
    redactionLevel: policy.redactionLevel,
    actionMode: policy.actionMode,
    allowScreenshot: policy.allowScreenshot,
    allowDomSnippet: policy.allowDomSnippet,
    allowNetworkSend: policy.allowNetworkSend,
    allowedDomains: [...policy.allowedDomains],
    redactedFields: [...policy.redactedFields],
    sensitiveHints: [...policy.sensitiveHints],
    includedSensitiveFields: [...policy.includedSensitiveFields],
  };
}

function projectArtifacts(artifacts: UIAttachment["artifacts"]): UIAttachment["artifacts"] {
  return {
    screenshotCrop: artifacts.screenshotCrop,
    overlayImage: artifacts.overlayImage,
  };
}

function projectReplayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectReplayValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, projectReplayValue(value[key])]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
