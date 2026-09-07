import {
  isMetadataDiagnosticsV1,
  type MetadataDiagnosticsV1,
} from "./metadata-diagnostics.ts";

export * from "./metadata-diagnostics.ts";
export * from "./annotation-lifecycle-control.ts";

export const UI_ATTACHMENT_SCHEMA_VERSION = "0.3.0" as const;
export const UI_ATTACHMENT_REPLAY_LOCATOR_MAX_CHARACTERS = 4_096 as const;
export const UI_ATTACHMENT_COMPUTED_STYLE_VALUE_MAX_BYTES = 512 as const;
export const UI_ATTACHMENT_COMPUTED_STYLE_FIELDS = [
  "position",
  "boxSizing",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "overflowX",
  "overflowY",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "borderRadius",
] as const;
export type UIAttachmentComputedStyleField =
  typeof UI_ATTACHMENT_COMPUTED_STYLE_FIELDS[number];

export const UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_SOURCE_BUILD_ID_ATTRIBUTE = "data-ui-attach-build-id" as const;
export const UI_ATTACH_SOURCE_ID_ATTRIBUTE = "data-ui-attach-source-id" as const;
export const UI_ATTACH_SOURCE_CALLSITE_BUILD_ID_ATTRIBUTE =
  "data-ui-attach-callsite-build-id" as const;
export const UI_ATTACH_SOURCE_CALLSITE_ID_ATTRIBUTE =
  "data-ui-attach-callsite-source-id" as const;

export const UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION = "0.1.0" as const;
export const UI_ATTACH_LOCAL_BRIDGE_HOST = "127.0.0.1" as const;
export const UI_ATTACH_LOCAL_BRIDGE_PORT = 38471 as const;
export const UI_ATTACH_LOCAL_BRIDGE_ORIGIN =
  `http://${UI_ATTACH_LOCAL_BRIDGE_HOST}:${UI_ATTACH_LOCAL_BRIDGE_PORT}` as const;
export const UI_ATTACH_LOCAL_BRIDGE_PAIR_PATH = "/v1/pair" as const;
export const UI_ATTACH_LOCAL_BRIDGE_CONNECTION_REQUEST_PATH = "/v1/connection-requests" as const;
export const UI_ATTACH_LOCAL_BRIDGE_CAPABILITIES_PATH = "/v1/capabilities" as const;
export const UI_ATTACH_LOCAL_BRIDGE_STRUCTURED_CAPTURE_CAPABILITIES_PATH =
  "/v1/capabilities/structured-capture" as const;
export const UI_ATTACH_LOCAL_BRIDGE_HEARTBEAT_PATH = "/v1/heartbeat" as const;
export const UI_ATTACH_LOCAL_BRIDGE_SHARED_CAPTURE_PATH = "/v1/shared-capture" as const;
export const UI_ATTACH_LOCAL_BRIDGE_SNAPSHOT_PATH = "/v1/snapshot" as const;
export const UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_PATH =
  "/v1/capture-read-acknowledgement" as const;
export const UI_ATTACH_LOCAL_BRIDGE_AGENT_READ_ACKNOWLEDGEMENT_PATH =
  "/v1/agent/capture-read-acknowledgement" as const;
export const UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES = 262_144 as const;
export const UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES = 262_144 as const;
export const UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES = 540_672 as const;
export const UI_ATTACH_MCP_READ_RECEIPT_KIND = "ui-attach.mcp-read-receipt" as const;
export const UI_ATTACH_MCP_READ_RECEIPT_LIMITATIONS = [
  "does_not_prove_model_attention",
  "does_not_prove_task_creation",
  "does_not_prove_downstream_execution",
] as const;
export const UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_KIND =
  "ui-attach.local-bridge-read-acknowledgement" as const;
export const UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS = [
  "does_not_prove_model_attention",
  "does_not_prove_task_creation",
  "does_not_prove_downstream_execution",
] as const;
export const UI_ATTACH_LOCAL_BRIDGE_MAX_READ_ACKNOWLEDGEMENT_BYTES = 8_192 as const;
const UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_DEPTH = 64;
const UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_NODES = 100_000;

export const UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION = "0.1.0" as const;
export const SAVED_SNAPSHOT_MAX_LIVE_RECHECK_VALIDITY_MS = 60_000 as const;

export interface SavedSnapshotAuthorityV1 {
  schemaVersion: typeof UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION;
  kind: "ui-attach.saved-snapshot-authority";
  status: "not_rechecked";
  origin: string;
  routingPolicy: "omitted";
  evidencePolicy: "capture_time_observations_only";
  controlPolicy: "live_recheck_and_user_confirmation_required";
}

export type SavedSnapshotLiveRecheckStatus =
  | "unique_match"
  | "missing"
  | "ambiguous"
  | "mismatch"
  | "error";

export interface SavedSnapshotLiveRecheckTargetV1 {
  attachmentId: string;
  status: SavedSnapshotLiveRecheckStatus;
}

export interface SavedSnapshotLiveRecheckResultV1 {
  schemaVersion: typeof UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION;
  kind: "ui-attach.saved-snapshot-live-recheck-result";
  controlAttemptId: string;
  receiptId: string;
  origin: string;
  checkedAt: string;
  validUntil: string;
  targets: SavedSnapshotLiveRecheckTargetV1[];
}

export interface SavedSnapshotUserConfirmationV1 {
  schemaVersion: typeof UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION;
  kind: "ui-attach.saved-snapshot-user-confirmation";
  purpose: "saved_snapshot_browser_control";
  controlAttemptId: string;
  liveRecheckReceiptId: string;
  decision: "confirmed" | "denied";
  confirmedAt: string;
}

export interface EvaluateSavedSnapshotControlPolicyInputV1 {
  authority: unknown;
  /** Derived by the trusted host from the same saved bundle as `authority`. */
  expectedAttachmentIds: readonly string[];
  /** Generated by the trusted host for this one proposed control attempt. */
  controlAttemptId: string;
  liveRecheck: unknown;
  userConfirmation: unknown;
  /** Current time from the trusted host clock, never from the bundle, model, or receipt issuer. */
  evaluatedAt: string;
}

export type SavedSnapshotControlPolicyDenialCode =
  | "invalid_request"
  | "invalid_authority"
  | "invalid_expected_targets"
  | "invalid_control_attempt"
  | "invalid_evaluated_at"
  | "live_recheck_required"
  | "invalid_live_recheck"
  | "control_attempt_mismatch"
  | "origin_mismatch"
  | "target_coverage_mismatch"
  | "target_not_uniquely_matched"
  | "live_recheck_time_invalid"
  | "live_recheck_expired"
  | "confirmation_required"
  | "invalid_confirmation"
  | "confirmation_denied"
  | "recheck_receipt_mismatch"
  | "confirmation_time_invalid";

export type SavedSnapshotControlPolicyDecisionV1 =
  | {
      allowed: true;
      code: "requirements_satisfied";
      liveRecheckReceiptId: string;
    }
  | {
      allowed: false;
      code: SavedSnapshotControlPolicyDenialCode;
    };

export function isSavedSnapshotAuthority(value: unknown): value is SavedSnapshotAuthorityV1 {
  return hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "status",
    "origin",
    "routingPolicy",
    "evidencePolicy",
    "controlPolicy",
  ]) &&
    value.schemaVersion === UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION &&
    value.kind === "ui-attach.saved-snapshot-authority" &&
    value.status === "not_rechecked" &&
    isCanonicalHttpOrigin(value.origin) &&
    value.routingPolicy === "omitted" &&
    value.evidencePolicy === "capture_time_observations_only" &&
    value.controlPolicy === "live_recheck_and_user_confirmation_required";
}

