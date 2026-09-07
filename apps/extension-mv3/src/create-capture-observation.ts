import { isUIAttachment, type UIAttachment } from "@meanthis/schema";
import { deriveAttachmentDisclosure } from "@meanthis/web-extractor";
import { CAPTURE_COMPARISON_FIELDS, isCaptureObservation, type CaptureObservation, type CaptureComparisonValue } from "./capture-comparison";

const MAX_TEXT_CHARACTERS = 2048;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A bounded, Agent-safe observation only; no storage, capture, or replay action. */
export function createCaptureObservation(attachment: UIAttachment): CaptureObservation | null {
  if (!isUIAttachment(attachment)) return null;
  const disclosed = deriveAttachmentDisclosure(attachment, "agent_safe");
  if (!disclosed.ok) return null;
  const observation: CaptureObservation = {
    capturedAt: attachment.capturedAt,
    fields: {},
    unavailableFields: [],
  };
  const redacted = new Set([
    ...attachment.policy.redactedFields,
    ...disclosed.attachment.policy.redactedFields,
  ]);
  for (const field of CAPTURE_COMPARISON_FIELDS) {
    let value: unknown = disclosed.attachment;
    for (const key of field.split(".")) value = isRecord(value) ? value[key] : undefined;
    const unavailable = [...redacted].some((path) => field === path || field.startsWith(`${path}.`)) ||
      value === undefined ||
      (typeof value === "string" && (value.length > MAX_TEXT_CHARACTERS || value.includes("[truncated]")));
    if (unavailable) {
      observation.unavailableFields.push(field);
    } else {
      // Geometry is in viewport CSS pixels, with one decimal of precision.
      observation.fields[field] = typeof value === "number"
        ? Math.round(value * 10) / 10
        : value as CaptureComparisonValue;
    }
  }
  return isCaptureObservation(observation) ? observation : null;
}
