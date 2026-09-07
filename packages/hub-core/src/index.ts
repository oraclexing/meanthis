import {
  serializeAttachmentMarkdown,
  serializeAttachmentSummary,
  UI_ATTACHMENT_COMPACT_SOURCE_RESOLUTION_CONTRACT,
  UI_ATTACHMENT_LIVE_CONSUMER_CONTRACT,
  UI_ATTACHMENT_SOURCE_RESOLUTION_CONTRACT,
  UI_ATTACHMENT_UNTRUSTED_DATA_NOTICE,
} from "@meanthis/prompt";
import {
  isUIAttachment,
  UI_ATTACHMENT_COMPUTED_STYLE_FIELDS,
  type SavedSnapshotAuthorityV1,
  type UIAttachment,
  type UIAttachmentDisclosureMode,
  type UILocatorStrategy,
} from "@meanthis/schema";
export type { SavedSnapshotAuthorityV1 } from "@meanthis/schema";
import {
  deriveAttachmentDisclosure,
  redactRecognizedSensitiveText,
} from "@meanthis/web-extractor";

export interface CaptureRouteSegmentV1 {
  origin: string;
  pathname: string;
}

export interface OriginCaptureRecordLike {
  origin: string;
  pageUrl: string | null;
  pageTitle: string | null;
  attachment: UIAttachment;
  intent: string;
  markdown: string;
  summary?: string;
  replayAttempts?: unknown[];
  capturedAt: string;
  tabId?: number;
  frameId?: number;
  routeChain?: CaptureRouteSegmentV1[];
}

export interface CaptureHubOptions {
  now?: () => Date;
}

export interface CreateSessionOptions {
  id?: string;
  title?: string | null;
  origin?: string | null;
}

export interface AddAttachmentOptions {
  id?: string;
  labels?: string[];
}

export interface DisclosureViewOptions {
  disclosureMode?: UIAttachmentDisclosureMode;
}

export interface CaptureSession {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  origin: string | null;
  attachments: CaptureHubItem[];
}

export interface CaptureHubItem {
  id: string;
  annotationId?: string;
  annotationLifecycle?: CaptureSessionAnnotationLifecycleV3;
  sourceRecord: OriginCaptureRecordLike;
  createdAt: string;
  updatedAt?: string;
  labels: string[];
}

export interface CaptureHubItemSummary {
  id: string;
  target: string;
  origin: string;
  pageTitle: string | null;
  pageUrl: string | null;
  capturedAt: string;
  disclosureMode: UIAttachmentDisclosureMode;
  replayVerified: boolean;
  redactedFields: string[];
  sensitiveHints: string[];
  includedSensitiveFields: string[];
  labels: string[];
  routingHint: CapturePageRoutingHintV1 | null;
}

export type CaptureHubSummaryResult =
  | ({
      ok: true;
    } & CaptureHubSummary)
  | {
      ok: false;
      error: string;
    };

export interface CaptureHubSummary {
  sessionId: string;
  title: string | null;
  attachmentCount: number;
  origins: string[];
  lastUpdatedAt: string;
  items: CaptureHubItemSummary[];
}

export type CaptureHubAttachmentResult =
  | {
      ok: true;
      item: CaptureHubItem;
      record: OriginCaptureRecordLike;
    }
  | {
      ok: false;
      error: string;
    };

export type CapturePromptBundleResult =
  | ({
      ok: true;
    } & CapturePromptBundle)
  | {
      ok: false;
      error: string;
    };

export interface CapturePromptBundle {
  sessionId: string;
  title: string | null;
  disclosureMode: UIAttachmentDisclosureMode;
  attachmentCount: number;
  attachmentIds: string[];
  attachmentRefs: CapturePromptBundleAttachmentRef[];
  routingHints: CapturePromptBundleRoutingRef[];
  markdown: string;
}

export interface SavedSnapshotPromptBundle
  extends Omit<CapturePromptBundle, "routingHints"> {
  kind: "ui-attach.saved-snapshot-prompt-bundle";
  authority: SavedSnapshotAuthorityV1;
}

export type SavedSnapshotPromptBundleResult =
  | ({ ok: true } & SavedSnapshotPromptBundle)
  | { ok: false; error: string };

export type CapturePromptBundleFormat = "exact" | "compact";

export interface CapturePromptBundleAttachmentRef {
  id: string;
  label: string;
  target: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  primaryLocator: string | null;
}

export interface CapturePageRoutingHintV1 {
  schemaVersion: "0.1.0";
  kind: "ui-attach.page-routing-hint";
  browserFamily: "chromium";
  pageInstanceId: string;
  tabId: number;
  frameId: number;
  route: string;
  capturedAt: string;
  matchPolicy: "unique-tab-and-frame-route-candidate";
  controlPolicy: "require-user-confirmation";
}

export interface CapturePromptBundleRoutingRef {
  attachmentId: string;
  label: string;
  routingHint: CapturePageRoutingHintV1;
}

export interface CapturePageRoutingSource {
  attachmentId: string;
  label: string;
  record: OriginCaptureRecordLike;
}

export interface BuildPromptBundleOptions {
  sessionId: string;
  attachmentIds: string[];
  disclosureMode?: UIAttachmentDisclosureMode;
  intent?: string;
  attachmentLabels?: Record<string, string>;
  attachmentIntents?: Record<string, string>;
  format?: CapturePromptBundleFormat;
}

export interface BuildSavedSnapshotPromptBundleOptions {
  sessionId: string;
  attachmentIds: string[];
  attachmentLabels?: Record<string, string>;
  attachmentIntents: Record<string, string>;
  format?: CapturePromptBundleFormat;
}

export interface CaptureHub {
  createSession(options?: CreateSessionOptions): CaptureSession;
  /** Returns agent-safe session views. Use getAttachment for an explicit disclosure mode. */
  listSessions(): CaptureSession[];
  addAttachment(
    sessionId: string,
    record: OriginCaptureRecordLike,
    options?: AddAttachmentOptions,
  ): CaptureHubAttachmentResult;
  summarizeSession(
    sessionId: string,
    options?: DisclosureViewOptions,
  ): CaptureHubSummaryResult;
  getAttachment(
    sessionId: string,
    attachmentId: string,
    options?: DisclosureViewOptions,
  ): CaptureHubAttachmentResult;
  buildPromptBundle(options: BuildPromptBundleOptions): CapturePromptBundleResult;
  buildSavedSnapshotPromptBundle(
    options: BuildSavedSnapshotPromptBundleOptions,
  ): SavedSnapshotPromptBundleResult;
}

export const CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1 = "0.1.0" as const;
export const CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2 = "0.2.0" as const;
export const CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3 = "0.3.0" as const;
export const CAPTURE_SESSION_FILE_SCHEMA_VERSION = CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3;
export const CAPTURE_SESSION_FILE_KIND = "ui-attach.capture-session" as const;
export const CAPTURE_SESSION_FILE_MAX_BYTES = 1_048_576 as const;
export const CAPTURE_SESSION_FILE_MAX_ATTACHMENTS = 26 as const;
export const CAPTURE_SESSION_FILE_MAX_ANNOTATION_ID_LENGTH = 128 as const;
export const CAPTURE_SESSION_FILE_MAX_COLLECTION_ITEMS = 256 as const;
export const CAPTURE_SESSION_FILE_MAX_STRING_BYTES = CAPTURE_SESSION_FILE_MAX_BYTES;
export const CAPTURE_SESSION_FILE_MAX_OBJECT_KEYS = 64 as const;
export const CAPTURE_SESSION_FILE_MAX_VALIDATION_ISSUES = 100 as const;
export const CAPTURE_SESSION_FILE_MAX_NESTING_DEPTH = 32 as const;
export const CAPTURE_SESSION_FILE_MAX_VALUE_NODES = 65_536 as const;

export interface CaptureSessionFileSourceRecordV1 {
  origin: string;
  pageUrl: string | null;
  pageTitle: string | null;
  attachment: UIAttachment;
  intent: string;
  replayAttempts?: unknown[];
  capturedAt: string;
  tabId?: number;
  frameId?: number;
  routeChain?: CaptureRouteSegmentV1[];
}

export interface CaptureSessionFileItemV1 {
  id: string;
  createdAt: string;
  labels: string[];
  sourceRecord: CaptureSessionFileSourceRecordV1;
}

export interface CaptureSessionFileSessionV1 {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  origin: string;
  attachments: CaptureSessionFileItemV1[];
}

interface CaptureSessionFileBase {
  kind: typeof CAPTURE_SESSION_FILE_KIND;
}

export interface CaptureSessionFileV1 extends CaptureSessionFileBase {
  schemaVersion: typeof CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1;
  session: CaptureSessionFileSessionV1;
}

export interface CaptureSessionFileItemV2 extends CaptureSessionFileItemV1 {
  annotationId: string;
  updatedAt: string;
}

export interface CaptureSessionFileSessionV2
  extends Omit<CaptureSessionFileSessionV1, "attachments"> {
  attachments: CaptureSessionFileItemV2[];
}

export interface CaptureSessionFileV2 extends CaptureSessionFileBase {
  schemaVersion: typeof CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2;
  session: CaptureSessionFileSessionV2;
}

export type CaptureSessionAnnotationLifecycleStateV3 = "open" | "resolved";

export interface CaptureSessionAnnotationLifecycleV3 {
  state: CaptureSessionAnnotationLifecycleStateV3;
  resolvedAt: string | null;
}

export interface CaptureSessionFileItemV3 extends CaptureSessionFileItemV2 {
  annotationLifecycle: CaptureSessionAnnotationLifecycleV3;
}

export interface CaptureSessionFileSessionV3
  extends Omit<CaptureSessionFileSessionV2, "attachments"> {
  attachments: CaptureSessionFileItemV3[];
}

export interface CaptureSessionFileV3 extends CaptureSessionFileBase {
  schemaVersion: typeof CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3;
  session: CaptureSessionFileSessionV3;
}

export type CaptureSessionFile = CaptureSessionFileV1 | CaptureSessionFileV2 | CaptureSessionFileV3;

export interface CaptureSessionFileValidationIssue {
  path: string;
  message: string;
}

const CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE = "Capture session exceeds the byte limit.";
const CAPTURE_SESSION_FILE_VALIDATION_LIMIT_MESSAGE = "Capture session exceeds validation limits.";

export function isCaptureSessionFileByteLimitIssue(
  issue: CaptureSessionFileValidationIssue,
): boolean {
  return issue.path === "" && issue.message === CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE;
}

export function isCaptureSessionAnnotationId(value: unknown): value is string {
  return typeof value === "string" &&
    new RegExp(`^[A-Za-z0-9._:-]{1,${CAPTURE_SESSION_FILE_MAX_ANNOTATION_ID_LENGTH}}$`).test(value);
}

export function isCaptureSessionAnnotationLifecycleV3(
  value: unknown,
): value is CaptureSessionAnnotationLifecycleV3 {
  if (!hasExactDataFields(value, ["state", "resolvedAt"])) return false;
  const lifecycle = value as Record<string, unknown>;
  if (lifecycle.state === "open") return lifecycle.resolvedAt === null;
  return lifecycle.state === "resolved" &&
    typeof lifecycle.resolvedAt === "string" &&
    isCanonicalDateTime(lifecycle.resolvedAt, true);
}

export const isCaptureSessionAnnotationLifecycle = isCaptureSessionAnnotationLifecycleV3;
export const isAnnotationLifecycleV3 = isCaptureSessionAnnotationLifecycleV3;

export type CaptureSessionFileValidationResult =
  | { ok: true; file: CaptureSessionFile }
  | { ok: false; issues: CaptureSessionFileValidationIssue[] };