export function isSavedSnapshotLiveRecheckResult(
  value: unknown,
): value is SavedSnapshotLiveRecheckResultV1 {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "controlAttemptId",
      "receiptId",
      "origin",
      "checkedAt",
      "validUntil",
      "targets",
    ]) ||
    value.schemaVersion !== UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION ||
    value.kind !== "ui-attach.saved-snapshot-live-recheck-result" ||
    !isSavedSnapshotControlToken(value.controlAttemptId) ||
    !isSavedSnapshotControlToken(value.receiptId) ||
    !isCanonicalHttpOrigin(value.origin) ||
    typeof value.checkedAt !== "string" ||
    !isCanonicalIsoDate(value.checkedAt) ||
    typeof value.validUntil !== "string" ||
    !isCanonicalIsoDate(value.validUntil) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 26
  ) return false;
  const attachmentIds = new Set<string>();
  for (const target of value.targets) {
    if (
      !hasExactKeys(target, ["attachmentId", "status"]) ||
      !isAttachmentId(target.attachmentId) ||
      !["unique_match", "missing", "ambiguous", "mismatch", "error"].includes(
        target.status as string,
      ) ||
      attachmentIds.has(target.attachmentId)
    ) return false;
    attachmentIds.add(target.attachmentId);
  }
  return true;
}

export function isSavedSnapshotUserConfirmation(
  value: unknown,
): value is SavedSnapshotUserConfirmationV1 {
  return hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "purpose",
    "controlAttemptId",
    "liveRecheckReceiptId",
    "decision",
    "confirmedAt",
  ]) &&
    value.schemaVersion === UI_ATTACH_SAVED_SNAPSHOT_SCHEMA_VERSION &&
    value.kind === "ui-attach.saved-snapshot-user-confirmation" &&
    value.purpose === "saved_snapshot_browser_control" &&
    isSavedSnapshotControlToken(value.controlAttemptId) &&
    isSavedSnapshotControlToken(value.liveRecheckReceiptId) &&
    (value.decision === "confirmed" || value.decision === "denied") &&
    typeof value.confirmedAt === "string" &&
    isCanonicalIsoDate(value.confirmedAt);
}

export function evaluateSavedSnapshotControlPolicy(
  input: EvaluateSavedSnapshotControlPolicyInputV1,
): SavedSnapshotControlPolicyDecisionV1;
export function evaluateSavedSnapshotControlPolicy(
  input: unknown,
): SavedSnapshotControlPolicyDecisionV1;
export function evaluateSavedSnapshotControlPolicy(
  input: unknown,
): SavedSnapshotControlPolicyDecisionV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return denySavedSnapshotControl("invalid_request");
  }
  const request = input as Partial<EvaluateSavedSnapshotControlPolicyInputV1>;
  if (!isSavedSnapshotAuthority(request.authority)) {
    return denySavedSnapshotControl("invalid_authority");
  }
  if (!isExpectedAttachmentIdSet(request.expectedAttachmentIds)) {
    return denySavedSnapshotControl("invalid_expected_targets");
  }
  if (!isSavedSnapshotControlToken(request.controlAttemptId)) {
    return denySavedSnapshotControl("invalid_control_attempt");
  }
  if (typeof request.evaluatedAt !== "string" || !isCanonicalIsoDate(request.evaluatedAt)) {
    return denySavedSnapshotControl("invalid_evaluated_at");
  }
  if (request.liveRecheck === null || request.liveRecheck === undefined) {
    return denySavedSnapshotControl("live_recheck_required");
  }
  if (!isSavedSnapshotLiveRecheckResult(request.liveRecheck)) {
    return denySavedSnapshotControl("invalid_live_recheck");
  }
  const liveRecheck = request.liveRecheck;
  if (liveRecheck.controlAttemptId !== request.controlAttemptId) {
    return denySavedSnapshotControl("control_attempt_mismatch");
  }
  if (liveRecheck.origin !== request.authority.origin) {
    return denySavedSnapshotControl("origin_mismatch");
  }
  const expectedAttachmentIds = [...request.expectedAttachmentIds].sort();
  const observedAttachmentIds = liveRecheck.targets
    .map((target) => target.attachmentId)
    .sort();
  if (
    expectedAttachmentIds.length !== observedAttachmentIds.length ||
    expectedAttachmentIds.some((attachmentId, index) => (
      attachmentId !== observedAttachmentIds[index]
    ))
  ) return denySavedSnapshotControl("target_coverage_mismatch");
  if (liveRecheck.targets.some((target) => target.status !== "unique_match")) {
    return denySavedSnapshotControl("target_not_uniquely_matched");
  }
  const checkedAt = Date.parse(liveRecheck.checkedAt);
  const validUntil = Date.parse(liveRecheck.validUntil);
  const evaluatedAt = Date.parse(request.evaluatedAt);
  if (
    checkedAt > evaluatedAt ||
    validUntil <= checkedAt ||
    validUntil - checkedAt > SAVED_SNAPSHOT_MAX_LIVE_RECHECK_VALIDITY_MS
  ) return denySavedSnapshotControl("live_recheck_time_invalid");
  if (evaluatedAt > validUntil) {
    return denySavedSnapshotControl("live_recheck_expired");
  }
  if (request.userConfirmation === null || request.userConfirmation === undefined) {
    return denySavedSnapshotControl("confirmation_required");
  }
  if (!isSavedSnapshotUserConfirmation(request.userConfirmation)) {
    return denySavedSnapshotControl("invalid_confirmation");
  }
  const confirmation = request.userConfirmation;
  if (confirmation.controlAttemptId !== request.controlAttemptId) {
    return denySavedSnapshotControl("control_attempt_mismatch");
  }
  if (confirmation.liveRecheckReceiptId !== liveRecheck.receiptId) {
    return denySavedSnapshotControl("recheck_receipt_mismatch");
  }
  if (confirmation.decision === "denied") {
    return denySavedSnapshotControl("confirmation_denied");
  }
  const confirmedAt = Date.parse(confirmation.confirmedAt);
  if (confirmedAt < checkedAt || confirmedAt > evaluatedAt) {
    return denySavedSnapshotControl("confirmation_time_invalid");
  }
  return {
    allowed: true,
    code: "requirements_satisfied",
    liveRecheckReceiptId: liveRecheck.receiptId,
  };
}

function denySavedSnapshotControl(
  code: SavedSnapshotControlPolicyDenialCode,
): SavedSnapshotControlPolicyDecisionV1 {
  return { allowed: false, code };
}

function isExpectedAttachmentIdSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 26 &&
    value.every(isAttachmentId) &&
    new Set(value).size === value.length;
}

function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && /^att_[A-Za-z0-9_-]{1,252}$/.test(value);
}

function isSavedSnapshotControlToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export type LocalBridgeApprovalMode = "ask" | "browser_session";

const LOCAL_BRIDGE_CONNECTION_CODE_VERSION = 2;
const LOCAL_BRIDGE_CONNECTION_CODE_BYTES = 50;
const LOCAL_BRIDGE_CONNECTION_CODE_LENGTH = 68;
const LOCAL_BRIDGE_CONNECTION_CODE_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOCAL_BRIDGE_CONNECTION_CODE_PATTERN = /^[A-Za-z0-9]{68}$/;

export interface LocalBridgeConnectionCodeFields {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  approvalKey: string;
}

