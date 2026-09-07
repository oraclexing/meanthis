import { createCaptureHub } from "@meanthis/hub-core";
import {
  isUIAttachment,
  type UIAttachmentDisclosureMode,
} from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";

const CONTENT_PART_KEYS = ["kind", "tagName", "role", "text", "accessibleName"] as const;
const CONTENT_PART_KINDS = new Set([
  "text",
  "link",
  "button",
  "image",
  "time",
  "form_control",
]);
const MAX_CONTENT_PARTS = 64;
const MAX_CONTENT_PART_TAG_NAME_BYTES = 128;
const MAX_CONTENT_PART_ROLE_BYTES = 256;
const MAX_CONTENT_PART_TEXT_BYTES = 16_384;

export type CaptureRecordDisclosureResult =
  | {
      ok: true;
      record: OriginCaptureRecord;
      status: string;
    }
  | {
      ok: false;
      status: string;
    };

export function deriveCaptureRecordDisclosure(
  record: OriginCaptureRecord,
  disclosureMode: UIAttachmentDisclosureMode,
): CaptureRecordDisclosureResult {
  const compatibleRecord = recoverLegacyContentPartsCapture(record);
  if (!compatibleRecord) {
    return { ok: false, status: "Cached capture is invalid. Capture the element again." };
  }

  const hub = createCaptureHub();
  const session = hub.createSession({
    id: "extension-panel-preview",
    title: compatibleRecord.pageTitle,
    origin: compatibleRecord.origin,
  });
  const added = hub.addAttachment(session.id, compatibleRecord);
  if (!added.ok) {
    return { ok: false, status: added.error };
  }

  const result = hub.getAttachment(session.id, compatibleRecord.attachment.id, {
    disclosureMode,
  });
  if (!result.ok) {
    return {
      ok: false,
      status: `Capture again with ${disclosureMode} disclosure to include ${formatDisclosureModeLabel(
        disclosureMode,
      )} details.`,
    };
  }

  const attachment = result.record.attachment;
  return {
    ok: true,
    status:
      attachment.policy.disclosureMode === compatibleRecord.attachment.policy.disclosureMode
        ? "Capture ready."
        : `Showing ${attachment.policy.disclosureMode} view from cached ${compatibleRecord.attachment.policy.disclosureMode} capture.`,
    record: result.record as OriginCaptureRecord,
  };
}

function recoverLegacyContentPartsCapture(
  record: OriginCaptureRecord,
): OriginCaptureRecord | null {
  const sourceAttachment: unknown = record.attachment;
  if (isUIAttachment(sourceAttachment)) return record;
  if (
    !hasContentPartsElement(sourceAttachment) ||
    !hasLegacyUtf8OverflowContentParts(sourceAttachment.element.contentParts)
  ) {
    return null;
  }

  const element = { ...sourceAttachment.element };
  delete element.contentParts;
  const attachment = { ...sourceAttachment, element };
  if (!isUIAttachment(attachment)) return null;

  return { ...record, attachment };
}

function hasContentPartsElement(
  value: unknown,
): value is Record<string, unknown> & {
  element: Record<string, unknown> & { contentParts: unknown };
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const element = (value as Record<string, unknown>).element;
  return typeof element === "object" && element !== null && !Array.isArray(element) &&
    Object.hasOwn(element, "contentParts");
}

function hasLegacyUtf8OverflowContentParts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTENT_PARTS) {
    return false;
  }

  let foundUtf8Overflow = false;
  for (const part of value) {
    if (!hasExactContentPartKeys(part)) return false;
    if (!CONTENT_PART_KINDS.has(part.kind as string)) return false;
    if (!isUtf8BoundedText(part.tagName, MAX_CONTENT_PART_TAG_NAME_BYTES)) return false;
    if (
      part.role !== null &&
      !isUtf8BoundedText(part.role, MAX_CONTENT_PART_ROLE_BYTES)
    ) return false;
    if (!isLegacyNullableText(part.text, MAX_CONTENT_PART_TEXT_BYTES)) return false;
    if (!isLegacyNullableText(part.accessibleName, MAX_CONTENT_PART_TEXT_BYTES)) return false;

    foundUtf8Overflow ||= hasUtf8Overflow(part.text, MAX_CONTENT_PART_TEXT_BYTES) ||
      hasUtf8Overflow(part.accessibleName, MAX_CONTENT_PART_TEXT_BYTES);
  }
  return foundUtf8Overflow;
}

function hasExactContentPartKeys(
  value: unknown,
): value is Record<(typeof CONTENT_PART_KEYS)[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...CONTENT_PART_KEYS].sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isLegacyNullableText(value: unknown, maxCharacters: number): boolean {
  return value === null || (typeof value === "string" && value.length <= maxCharacters);
}

function isUtf8BoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= maxBytes;
}

function hasUtf8Overflow(value: unknown, maxBytes: number): boolean {
  return typeof value === "string" && value.length <= maxBytes &&
    utf8ByteLength(value) > maxBytes;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatDisclosureModeLabel(disclosureMode: UIAttachmentDisclosureMode): string {
  return disclosureMode.replaceAll("_", " ");
}