export interface SerializedCaptureSessionFile {
  file: CaptureSessionFile;
  text: string;
  byteLength: number;
}

export type CaptureSessionFileSerializationResult =
  | { ok: true; value: SerializedCaptureSessionFile }
  | { ok: false; issues: CaptureSessionFileValidationIssue[] };

export type CaptureSessionFileParseResult =
  | { ok: true; value: CaptureSessionFile }
  | { ok: false; issues: CaptureSessionFileValidationIssue[] };

export type CaptureSessionFileHydrationResult =
  | { ok: true; hub: CaptureHub; sessionId: string }
  | { ok: false; issues: CaptureSessionFileValidationIssue[] };

export function sanitizeCaptureSessionFileValidationIssues(
  issues: readonly CaptureSessionFileValidationIssue[],
): CaptureSessionFileValidationIssue[] {
  return issues.map((issue) => ({
    path: /^[A-Za-z0-9_.[\]:-]*$/.test(issue.path) ? issue.path : "",
    message: sanitizeCaptureSessionFileValidationMessage(issue.message),
  }));
}

function sanitizeCaptureSessionFileValidationMessage(message: string): string {
  if (SAFE_CAPTURE_SESSION_VALIDATION_MESSAGES.has(message)) {
    return message;
  }
  if (/^Duplicate attachment id ".+"\.$/.test(message)) {
    return "Duplicate attachment id.";
  }
  if (/^Duplicate label ".+"\.$/.test(message)) {
    return "Duplicate label.";
  }
  if (/^Expected attachment id ".+" or a numeric deduplication suffix\.$/.test(message)) {
    return "Expected attachment id or a numeric deduplication suffix.";
  }
  if (/^Expected origin ".+"\.$/.test(message)) {
    return "Expected origin to match session origin.";
  }
  if (/^Expected an HTTP\(S\) URL with origin ".+"\.$/.test(message)) {
    return "Expected an HTTP(S) URL with session origin.";
  }
  return "Invalid capture session field.";
}

const SAFE_CAPTURE_SESSION_VALIDATION_MESSAGES = new Set([
  'Expected "0.1.0".',
  'Expected "0.2.0".',
  'Expected "0.3.0".',
  'Expected "0.1.0", "0.2.0", or "0.3.0".',
  'Expected "ui-attach.capture-session".',
  "Expected a root record.",
  "Expected a session record.",
  "Expected a session id in the form session-<positive integer>.",
  "Expected a string or null.",
  "Expected a canonical HTTP(S) origin.",
  "Expected an array.",
  "Expected an attachment item record.",
  "Expected a non-empty attachment id.",
  "Expected an opaque ASCII annotation id up to 128 characters.",
  "Duplicate annotation id.",
  "Expected item updatedAt not to precede createdAt.",
  "Expected item updatedAt not to exceed session updatedAt.",
  "Expected an annotation lifecycle record.",
  'Expected annotation lifecycle state to be "open" or "resolved".',
  "Expected annotation lifecycle resolvedAt to be a string or null.",
  "Expected open annotation lifecycle resolvedAt to be null.",
  "Expected resolved annotation lifecycle resolvedAt to be canonical.",
  "Expected annotation lifecycle resolvedAt not to precede item createdAt.",
  "Expected annotation lifecycle resolvedAt not to exceed item updatedAt.",
  "Expected a label from A through Z.",
  "Expected a source record.",
  "Expected session title to match at least one source record page title.",
  "Expected an HTTP(S) origin.",
  "Expected a valid UIAttachment.",
  "Expected a known disclosure field path.",
  "Expected a string.",
  "Derived markdown must not be persisted in a session file.",
  "Derived summary must not be persisted in a session file.",
  "Unknown field.",
  "Expected a canonical UTC ISO date-time string.",
  "Expected a non-negative integer.",
  "Expected capture session JSON text.",
  "Expected canonical capture session JSON bytes.",
  CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE,
  CAPTURE_SESSION_FILE_VALIDATION_LIMIT_MESSAGE,
]);

class CaptureSessionFileValidationIssues extends Array<CaptureSessionFileValidationIssue> {
  override push(...issues: CaptureSessionFileValidationIssue[]): number {
    const remaining = CAPTURE_SESSION_FILE_MAX_VALIDATION_ISSUES - this.length;
    if (remaining <= 0) return this.length;
    return super.push(...issues.slice(0, remaining));
  }
}

const CAPTURE_SESSION_ATTACHMENT_AUDIT_FIELDS = new Set([
  "attachment.id",
  "source.url",
  "source.title",
  "element.tagName",
  "element.role",
  "element.text",
  "element.accessibleName",
  "style.display",
  "style.color",
  "style.backgroundColor",
  ...UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.map((field) => `style.${field}`),
  "context.parentSummary",
  "context.nearbyText",
  "context.selectorHints",
  "locatorBundle.candidates",
  "locatorBundle.notes",
  "locatorBundle.stability.failureReason",
  "locatorBundle.stability.verifiedValue",
  "artifacts.screenshotCrop",
  "artifacts.overlayImage",
  "record.replayAttempts",
]);

export function validateCaptureSessionFile(
  value: unknown,
): CaptureSessionFileValidationResult {
  const budgetedClone = cloneCaptureSessionFileValueWithinBudget(value);
  if (!budgetedClone.ok) {
    return {
      ok: false,
      issues: [{
        path: "",
        message: budgetedClone.reason === "byte_limit"
          ? CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE
          : CAPTURE_SESSION_FILE_VALIDATION_LIMIT_MESSAGE,
      }],
    };
  }
  value = budgetedClone.value;

  const issues = new CaptureSessionFileValidationIssues();
  if (!isUnknownRecord(value)) {
    return { ok: false, issues: [{ path: "", message: "Expected a root record." }] };
  }

  validateKnownFields(value, "", ["schemaVersion", "kind", "session"], issues);

  const isLegacyV1 = value.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1;
  const isCurrentV2 = value.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2;
  const isCurrentV3 = value.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3;
  if (!isLegacyV1 && !isCurrentV2 && !isCurrentV3) {
    issues.push({
      path: "schemaVersion",
      message: `Expected "${CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1}", "${CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2}", or "${CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3}".`,
    });
  }
  if (value.kind !== CAPTURE_SESSION_FILE_KIND) {
    issues.push({ path: "kind", message: `Expected "${CAPTURE_SESSION_FILE_KIND}".` });
  }
  if (!isUnknownRecord(value.session)) {
    issues.push({ path: "session", message: "Expected a session record." });
    return { ok: false, issues };
  }

  const session = value.session;
  validateKnownFields(
    session,
    "session",
    ["id", "title", "createdAt", "updatedAt", "origin", "attachments"],
    issues,
  );
  if (typeof session.id !== "string" || !/^session-[1-9][0-9]*$/.test(session.id)) {
    issues.push({ path: "session.id", message: "Expected a session id in the form session-<positive integer>." });
  }
  if (session.title !== null && typeof session.title !== "string") {
    issues.push({ path: "session.title", message: "Expected a string or null." });
  }
  validateCanonicalDateTime(session.createdAt, "session.createdAt", issues, isCurrentV3);
  validateCanonicalDateTime(session.updatedAt, "session.updatedAt", issues, isCurrentV3);
  const sessionOrigin = typeof session.origin === "string" && isCanonicalHttpOrigin(session.origin)
    ? session.origin
    : null;
  if (!sessionOrigin) {
    issues.push({ path: "session.origin", message: "Expected a canonical HTTP(S) origin." });
  }
  if (!Array.isArray(session.attachments)) {
    issues.push({ path: "session.attachments", message: "Expected an array." });
    return issues.length === 0
      ? { ok: true, file: value as unknown as CaptureSessionFile }
      : { ok: false, issues };
  }
  if (session.attachments.length > CAPTURE_SESSION_FILE_MAX_ATTACHMENTS) {
    issues.push({
      path: "session.attachments",
      message: "Capture session exceeds validation limits.",
    });
    return { ok: false, issues };
  }

  const itemIds = new Set<string>();
  const annotationIds = new Set<string>();
  const labels = new Set<string>();
  const validSourceRecords: Array<{ pageTitle: string | null }> = [];
  session.attachments.forEach((item, index) => {
    const itemPath = `session.attachments[${index}]`;
    if (!isUnknownRecord(item)) {
      issues.push({ path: itemPath, message: "Expected an attachment item record." });
      return;
    }
    validateKnownFields(
      item,
      itemPath,
      isCurrentV2
        ? ["id", "annotationId", "createdAt", "updatedAt", "labels", "sourceRecord"]
        : isCurrentV3
          ? [
              "id",
              "annotationId",
              "createdAt",
              "updatedAt",
              "annotationLifecycle",
              "labels",
              "sourceRecord",
            ]
          : ["id", "createdAt", "labels", "sourceRecord"],
      issues,
    );

    const sourceRecord = isUnknownRecord(item.sourceRecord) ? item.sourceRecord : null;
    const attachment = sourceRecord?.attachment;
    const validAttachment = isUIAttachment(attachment);
    const attachmentId = validAttachment ? attachment.id : null;

    if (typeof item.id !== "string" || item.id.length === 0) {
      issues.push({ path: `${itemPath}.id`, message: "Expected a non-empty attachment id." });
    } else {
      if (itemIds.has(item.id)) {
        issues.push({ path: `${itemPath}.id`, message: `Duplicate attachment id "${item.id}".` });
      }
      itemIds.add(item.id);
      if (attachmentId && !isCaptureSessionFileItemId(item.id, attachmentId)) {
        issues.push({
          path: `${itemPath}.id`,
          message: `Expected attachment id "${attachmentId}" or a numeric deduplication suffix.`,
        });
      }
    }
    validateCanonicalDateTime(item.createdAt, `${itemPath}.createdAt`, issues, isCurrentV3);
    if (isCurrentV2 || isCurrentV3) {
      if (!isCaptureSessionAnnotationId(item.annotationId)) {
        issues.push({
          path: `${itemPath}.annotationId`,
          message: "Expected an opaque ASCII annotation id up to 128 characters.",
        });
      } else if (annotationIds.has(item.annotationId)) {
        issues.push({
          path: `${itemPath}.annotationId`,
          message: "Duplicate annotation id.",
        });
      } else {
        annotationIds.add(item.annotationId);
      }
      validateCanonicalDateTime(item.updatedAt, `${itemPath}.updatedAt`, issues, isCurrentV3);
      if (
        typeof item.createdAt === "string" &&
        typeof item.updatedAt === "string" &&
        Date.parse(item.updatedAt) < Date.parse(item.createdAt)
      ) {
        issues.push({
          path: `${itemPath}.updatedAt`,
          message: "Expected item updatedAt not to precede createdAt.",
        });
      }
      if (
        typeof item.updatedAt === "string" &&
        typeof session.updatedAt === "string" &&
        Date.parse(item.updatedAt) > Date.parse(session.updatedAt)
      ) {
        issues.push({
          path: `${itemPath}.updatedAt`,
          message: "Expected item updatedAt not to exceed session updatedAt.",
        });
      }
    }
    if (isCurrentV3) {
      validateCaptureSessionAnnotationLifecycle(
        item.annotationLifecycle,
        `${itemPath}.annotationLifecycle`,
        item.createdAt,
        item.updatedAt,
        issues,
      );
    }
    if (!Array.isArray(item.labels)) {
      issues.push({ path: `${itemPath}.labels`, message: "Expected an array." });
    } else {
      item.labels.forEach((label, labelIndex) => {
        const labelPath = `${itemPath}.labels[${labelIndex}]`;
        if (typeof label !== "string" || !/^[A-Z]$/.test(label)) {
          issues.push({ path: labelPath, message: "Expected a label from A through Z." });
          return;
        }
        if (labels.has(label)) {
          issues.push({ path: labelPath, message: `Duplicate label "${label}".` });
        }
        labels.add(label);
      });
    }

    if (!sourceRecord) {
      issues.push({ path: `${itemPath}.sourceRecord`, message: "Expected a source record." });
      return;
    }
    const recordPath = `${itemPath}.sourceRecord`;
    const sourceRecordIsValid = validateCaptureSessionFileSourceRecord(
      sourceRecord,
      recordPath,
      sessionOrigin,
      isCurrentV3,
      issues,
    );
    if (sourceRecordIsValid) {
      validSourceRecords.push({ pageTitle: sourceRecord.pageTitle as string | null });
    }
  });

  if (
    typeof session.title === "string" &&
    !validSourceRecords.some((record) => record.pageTitle === session.title)
  ) {
    issues.push({
      path: "session.title",
      message: "Expected session title to match at least one source record page title.",
    });
  }

  return issues.length === 0
    ? { ok: true, file: value as unknown as CaptureSessionFile }
    : { ok: false, issues };
}