export function createLocalBridgeConnectionCode(
  fields: LocalBridgeConnectionCodeFields,
): string {
  if (!isUuidV4(fields.requestId)) {
    throw new Error("Invalid local bridge connection code fields.");
  }
  const approvalKey = decodeBase64Url(fields.approvalKey);
  if (
    approvalKey === null ||
    approvalKey.byteLength !== 32 ||
    encodeBase64Url(approvalKey) !== fields.approvalKey ||
    (fields.approvalMode !== "ask" && fields.approvalMode !== "browser_session")
  ) {
    throw new Error("Invalid local bridge connection code fields.");
  }

  const bytes = new Uint8Array(LOCAL_BRIDGE_CONNECTION_CODE_BYTES);
  bytes[0] = LOCAL_BRIDGE_CONNECTION_CODE_VERSION;
  bytes[1] = fields.approvalMode === "ask" ? 0 : 1;
  const requestIdBytes = hexToBytes(fields.requestId.replaceAll("-", ""));
  if (requestIdBytes === null || requestIdBytes.byteLength !== 16) {
    throw new Error("Invalid local bridge connection code fields.");
  }
  bytes.set(approvalKey, 2);
  bytes.set(requestIdBytes, 34);
  return encodeBase62(bytes);
}

export function parseLocalBridgeConnectionCode(
  value: unknown,
): LocalBridgeConnectionCodeFields | null {
  if (typeof value !== "string" || !LOCAL_BRIDGE_CONNECTION_CODE_PATTERN.test(value)) {
    return null;
  }
  const bytes = decodeBase62(value);
  if (
    bytes === null ||
    bytes.byteLength !== LOCAL_BRIDGE_CONNECTION_CODE_BYTES ||
    bytes[0] !== LOCAL_BRIDGE_CONNECTION_CODE_VERSION ||
    (bytes[1] !== 0 && bytes[1] !== 1)
  ) {
    return null;
  }
  const requestHex = bytesToHex(bytes.subarray(34));
  const requestId = [
    requestHex.slice(0, 8),
    requestHex.slice(8, 12),
    requestHex.slice(12, 16),
    requestHex.slice(16, 20),
    requestHex.slice(20),
  ].join("-");
  if (!isUuidV4(requestId)) return null;
  const approvalKey = encodeBase64Url(bytes.subarray(2, 34));
  if (!/^[A-Za-z0-9_-]{43}$/.test(approvalKey)) return null;
  return {
    requestId,
    approvalMode: bytes[1] === 0 ? "ask" : "browser_session",
    approvalKey,
  };
}

function encodeBase62(bytes: Uint8Array): string {
  let numeric = 0n;
  for (const byte of bytes) numeric = numeric * 256n + BigInt(byte);
  let encoded = "";
  while (numeric > 0n) {
    encoded = LOCAL_BRIDGE_CONNECTION_CODE_ALPHABET[Number(numeric % 62n)] + encoded;
    numeric /= 62n;
  }
  return encoded.padStart(LOCAL_BRIDGE_CONNECTION_CODE_LENGTH, "0");
}

function decodeBase62(value: string): Uint8Array | null {
  if (!LOCAL_BRIDGE_CONNECTION_CODE_PATTERN.test(value)) return null;
  let numeric = 0n;
  for (const character of value) {
    const digit = LOCAL_BRIDGE_CONNECTION_CODE_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    numeric = numeric * 62n + BigInt(digit);
  }
  const bytes = new Uint8Array(LOCAL_BRIDGE_CONNECTION_CODE_BYTES);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(numeric % 256n);
    numeric /= 256n;
  }
  if (numeric !== 0n || encodeBase62(bytes) !== value) return null;
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{32}$/i.test(value)) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

export interface LocalBridgePairRequestV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-pair";
  pairingCode: string;
  installationId: string;
}

export interface LocalBridgeConnectionRequestV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-connection-request";
  requestId: string;
  requestSecret: string;
  approvalVerifier: string;
  installationId: string;
  browserSessionId: string;
  approvalMode: LocalBridgeApprovalMode;
}

export interface LocalBridgeApprovedConnectionProofFields {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  expiresAt: string;
  status: "approved";
  instanceId: string;
  token: string;
  sessionTrustKey: string | null;
}

export function createLocalBridgeApprovalProofMessage(
  fields: LocalBridgeApprovedConnectionProofFields,
): string {
  return [
    "ui-attach-extension-approval-v1",
    fields.requestId,
    fields.approvalMode,
    fields.expiresAt,
    fields.status,
    fields.instanceId,
    fields.token,
    fields.sessionTrustKey ?? "",
  ].join("\0");
}

export interface LocalBridgePageV1 {
  pageInstanceId: string;
  route: string;
}

export interface LocalBridgeCapabilitiesV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-capabilities";
  snapshotObservations: "v1";
}

export interface LocalBridgeStructuredCaptureCapabilitiesV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-structured-capture-capabilities";
  structuredCapture: "v1";
}

export interface LocalBridgeStructuredCaptureCapabilitiesV2 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-structured-capture-capabilities";
  structuredCapture: "v2";
}

export interface LocalBridgeStructuredCaptureCapabilitiesV3 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-structured-capture-capabilities";
  structuredCapture: "v3";
}

export type LocalBridgeStructuredCaptureCapabilities =
  | LocalBridgeStructuredCaptureCapabilitiesV1
  | LocalBridgeStructuredCaptureCapabilitiesV2
  | LocalBridgeStructuredCaptureCapabilitiesV3;

export type LocalBridgeTargetObservationStatus =
  | "checking"
  | "restored"
  | "missing"
  | "ambiguous";

export interface LocalBridgeTargetObservationV1 {
  attachmentId: string;
  status: LocalBridgeTargetObservationStatus;
}

export interface LocalBridgeObservationsV1 {
  observedAt: string;
  documentInstanceId: string;
  targets: LocalBridgeTargetObservationV1[];
}

export interface LocalBridgeActivityV1 {
  operation: "saved_restore";
  state: "pending" | "failed" | "succeeded";
  stage: "panel_request" | "background_response" | "panel_reconciliation";
  code: string | null;
  observedAt: string;
}

export type LocalBridgeCaptureAuthorityV1 =
  | "live_page"
  | "capture_time"
  | "not_rechecked";

export interface LocalBridgeAnnotationLifecycleV1 {
  state: "open" | "resolved";
  resolvedAt: string | null;
}

export interface LocalBridgeCaptureTargetV1 {
  targetId?: string;
  attachmentId: string;
  label: string;
  taskNote: string;
  /**
   * Absent only on a previously cached 0.1.0 bridge target. New publishers
   * always emit the complete four-field annotation identity group.
   */
  annotationId?: string | null;
  annotationIdScope?: "capture_session" | "unknown";
  annotationCreatedAt?: string | null;
  annotationUpdatedAt?: string | null;
  annotationLifecycle?: LocalBridgeAnnotationLifecycleV1;
  attachment: UIAttachment;
}

export interface LocalBridgeCaptureV1 {
  captureId: string;
  title: string | null;
  origin: string;
  updatedAt: string;
  authority: LocalBridgeCaptureAuthorityV1;
  disclosureMode: "agent_safe";
  annotationLifecycleVersion?: "v1";
  metadataDiagnostics?: MetadataDiagnosticsV1;
  targets: LocalBridgeCaptureTargetV1[];
}

export interface LocalBridgeSnapshotV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: "ui-attach.local-bridge-snapshot";
  sequence: number;
  publishedAt: string;
  page: LocalBridgePageV1 | null;
  attachmentCount: number;
  agentCopy: string | null;
  capture?: LocalBridgeCaptureV1;
  observations?: LocalBridgeObservationsV1;
  activity?: LocalBridgeActivityV1;
}

export interface LocalBridgeMcpReadReceiptV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: typeof UI_ATTACH_MCP_READ_RECEIPT_KIND;
  receiptId: string;
  status: "returned_to_mcp_client";
  instanceId: string;
  captureId: string;
  snapshotSequence: number;
  detail: "handoff";
  handoffDigest: string;
  issuedAt: string;
  executionAuthority: {
    grantedByCapture: false;
    browserControl: false;
    liveDomMutation: false;
  };
  limitations: typeof UI_ATTACH_MCP_READ_RECEIPT_LIMITATIONS;
}

