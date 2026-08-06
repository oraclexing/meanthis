import { createHash } from "node:crypto";
import { isSavedSnapshotAuthority } from "@meanthis/schema";

const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{1,252}$/u;
const ATTACHMENT_REF_KEYS = Object.freeze([
  "id",
  "label",
  "target",
  "role",
  "accessibleName",
  "text",
  "primaryLocator",
]);
const FORBIDDEN_ROUTING_FIELDS = Object.freeze([
  "routing",
  "routingHints",
  "pageInstanceId",
  "tabId",
  "frameId",
]);
const CONSUMER_BUNDLE_KEYS = new Set([
  "ok",
  "kind",
  "sessionId",
  "title",
  "disclosureMode",
  "authority",
  "attachmentCount",
  "attachmentIds",
  "attachmentRefs",
  "markdown",
]);

export const SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_MARKDOWN_BYTES = 262_144;

export function projectAcceptedSavedSnapshotPolicySubject(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.kind !== "ui-attach.saved-snapshot-prompt-bundle" ||
    value.disclosureMode !== "agent_safe" ||
    !isSavedSnapshotAuthority(value.authority) ||
    FORBIDDEN_ROUTING_FIELDS.some((field) => Object.hasOwn(value, field)) ||
    !Number.isSafeInteger(value.attachmentCount) ||
    value.attachmentCount < 1 ||
    value.attachmentCount > 26 ||
    !Array.isArray(value.attachmentIds) ||
    value.attachmentIds.length !== value.attachmentCount ||
    value.attachmentIds.some((attachmentId) => (
      typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId)
    )) ||
    new Set(value.attachmentIds).size !== value.attachmentIds.length ||
    !Array.isArray(value.attachmentRefs) ||
    value.attachmentRefs.length !== value.attachmentCount
  ) return null;

  const attachmentRefs = value.attachmentRefs.map((ref, index) => (
    normalizeAttachmentRef(ref, value.attachmentIds[index])
  ));
  if (attachmentRefs.some((ref) => ref === null)) return null;

  try {
    return {
      kind: value.kind,
      disclosureMode: value.disclosureMode,
      authority: structuredClone(value.authority),
      attachmentCount: value.attachmentCount,
      attachmentIds: structuredClone(value.attachmentIds),
      attachmentRefs: structuredClone(attachmentRefs),
    };
  } catch {
    return null;
  }
}

export function projectAcceptedSavedSnapshotAttachmentContext(value) {
  const subject = projectAcceptedSavedSnapshotPolicySubject(value);
  if (
    subject === null ||
    !Object.keys(value).every((key) => CONSUMER_BUNDLE_KEYS.has(key)) ||
    (Object.hasOwn(value, "ok") && value.ok !== true) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0 ||
    !(value.title === null || typeof value.title === "string") ||
    typeof value.markdown !== "string" ||
    value.markdown.trim().length === 0 ||
    new TextEncoder().encode(value.markdown).byteLength >
      SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_MARKDOWN_BYTES
  ) return null;

  try {
    return {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-attachment-context",
      disclosureMode: subject.disclosureMode,
      authority: structuredClone(subject.authority),
      attachmentCount: subject.attachmentCount,
      attachmentIds: structuredClone(subject.attachmentIds),
      attachmentRefs: structuredClone(subject.attachmentRefs),
      markdown: value.markdown,
    };
  } catch {
    return null;
  }
}

export function bindSavedSnapshotTextConsumerContext(value) {
  const attachmentContext = projectAcceptedSavedSnapshotAttachmentContext(value);
  if (attachmentContext === null) return null;
  return {
    ...attachmentContext,
    contentSha256: sha256(JSON.stringify(attachmentContext)),
  };
}

export function verifySavedSnapshotTextConsumerContext(value) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "disclosureMode",
      "authority",
      "attachmentCount",
      "attachmentIds",
      "attachmentRefs",
      "markdown",
      "contentSha256",
    ]) ||
    typeof value.contentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.contentSha256)
  ) return null;

  const canonicalContext = projectAcceptedSavedSnapshotAttachmentContext({
    kind: "ui-attach.saved-snapshot-prompt-bundle",
    sessionId: "accepted_text_consumer_context",
    title: null,
    disclosureMode: value.disclosureMode,
    authority: value.authority,
    attachmentCount: value.attachmentCount,
    attachmentIds: value.attachmentIds,
    attachmentRefs: value.attachmentRefs,
    markdown: value.markdown,
  });
  if (
    canonicalContext === null ||
    value.schemaVersion !== canonicalContext.schemaVersion ||
    value.kind !== canonicalContext.kind ||
    value.contentSha256 !== sha256(JSON.stringify(canonicalContext))
  ) return null;

  return {
    ...canonicalContext,
    contentSha256: value.contentSha256,
  };
}

function normalizeAttachmentRef(value, expectedId) {
  if (
    !hasExactKeys(value, ATTACHMENT_REF_KEYS) ||
    value.id !== expectedId ||
    typeof value.label !== "string" ||
    typeof value.target !== "string" ||
    !isNullableString(value.role) ||
    !isNullableString(value.accessibleName) ||
    !isNullableString(value.text) ||
    !isNullableString(value.primaryLocator)
  ) return null;

  return Object.fromEntries(ATTACHMENT_REF_KEYS.map((key) => [key, value[key]]));
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isNullableString(value) {
  return typeof value === "string" || value === null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