export function serializeCaptureSessionFile(
  value: unknown,
): CaptureSessionFileSerializationResult {
  const validation = validateCaptureSessionFile(value);
  if (!validation.ok) {
    return {
      ok: false,
      issues: sanitizeCaptureSessionFileValidationIssues(validation.issues),
    };
  }

  const file = canonicalizeCaptureSessionFile(validation.file);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > CAPTURE_SESSION_FILE_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: "", message: CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE }],
    };
  }
  return { ok: true, value: { file, text, byteLength } };
}

export function serializeCaptureSessionFileText(value: unknown): string | null {
  const result = serializeCaptureSessionFile(value);
  return result.ok ? result.value.text : null;
}

export function parseCaptureSessionFile(text: unknown): CaptureSessionFileParseResult {
  if (typeof text !== "string") {
    return {
      ok: false,
      issues: [{ path: "", message: "Expected capture session JSON text." }],
    };
  }
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > CAPTURE_SESSION_FILE_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: "", message: CAPTURE_SESSION_FILE_BYTE_LIMIT_MESSAGE }],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: [{ path: "", message: "Expected capture session JSON text." }],
    };
  }

  const serialized = serializeCaptureSessionFile(value);
  if (!serialized.ok) return serialized;
  if (serialized.value.text !== text) {
    return {
      ok: false,
      issues: [{ path: "", message: "Expected canonical capture session JSON bytes." }],
    };
  }
  return { ok: true, value: serialized.value.file };
}

export function parseCaptureSessionFileValue(text: unknown): CaptureSessionFile | null {
  const result = parseCaptureSessionFile(text);
  return result.ok ? result.value : null;
}

export function isCaptureSessionFile(value: unknown): value is CaptureSessionFile {
  return validateCaptureSessionFile(value).ok;
}

export function isCaptureSessionFileV1(value: unknown): value is CaptureSessionFileV1 {
  const result = validateCaptureSessionFile(value);
  return result.ok && result.file.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1;
}

export function isCaptureSessionFileV2(value: unknown): value is CaptureSessionFileV2 {
  const result = validateCaptureSessionFile(value);
  return result.ok && result.file.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V2;
}

export function isCaptureSessionFileV3(value: unknown): value is CaptureSessionFileV3 {
  const result = validateCaptureSessionFile(value);
  return result.ok && result.file.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3;
}

export function hydrateCaptureSessionFile(
  value: unknown,
  options: CaptureHubOptions = {},
): CaptureSessionFileHydrationResult {
  const validation = validateCaptureSessionFile(value);
  if (!validation.ok) {
    return validation;
  }

  const session: CaptureSession = {
    ...validation.file.session,
    attachments: validation.file.session.attachments.map((item) => {
      const sourceRecord: OriginCaptureRecordLike = {
        ...item.sourceRecord,
        attachment: structuredClone(item.sourceRecord.attachment),
        markdown: serializeAttachmentMarkdown(item.sourceRecord.attachment),
        summary: serializeAttachmentSummary(item.sourceRecord.attachment),
        replayAttempts: item.sourceRecord.replayAttempts
          ? structuredClone(item.sourceRecord.replayAttempts)
          : undefined,
      };
      return {
        ...item,
        labels: [...item.labels],
        sourceRecord,
      };
    }),
  };
  const hub = createCaptureHubInternal(options, [session]);
  return { ok: true, hub, sessionId: session.id };
}

function validateCaptureSessionAnnotationLifecycle(
  value: unknown,
  path: string,
  itemCreatedAt: unknown,
  itemUpdatedAt: unknown,
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (!isUnknownRecord(value)) {
    issues.push({ path, message: "Expected an annotation lifecycle record." });
    return;
  }
  validateKnownFields(value, path, ["state", "resolvedAt"], issues);

  const state = value.state;
  const resolvedAt = value.resolvedAt;
  if (state !== "open" && state !== "resolved") {
    issues.push({
      path: `${path}.state`,
      message: 'Expected annotation lifecycle state to be "open" or "resolved".',
    });
  }

  if (resolvedAt !== null && typeof resolvedAt !== "string") {
    issues.push({
      path: `${path}.resolvedAt`,
      message: "Expected annotation lifecycle resolvedAt to be a string or null.",
    });
    return;
  }

  if (state === "open") {
    if (resolvedAt !== null) {
      issues.push({
        path: `${path}.resolvedAt`,
        message: "Expected open annotation lifecycle resolvedAt to be null.",
      });
    }
    return;
  }

  if (state !== "resolved") return;
  if (typeof resolvedAt !== "string" || !isCanonicalDateTime(resolvedAt, true)) {
    issues.push({
      path: `${path}.resolvedAt`,
      message: "Expected resolved annotation lifecycle resolvedAt to be canonical.",
    });
    return;
  }

  const resolvedMilliseconds = Date.parse(resolvedAt);
  const createdMilliseconds = typeof itemCreatedAt === "string"
    ? Date.parse(itemCreatedAt)
    : Number.NaN;
  const updatedMilliseconds = typeof itemUpdatedAt === "string"
    ? Date.parse(itemUpdatedAt)
    : Number.NaN;
  if (Number.isFinite(createdMilliseconds) && resolvedMilliseconds < createdMilliseconds) {
    issues.push({
      path: `${path}.resolvedAt`,
      message: "Expected annotation lifecycle resolvedAt not to precede item createdAt.",
    });
  }
  if (Number.isFinite(updatedMilliseconds) && resolvedMilliseconds > updatedMilliseconds) {
    issues.push({
      path: `${path}.resolvedAt`,
      message: "Expected annotation lifecycle resolvedAt not to exceed item updatedAt.",
    });
  }
}

function validateCaptureSessionFileSourceRecord(
  sourceRecord: Record<string, unknown>,
  recordPath: string,
  sessionOrigin: string | null,
  strictDateTime: boolean,
  issues: CaptureSessionFileValidationIssue[],
): boolean {
  const issueCount = issues.length;
  validateKnownFields(
    sourceRecord,
    recordPath,
    [
      "origin",
      "pageUrl",
      "pageTitle",
      "attachment",
      "intent",
      "replayAttempts",
      "capturedAt",
      "tabId",
      "frameId",
      "routeChain",
      "markdown",
      "summary",
    ],
    issues,
  );
  if (typeof sourceRecord.origin !== "string") {
    issues.push({ path: `${recordPath}.origin`, message: "Expected an HTTP(S) origin." });
  } else if (!isCanonicalHttpOrigin(sourceRecord.origin)) {
    issues.push({ path: `${recordPath}.origin`, message: "Expected a canonical HTTP(S) origin." });
  } else if (sessionOrigin && sourceRecord.origin !== sessionOrigin) {
    issues.push({
      path: `${recordPath}.origin`,
      message: `Expected origin "${sessionOrigin}".`,
    });
  }

  validateNullableString(sourceRecord.pageUrl, `${recordPath}.pageUrl`, issues);
  validateNullableString(sourceRecord.pageTitle, `${recordPath}.pageTitle`, issues);
  if (typeof sourceRecord.pageUrl === "string" && !isSameOriginHttpUrl(sourceRecord.pageUrl, sessionOrigin)) {
    issues.push({
      path: `${recordPath}.pageUrl`,
      message: `Expected an HTTP(S) URL with origin "${sessionOrigin ?? "session origin"}".`,
    });
  }

  validateCaptureSessionFileAttachmentFields(
    sourceRecord.attachment,
    `${recordPath}.attachment`,
    issues,
  );
  if (!isUIAttachment(sourceRecord.attachment)) {
    issues.push({ path: `${recordPath}.attachment`, message: "Expected a valid UIAttachment." });
  } else {
    validateCanonicalDateTime(
      sourceRecord.attachment.capturedAt,
      `${recordPath}.attachment.capturedAt`,
      issues,
      strictDateTime,
    );
    if (sourceRecord.attachment.id.length === 0) {
      issues.push({ path: `${recordPath}.attachment.id`, message: "Expected a non-empty attachment id." });
    }
    if (
      typeof sourceRecord.attachment.source.url === "string" &&
      !isSameOriginHttpUrl(sourceRecord.attachment.source.url, sessionOrigin)
    ) {
      issues.push({
        path: `${recordPath}.attachment.source.url`,
        message: `Expected an HTTP(S) URL with origin "${sessionOrigin ?? "session origin"}".`,
      });
    }
    sourceRecord.attachment.policy.allowedDomains.forEach((domain, index) => {
      if (sessionOrigin && domain !== sessionOrigin) {
        issues.push({
          path: `${recordPath}.attachment.policy.allowedDomains[${index}]`,
          message: `Expected origin "${sessionOrigin}".`,
        });
      }
    });
    for (const field of [
      "redactedFields",
      "sensitiveHints",
      "includedSensitiveFields",
    ] as const) {
      sourceRecord.attachment.policy[field].forEach((value, index) => {
        if (!CAPTURE_SESSION_ATTACHMENT_AUDIT_FIELDS.has(value)) {
          issues.push({
            path: `${recordPath}.attachment.policy.${field}[${index}]`,
            message: "Expected a known disclosure field path.",
          });
        }
      });
    }
  }

  if (typeof sourceRecord.intent !== "string") {
    issues.push({ path: `${recordPath}.intent`, message: "Expected a string." });
  }
  validateCanonicalDateTime(
    sourceRecord.capturedAt,
    `${recordPath}.capturedAt`,
    issues,
    strictDateTime,
  );
  validateOptionalNonNegativeInteger(sourceRecord.tabId, `${recordPath}.tabId`, issues);
  validateOptionalNonNegativeInteger(sourceRecord.frameId, `${recordPath}.frameId`, issues);
  validateCaptureRouteChain(
    sourceRecord.routeChain,
    sourceRecord.pageUrl,
    sourceRecord.frameId,
    `${recordPath}.routeChain`,
    issues,
  );
  if (sourceRecord.replayAttempts !== undefined && !Array.isArray(sourceRecord.replayAttempts)) {
    issues.push({ path: `${recordPath}.replayAttempts`, message: "Expected an array." });
  }
  if (Object.hasOwn(sourceRecord, "markdown")) {
    issues.push({
      path: `${recordPath}.markdown`,
      message: "Derived markdown must not be persisted in a session file.",
    });
  }
  if (Object.hasOwn(sourceRecord, "summary")) {
    issues.push({
      path: `${recordPath}.summary`,
      message: "Derived summary must not be persisted in a session file.",
    });
  }
  return issues.length === issueCount;
}