export type LocalBridgeReadAcknowledgementDetail =
  | "summary"
  | "content"
  | "task"
  | "agent_context"
  | "locator"
  | "visual"
  | "diagnostics"
  | "context"
  | "handoff";

export interface LocalBridgeReadAcknowledgementV1 {
  schemaVersion: typeof UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION;
  kind: typeof UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_KIND;
  acknowledgementId: string;
  status: "acknowledged_by_agent_client";
  instanceId: string;
  captureId: string;
  snapshotSequence: number;
  detail: LocalBridgeReadAcknowledgementDetail;
  acknowledgedAt: string;
  executionAuthority: {
    grantedByCapture: false;
    browserControl: false;
    liveDomMutation: false;
  };
  limitations: typeof UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS;
}

export function isLocalBridgePairRequest(value: unknown): value is LocalBridgePairRequestV1 {
  return (
    hasExactKeys(value, ["schemaVersion", "kind", "pairingCode", "installationId"]) &&
    value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    value.kind === "ui-attach.local-bridge-pair" &&
    typeof value.pairingCode === "string" &&
    /^\d{3}-\d{3}$/.test(value.pairingCode) &&
    isUuidV4(value.installationId)
  );
}

export function isLocalBridgeConnectionRequest(
  value: unknown,
): value is LocalBridgeConnectionRequestV1 {
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "requestId",
      "requestSecret",
      "approvalVerifier",
      "installationId",
      "browserSessionId",
      "approvalMode",
    ]) &&
    value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    value.kind === "ui-attach.local-bridge-connection-request" &&
    isUuidV4(value.requestId) &&
    typeof value.requestSecret === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.requestSecret) &&
    typeof value.approvalVerifier === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.approvalVerifier) &&
    isUuidV4(value.installationId) &&
    isUuidV4(value.browserSessionId) &&
    (value.approvalMode === "ask" || value.approvalMode === "browser_session")
  );
}

export function isLocalBridgeCapabilities(value: unknown): value is LocalBridgeCapabilitiesV1 {
  return hasExactKeys(value, ["schemaVersion", "kind", "snapshotObservations"]) &&
    value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    value.kind === "ui-attach.local-bridge-capabilities" &&
    value.snapshotObservations === "v1";
}

export function isLocalBridgeStructuredCaptureCapabilities(
  value: unknown,
): value is LocalBridgeStructuredCaptureCapabilities {
  return hasExactKeys(value, ["schemaVersion", "kind", "structuredCapture"]) &&
    value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    value.kind === "ui-attach.local-bridge-structured-capture-capabilities" &&
    (
      value.structuredCapture === "v1" ||
      value.structuredCapture === "v2" ||
      value.structuredCapture === "v3"
    );
}

export function parseLocalBridgeMcpReadReceipt(
  value: unknown,
): LocalBridgeMcpReadReceiptV1 | null {
  const detached = detachLocalBridgeData(value);
  if (!detached.ok || !isNativeStructuredCloneable(value)) return null;
  return isLocalBridgeMcpReadReceiptData(detached.value)
    ? detached.value
    : null;
}

export function isLocalBridgeMcpReadReceipt(
  value: unknown,
): value is LocalBridgeMcpReadReceiptV1 {
  return parseLocalBridgeMcpReadReceipt(value) !== null;
}

export function parseLocalBridgeReadAcknowledgement(
  value: unknown,
): LocalBridgeReadAcknowledgementV1 | null {
  const detached = detachLocalBridgeData(value);
  if (!detached.ok || !isNativeStructuredCloneable(value)) return null;
  return isLocalBridgeReadAcknowledgementData(detached.value)
    ? detached.value
    : null;
}

export function isLocalBridgeReadAcknowledgement(
  value: unknown,
): value is LocalBridgeReadAcknowledgementV1 {
  return parseLocalBridgeReadAcknowledgement(value) !== null;
}

function isLocalBridgeMcpReadReceiptData(
  value: unknown,
): value is LocalBridgeMcpReadReceiptV1 {
  if (!hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "receiptId",
    "status",
    "instanceId",
    "captureId",
    "snapshotSequence",
    "detail",
    "handoffDigest",
    "issuedAt",
    "executionAuthority",
    "limitations",
  ])) return false;
  if (
    value.schemaVersion !== UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION ||
    value.kind !== UI_ATTACH_MCP_READ_RECEIPT_KIND ||
    !isUuidV4(value.receiptId) ||
    value.status !== "returned_to_mcp_client" ||
    typeof value.instanceId !== "string" ||
    !/^instance-[0-9a-f]{12}$/.test(value.instanceId) ||
    typeof value.captureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.captureId) ||
    !Number.isSafeInteger(value.snapshotSequence) ||
    (value.snapshotSequence as number) < 0 ||
    value.detail !== "handoff" ||
    typeof value.handoffDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.handoffDigest) ||
    typeof value.issuedAt !== "string" ||
    !isCanonicalFourDigitUtcDate(value.issuedAt) ||
    !hasExactKeys(value.executionAuthority, [
      "grantedByCapture",
      "browserControl",
      "liveDomMutation",
    ]) ||
    value.executionAuthority.grantedByCapture !== false ||
    value.executionAuthority.browserControl !== false ||
    value.executionAuthority.liveDomMutation !== false ||
    !Array.isArray(value.limitations) ||
    value.limitations.length !== UI_ATTACH_MCP_READ_RECEIPT_LIMITATIONS.length ||
    value.limitations.some((limitation, index) => (
      limitation !== UI_ATTACH_MCP_READ_RECEIPT_LIMITATIONS[index]
    ))
  ) return false;
  return true;
}

function isLocalBridgeReadAcknowledgementData(
  value: unknown,
): value is LocalBridgeReadAcknowledgementV1 {
  if (!hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "acknowledgementId",
    "status",
    "instanceId",
    "captureId",
    "snapshotSequence",
    "detail",
    "acknowledgedAt",
    "executionAuthority",
    "limitations",
  ])) return false;
  if (
    value.schemaVersion !== UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION ||
    value.kind !== UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_KIND ||
    !isUuidV4(value.acknowledgementId) ||
    value.status !== "acknowledged_by_agent_client" ||
    typeof value.instanceId !== "string" ||
    !/^instance-[0-9a-f]{12}$/.test(value.instanceId) ||
    typeof value.captureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.captureId) ||
    !Number.isSafeInteger(value.snapshotSequence) ||
    (value.snapshotSequence as number) < 1 ||
    (
      value.detail !== "summary" &&
      value.detail !== "content" &&
      value.detail !== "task" &&
      value.detail !== "agent_context" &&
      value.detail !== "locator" &&
      value.detail !== "visual" &&
      value.detail !== "diagnostics" &&
      value.detail !== "context" &&
      value.detail !== "handoff"
    ) ||
    typeof value.acknowledgedAt !== "string" ||
    !isCanonicalFourDigitUtcDate(value.acknowledgedAt) ||
    !hasExactKeys(value.executionAuthority, [
      "grantedByCapture",
      "browserControl",
      "liveDomMutation",
    ]) ||
    value.executionAuthority.grantedByCapture !== false ||
    value.executionAuthority.browserControl !== false ||
    value.executionAuthority.liveDomMutation !== false ||
    !Array.isArray(value.limitations) ||
    value.limitations.length !== UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS.length ||
    value.limitations.some((limitation, index) => (
      limitation !== UI_ATTACH_LOCAL_BRIDGE_READ_ACKNOWLEDGEMENT_LIMITATIONS[index]
    )) ||
    !isBoundedJson(value, UI_ATTACH_LOCAL_BRIDGE_MAX_READ_ACKNOWLEDGEMENT_BYTES)
  ) return false;
  return true;
}

