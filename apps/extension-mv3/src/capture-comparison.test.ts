import { createCaptureObservation } from "./create-capture-observation";
// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from "vitest";
import { extractElementAttachment } from "@meanthis/web-extractor";
import {
  compareCaptureObservations,
  isCaptureObservation,
} from "./capture-comparison";

function capture(text = "Save") {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return extractElementAttachment(button, {
    disclosureMode: "agent_safe",
    locationHref: "https://example.test/settings",
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  });
}

describe("capture observations", () => {
  beforeEach(() => document.body.replaceChildren());

  test("compares captured facts without changing the stored baseline", () => {
    const original = capture();
    original.element.bbox = { x: 10, y: 20, width: 80, height: 32 };
    const frozen = structuredClone(original);
    const current = structuredClone(original);
    current.capturedAt = "2026-09-05T00:01:00.000Z";
    current.element.text = "Save changes";
    current.style.fontSize = "18px";
    original.style.fontSize = "14px";
    frozen.style.fontSize = "14px";
    current.element.bbox.x = 30;
    const result = compareCaptureObservations(createCaptureObservation(original)!, createCaptureObservation(current)!);
    expect(result.changes).toEqual(expect.arrayContaining([
      { field: "element.text", before: "Save", after: "Save changes" },
      { field: "style.fontSize", before: "14px", after: "18px" },
      { field: "element.bbox.x", before: 10, after: 30 },
    ]));
    expect(original).toEqual(frozen);
    expect(result.baselineCapturedAt).toBe(original.capturedAt);
    expect(result.observedAt).toBe(current.capturedAt);
  });

  test("marks missing, redacted, and bounded text unavailable instead of calling it unchanged", () => {
    const original = capture();
    original.element.text = "x".repeat(3000);
    original.element.accessibleName = "Private";
    original.policy.redactedFields.push("element.accessibleName");
    delete original.style.fontSize;
    const observation = createCaptureObservation(original)!;
    expect(observation.unavailableFields).toEqual(expect.arrayContaining([
      "element.text", "element.accessibleName", "style.fontSize",
    ]));
    expect(observation.fields).not.toHaveProperty("element.text");
    const result = compareCaptureObservations(observation, observation);
    expect(result.changes).toEqual([]);
    expect(result.unavailableFields).toContain("element.text");
    expect(JSON.stringify(observation)).not.toContain("Private");
  });

  test("rejects malformed observations and unknown payload fields", () => {
    const observation = createCaptureObservation(capture())!;
    expect(isCaptureObservation(observation)).toBe(true);
    expect(isCaptureObservation({ ...observation, unknown: true })).toBe(false);
    expect(isCaptureObservation({ ...observation, capturedAt: "yesterday" })).toBe(false);
    expect(isCaptureObservation({ ...observation, fields: { ...observation.fields, "element.bbox.width": -1 } })).toBe(false);
    expect(isCaptureObservation({ ...observation, fields: { ...observation.fields, "element.text": "x".repeat(3000) } })).toBe(false);
    expect(isCaptureObservation({ ...observation, fields: { ...observation.fields, unknown: "value" } })).toBe(false);
  });

  test("reports geometry at one decimal without treating fractional noise as a change", () => {
    const original = capture();
    original.element.bbox.x = 10.001;
    const current = structuredClone(original);
    current.element.bbox.x = 10.002;
    const result = compareCaptureObservations(createCaptureObservation(original)!, createCaptureObservation(current)!);
    expect(result.changes).toEqual([]);
  });
});