function validateCaptureSessionFileAttachmentFields(
  value: unknown,
  path: string,
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (!isUnknownRecord(value)) {
    return;
  }

  validateKnownFields(
    value,
    path,
    [
      "schemaVersion",
      "id",
      "capturedAt",
      "source",
      "sourceAnchor",
      "selectionPoint",
      "element",
      "style",
      "context",
      "locatorBundle",
      "policy",
      "artifacts",
      "boundary",
    ],
    issues,
  );
  validateNestedKnownFields(value.source, `${path}.source`, ["kind", "url", "title"], issues);
  validateNestedKnownFields(
    value.sourceAnchor,
    `${path}.sourceAnchor`,
    ["schemaVersion", "kind", "buildId", "sourceId"],
    issues,
  );
  validateNestedKnownFields(
    value.selectionPoint,
    `${path}.selectionPoint`,
    ["kind", "xRatio", "yRatio"],
    issues,
  );
  validateNestedKnownFields(
    value.element,
    `${path}.element`,
    [
      "tagName",
      "role",
      "text",
      "accessibleName",
      "contentParts",
      "bbox",
      "visible",
      "enabled",
    ],
    issues,
  );
  if (isUnknownRecord(value.element)) {
    if (Array.isArray(value.element.contentParts)) {
      value.element.contentParts.forEach((part, index) => {
        validateNestedKnownFields(
          part,
          `${path}.element.contentParts[${index}]`,
          ["kind", "tagName", "role", "text", "accessibleName"],
          issues,
        );
      });
    }
    validateNestedKnownFields(
      value.element.bbox,
      `${path}.element.bbox`,
      ["x", "y", "width", "height"],
      issues,
    );
  }
  validateNestedKnownFields(
    value.style,
    `${path}.style`,
    ["display", "color", "backgroundColor", ...UI_ATTACHMENT_COMPUTED_STYLE_FIELDS],
    issues,
  );
  validateNestedKnownFields(
    value.context,
    `${path}.context`,
    ["parentSummary", "nearbyText", "selectorHints"],
    issues,
  );
  validateNestedKnownFields(
    value.locatorBundle,
    `${path}.locatorBundle`,
    ["primary", "candidates", "stability"],
    issues,
  );
  if (isUnknownRecord(value.locatorBundle)) {
    validateNestedKnownFields(
      value.locatorBundle.primary,
      `${path}.locatorBundle.primary`,
      ["strategy", "value", "confidence", "notes"],
      issues,
    );
    if (Array.isArray(value.locatorBundle.candidates)) {
      value.locatorBundle.candidates.forEach((candidate, index) => {
        validateNestedKnownFields(
          candidate,
          `${path}.locatorBundle.candidates[${index}]`,
          ["strategy", "value", "confidence", "notes"],
          issues,
        );
      });
    }
    validateNestedKnownFields(
      value.locatorBundle.stability,
      `${path}.locatorBundle.stability`,
      [
        "score",
        "uniqueness",
        "replayVerified",
        "failureReason",
        "verifiedBy",
        "verifiedValue",
      ],
      issues,
    );
  }
  validateNestedKnownFields(
    value.policy,
    `${path}.policy`,
    [
      "disclosureMode",
      "redactionLevel",
      "actionMode",
      "allowScreenshot",
      "allowDomSnippet",
      "allowNetworkSend",
      "allowedDomains",
      "redactedFields",
      "sensitiveHints",
      "includedSensitiveFields",
    ],
    issues,
  );
  validateNestedKnownFields(
    value.artifacts,
    `${path}.artifacts`,
    ["screenshotCrop", "overlayImage"],
    issues,
  );
  validateNestedKnownFields(
    value.boundary,
    `${path}.boundary`,
    [
      "kind",
      "innerDom",
      "originRelation",
      "frameOrigin",
      "framePathname",
      "dominantViewport",
    ],
    issues,
  );
}

function validateNestedKnownFields(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (isUnknownRecord(value)) {
    validateKnownFields(value, path, knownFields, issues);
  }
}

function validateKnownFields(
  value: Record<string, unknown>,
  path: string,
  knownFields: readonly string[],
  issues: CaptureSessionFileValidationIssue[],
): void {
  const known = new Set(knownFields);
  let unknownFieldIndex = 0;
  for (const field of Object.keys(value)) {
    if (!known.has(field)) {
      issues.push({
        path: path
          ? `${path}.[unknownField:${unknownFieldIndex}]`
          : `[unknownField:${unknownFieldIndex}]`,
        message: "Unknown field.",
      });
      unknownFieldIndex += 1;
    }
  }
}

type CaptureSessionBudgetResult = "ok" | "byte_limit" | "validation_limit";
type CaptureSessionBudgetedClone =
  | { ok: true; value: unknown }
  | { ok: false; reason: Exclude<CaptureSessionBudgetResult, "ok"> };

function cloneCaptureSessionFileValueWithinBudget(root: unknown): CaptureSessionBudgetedClone {
  const activeContainers = new WeakSet<object>();
  let totalBytes = 0;
  let valueNodes = 0;

  const addBytes = (bytes: number): CaptureSessionBudgetResult => {
    totalBytes += bytes;
    return totalBytes <= CAPTURE_SESSION_FILE_MAX_BYTES ? "ok" : "byte_limit";
  };

  const cloneValue = (current: unknown, depth: number): CaptureSessionBudgetedClone => {
    valueNodes += 1;
    if (
      valueNodes > CAPTURE_SESSION_FILE_MAX_VALUE_NODES ||
      depth > CAPTURE_SESSION_FILE_MAX_NESTING_DEPTH
    ) {
      return { ok: false, reason: "validation_limit" };
    }

    if (current === null) {
      const result = addBytes(4);
      return result === "ok" ? { ok: true, value: null } : { ok: false, reason: result };
    }
    if (typeof current === "string") {
      if (boundedUtf8Length(current) === null) return { ok: false, reason: "byte_limit" };
      const serialized = JSON.stringify(current);
      const result = addBytes(new TextEncoder().encode(serialized).byteLength);
      return result === "ok" ? { ok: true, value: current } : { ok: false, reason: result };
    }
    if (typeof current === "boolean") {
      const result = addBytes(current ? 4 : 5);
      return result === "ok" ? { ok: true, value: current } : { ok: false, reason: result };
    }
    if (typeof current === "number") {
      const result = addBytes(JSON.stringify(current).length);
      return result === "ok" ? { ok: true, value: current } : { ok: false, reason: result };
    }
    if (typeof current !== "object") return { ok: false, reason: "validation_limit" };
    if (activeContainers.has(current)) return { ok: false, reason: "validation_limit" };

    activeContainers.add(current);
    try {
      if (Array.isArray(current)) {
        if (
          Object.getPrototypeOf(current) !== Array.prototype ||
          current.length > CAPTURE_SESSION_FILE_MAX_COLLECTION_ITEMS
        ) {
          return { ok: false, reason: "validation_limit" };
        }
        const keys = Object.keys(current);
        const ownKeys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length ||
          ownKeys.length !== keys.length + 1 ||
          ownKeys.some((key) =>
            typeof key !== "string" || (key !== "length" && !keys.includes(key))) ||
          keys.some((key, index) => key !== String(index))
        ) {
          return { ok: false, reason: "validation_limit" };
        }
        const containerBudget = addBytes(2 + Math.max(0, current.length - 1));
        if (containerBudget !== "ok") return { ok: false, reason: containerBudget };

        const clone: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            return { ok: false, reason: "validation_limit" };
          }
          const child = cloneValue(descriptor.value, depth + 1);
          if (!child.ok) return child;
          clone.push(child.value);
        }
        return { ok: true, value: clone };
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return { ok: false, reason: "validation_limit" };
      }
      const keys = Object.keys(current);
      const ownKeys = Reflect.ownKeys(current);
      if (
        ownKeys.length > CAPTURE_SESSION_FILE_MAX_OBJECT_KEYS ||
        ownKeys.length !== keys.length ||
        ownKeys.some((key) => typeof key !== "string")
      ) {
        return { ok: false, reason: "validation_limit" };
      }
      const containerBudget = addBytes(2 + Math.max(0, keys.length - 1));
      if (containerBudget !== "ok") return { ok: false, reason: containerBudget };

      const clone = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (boundedUtf8Length(key) === null) return { ok: false, reason: "byte_limit" };
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return { ok: false, reason: "validation_limit" };
        }
        const keyBudget = addBytes(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1);
        if (keyBudget !== "ok") return { ok: false, reason: keyBudget };
        const child = cloneValue(descriptor.value, depth + 1);
        if (!child.ok) return child;
        Object.defineProperty(clone, key, {
          value: child.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { ok: true, value: clone };
    } finally {
      activeContainers.delete(current);
    }
  };

  try {
    return cloneValue(root, 0);
  } catch {
    return { ok: false, reason: "validation_limit" };
  }
}

function boundedUtf8Length(value: string): number | null {
  if (value.length > CAPTURE_SESSION_FILE_MAX_STRING_BYTES) return null;
  const length = new TextEncoder().encode(value).byteLength;
  return length <= CAPTURE_SESSION_FILE_MAX_STRING_BYTES ? length : null;
}

function validateNullableString(
  value: unknown,
  path: string,
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (value !== null && typeof value !== "string") {
    issues.push({ path, message: "Expected a string or null." });
  }
}

function validateCanonicalDateTime(
  value: unknown,
  path: string,
  issues: CaptureSessionFileValidationIssue[],
  boundedYear = false,
): void {
  if (typeof value !== "string" || !isCanonicalDateTime(value, boundedYear)) {
    issues.push({ path, message: "Expected a canonical UTC ISO date-time string." });
  }
}

function validateOptionalNonNegativeInteger(
  value: unknown,
  path: string,
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
    issues.push({ path, message: "Expected a non-negative integer." });
  }
}

function validateCaptureRouteChain(
  value: unknown,
  pageUrl: unknown,
  frameId: unknown,
  path: string,
  issues: CaptureSessionFileValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 33) {
    issues.push({ path, message: "Expected 1 to 33 canonical route segments." });
    return;
  }
  if (typeof frameId !== "number" || !Number.isInteger(frameId) || frameId < 0) {
    issues.push({ path, message: "Expected the route chain to include a valid frameId." });
    return;
  }
  const routes: CaptureRouteSegmentV1[] = [];
  for (const [index, segment] of value.entries()) {
    const segmentPath = `${path}[${index}]`;
    if (!isUnknownRecord(segment)) {
      issues.push({ path: segmentPath, message: "Expected a canonical route segment." });
      continue;
    }
    validateKnownFields(segment, segmentPath, ["origin", "pathname"], issues);
    if (typeof segment.origin !== "string" || !isCanonicalHttpOrigin(segment.origin)) {
      issues.push({ path: `${segmentPath}.origin`, message: "Expected a canonical HTTP(S) origin." });
      continue;
    }
    if (typeof segment.pathname !== "string" || !isCanonicalRoutePathname(segment.origin, segment.pathname)) {
      issues.push({ path: `${segmentPath}.pathname`, message: "Expected a canonical pathname." });
      continue;
    }
    routes.push({ origin: segment.origin, pathname: segment.pathname });
  }
  if (routes.length !== value.length) return;
  const selected = canonicalRouteSegmentFromUrl(pageUrl);
  const last = routes.at(-1);
  if (!selected || !last || selected.origin !== last.origin || selected.pathname !== last.pathname) {
    issues.push({ path, message: "Expected the route chain to end at pageUrl." });
  }
  if ((frameId === 0 && routes.length !== 1) || (frameId > 0 && routes.length < 2)) {
    issues.push({ path, message: "Expected the route chain depth to match frameId." });
  }
}