export function parseLocalBridgeSnapshot(value: unknown): LocalBridgeSnapshotV1 | null {
  const detached = detachLocalBridgeData(value);
  if (!detached.ok || !isNativeStructuredCloneable(value)) return null;
  return isLocalBridgeSnapshotData(detached.value)
    ? detached.value
    : null;
}

export function isLocalBridgeSnapshot(value: unknown): value is LocalBridgeSnapshotV1 {
  return parseLocalBridgeSnapshot(value) !== null;
}

function isLocalBridgeSnapshotData(value: unknown): value is LocalBridgeSnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sequence",
      "publishedAt",
      "page",
      "attachmentCount",
      "agentCopy",
      ...(Object.hasOwn(value, "capture") ? ["capture"] : []),
      ...(Object.hasOwn(value, "observations") ? ["observations"] : []),
      ...(Object.hasOwn(value, "activity") ? ["activity"] : []),
    ]) &&
    value.schemaVersion === UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION &&
    value.kind === "ui-attach.local-bridge-snapshot" &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    typeof value.publishedAt === "string" &&
    isCanonicalIsoDate(value.publishedAt) &&
    (value.page === null || isLocalBridgePage(value.page)) &&
    Number.isSafeInteger(value.attachmentCount) &&
    (value.attachmentCount as number) >= 0 &&
    (value.attachmentCount as number) <= 26 &&
    (value.agentCopy === null || (
      typeof value.agentCopy === "string" &&
      new TextEncoder().encode(value.agentCopy).byteLength <= UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES
    )) &&
    (value.capture === undefined || (
      isLocalBridgeCapture(value.capture) &&
      value.capture.targets.length === value.attachmentCount
    )) &&
    (value.observations === undefined || (
      isLocalBridgeObservations(value.observations) &&
      value.page !== null &&
      value.observations.targets.length > 0 &&
      value.observations.targets.length <= (value.attachmentCount as number)
    )) &&
    (value.activity === undefined || isLocalBridgeActivity(value.activity)) &&
    hasMatchingLocalBridgeCaptureOrigin(value as unknown as LocalBridgeSnapshotV1) &&
    isBoundedJson(value, UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES) &&
    hasValidLocalBridgeCaptureAuthority(value as unknown as LocalBridgeSnapshotV1)
  );
}

type DetachedLocalBridgeDataResult =
  | { ok: true; value: unknown }
  | { ok: false };

interface DetachedLocalBridgeDataState {
  nodes: number;
  stringUnits: number;
  ancestors: WeakSet<object>;
}

function detachLocalBridgeData(value: unknown): DetachedLocalBridgeDataResult {
  return detachLocalBridgeDataValue(value, {
    nodes: 0,
    stringUnits: 0,
    ancestors: new WeakSet<object>(),
  }, 0);
}

function isNativeStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function detachLocalBridgeDataValue(
  value: unknown,
  state: DetachedLocalBridgeDataState,
  depth: number,
): DetachedLocalBridgeDataResult {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    state.stringUnits += value.length;
    return state.stringUnits <= UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES
      ? { ok: true, value }
      : { ok: false };
  }
  if (typeof value !== "object" || depth > UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_DEPTH) {
    return { ok: false };
  }
  state.nodes += 1;
  if (state.nodes > UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_NODES || state.ancestors.has(value)) {
    return { ok: false };
  }
  state.ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_NODES ||
      keys.some((key) => typeof key === "symbol")
    ) {
      return { ok: false };
    }
    if (Array.isArray(value)) {
      return detachLocalBridgeArray(value, keys as string[], state, depth);
    }
    const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      state.stringUnits += key.length;
      if (state.stringUnits > UI_ATTACH_LOCAL_BRIDGE_MAX_SNAPSHOT_BYTES) return { ok: false };
      const field = readLocalBridgeDataField(value, key, true);
      if (!field.ok) return field;
      const child = detachLocalBridgeDataValue(field.value, state, depth + 1);
      if (!child.ok) return child;
      Object.defineProperty(detached, key, {
        value: child.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, value: detached };
  } catch {
    return { ok: false };
  } finally {
    state.ancestors.delete(value);
  }
}

function detachLocalBridgeArray(
  value: object,
  keys: string[],
  state: DetachedLocalBridgeDataState,
  depth: number,
): DetachedLocalBridgeDataResult {
  const lengthField = readLocalBridgeDataField(value, "length", false);
  if (
    !lengthField.ok ||
    !Number.isSafeInteger(lengthField.value) ||
    (lengthField.value as number) < 0 ||
    (lengthField.value as number) > UI_ATTACH_LOCAL_BRIDGE_MAX_DATA_NODES
  ) {
    return { ok: false };
  }
  const length = lengthField.value as number;
  if (keys.length !== length + 1) return { ok: false };
  const keySet = new Set(keys);
  if (!keySet.has("length")) return { ok: false };
  const detached: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) return { ok: false };
    const field = readLocalBridgeDataField(value, key, true);
    if (!field.ok) return field;
    const child = detachLocalBridgeDataValue(field.value, state, depth + 1);
    if (!child.ok) return child;
    detached[index] = child.value;
  }
  return { ok: true, value: detached };
}

function readLocalBridgeDataField(
  value: object,
  key: string,
  enumerable: boolean,
): DetachedLocalBridgeDataResult {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== enumerable ||
    !("value" in descriptor)
  ) {
    return { ok: false };
  }
  return { ok: true, value: descriptor.value };
}

function hasMatchingLocalBridgeCaptureOrigin(snapshot: LocalBridgeSnapshotV1): boolean {
  if (!snapshot.page || !snapshot.capture) return true;
  try {
    return new URL(snapshot.page.route).origin === snapshot.capture.origin;
  } catch {
    return false;
  }
}

function isLocalBridgeCapture(value: unknown): value is LocalBridgeCaptureV1 {
  const hasAnnotationLifecycleVersion = isRecord(value) &&
    Object.hasOwn(value, "annotationLifecycleVersion");
  const hasMetadataDiagnostics = isRecord(value) &&
    Object.hasOwn(value, "metadataDiagnostics");
  if (!hasExactKeys(value, [
    "captureId",
    "title",
    "origin",
    "updatedAt",
    "authority",
    "disclosureMode",
    ...(hasAnnotationLifecycleVersion ? ["annotationLifecycleVersion"] : []),
    ...(hasMetadataDiagnostics ? ["metadataDiagnostics"] : []),
    "targets",
  ])) {
    return false;
  }
  if (
    typeof value.captureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.captureId) ||
    !(value.title === null || isBoundedText(value.title, 512)) ||
    !isCanonicalHttpOrigin(value.origin) ||
    typeof value.updatedAt !== "string" ||
    !isCanonicalIsoDate(value.updatedAt) ||
    (
      value.authority !== "live_page" &&
      value.authority !== "capture_time" &&
      value.authority !== "not_rechecked"
    ) ||
    value.disclosureMode !== "agent_safe" ||
    (hasAnnotationLifecycleVersion && value.annotationLifecycleVersion !== "v1") ||
    (hasAnnotationLifecycleVersion && !isCanonicalFourDigitUtcDate(value.updatedAt as string)) ||
    (hasMetadataDiagnostics && !isLocalBridgeCaptureMetadataDiagnostics(
      value.metadataDiagnostics,
      value.captureId as string,
      value.updatedAt as string,
    )) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    value.targets.length > 26 ||
    !value.targets.every((target) => isLocalBridgeCaptureTarget(
      target,
      value.updatedAt as string,
      hasAnnotationLifecycleVersion,
    ))
  ) {
    return false;
  }
  const attachmentIds = value.targets.map((target) => target.attachmentId);
  const targetIds = value.targets.flatMap((target) => target.targetId ? [target.targetId] : []);
  const annotationIds = value.targets.flatMap((target) => (
    typeof target.annotationId === "string" ? [target.annotationId] : []
  ));
  const annotationIdentityModes = value.targets.map((target) => (
    !hasLocalBridgeAnnotationIdentity(target)
      ? "absent"
      : target.annotationId === null
        ? "unknown"
        : "capture_session"
  ));
  return new Set(attachmentIds).size === attachmentIds.length &&
    new Set(targetIds).size === targetIds.length &&
    new Set(annotationIds).size === annotationIds.length &&
    new Set(annotationIdentityModes).size === 1 &&
    isBoundedJson(value, UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES);
}

