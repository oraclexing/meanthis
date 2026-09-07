export const CAPTURE_COMPARISON_FIELDS = [
  "element.tagName", "element.role", "element.text", "element.accessibleName",
  "element.visible", "element.enabled",
  "element.bbox.x", "element.bbox.y", "element.bbox.width", "element.bbox.height",
  "style.display", "style.color", "style.backgroundColor", "style.fontSize",
  "style.fontWeight", "style.lineHeight", "style.margin", "style.padding",
  "style.gap", "style.borderRadius", "style.flexDirection", "style.justifyContent",
  "style.alignItems",
] as const;

export type CaptureComparisonField = typeof CAPTURE_COMPARISON_FIELDS[number];
export type CaptureComparisonValue = string | number | boolean | null;
export interface CaptureObservation {
  capturedAt: string;
  fields: Partial<Record<CaptureComparisonField, CaptureComparisonValue>>;
  unavailableFields: CaptureComparisonField[];
}
export interface CaptureComparison {
  baselineCapturedAt: string;
  observedAt: string;
  changes: { field: CaptureComparisonField; before: CaptureComparisonValue; after: CaptureComparisonValue }[];
  comparedFieldCount: number;
  unavailableFields: CaptureComparisonField[];
}

const MAX_TEXT_CHARACTERS = 2048;
const fieldSet = new Set<string>(CAPTURE_COMPARISON_FIELDS);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isCaptureObservation(value: unknown): value is CaptureObservation {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
    typeof value.capturedAt !== "string" || !isRecord(value.fields) ||
    !Array.isArray(value.unavailableFields)) return false;
  const timestamp = new Date(value.capturedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value.capturedAt) return false;
  const unavailable = new Set(value.unavailableFields);
  if (unavailable.size !== value.unavailableFields.length ||
    value.unavailableFields.some((field) => typeof field !== "string" || !fieldSet.has(field))) return false;
  if (Object.keys(value.fields).some((field) => !fieldSet.has(field) || unavailable.has(field))) return false;
  return CAPTURE_COMPARISON_FIELDS.every((field) => {
    if (unavailable.has(field)) return true;
    if (!Object.hasOwn(value.fields as object, field)) return false;
    const fact = (value.fields as Record<string, unknown>)[field];
    if (field === "element.visible" || field === "element.enabled") return typeof fact === "boolean";
    if (field.startsWith("element.bbox.")) {
      return typeof fact === "number" && Number.isFinite(fact) &&
        (!(field.endsWith("width") || field.endsWith("height")) || fact >= 0);
    }
    return fact === null || (typeof fact === "string" && fact.length <= MAX_TEXT_CHARACTERS);
  });
}

export function compareCaptureObservations(baseline: CaptureObservation, current: CaptureObservation): CaptureComparison {
  if (!isCaptureObservation(baseline) || !isCaptureObservation(current)) {
    throw new TypeError("Capture comparison observations were invalid.");
  }
  const result: CaptureComparison = {
    baselineCapturedAt: baseline.capturedAt,
    observedAt: current.capturedAt,
    changes: [],
    comparedFieldCount: 0,
    unavailableFields: [],
  };
  for (const field of CAPTURE_COMPARISON_FIELDS) {
    if (baseline.unavailableFields.includes(field) || current.unavailableFields.includes(field)) {
      result.unavailableFields.push(field);
      continue;
    }
    result.comparedFieldCount += 1;
    const before = baseline.fields[field]!;
    const after = current.fields[field]!;
    if (before !== after) result.changes.push({ field, before, after });
  }
  return result;
}