function isCanonicalRoutePathname(origin: string, pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  try {
    const url = new URL(`${origin}${pathname}`);
    return url.origin === origin &&
      url.pathname === pathname &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

function canonicalRouteSegmentFromUrl(value: unknown): CaptureRouteSegmentV1 | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? { origin: url.origin, pathname: url.pathname }
      : null;
  } catch {
    return null;
  }
}

function isCaptureSessionFileItemId(itemId: string, attachmentId: string): boolean {
  return (
    itemId === attachmentId ||
    new RegExp(`^${escapeRegExp(attachmentId)}-(?:[2-9]|[1-9][0-9]+)$`).test(itemId)
  );
}

function isCanonicalHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isSameOriginHttpUrl(value: string, expectedOrigin: string | null): boolean {
  if (!expectedOrigin) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isCanonicalDateTime(value: string, boundedYear = false): boolean {
  if (boundedYear && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function deriveCaptureRecordView(
  record: OriginCaptureRecordLike,
  disclosureMode: UIAttachmentDisclosureMode,
): CaptureHubAttachmentResult {
  return buildRecordView(record, disclosureMode);
}

export function deriveCapturePageRoutingHint(
  record: OriginCaptureRecordLike,
): CapturePageRoutingHintV1 | null {
  if (
    !Number.isSafeInteger(record.tabId) ||
    (record.tabId ?? -1) < 0 ||
    !Number.isSafeInteger(record.frameId) ||
    (record.frameId ?? -1) < 0 ||
    !record.pageUrl ||
    !isCanonicalDateTime(record.capturedAt)
  ) {
    return null;
  }

  try {
    const url = new URL(record.pageUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== record.origin ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const route = `${url.origin}${url.pathname}`;
    const decodedPathname = decodePathnameForSensitiveDetection(url.pathname);
    if (decodedPathname === null) {
      return null;
    }
    const decodedRoute = `${url.origin}${decodedPathname}`;
    if (
      decodedRoute.toLowerCase().includes("[redacted:") ||
      redactRecognizedSensitiveText(decodedRoute) !== decodedRoute
    ) {
      return null;
    }
    const tabId = record.tabId as number;
    const frameId = record.frameId as number;
    return {
      schemaVersion: "0.1.0",
      kind: "ui-attach.page-routing-hint",
      browserFamily: "chromium",
      pageInstanceId: `chromium-tab:${tabId}:frame:${frameId}`,
      tabId,
      frameId,
      route,
      capturedAt: record.capturedAt,
      matchPolicy: "unique-tab-and-frame-route-candidate",
      controlPolicy: "require-user-confirmation",
    };
  } catch {
    return null;
  }
}

export function buildCapturePageRoutingRefs(
  sources: CapturePageRoutingSource[],
): CapturePromptBundleRoutingRef[] {
  return sources.flatMap((source) => {
    const routingHint = deriveCapturePageRoutingHint(source.record);
    return routingHint
      ? [{ attachmentId: source.attachmentId, label: source.label, routingHint }]
      : [];
  });
}

export function serializeCapturePageRoutingSection(
  sources: CapturePageRoutingSource[],
): string | null {
  return serializeCapturePageRoutingRefs(buildCapturePageRoutingRefs(sources));
}

export function createCaptureHub(options: CaptureHubOptions = {}): CaptureHub {
  return createCaptureHubInternal(options);
}

function createCaptureHubInternal(
  options: CaptureHubOptions,
  initialSessions: CaptureSession[] = [],
): CaptureHub {
  const now = options.now ?? (() => new Date());
  const sessions = new Map(initialSessions.map((session) => [session.id, cloneSession(session)]));

  function nextSessionId(): string {
    let index = sessions.size + 1;
    while (sessions.has(`session-${index}`)) {
      index += 1;
    }
    return `session-${index}`;
  }

  function createSession(sessionOptions: CreateSessionOptions = {}): CaptureSession {
    const id = sessionOptions.id ?? nextSessionId();
    if (sessions.has(id)) {
      throw new Error("Capture session id already exists.");
    }
    const timestamp = now().toISOString();
    const session: CaptureSession = {
      id,
      title: sessionOptions.title ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: sessionOptions.origin ?? null,
      attachments: [],
    };
    sessions.set(id, session);
    return cloneSession(session);
  }

  function listSessions(): CaptureSession[] {
    return [...sessions.values()].map((session) => {
      let title = session.title;
      const itemIds = buildDisclosureItemIdMap(session, "agent_safe");
      const attachments = session.attachments.map((item) => {
        const view = buildRecordView(item.sourceRecord, "agent_safe");
        if (!view.ok) {
          throw new Error(view.error);
        }
        if (session.title !== null && item.sourceRecord.pageTitle === session.title) {
          title = view.record.pageTitle;
        }
        return {
          ...cloneItem(item),
          id: itemIds.get(item) ?? item.id,
          sourceRecord: cloneRecord(view.record),
        };
      });
      return {
        ...session,
        title,
        attachments,
      };
    });
  }

  function addAttachment(
    sessionId: string,
    record: OriginCaptureRecordLike,
    itemOptions: AddAttachmentOptions = {},
  ): CaptureHubAttachmentResult {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${sessionId}` };
    }

    const item: CaptureHubItem = {
      id: createUniqueAttachmentItemId(session, itemOptions.id ?? record.attachment.id),
      sourceRecord: cloneRecord(record),
      createdAt: now().toISOString(),
      labels: [...(itemOptions.labels ?? [])],
    };
    session.attachments.push(item);
    session.updatedAt = item.createdAt;
    session.origin = session.origin ?? record.origin;
    return {
      ok: true,
      item: cloneItem(item),
      record: cloneRecord(item.sourceRecord),
    };
  }

  function summarizeSession(
    sessionId: string,
    viewOptions: DisclosureViewOptions = {},
  ): CaptureHubSummaryResult {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${sessionId}` };
    }

    const disclosureMode = viewOptions.disclosureMode ?? "agent_safe";
    const itemIds = buildDisclosureItemIdMap(session, disclosureMode);
    const items: CaptureHubItemSummary[] = [];
    let title = session.title;
    for (const item of session.attachments) {
      const view = buildRecordView(item.sourceRecord, disclosureMode);
      if (!view.ok) {
        return view;
      }
      if (session.title !== null && item.sourceRecord.pageTitle === session.title) {
        title = view.record.pageTitle;
      }
      items.push(summarizeItem(item, view.record, itemIds.get(item) ?? item.id));
    }

    return {
      ok: true,
      sessionId: session.id,
      title,
      attachmentCount: session.attachments.length,
      origins: unique(items.map((item) => item.origin)),
      lastUpdatedAt: session.updatedAt,
      items,
    };
  }

  function getAttachment(
    sessionId: string,
    attachmentId: string,
    viewOptions: DisclosureViewOptions = {},
  ): CaptureHubAttachmentResult {
    const disclosureMode = viewOptions.disclosureMode ?? "agent_safe";
    const itemResult = findItem(sessionId, attachmentId, disclosureMode);
    if (!itemResult.ok) {
      return itemResult;
    }

    const view = buildRecordView(
      itemResult.item.sourceRecord,
      disclosureMode,
    );
    if (!view.ok) {
      return view;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${sessionId}` };
    }
    const itemId =
      buildDisclosureItemIdMap(session, disclosureMode).get(itemResult.item) ??
      itemResult.item.id;

    return {
      ok: true,
      item: {
        ...cloneItem(itemResult.item),
        id: itemId,
        sourceRecord: cloneRecord(view.record),
      },
      record: view.record,
    };
  }

  function buildPromptBundle(options: BuildPromptBundleOptions): CapturePromptBundleResult {
    const session = sessions.get(options.sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${options.sessionId}` };
    }

    const disclosureMode = options.disclosureMode ?? "agent_safe";
    const format = options.format ?? "exact";
    const prepared = preparePromptBundleItems(session, options, disclosureMode, format);
    if (!prepared.ok) return prepared;
    const { bundleItems } = prepared;

    return {
      ok: true,
      sessionId: session.id,
      title: derivePromptBundleTitle(session.title, bundleItems),
      disclosureMode,
      attachmentCount: bundleItems.length,
      attachmentIds: bundleItems.map((item) => item.ref.id),
      attachmentRefs: bundleItems.map((item) => ({ ...item.ref })),
      routingHints: buildCapturePageRoutingRefs(
        bundleItems.map((item) => ({
          attachmentId: item.ref.id,
          label: item.ref.label,
          record: item.record,
        })),
      ),
      markdown: buildBundleMarkdown(bundleItems, options.intent ?? "", format),
    };
  }

  function buildSavedSnapshotPromptBundle(
    options: BuildSavedSnapshotPromptBundleOptions,
  ): SavedSnapshotPromptBundleResult {
    const session = sessions.get(options.sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${options.sessionId}` };
    }
    if (!session.origin || !isCanonicalHttpOrigin(session.origin)) {
      return {
        ok: false,
        error: "Saved snapshot bundles require a canonical HTTP(S) origin.",
      };
    }
    if (
      options.attachmentIntents === null ||
      typeof options.attachmentIntents !== "object" ||
      Array.isArray(options.attachmentIntents) ||
      options.attachmentIds.length === 0 ||
      Object.keys(options.attachmentIntents).length !== options.attachmentIds.length ||
      options.attachmentIds.some(
        (attachmentId) => !Object.hasOwn(options.attachmentIntents, attachmentId),
      )
    ) {
      return {
        ok: false,
        error: "Saved snapshot bundles require one task note for every attachment.",
      };
    }
    const disclosureMode = "agent_safe" as const;
    const format = options.format ?? "exact";
    const prepared = preparePromptBundleItems(session, options, disclosureMode, format);
    if (!prepared.ok) return prepared;
    const { bundleItems } = prepared;
    const authority: SavedSnapshotAuthorityV1 = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-authority",
      status: "not_rechecked",
      origin: session.origin,
      routingPolicy: "omitted",
      evidencePolicy: "capture_time_observations_only",
      controlPolicy: "live_recheck_and_user_confirmation_required",
    };

    return {
      ok: true,
      kind: "ui-attach.saved-snapshot-prompt-bundle",
      authority,
      sessionId: session.id,
      title: derivePromptBundleTitle(session.title, bundleItems),
      disclosureMode,
      attachmentCount: bundleItems.length,
      attachmentIds: bundleItems.map((item) => item.ref.id),
      attachmentRefs: bundleItems.map((item) => ({ ...item.ref })),
      markdown: buildSavedSnapshotBundleMarkdown(
        bundleItems,
        format,
        authority,
      ),
    };
  }

  function preparePromptBundleItems(
    session: CaptureSession,
    options: BuildPromptBundleOptions,
    disclosureMode: UIAttachmentDisclosureMode,
    format: CapturePromptBundleFormat,
  ): { ok: true; bundleItems: PromptBundleItem[] } | { ok: false; error: string } {
    if (format !== "exact" && format !== "compact") {
      return { ok: false, error: "Prompt bundle format is invalid." };
    }
    if (
      options.attachmentIntents !== undefined &&
      (
        options.attachmentIntents === null ||
        typeof options.attachmentIntents !== "object" ||
        Array.isArray(options.attachmentIntents) ||
        Object.keys(options.attachmentIntents).some(
          (attachmentId) => (
            !options.attachmentIds.includes(attachmentId) ||
            typeof options.attachmentIntents?.[attachmentId] !== "string"
          ),
        )
      )
    ) {
      return { ok: false, error: "Prompt bundle attachment intents are invalid." };
    }
    if (
      format === "compact" &&
      (
        options.attachmentIntents === undefined ||
        Object.keys(options.attachmentIntents).length !== options.attachmentIds.length ||
        options.attachmentIds.some(
          (attachmentId) => !Object.hasOwn(options.attachmentIntents ?? {}, attachmentId),
        )
      )
    ) {
      return {
        ok: false,
        error: "Compact prompt bundles require one task note for every attachment.",
      };
    }
    const itemIds = buildDisclosureItemIdMap(session, disclosureMode);
    const bundleItems: PromptBundleItem[] = [];
    for (const [index, attachmentId] of options.attachmentIds.entries()) {
      const itemResult = findItem(session.id, attachmentId, disclosureMode);
      if (!itemResult.ok) {
        return itemResult;
      }

      const view = buildRecordView(itemResult.item.sourceRecord, disclosureMode);
      if (!view.ok) {
        return view;
      }

      const label = resolvePromptBundleLabel(itemResult.item, attachmentId, index, options);
      const ref = buildPromptBundleAttachmentRef(
        view.record.attachment,
        itemIds.get(itemResult.item) ?? itemResult.item.id,
        label,
      );
      const bundleRecord = normalizePromptBundleRecordId(view.record, ref.id);
      bundleItems.push({
        record: bundleRecord,
        ref,
        sourcePageTitle: itemResult.item.sourceRecord.pageTitle,
        taskNote: options.attachmentIntents === undefined
          ? null
          : (options.attachmentIntents[attachmentId] ?? "").trim(),
      });
    }
    return { ok: true, bundleItems };
  }

  function findItem(
    sessionId: string,
    attachmentId: string,
    disclosureMode: UIAttachmentDisclosureMode,
  ): { ok: true; item: CaptureHubItem } | { ok: false; error: string } {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `Capture session not found: ${sessionId}` };
    }

    const directItem = session.attachments.find((candidate) => candidate.id === attachmentId);
    const disclosureIds = buildDisclosureItemIdMap(session, disclosureMode);
    const safeIds =
      disclosureMode === "agent_safe"
        ? disclosureIds
        : buildDisclosureItemIdMap(session, "agent_safe");
    const item =
      directItem ??
      session.attachments.find(
        (candidate) =>
          disclosureIds.get(candidate) === attachmentId ||
          safeIds.get(candidate) === attachmentId,
      );
    if (!item) {
      return {
        ok: false,
        error: `Capture attachment not found in ${sessionId}: ${attachmentId}`,
      };
    }

    return { ok: true, item };
  }
  return {
    createSession,
    listSessions,
    addAttachment,
    summarizeSession,
    getAttachment,
    buildPromptBundle,
    buildSavedSnapshotPromptBundle,
  };
}

function buildRecordView(
  record: OriginCaptureRecordLike,
  disclosureMode: UIAttachmentDisclosureMode,
): CaptureHubAttachmentResult {
  const derived = deriveAttachmentDisclosure(record.attachment, disclosureMode);
  if (!derived.ok) {
    return { ok: false, error: derived.reason };
  }

  const replayView = deriveReplayAttemptsDisclosure(
    record.attachment,
    derived.attachment,
    record.replayAttempts,
    disclosureMode,
  );
  const attachment = replayView.redacted
    ? markAttachmentFieldRedacted(derived.attachment, "record.replayAttempts")
    : derived.attachment;
  const viewRecord: OriginCaptureRecordLike = {
    ...cloneRecord(record),
    pageUrl: attachment.source.url,
    pageTitle: attachment.source.title,
    attachment,
    markdown: serializeAttachmentMarkdown(attachment),
    summary: serializeAttachmentSummary(attachment),
    replayAttempts: replayView.attempts,
  };
  return {
    ok: true,
    item: {
      id: attachment.id,
      sourceRecord: cloneRecord(viewRecord),
      createdAt: record.capturedAt,
      labels: [],
    },
    record: viewRecord,
  };
}

function deriveReplayAttemptsDisclosure(
  sourceAttachment: UIAttachment,
  attachment: UIAttachment,
  replayAttempts: unknown[] | undefined,
  disclosureMode: UIAttachmentDisclosureMode,
): { attempts: unknown[] | undefined; redacted: boolean } {
  if (!replayAttempts) {
    return { attempts: undefined, redacted: false };
  }
  if (disclosureMode === "full_debug") {
    return { attempts: structuredClone(replayAttempts), redacted: false };
  }

  const locatorValues = buildDerivedLocatorValueMap(sourceAttachment, attachment);
  const derivedAttempts = replayAttempts.map((attempt) =>
    deriveReplayAttemptView(attempt, locatorValues),
  );
  return {
    attempts: derivedAttempts.map((attempt) => attempt.value),
    redacted: derivedAttempts.some((attempt) => attempt.redacted),
  };
}

function buildDerivedLocatorValueMap(
  sourceAttachment: UIAttachment,
  attachment: UIAttachment,
): Map<string, DerivedReplayLocator> {
  const values = new Map<string, DerivedReplayLocator>();
  addLocatorValuePair(
    values,
    sourceAttachment.locatorBundle.primary,
    attachment.locatorBundle.primary,
  );
  sourceAttachment.locatorBundle.candidates.forEach((candidate, index) => {
    addLocatorValuePair(values, candidate, attachment.locatorBundle.candidates[index]);
  });
  const sourceVerifiedValue = sourceAttachment.locatorBundle.stability.verifiedValue;
  const derivedVerifiedValue = attachment.locatorBundle.stability.verifiedValue;
  const derivedVerifiedBy = attachment.locatorBundle.stability.verifiedBy;
  if (
    typeof sourceVerifiedValue === "string" &&
    typeof derivedVerifiedValue === "string" &&
    typeof derivedVerifiedBy === "string"
  ) {
    values.set(sourceVerifiedValue, { value: derivedVerifiedValue, strategy: derivedVerifiedBy });
  }
  return values;
}

interface DerivedReplayLocator {
  value: string;
  strategy: UILocatorStrategy;
}

function addLocatorValuePair(
  values: Map<string, DerivedReplayLocator>,
  sourceLocator: UIAttachment["locatorBundle"]["primary"] | undefined,
  derivedLocator: UIAttachment["locatorBundle"]["primary"] | undefined,
): void {
  if (sourceLocator && derivedLocator) {
    values.set(sourceLocator.value, {
      value: derivedLocator.value,
      strategy: derivedLocator.strategy,
    });
  }
}

function deriveReplayAttemptView(
  attempt: unknown,
  locatorValues: Map<string, DerivedReplayLocator>,
): { value: unknown; redacted: boolean } {
  if (!isUnknownRecord(attempt)) {
    return { value: { redacted: true }, redacted: true };
  }

  const rawValue = typeof attempt.value === "string" ? attempt.value : null;
  const derivedLocator = rawValue ? locatorValues.get(rawValue) : undefined;
  const hasKnownShape = [
    "strategy",
    "value",
    "replayVerified",
    "uniqueness",
    "failureReason",
    "matchCount",
    "visible",
  ].every((field) => field in attempt);
  const hasOnlyKnownFields = Object.keys(attempt).every((field) =>
    [
      "strategy",
      "value",
      "replayVerified",
      "uniqueness",
      "failureReason",
      "matchCount",
      "visible",
    ].includes(field),
  );
  const failureReasonRedacted = attempt.failureReason !== null;
  return {
    value: {
      strategy: derivedLocator?.strategy ?? "unknown",
      value: derivedLocator?.value ?? "[redacted:replay-value]",
      replayVerified: attempt.replayVerified === true,
      uniqueness: typeof attempt.uniqueness === "boolean" ? attempt.uniqueness : null,
      failureReason: failureReasonRedacted
        ? "redacted in derived disclosure view"
        : null,
      matchCount: typeof attempt.matchCount === "number" ? attempt.matchCount : null,
      visible: typeof attempt.visible === "boolean" ? attempt.visible : null,
    },
    redacted:
      !hasKnownShape ||
      !hasOnlyKnownFields ||
      derivedLocator === undefined ||
      derivedLocator.value !== rawValue ||
      attempt.strategy !== derivedLocator.strategy ||
      failureReasonRedacted,
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactDataFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  try {
    if (!isUnknownRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== fields.length ||
      ownKeys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    const expected = new Set(fields);
    return fields.every((field) => {
      if (!Object.hasOwn(value, field)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable &&
        expected.has(field);
    });
  } catch {
    return false;
  }
}

function canonicalizeCaptureSessionFile(file: CaptureSessionFile): CaptureSessionFile {
  const isV1 = file.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V1;
  const isV3 = file.schemaVersion === CAPTURE_SESSION_FILE_SCHEMA_VERSION_V3;
  const attachments = file.session.attachments.map((item) => {
    const projected: Record<string, unknown> = { id: item.id };
    if (!isV1) {
      projected.annotationId = (item as CaptureSessionFileItemV2).annotationId;
    }
    projected.createdAt = item.createdAt;
    if (!isV1) {
      projected.updatedAt = (item as CaptureSessionFileItemV2).updatedAt;
    }
    if (isV3) {
      const lifecycle = (item as CaptureSessionFileItemV3).annotationLifecycle;
      projected.annotationLifecycle = {
        state: lifecycle.state,
        resolvedAt: lifecycle.resolvedAt,
      } satisfies CaptureSessionAnnotationLifecycleV3;
    }
    projected.labels = [...item.labels];
    projected.sourceRecord = canonicalizeCaptureSessionSourceRecord(item.sourceRecord);
    return projected;
  });

  return {
    schemaVersion: file.schemaVersion,
    kind: file.kind,
    session: {
      id: file.session.id,
      title: file.session.title,
      createdAt: file.session.createdAt,
      updatedAt: file.session.updatedAt,
      origin: file.session.origin,
      attachments,
    },
  } as unknown as CaptureSessionFile;
}

function canonicalizeCaptureSessionSourceRecord(
  record: CaptureSessionFileSourceRecordV1,
): CaptureSessionFileSourceRecordV1 {
  return {
    origin: record.origin,
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    attachment: canonicalizeCaptureSessionAttachment(record.attachment),
    intent: record.intent,
    ...(record.replayAttempts !== undefined
      ? { replayAttempts: record.replayAttempts.map(canonicalizeCaptureSessionValue) }
      : {}),
    capturedAt: record.capturedAt,
    ...(record.tabId !== undefined ? { tabId: record.tabId } : {}),
    ...(record.frameId !== undefined ? { frameId: record.frameId } : {}),
    ...(record.routeChain !== undefined
      ? {
          routeChain: record.routeChain.map((route) => ({
            origin: route.origin,
            pathname: route.pathname,
          })),
        }
      : {}),
  };
}

function canonicalizeCaptureSessionAttachment(attachment: UIAttachment): UIAttachment {
  return {
    schemaVersion: attachment.schemaVersion,
    id: attachment.id,
    capturedAt: attachment.capturedAt,
    source: {
      kind: attachment.source.kind,
      url: attachment.source.url,
      title: attachment.source.title,
    },
    ...(attachment.sourceAnchor === undefined
      ? {}
      : {
          sourceAnchor: {
            schemaVersion: attachment.sourceAnchor.schemaVersion,
            kind: attachment.sourceAnchor.kind,
            buildId: attachment.sourceAnchor.buildId,
            sourceId: attachment.sourceAnchor.sourceId,
          },
        }),
    ...(attachment.selectionPoint === undefined
      ? {}
      : {
          selectionPoint: {
            kind: attachment.selectionPoint.kind,
            xRatio: attachment.selectionPoint.xRatio,
            yRatio: attachment.selectionPoint.yRatio,
          },
        }),
    element: {
      tagName: attachment.element.tagName,
      role: attachment.element.role,
      text: attachment.element.text,
      accessibleName: attachment.element.accessibleName,
      ...(attachment.element.contentParts === undefined
        ? {}
        : {
            contentParts: attachment.element.contentParts.map((part) => ({
              kind: part.kind,
              tagName: part.tagName,
              role: part.role,
              text: part.text,
              accessibleName: part.accessibleName,
            })),
          }),
      bbox: {
        x: attachment.element.bbox.x,
        y: attachment.element.bbox.y,
        width: attachment.element.bbox.width,
        height: attachment.element.bbox.height,
      },
      visible: attachment.element.visible,
      enabled: attachment.element.enabled,
    },
    style: {
      display: attachment.style.display,
      color: attachment.style.color,
      backgroundColor: attachment.style.backgroundColor,
      ...Object.fromEntries(UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.flatMap((field) =>
        Object.hasOwn(attachment.style, field)
          ? [[field, attachment.style[field]]]
          : []
      )),
    },
    context: {
      parentSummary: attachment.context.parentSummary,
      nearbyText: [...attachment.context.nearbyText],
      selectorHints: [...attachment.context.selectorHints],
    },
    locatorBundle: {
      primary: attachment.locatorBundle.primary === null
        ? null
        : canonicalizeCaptureSessionLocator(attachment.locatorBundle.primary),
      candidates: attachment.locatorBundle.candidates.map(canonicalizeCaptureSessionLocator),
      stability: {
        score: attachment.locatorBundle.stability.score,
        uniqueness: attachment.locatorBundle.stability.uniqueness,
        replayVerified: attachment.locatorBundle.stability.replayVerified,
        failureReason: attachment.locatorBundle.stability.failureReason,
        ...(attachment.locatorBundle.stability.verifiedBy !== undefined
          ? { verifiedBy: attachment.locatorBundle.stability.verifiedBy }
          : {}),
        ...(attachment.locatorBundle.stability.verifiedValue !== undefined
          ? { verifiedValue: attachment.locatorBundle.stability.verifiedValue }
          : {}),
      },
    },
    policy: {
      disclosureMode: attachment.policy.disclosureMode,
      redactionLevel: attachment.policy.redactionLevel,
      actionMode: attachment.policy.actionMode,
      allowScreenshot: attachment.policy.allowScreenshot,
      allowDomSnippet: attachment.policy.allowDomSnippet,
      allowNetworkSend: attachment.policy.allowNetworkSend,
      allowedDomains: [...attachment.policy.allowedDomains],
      redactedFields: [...attachment.policy.redactedFields],
      sensitiveHints: [...attachment.policy.sensitiveHints],
      includedSensitiveFields: [...attachment.policy.includedSensitiveFields],
    },
    artifacts: {
      screenshotCrop: attachment.artifacts.screenshotCrop,
      overlayImage: attachment.artifacts.overlayImage,
    },
    ...(attachment.boundary === undefined
      ? {}
      : {
          boundary: {
            kind: attachment.boundary.kind,
            innerDom: attachment.boundary.innerDom,
            originRelation: attachment.boundary.originRelation,
            frameOrigin: attachment.boundary.frameOrigin,
            ...(attachment.boundary.framePathname === undefined
              ? {}
              : { framePathname: attachment.boundary.framePathname }),
            dominantViewport: attachment.boundary.dominantViewport,
          },
        }),
  };
}

function canonicalizeCaptureSessionLocator(
  locator: UIAttachment["locatorBundle"]["candidates"][number],
): UIAttachment["locatorBundle"]["candidates"][number] {
  return {
    strategy: locator.strategy,
    value: locator.value,
    confidence: locator.confidence,
    ...(locator.notes !== undefined ? { notes: locator.notes } : {}),
  };
}

function canonicalizeCaptureSessionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCaptureSessionValue);
  if (!isUnknownRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeCaptureSessionValue(value[key])]),
  );
}

function markAttachmentFieldRedacted(attachment: UIAttachment, field: string): UIAttachment {
  return {
    ...attachment,
    policy: {
      ...attachment.policy,
      redactedFields: unique([...attachment.policy.redactedFields, field]),
      sensitiveHints: unique([...attachment.policy.sensitiveHints, field]),
      includedSensitiveFields: attachment.policy.includedSensitiveFields.filter(
        (candidate) => candidate !== field,
      ),
    },
  };
}

function summarizeItem(
  item: CaptureHubItem,
  record: OriginCaptureRecordLike,
  itemId: string,
): CaptureHubItemSummary {
  const attachment = record.attachment;
  const targetName = attachment.element.accessibleName ?? attachment.element.text ?? "unnamed";
  return {
    id: itemId,
    target: `${attachment.element.tagName} ${targetName}`,
    origin: record.origin,
    pageTitle: record.pageTitle,
    pageUrl: attachment.source.url,
    capturedAt: record.capturedAt,
    disclosureMode: attachment.policy.disclosureMode,
    replayVerified: attachment.locatorBundle.stability.replayVerified,
    redactedFields: [...attachment.policy.redactedFields],
    sensitiveHints: [...attachment.policy.sensitiveHints],
    includedSensitiveFields: [...attachment.policy.includedSensitiveFields],
    labels: [...item.labels],
    routingHint: deriveCapturePageRoutingHint(record),
  };
}

function buildDisclosureItemIdMap(
  session: CaptureSession,
  disclosureMode: UIAttachmentDisclosureMode,
): Map<CaptureHubItem, string> {
  const result = new Map<CaptureHubItem, string>();
  const usedIds = new Set<string>();
  const rawItemIds = new Set(session.attachments.map((item) => item.id));
  for (const item of session.attachments) {
    const derived = deriveAttachmentDisclosure(item.sourceRecord.attachment, disclosureMode);
    if (!derived.ok) {
      continue;
    }
    const baseId = deriveHubItemId(
      item.id,
      item.sourceRecord.attachment.id,
      derived.attachment.id,
    );
    let itemId = baseId;
    let suffix = 2;
    while (usedIds.has(itemId) || (rawItemIds.has(itemId) && itemId !== item.id)) {
      itemId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(itemId);
    result.set(item, itemId);
  }
  return result;
}

function deriveHubItemId(itemId: string, sourceAttachmentId: string, attachmentId: string): string {
  if (sourceAttachmentId === attachmentId) {
    return itemId;
  }
  return itemId.startsWith(sourceAttachmentId)
    ? `${attachmentId}${itemId.slice(sourceAttachmentId.length)}`
    : itemId;
}

function createUniqueAttachmentItemId(session: CaptureSession, preferredId: string): string {
  if (!session.attachments.some((item) => item.id === preferredId)) {
    return preferredId;
  }

  let suffix = 2;
  let candidate = `${preferredId}-${suffix}`;
  while (session.attachments.some((item) => item.id === candidate)) {
    suffix += 1;
    candidate = `${preferredId}-${suffix}`;
  }
  return candidate;
}

interface PromptBundleItem {
  record: OriginCaptureRecordLike;
  ref: CapturePromptBundleAttachmentRef;
  sourcePageTitle: string | null;
  taskNote: string | null;
}

function derivePromptBundleTitle(
  title: string | null,
  items: PromptBundleItem[],
): string | null {
  if (title === null) {
    return null;
  }
  return items.find((item) => item.sourcePageTitle === title)?.record.pageTitle ?? null;
}

function buildBundleMarkdown(
  items: PromptBundleItem[],
  intent: string,
  format: CapturePromptBundleFormat,
): string {
  if (format === "compact") {
    return buildCompactBundleMarkdown(items, intent);
  }
  const sections = [
    ["# MeanThis Capture Bundle", "", `> ${UI_ATTACHMENT_UNTRUSTED_DATA_NOTICE}`].join("\n"),
    UI_ATTACHMENT_LIVE_CONSUMER_CONTRACT,
  ];
  if (items.some(({ record }) => record.attachment.sourceAnchor)) {
    sections.push(UI_ATTACHMENT_SOURCE_RESOLUTION_CONTRACT);
  }
  const trimmedIntent = intent.trim();
  if (trimmedIntent) {
    sections.push(["## User Intent", "", trimmedIntent].join("\n"));
  }

  if (items.length > 0) {
    sections.push(
      [
        "## Attachment Map",
        "",
        ...items.map(({ ref }) => formatPromptBundleMapLine(ref)),
      ].join("\n"),
    );
  }

  const routingSection = serializeCapturePageRoutingSection(
    items.map(({ record, ref }) => ({
      attachmentId: ref.id,
      label: ref.label,
      record,
    })),
  );
  if (routingSection) {
    sections.push(routingSection);
  }

  for (const { record, ref } of items) {
    sections.push(
      [
        `## Attachment ${ref.label} (${inlineCode(ref.id)})`,
        "",
        record.summary ?? serializeAttachmentSummary(record.attachment),
        "",
        record.markdown || serializeAttachmentMarkdown(record.attachment),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function buildSavedSnapshotBundleMarkdown(
  items: PromptBundleItem[],
  format: CapturePromptBundleFormat,
  authority: SavedSnapshotAuthorityV1,
): string {
  if (format === "compact") {
    return buildCompactBundleMarkdown(items, "", authority);
  }
  const sections = [
    [
      "# MeanThis Saved Snapshot Bundle",
      "",
      `> ${UI_ATTACHMENT_UNTRUSTED_DATA_NOTICE}`,
    ].join("\n"),
    [
      "## Snapshot Authority",
      "",
      "- Targets and locators were not rechecked against a live page.",
      "- Locator, uniqueness, and replay fields are capture-time observations only.",
      "- Browser routing is omitted. Before any control action, require a live recheck and user confirmation.",
      "",
      fencedBlock("json", JSON.stringify(authority)),
    ].join("\n"),
  ];
  if (items.some(({ record }) => record.attachment.sourceAnchor)) {
    sections.push(UI_ATTACHMENT_SOURCE_RESOLUTION_CONTRACT);
  }
  const taskNotes = items.flatMap(({ ref, taskNote }) =>
    taskNote ? [{ label: ref.label, intent: taskNote }] : [],
  );
  if (taskNotes.length > 0) {
    sections.push([
      "## Per-element Task Notes",
      "",
      "Labels match the attachment map.",
      "",
      fencedBlock("json", JSON.stringify(taskNotes)),
    ].join("\n"));
  }
  if (items.length > 0) {
    sections.push([
      "## Attachment Map",
      "",
      ...items.map(({ ref }) => formatPromptBundleMapLine(ref)),
    ].join("\n"));
  }
  for (const { record, ref } of items) {
    sections.push([
      `## Attachment ${ref.label} (${inlineCode(ref.id)})`,
      "",
      record.summary ?? serializeAttachmentSummary(record.attachment),
      "",
      record.markdown || serializeAttachmentMarkdown(record.attachment),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function normalizePromptBundleRecordId(
  record: OriginCaptureRecordLike,
  itemId: string,
): OriginCaptureRecordLike {
  if (record.attachment.id === itemId) return record;
  const attachment: UIAttachment = {
    ...record.attachment,
    id: itemId,
  };
  return {
    ...record,
    attachment,
    summary: serializeAttachmentSummary(attachment),
    markdown: serializeAttachmentMarkdown(attachment),
  };
}

function buildCompactBundleMarkdown(
  items: PromptBundleItem[],
  intent: string,
  savedSnapshotAuthority?: SavedSnapshotAuthorityV1,
): string {
  const sources = items.map(({ record }) => compactSource(record.attachment));
  const policyCapabilities = items.map(
    ({ record }) => compactPolicyCapabilities(record.attachment),
  );
  const routing = savedSnapshotAuthority ? [] : items.map(({ record }) => {
    const hint = deriveCapturePageRoutingHint(record);
    return hint
      ? {
          schemaVersion: hint.schemaVersion,
          kind: hint.kind,
          browserFamily: hint.browserFamily,
          pageInstanceId: hint.pageInstanceId,
          tabId: hint.tabId,
          frameId: hint.frameId,
          route: hint.route,
          matchPolicy: hint.matchPolicy,
          controlPolicy: hint.controlPolicy,
        }
      : null;
  });
  const sharedSource = commonJsonValue(sources);
  const sharedPolicyCapabilities = commonJsonValue(policyCapabilities);
  const sharedRouting = routing.length > 0 && routing.every((value) => value !== null)
    ? commonJsonValue(routing)
    : null;
  const nearbyTextPool = [...new Set(
    items.flatMap(({ record }) => record.attachment.context.nearbyText),
  )];
  const nearbyTextIndex = new Map(
    nearbyTextPool.map((value, index) => [value, index]),
  );
  const payload = {
    schemaVersion: "0.1.0",
    kind: savedSnapshotAuthority
      ? "ui-attach.compact-saved-snapshot-bundle"
      : "ui-attach.compact-capture-bundle",
    ...(savedSnapshotAuthority ? { authority: savedSnapshotAuthority } : {}),
    shared: {
      source: sharedSource,
      ...(savedSnapshotAuthority ? {} : { routing: sharedRouting }),
      policyCapabilities: sharedPolicyCapabilities,
      nearbyTextPool,
    },
    attachments: items.map(({ record, ref, taskNote }, index) => {
      const attachment = record.attachment;
      const hint = savedSnapshotAuthority ? null : deriveCapturePageRoutingHint(record);
      return {
        label: ref.label,
        id: ref.id,
        taskNote,
        capturedAt: attachment.capturedAt,
        ...(hint && hint.capturedAt !== attachment.capturedAt
          ? { routingCapturedAt: hint.capturedAt }
          : {}),
        ...(sharedSource === null ? { source: sources[index] } : {}),
        element: structuredClone(attachment.element),
        style: structuredClone(attachment.style),
        context: {
          parentSummary: attachment.context.parentSummary,
          nearbyTextRefs: attachment.context.nearbyText.map(
            (value) => nearbyTextIndex.get(value)!,
          ),
          selectorHints: [...attachment.context.selectorHints],
        },
        locatorBundle: structuredClone(attachment.locatorBundle),
        ...(attachment.sourceAnchor
          ? { sourceAnchor: structuredClone(attachment.sourceAnchor) }
          : {}),
        ...(attachment.selectionPoint
          ? { selectionPoint: structuredClone(attachment.selectionPoint) }
          : {}),
        ...(attachment.boundary
          ? { boundary: structuredClone(attachment.boundary) }
          : {}),
        ...(sharedPolicyCapabilities === null
          ? { policyCapabilities: policyCapabilities[index] }
          : {}),
        disclosureAudit: compactDisclosureAudit(attachment),
        ...(!savedSnapshotAuthority && sharedRouting === null
          ? { routing: hint ? { ...routing[index], capturedAt: hint.capturedAt } : null }
          : {}),
      };
    }),
  };
  const sections = [
    [
      savedSnapshotAuthority
        ? "# MeanThis Saved Snapshot Bundle"
        : "# MeanThis Compact Capture Bundle",
      "",
      `> ${UI_ATTACHMENT_UNTRUSTED_DATA_NOTICE}`,
    ].join("\n"),
  ];
  if (!savedSnapshotAuthority) {
    sections.push(UI_ATTACHMENT_LIVE_CONSUMER_CONTRACT);
  }
  const sourceResolutionInputs = items.flatMap(({ record, ref }) => {
    const sourceAnchor = record.attachment.sourceAnchor;
    if (!sourceAnchor) return [];
    return [
      `- Attachment ${formatInlineData(ref.label)} Source Anchor Tool Input: ${JSON.stringify({
        sourceAnchor,
      })}`,
    ];
  });
  if (sourceResolutionInputs.length > 0) {
    sections.push([
      UI_ATTACHMENT_COMPACT_SOURCE_RESOLUTION_CONTRACT,
      "",
      ...sourceResolutionInputs,
    ].join("\n"));
  }
  const trimmedIntent = intent.trim();
  if (trimmedIntent && items.every((item) => item.taskNote === null)) {
    sections.push(["## User Intent", "", trimmedIntent].join("\n"));
  }
  sections.push([
    "## Compact Data",
    "",
    "- Shared values apply to every attachment unless that attachment carries an override.",
    "- An empty `taskNote` means the user supplied no change request for that target.",
    ...(savedSnapshotAuthority
      ? []
      : ["- `routingCapturedAt` defaults to the attachment `capturedAt` when omitted."]),
    savedSnapshotAuthority
      ? "- Targets and locators were not rechecked. Locator, uniqueness, and replay fields are capture-time observations only. Browser routing is omitted; require a live recheck and user confirmation before control."
      : "- Routing is local candidate metadata only; require a unique live match and user confirmation before control.",
    "",
    fencedBlock("json", JSON.stringify(payload)),
  ].join("\n"));
  return sections.join("\n\n");
}

function compactSource(attachment: UIAttachment): {
  kind: UIAttachment["source"]["kind"];
  url: string | null;
} {
  return {
    kind: attachment.source.kind,
    url: attachment.source.url,
  };
}

function compactPolicyCapabilities(attachment: UIAttachment): {
  disclosureMode: UIAttachmentDisclosureMode;
  redactionLevel: UIAttachment["policy"]["redactionLevel"];
  actionMode: UIAttachment["policy"]["actionMode"];
  allowScreenshot: boolean;
  allowDomSnippet: boolean;
  allowNetworkSend: boolean;
} {
  return {
    disclosureMode: attachment.policy.disclosureMode ?? "agent_safe",
    redactionLevel: attachment.policy.redactionLevel,
    actionMode: attachment.policy.actionMode,
    allowScreenshot: attachment.policy.allowScreenshot,
    allowDomSnippet: attachment.policy.allowDomSnippet,
    allowNetworkSend: attachment.policy.allowNetworkSend,
  };
}

function compactDisclosureAudit(attachment: UIAttachment): {
  redactedFields: string[];
  sensitiveHints: string[];
  includedSensitiveFields: string[];
} {
  return {
    redactedFields: [...(attachment.policy.redactedFields ?? [])],
    sensitiveHints: [...(attachment.policy.sensitiveHints ?? [])],
    includedSensitiveFields: [...(attachment.policy.includedSensitiveFields ?? [])],
  };
}

function commonJsonValue<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  const expected = JSON.stringify(values[0]);
  return values.every((value) => JSON.stringify(value) === expected)
    ? structuredClone(values[0])
    : null;
}

function serializeCapturePageRoutingRefs(
  refs: CapturePromptBundleRoutingRef[],
): string | null {
  if (refs.length === 0) {
    return null;
  }
  return [
    "## Local Page Routing",
    "",
    "> Local, ephemeral candidate metadata, not authority. Require exactly one live tab ID and frame-route match, then require user confirmation of the browser instance before control. Otherwise do not take control.",
    "",
    ...refs.map(({ label, routingHint }) => {
      const safeLabel = formatInlineData(label);
      const instance = inlineCode(escapeInlineData(routingHint.pageInstanceId));
      const tab = inlineCode(String(routingHint.tabId));
      const frame = inlineCode(String(routingHint.frameId));
      const route = inlineCode(escapeInlineData(routingHint.route));
      const capturedAt = inlineCode(escapeInlineData(routingHint.capturedAt));
      return `- ${safeLabel}: instance ${instance}; tab ${tab}; frame ${frame}; route ${route}; captured ${capturedAt}`;
    }),
  ].join("\n");
}

function buildPromptBundleAttachmentRef(
  attachment: UIAttachment,
  itemId: string,
  label: string,
): CapturePromptBundleAttachmentRef {
  const targetName = attachment.element.accessibleName ?? attachment.element.text ?? "unnamed";
  return {
    id: itemId,
    label,
    target: `${attachment.element.tagName} ${targetName}`,
    role: attachment.element.role,
    accessibleName: attachment.element.accessibleName,
    text: attachment.element.text,
    primaryLocator: attachment.locatorBundle.primary?.value ?? null,
  };
}

function resolvePromptBundleLabel(
  item: CaptureHubItem,
  attachmentId: string,
  index: number,
  options: BuildPromptBundleOptions,
): string {
  const override = options.attachmentLabels?.[attachmentId]?.trim();
  const storedLabel = item.labels.find((label) => label.trim().length > 0)?.trim();
  return override || storedLabel || formatPromptBundleLabel(index);
}

function formatPromptBundleLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function formatPromptBundleMapLine(ref: CapturePromptBundleAttachmentRef): string {
  const label = formatInlineData(ref.label);
  const id = inlineCode(escapeInlineData(ref.id));
  const role = formatInlineData(ref.role ?? "element");
  const targetName = quoteInlineData(ref.accessibleName ?? ref.text ?? "unnamed");
  const locator = ref.primaryLocator
    ? `; primary locator ${inlineCode(escapeInlineData(ref.primaryLocator))}`
    : "";
  return `- ${label} (${id}): ${role} ${targetName}${locator}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inlineCode(value: string): string {
  const fence = "`".repeat(Math.max(1, longestBacktickRun(value) + 1));
  const padded = /^[`\s]|[`\s]$/.test(value) ? ` ${value} ` : value;
  return `${fence}${padded}${fence}`;
}

function escapeInlineData(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (character === "\n") {
      escaped += "\\n";
    } else if (character === "\r") {
      escaped += "\\r";
    } else if (character === "\t") {
      escaped += "\\t";
    } else if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
      escaped += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function decodePathnameForSensitiveDetection(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function formatInlineData(value: string): string {
  const escaped = escapeInlineData(value);
  return needsInlineCode(escaped) ? inlineCode(escaped) : escaped;
}

function quoteInlineData(value: string): string {
  const escaped = escapeInlineData(value);
  return needsInlineCode(escaped) ? inlineCode(escaped) : `"${escaped.replaceAll('"', '\\"')}"`;
}

function needsInlineCode(value: string): boolean {
  return (
    value.includes("`") ||
    value.includes("<") ||
    value.includes("[") ||
    /\b(?:https?:\/\/|www\.)[^\s<]*/i.test(value) ||
    /[^\s@]+@[^\s@]+/.test(value)
  );
}

function fencedBlock(language: string, value: string): string {
  const fenceLength = Math.max(3, longestBacktickRun(value) + 1);
  const fence = "`".repeat(fenceLength);
  return [language ? `${fence}${language}` : fence, value, fence].join("\n");
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function cloneSession(session: CaptureSession): CaptureSession {
  return {
    ...session,
    attachments: session.attachments.map(cloneItem),
  };
}

function cloneItem(item: CaptureHubItem): CaptureHubItem {
  return {
    ...item,
    sourceRecord: cloneRecord(item.sourceRecord),
    labels: [...item.labels],
  };
}

function cloneRecord(record: OriginCaptureRecordLike): OriginCaptureRecordLike {
  return {
    ...record,
    attachment: structuredClone(record.attachment),
    replayAttempts: record.replayAttempts ? structuredClone(record.replayAttempts) : undefined,
    ...(record.routeChain
      ? { routeChain: record.routeChain.map((route) => ({ ...route })) }
      : {}),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