function isLocalBridgeCaptureMetadataDiagnostics(
  value: unknown,
  captureId: string,
  updatedAt: string,
): value is MetadataDiagnosticsV1 {
  return isMetadataDiagnosticsV1(value) &&
    value.captureId === captureId &&
    Date.parse(value.observedAt) <= Date.parse(updatedAt) &&
    value.consent === "explicit_capture" &&
    value.authority === "capture_time" &&
    value.network.status === "not_requested" &&
    value.console.status === "not_requested" &&
    value.executionAuthority.grantedByCapture === false &&
    value.executionAuthority.browserControl === false &&
    value.executionAuthority.liveDomMutation === false;
}

function hasValidLocalBridgeCaptureAuthority(snapshot: LocalBridgeSnapshotV1): boolean {
  if (!snapshot.capture || snapshot.capture.authority !== "live_page") return true;
  if (!snapshot.page || !snapshot.observations) return false;
  const publicationDelay = Date.parse(snapshot.publishedAt) - Date.parse(snapshot.observations.observedAt);
  if (publicationDelay < 0 || publicationDelay > 30_000) return false;
  const expected = new Set(snapshot.capture.targets.map((target) => target.attachmentId));
  return snapshot.observations.targets.length === expected.size &&
    snapshot.observations.targets.every(
      (target) => expected.has(target.attachmentId) && target.status === "restored",
    );
}

function isLocalBridgeCaptureTarget(
  value: unknown,
  captureUpdatedAt: string,
  requiresAnnotationLifecycle: boolean,
): value is LocalBridgeCaptureTargetV1 {
  const annotationKeys = [
    "annotationId",
    "annotationIdScope",
    "annotationCreatedAt",
    "annotationUpdatedAt",
  ] as const;
  const hasAnnotationKeys = isRecord(value) && annotationKeys.every((key) => Object.hasOwn(value, key));
  const hasAnyAnnotationKey = isRecord(value) && annotationKeys.some((key) => Object.hasOwn(value, key));
  return hasAnyAnnotationKey === hasAnnotationKeys &&
    hasExactKeys(value, [
      ...(isRecord(value) && Object.hasOwn(value, "targetId") ? ["targetId"] : []),
      "attachmentId",
      "label",
      "taskNote",
      ...(hasAnnotationKeys ? annotationKeys : []),
      ...(requiresAnnotationLifecycle ? ["annotationLifecycle"] : []),
      "attachment",
    ]) &&
    (!Object.hasOwn(value, "targetId") || (
      typeof value.targetId === "string" &&
      /^target_[A-Za-z0-9_-]{1,64}$/.test(value.targetId)
    )) &&
    typeof value.attachmentId === "string" &&
    /^att_[A-Za-z0-9_-]{1,252}$/.test(value.attachmentId) &&
    isBoundedText(value.label, 128) &&
    isBoundedText(value.taskNote, 16_384) &&
    (!hasAnnotationKeys || isLocalBridgeAnnotationIdentity(value, captureUpdatedAt)) &&
    (!requiresAnnotationLifecycle || isLocalBridgeAnnotationLifecycle(
      value,
      captureUpdatedAt,
    )) &&
    isUIAttachment(value.attachment) &&
    value.attachment.id === value.attachmentId &&
    value.attachment.policy.disclosureMode === "agent_safe";
}

function isLocalBridgeAnnotationLifecycle(
  value: Record<string, unknown>,
  captureUpdatedAt: string,
): boolean {
  if (
    value.annotationIdScope !== "capture_session" ||
    typeof value.annotationId !== "string" ||
    typeof value.annotationCreatedAt !== "string" ||
    typeof value.annotationUpdatedAt !== "string" ||
    !isCanonicalFourDigitUtcDate(value.annotationCreatedAt) ||
    !isCanonicalFourDigitUtcDate(value.annotationUpdatedAt) ||
    !isCanonicalFourDigitUtcDate(captureUpdatedAt) ||
    !hasExactKeys(value.annotationLifecycle, ["state", "resolvedAt"])
  ) {
    return false;
  }
  const lifecycle = value.annotationLifecycle;
  if (lifecycle.state === "open") return lifecycle.resolvedAt === null;
  if (
    lifecycle.state !== "resolved" ||
    typeof lifecycle.resolvedAt !== "string" ||
    !isCanonicalFourDigitUtcDate(lifecycle.resolvedAt)
  ) {
    return false;
  }
  const createdAt = Date.parse(value.annotationCreatedAt);
  const resolvedAt = Date.parse(lifecycle.resolvedAt);
  const updatedAt = Date.parse(value.annotationUpdatedAt);
  const captureAt = Date.parse(captureUpdatedAt);
  return createdAt <= resolvedAt && resolvedAt <= updatedAt && updatedAt <= captureAt;
}

function hasLocalBridgeAnnotationIdentity(value: unknown): boolean {
  return isRecord(value) &&
    Object.hasOwn(value, "annotationId") &&
    Object.hasOwn(value, "annotationIdScope") &&
    Object.hasOwn(value, "annotationCreatedAt") &&
    Object.hasOwn(value, "annotationUpdatedAt");
}

function isLocalBridgeAnnotationIdentity(
  value: Record<string, unknown>,
  captureUpdatedAt: string,
): boolean {
  if (value.annotationId === null) {
    return value.annotationIdScope === "unknown" &&
      value.annotationCreatedAt === null &&
      value.annotationUpdatedAt === null;
  }
  if (
    typeof value.annotationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.annotationId) ||
    value.annotationIdScope !== "capture_session" ||
    typeof value.annotationCreatedAt !== "string" ||
    typeof value.annotationUpdatedAt !== "string" ||
    !isCanonicalIsoDate(value.annotationCreatedAt) ||
    !isCanonicalIsoDate(value.annotationUpdatedAt)
  ) {
    return false;
  }
  const createdAt = Date.parse(value.annotationCreatedAt);
  const updatedAt = Date.parse(value.annotationUpdatedAt);
  const captureAt = Date.parse(captureUpdatedAt);
  return Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    Number.isFinite(captureAt) &&
    updatedAt >= createdAt &&
    updatedAt <= captureAt;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function isLocalBridgeActivity(value: unknown): value is LocalBridgeActivityV1 {
  if (
    !hasExactKeys(value, ["operation", "state", "stage", "code", "observedAt"]) ||
    value.operation !== "saved_restore" ||
    (value.state !== "pending" && value.state !== "failed" && value.state !== "succeeded") ||
    (
      value.stage !== "panel_request" &&
      value.stage !== "background_response" &&
      value.stage !== "panel_reconciliation"
    ) ||
    !(value.code === null || (
      typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    )) ||
    typeof value.observedAt !== "string" ||
    !isCanonicalIsoDate(value.observedAt)
  ) {
    return false;
  }
  return value.state === "failed" ? value.code !== null : value.code === null;
}

function isLocalBridgeObservations(value: unknown): value is LocalBridgeObservationsV1 {
  if (
    !hasExactKeys(value, ["observedAt", "documentInstanceId", "targets"]) ||
    typeof value.observedAt !== "string" ||
    !isCanonicalIsoDate(value.observedAt) ||
    typeof value.documentInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.documentInstanceId) ||
    !Array.isArray(value.targets) ||
    value.targets.length > 26
  ) {
    return false;
  }
  const attachmentIds = new Set<string>();
  for (const target of value.targets) {
    if (
      !hasExactKeys(target, ["attachmentId", "status"]) ||
      typeof target.attachmentId !== "string" ||
      !/^att_[A-Za-z0-9_-]{1,252}$/.test(target.attachmentId) ||
      !["checking", "restored", "missing", "ambiguous"].includes(
        target.status as string,
      ) ||
      attachmentIds.has(target.attachmentId)
    ) {
      return false;
    }
    attachmentIds.add(target.attachmentId);
  }
  return true;
}

function isLocalBridgePage(value: unknown): value is LocalBridgePageV1 {
  if (
    !hasExactKeys(value, ["pageInstanceId", "route"]) ||
    typeof value.pageInstanceId !== "string" ||
    !/^chromium-tab:\d+:frame:\d+$/.test(value.pageInstanceId) ||
    typeof value.route !== "string"
  ) {
    return false;
  }
  try {
    const url = new URL(value.route);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.route !== `${url.origin}${url.pathname}`
    ) {
      return false;
    }
    const decoded = decodeLocalBridgePathname(url.pathname);
    return decoded !== null && !/(?:\bsk-[a-z0-9]|\b(?:api[_-]?key|token|secret|password|bearer)\b|[^\s/@]+@[^\s/@]+\.[^\s/@]+)/i.test(decoded);
  } catch {
    return false;
  }
}

function decodeLocalBridgePathname(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function isCanonicalIsoDate(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isCanonicalFourDigitUtcDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    isCanonicalIsoDate(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[],
): value is Record<T, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export type UISourceKind = "web";

export interface UIBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UIAttachmentSource {
  kind: UISourceKind;
  url: string | null;
  title: string | null;
}

export interface UIAttachmentSourceAnchor {
  schemaVersion: typeof UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION;
  kind: "ui-attach.opaque-source-anchor";
  buildId: string;
  sourceId: string;
}

export interface UIAttachmentElement {
  tagName: string;
  role: string | null;
  text: string | null;
  accessibleName: string | null;
  contentParts?: UIAttachmentContentPart[];
  bbox: UIBounds;
  visible: boolean;
  enabled: boolean;
}

export type UIAttachmentContentPartKind =
  | "text"
  | "link"
  | "button"
  | "image"
  | "time"
  | "form_control";

export interface UIAttachmentContentPart {
  kind: UIAttachmentContentPartKind;
  tagName: string;
  role: string | null;
  text: string | null;
  accessibleName: string | null;
}

export interface UIAttachmentStyle {
  display: string | null;
  color: string | null;
  backgroundColor: string | null;
  position?: string | null;
  boxSizing?: string | null;
  width?: string | null;
  height?: string | null;
  margin?: string | null;
  padding?: string | null;
  gap?: string | null;
  flexDirection?: string | null;
  justifyContent?: string | null;
  alignItems?: string | null;
  overflowX?: string | null;
  overflowY?: string | null;
  fontSize?: string | null;
  fontWeight?: string | null;
  lineHeight?: string | null;
  borderRadius?: string | null;
}

export interface UIAttachmentContext {
  parentSummary: string | null;
  nearbyText: string[];
  selectorHints: string[];
}

export type UILocatorStrategy =
  | "playwright.role"
  | "playwright.label"
  | "playwright.text"
  | "playwright.testId"
  | "playwright.altText"
  | "playwright.title"
  | "playwright.placeholder"
  | "css"
  | "xpath"
  | "coordinates";

export interface UIAttachmentLocator {
  strategy: UILocatorStrategy;
  value: string;
  confidence: number;
  notes?: string;
}

export interface UIAttachmentLocatorStability {
  score: number;
  uniqueness: boolean | null;
  replayVerified: boolean;
  failureReason: string | null;
  verifiedBy?: UILocatorStrategy | null;
  verifiedValue?: string | null;
}

export interface UIAttachmentLocatorBundle {
  primary: UIAttachmentLocator | null;
  candidates: UIAttachmentLocator[];
  stability: UIAttachmentLocatorStability;
}

export type UIAttachmentRedactionLevel = "strict" | "balanced" | "debug";

export type UIAttachmentDisclosureMode =
  | "agent_safe"
  | "developer_diagnostic"
  | "full_debug";

export type UIAttachmentActionMode = "read_only" | "suggest_patch" | "requires_approval";

export interface UIAttachmentPolicy {
  disclosureMode: UIAttachmentDisclosureMode;
  redactionLevel: UIAttachmentRedactionLevel;
  actionMode: UIAttachmentActionMode;
  allowScreenshot: boolean;
  allowDomSnippet: boolean;
  allowNetworkSend: boolean;
  allowedDomains: string[];
  redactedFields: string[];
  sensitiveHints: string[];
  includedSensitiveFields: string[];
}

export interface UIAttachmentArtifacts {
  screenshotCrop: string | null;
  overlayImage: string | null;
}

export interface UIAttachmentSelectionPoint {
  kind: "element_relative_pointer";
  xRatio: number;
  yRatio: number;
}

export type UIAttachmentFrameOriginRelation =
  | "same_origin"
  | "cross_origin"
  | "opaque_or_unavailable";

export interface UIAttachmentEmbeddedFrameBoundary {
  kind: "embedded_frame";
  innerDom: "not_captured";
  originRelation: UIAttachmentFrameOriginRelation;
  frameOrigin: string | null;
  framePathname?: string | null;
  dominantViewport: boolean;
}

export type UIAttachmentBoundary = UIAttachmentEmbeddedFrameBoundary;

export interface UIAttachment {
  schemaVersion: typeof UI_ATTACHMENT_SCHEMA_VERSION;
  id: string;
  capturedAt: string;
  source: UIAttachmentSource;
  sourceAnchor?: UIAttachmentSourceAnchor;
  element: UIAttachmentElement;
  style: UIAttachmentStyle;
  context: UIAttachmentContext;
  locatorBundle: UIAttachmentLocatorBundle;
  policy: UIAttachmentPolicy;
  artifacts: UIAttachmentArtifacts;
  selectionPoint?: UIAttachmentSelectionPoint;
  boundary?: UIAttachmentBoundary;
}

export function createAttachmentId(seed: string): string {
  const safeSeed = seed.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `att_${safeSeed || "element"}`;
}

export function isUIAttachment(value: unknown): value is UIAttachment {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === UI_ATTACHMENT_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    typeof value.capturedAt === "string" &&
    isSource(value.source) &&
    (value.sourceAnchor === undefined || isUIAttachmentSourceAnchor(value.sourceAnchor)) &&
    isElement(value.element) &&
    isStyle(value.style) &&
    isContext(value.context) &&
    isLocatorBundle(value.locatorBundle) &&
    isPolicy(value.policy) &&
    isArtifacts(value.artifacts) &&
    (value.selectionPoint === undefined || isUIAttachmentSelectionPoint(value.selectionPoint)) &&
    (value.boundary === undefined || isAttachmentBoundary(value.boundary))
  );
}

export function isUIAttachmentSelectionPoint(
  value: unknown,
): value is UIAttachmentSelectionPoint {
  return (
    hasExactKeys(value, ["kind", "xRatio", "yRatio"]) &&
    value.kind === "element_relative_pointer" &&
    isRatio(value.xRatio) &&
    isRatio(value.yRatio)
  );
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isUIAttachmentSourceAnchor(
  value: unknown,
): value is UIAttachmentSourceAnchor {
  return (
    hasExactKeys(value, ["schemaVersion", "kind", "buildId", "sourceId"]) &&
    value.schemaVersion === UI_ATTACH_SOURCE_ANCHOR_SCHEMA_VERSION &&
    value.kind === "ui-attach.opaque-source-anchor" &&
    isOpaqueSourceIdentifier(value.buildId) &&
    isOpaqueSourceIdentifier(value.sourceId)
  );
}

function isOpaqueSourceIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isSource(value: unknown): value is UIAttachmentSource {
  return (
    isRecord(value) &&
    value.kind === "web" &&
    isNullableString(value.url) &&
    isNullableString(value.title)
  );
}

function isElement(value: unknown): value is UIAttachmentElement {
  return (
    isRecord(value) &&
    typeof value.tagName === "string" &&
    isNullableString(value.role) &&
    isNullableString(value.text) &&
    isNullableString(value.accessibleName) &&
    (
      value.contentParts === undefined ||
      (
        Array.isArray(value.contentParts) &&
        value.contentParts.length <= 64 &&
        value.contentParts.every(isContentPart)
      )
    ) &&
    isBounds(value.bbox) &&
    typeof value.visible === "boolean" &&
    typeof value.enabled === "boolean"
  );
}

function isContentPart(value: unknown): value is UIAttachmentContentPart {
  return hasExactKeys(value, ["kind", "tagName", "role", "text", "accessibleName"]) &&
    ["text", "link", "button", "image", "time", "form_control"].includes(
      value.kind as string,
    ) &&
    isBoundedText(value.tagName, 128) &&
    (value.role === null || isBoundedText(value.role, 256)) &&
    (value.text === null || isBoundedText(value.text, 16_384)) &&
    (value.accessibleName === null || isBoundedText(value.accessibleName, 16_384));
}

function isBounds(value: unknown): value is UIBounds {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNonNegativeNumber(value.width) &&
    isFiniteNonNegativeNumber(value.height)
  );
}

function isStyle(value: unknown): value is UIAttachmentStyle {
  const optionalFields = isRecord(value)
    ? UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.filter((field) => Object.hasOwn(value, field))
    : [];
  return (
    hasExactKeys(value, [
      "display",
      "color",
      "backgroundColor",
      ...optionalFields,
    ]) &&
    isNullableString(value.display) &&
    isNullableString(value.color) &&
    isNullableString(value.backgroundColor) &&
    UI_ATTACHMENT_COMPUTED_STYLE_FIELDS.every((field) =>
      !Object.hasOwn(value, field) ||
      value[field] === null ||
      isBoundedText(value[field], UI_ATTACHMENT_COMPUTED_STYLE_VALUE_MAX_BYTES)
    )
  );
}

function isContext(value: unknown): value is UIAttachmentContext {
  return (
    isRecord(value) &&
    isNullableString(value.parentSummary) &&
    isStringArray(value.nearbyText) &&
    isStringArray(value.selectorHints)
  );
}

function isArtifacts(value: unknown): value is UIAttachmentArtifacts {
  return (
    isRecord(value) &&
    isNullableString(value.screenshotCrop) &&
    isNullableString(value.overlayImage)
  );
}

function isAttachmentBoundary(value: unknown): value is UIAttachmentBoundary {
  const hasLegacyKeys = hasExactKeys(value, [
    "kind",
    "innerDom",
    "originRelation",
    "frameOrigin",
    "dominantViewport",
  ]);
  const hasRouteKeys = hasExactKeys(value, [
    "kind",
    "innerDom",
    "originRelation",
    "frameOrigin",
    "framePathname",
    "dominantViewport",
  ]);
  const framePathname = hasRouteKeys
    ? (value as { framePathname: unknown }).framePathname
    : undefined;
  if (
    (!hasLegacyKeys && !hasRouteKeys) ||
    value.kind !== "embedded_frame" ||
    value.innerDom !== "not_captured" ||
    typeof value.dominantViewport !== "boolean"
  ) {
    return false;
  }

  if (value.originRelation === "opaque_or_unavailable") {
    return value.frameOrigin === null &&
      (framePathname === undefined || framePathname === null);
  }

  return (
    (value.originRelation === "same_origin" || value.originRelation === "cross_origin") &&
    isCanonicalHttpOrigin(value.frameOrigin) &&
    (framePathname === undefined ||
      isCanonicalPathname(framePathname, value.frameOrigin))
  );
}

function isCanonicalPathname(value: unknown, origin: unknown): value is string {
  if (typeof value !== "string" || typeof origin !== "string" || !value.startsWith("/")) {
    return false;
  }
  try {
    const parsed = new URL(value, `${origin}/`);
    return parsed.origin === origin && parsed.pathname === value &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function isLocatorBundle(value: unknown): value is UIAttachmentLocatorBundle {
  return (
    isRecord(value) &&
    (value.primary === null || isLocator(value.primary)) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isLocator) &&
    isLocatorStability(value.stability)
  );
}

function isLocator(value: unknown): value is UIAttachmentLocator {
  return (
    isRecord(value) &&
    isLocatorStrategy(value.strategy) &&
    typeof value.value === "string" &&
    isConfidence(value.confidence) &&
    (value.notes === undefined || typeof value.notes === "string")
  );
}

function isLocatorStrategy(value: unknown): value is UILocatorStrategy {
  return (
    value === "playwright.role" ||
    value === "playwright.label" ||
    value === "playwright.text" ||
    value === "playwright.testId" ||
    value === "playwright.altText" ||
    value === "playwright.title" ||
    value === "playwright.placeholder" ||
    value === "css" ||
    value === "xpath" ||
    value === "coordinates"
  );
}

function isLocatorStability(value: unknown): value is UIAttachmentLocatorStability {
  return (
    isRecord(value) &&
    isScore(value.score) &&
    (typeof value.uniqueness === "boolean" || value.uniqueness === null) &&
    typeof value.replayVerified === "boolean" &&
    isNullableString(value.failureReason) &&
    (value.verifiedBy === undefined ||
      value.verifiedBy === null ||
      isLocatorStrategy(value.verifiedBy)) &&
    (value.verifiedValue === undefined ||
      value.verifiedValue === null ||
      typeof value.verifiedValue === "string")
  );
}

function isPolicy(value: unknown): value is UIAttachmentPolicy {
  return (
    isRecord(value) &&
    isDisclosureMode(value.disclosureMode) &&
    isRedactionLevel(value.redactionLevel) &&
    isActionMode(value.actionMode) &&
    typeof value.allowScreenshot === "boolean" &&
    typeof value.allowDomSnippet === "boolean" &&
    typeof value.allowNetworkSend === "boolean" &&
    isStringArray(value.allowedDomains) &&
    isStringArray(value.redactedFields) &&
    isStringArray(value.sensitiveHints) &&
    isStringArray(value.includedSensitiveFields)
  );
}

function isDisclosureMode(value: unknown): value is UIAttachmentDisclosureMode {
  return value === "agent_safe" || value === "developer_diagnostic" || value === "full_debug";
}

function isRedactionLevel(value: unknown): value is UIAttachmentRedactionLevel {
  return value === "strict" || value === "balanced" || value === "debug";
}

function isActionMode(value: unknown): value is UIAttachmentActionMode {
  return value === "read_only" || value === "suggest_patch" || value === "requires_approval";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isConfidence(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 1;
}

function isScore(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 100;
}
