import { describe, expect, it } from "vitest";
import {
  METADATA_DIAGNOSTICS_MAX_BYTES,
  PRIVATE_DEBUG_SUMMARY_MAX_BYTES,
  UI_ATTACH_METADATA_DIAGNOSTICS_KIND,
  UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION,
  UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND,
  UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION,
  isMetadataDiagnosticsV1,
  isPrivateDebugSummaryV1,
  parseMetadataDiagnosticsV1,
  parsePrivateDebugSummaryV1,
  projectPrivateDebugSummaryV1,
  serializeMetadataDiagnosticsV1,
  serializePrivateDebugSummaryV1,
  validateMetadataDiagnosticsV1,
  validatePrivateDebugSummaryV1,
  type MetadataDiagnosticsV1,
  type PrivateDebugSummaryV1,
} from "./metadata-diagnostics";

const authority = {
  grantedByCapture: false,
  browserControl: false,
  liveDomMutation: false,
} as const;

const validNotRequested = {
  schemaVersion: UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION,
  kind: UI_ATTACH_METADATA_DIAGNOSTICS_KIND,
  captureId: "capture-opaque-1",
  scope: "capture",
  observedAt: "2026-08-30T00:00:00.000Z",
  consent: "explicit_capture",
  authority: "capture_time",
  replay: { status: "not_requested" },
  device: { status: "not_requested" },
  network: { status: "not_requested" },
  console: { status: "not_requested" },
  executionAuthority: authority,
} satisfies MetadataDiagnosticsV1;

const validCollected = {
  ...validNotRequested,
  authority: "live_page",
  replay: {
    status: "collected",
    attemptCount: 2,
    verifiedCount: 1,
    ambiguousCount: 0,
    missingCount: 1,
  },
  device: {
    status: "collected",
    deviceClass: "desktop",
    viewportClass: "large",
    touch: "none",
  },
  network: {
    status: "collected",
    requestCount: 3,
    failureCount: 1,
    windowMs: 120,
  },
  console: {
    status: "collected",
    logCount: 4,
    warnCount: 1,
    errorCount: 0,
    windowMs: 120,
  },
} satisfies MetadataDiagnosticsV1;

function assertFailure(value: unknown): void {
  const result = validateMetadataDiagnosticsV1(value);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.issues.length).toBeLessThanOrEqual(32);
  expect(JSON.stringify(result)).not.toContain("secret");
}

describe("MetadataDiagnosticsV1", () => {
  it("exports the exact V1 identity and accepts a status-only sidecar", () => {
    expect(UI_ATTACH_METADATA_DIAGNOSTICS_SCHEMA_VERSION).toBe("0.1.0");
    expect(UI_ATTACH_METADATA_DIAGNOSTICS_KIND).toBe("ui-attach.metadata-only-diagnostics");
    expect(validateMetadataDiagnosticsV1(validNotRequested)).toEqual({
      ok: true,
      value: validNotRequested,
    });
    expect(isMetadataDiagnosticsV1(validNotRequested)).toBe(true);
  });

  it("accepts zero-valued collected metrics and every bounded enum", () => {
    const zero: MetadataDiagnosticsV1 = {
      ...validNotRequested,
      replay: {
        status: "collected",
        attemptCount: 0,
        verifiedCount: 0,
        ambiguousCount: 0,
        missingCount: 0,
      },
      device: {
        status: "collected",
        deviceClass: "mobile",
        viewportClass: "small",
        touch: "unknown",
      },
      network: {
        status: "collected",
        requestCount: 0,
        failureCount: 0,
        windowMs: 0,
      },
      console: {
        status: "collected",
        logCount: 0,
        warnCount: 0,
        errorCount: 0,
        windowMs: 0,
      },
    };
    expect(isMetadataDiagnosticsV1(zero)).toBe(true);
  });

  it("accepts collected replay, device, network, and console records", () => {
    expect(isMetadataDiagnosticsV1(validCollected)).toBe(true);
  });

  it.each([
    ["missing whole sidecar", undefined],
    ["null whole sidecar", null],
    ["primitive whole sidecar", "not-a-sidecar"],
    ["missing top-level field", { ...validNotRequested, observedAt: undefined }],
    ["own undefined status", {
      ...validNotRequested,
      replay: { status: undefined },
    }],
    ["null record", { ...validNotRequested, device: null }],
    ["wrong enum", { ...validNotRequested, authority: "browser" }],
    ["wrong time", { ...validNotRequested, observedAt: "2026-08-30T00:00:00+00:00" }],
    ["extended year", { ...validNotRequested, observedAt: "12026-08-30T00:00:00.000Z" }],
  ])("rejects %s", (_name, candidate) => {
    assertFailure(candidate);
  });

  it("rejects unknown fields and metrics on non-collected records", () => {
    assertFailure({ ...validNotRequested, extra: 1 });
    assertFailure({
      ...validNotRequested,
      replay: { status: "not_available", attemptCount: 0 },
    });
    assertFailure({
      ...validNotRequested,
      network: { status: "malformed", requestCount: 0 },
    });
    assertFailure({
      ...validNotRequested,
      console: { status: "overbound", errorCount: 0 },
    });
  });

  it("rejects invalid numeric values and never clamps overbound metrics", () => {
    const cases = [
      { ...validCollected, replay: { ...validCollected.replay, attemptCount: 65 } },
      { ...validCollected, replay: { ...validCollected.replay, verifiedCount: -1 } },
      { ...validCollected, replay: { ...validCollected.replay, ambiguousCount: 1.5 } },
      { ...validCollected, replay: { ...validCollected.replay, missingCount: Number.NaN } },
      {
        ...validCollected,
        replay: {
          status: "collected",
          attemptCount: 1,
          verifiedCount: 1,
          ambiguousCount: 1,
          missingCount: 1,
        },
      },
      {
        ...validCollected,
        replay: {
          status: "collected",
          attemptCount: 1,
          verifiedCount: 2,
          ambiguousCount: 0,
          missingCount: 0,
        },
      },
      { ...validCollected, network: { ...validCollected.network, requestCount: 1025 } },
      { ...validCollected, network: { ...validCollected.network, failureCount: -1 } },
      { ...validCollected, network: { ...validCollected.network, windowMs: 600001 } },
      { ...validCollected, console: { ...validCollected.console, logCount: 1025 } },
      { ...validCollected, console: { ...validCollected.console, warnCount: 1.25 } },
      { ...validCollected, console: { ...validCollected.console, errorCount: Infinity } },
      { ...validCollected, console: { ...validCollected.console, windowMs: -1 } },
    ];
    for (const candidate of cases) assertFailure(candidate);
    expect((cases[0].replay as { attemptCount: number }).attemptCount).toBe(65);
  });

  it("rejects forbidden keys recursively with case-insensitive canonical treatment", () => {
    const nested = {
      status: "collected",
      requestCount: 1,
      failureCount: 0,
      windowMs: 1,
      nested: { User_Agent: "secret" },
    };
    const result = validateMetadataDiagnosticsV1({ ...validNotRequested, network: nested });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === "forbidden_field")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("User_Agent");
      expect(JSON.stringify(result)).not.toContain("secret");
    }

    for (const key of ["text", "STACK", "url", "query", "Headers", "body", "cookies", "har", "screenshot", "user-Agent", "path", "local_path"]) {
      assertFailure({
        ...validNotRequested,
        network: {
          status: "not_available",
          [key]: "secret",
        },
      });
    }
  });

  it("rejects arbitrary strings outside opaque ids, canonical time, and enums", () => {
    assertFailure({ ...validCollected, replay: { ...validCollected.replay, attemptCount: "1" } });
    assertFailure({ ...validCollected, network: { ...validCollected.network, requestCount: "3" } });
    assertFailure({ ...validCollected, executionAuthority: { ...authority, browserControl: "false" } });
    assertFailure({ ...validNotRequested, captureId: "非 ASCII" });
    assertFailure({ ...validNotRequested, captureId: "capture id" });
  });

  it("rejects accessors, non-enumerable fields, and non-plain records without invoking getters", () => {
    let getterCalls = 0;
    const withGetter = { ...validNotRequested } as Record<string, unknown>;
    Object.defineProperty(withGetter, "captureId", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "secret";
      },
    });
    assertFailure(withGetter);
    expect(getterCalls).toBe(0);

    const withNonEnumerable = { ...validNotRequested } as Record<string, unknown>;
    Object.defineProperty(withNonEnumerable, "captureId", {
      enumerable: false,
      configurable: true,
      value: "capture-opaque-1",
    });
    assertFailure(withNonEnumerable);

    assertFailure(new Date());
    assertFailure(new Map());
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(customPrototype, validNotRequested);
    assertFailure(customPrototype);
  });

  it("serializes a detached descriptor snapshot without invoking Proxy gets or leaking values", () => {
    const target = { ...validCollected };
    let getTrapCalls = 0;
    const hostile = new Proxy(target, {
      get(_target, key) {
        getTrapCalls += 1;
        if (key === "captureId") return "Mozilla/5.0 C:\\fixture-private\\secret";
        return "C:\\fixture-private\\secret";
      },
    });

    const validated = validateMetadataDiagnosticsV1(hostile);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value === hostile).toBe(false);
    expect(validated.value).not.toBe(target);
    expect(validated.value.captureId).toBe("capture-opaque-1");

    // The detached validation result remains stable even if the source object
    // changes before it is serialized.
    target.captureId = "capture-opaque-2";
    const fromFrozenSnapshot = serializeMetadataDiagnosticsV1(validated.value);
    expect(fromFrozenSnapshot.ok).toBe(true);
    if (!fromFrozenSnapshot.ok) return;
    expect(fromFrozenSnapshot.value).toContain('"captureId":"capture-opaque-1"');
    expect(fromFrozenSnapshot.value).not.toContain("Mozilla/5.0");
    expect(fromFrozenSnapshot.value).not.toContain("C:\\fixture-private\\secret");

    // Serializing the hostile source itself must use descriptor values and
    // produce the same safe bytes; the Proxy get trap is never entered.
    const direct = serializeMetadataDiagnosticsV1(hostile);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value).toContain('"captureId":"capture-opaque-2"');
    expect(direct.value).not.toContain("Mozilla/5.0");
    expect(direct.value).not.toContain("C:\\fixture-private\\secret");
    expect(getTrapCalls).toBe(0);
    expect(parseMetadataDiagnosticsV1(direct.value)).toMatchObject({ ok: true });
  });

  it("serializes and parses exact canonical V1 bytes", () => {
    const serialized = serializeMetadataDiagnosticsV1(validCollected);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const expected = JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId: "capture-opaque-1",
      scope: "capture",
      observedAt: "2026-08-30T00:00:00.000Z",
      consent: "explicit_capture",
      authority: "live_page",
      replay: {
        status: "collected",
        attemptCount: 2,
        verifiedCount: 1,
        ambiguousCount: 0,
        missingCount: 1,
      },
      device: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "none",
      },
      network: {
        status: "collected",
        requestCount: 3,
        failureCount: 1,
        windowMs: 120,
      },
      console: {
        status: "collected",
        logCount: 4,
        warnCount: 1,
        errorCount: 0,
        windowMs: 120,
      },
      executionAuthority: authority,
    });
    expect(serialized.value).toBe(expected);
    expect(new TextEncoder().encode(serialized.value).byteLength).toBeLessThanOrEqual(
      METADATA_DIAGNOSTICS_MAX_BYTES,
    );
    expect(parseMetadataDiagnosticsV1(serialized.value)).toEqual({
      ok: true,
      value: JSON.parse(expected),
    });
    expect(parseMetadataDiagnosticsV1(` ${serialized.value}`)).toMatchObject({
      ok: false,
    });
    expect(parseMetadataDiagnosticsV1(serialized.value.replace('"captureId":"capture-opaque-1"', '"captureId":"capture\\u002Dopaque-1"'))).toMatchObject({
      ok: false,
    });
  });

  it("returns bounded generic failures for malformed JSON and oversized UTF-8 input", () => {
    expect(parseMetadataDiagnosticsV1("{")).toEqual({
      ok: false,
      issues: [{ code: "invalid_json", path: "$" }],
    });
    const oversized = "x".repeat(METADATA_DIAGNOSTICS_MAX_BYTES + 1);
    const result = parseMetadataDiagnosticsV1(oversized);
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "overbound", path: "$" }],
    });
    const serialized = serializeMetadataDiagnosticsV1({ ...validNotRequested, extra: oversized });
    expect(serialized.ok).toBe(false);
    if (!serialized.ok) expect(JSON.stringify(serialized)).not.toContain(oversized);
  });
});

describe("PrivateDebugSummaryV1", () => {
  const validSummary = {
    schemaVersion: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_SCHEMA_VERSION,
    kind: UI_ATTACH_PRIVATE_DEBUG_SUMMARY_KIND,
    scope: "one_capture",
    consent: "explicit_one_shot",
    replay: {
      status: "collected",
      attemptCount: 2,
      verifiedCount: 1,
      ambiguousCount: 0,
      missingCount: 1,
    },
    device: {
      status: "collected",
      deviceClass: "desktop",
      viewportClass: "large",
      touch: "none",
    },
    executionAuthority: authority,
  } satisfies PrivateDebugSummaryV1;

  it("projects only bounded troubleshooting facts from explicit capture diagnostics", () => {
    const source: MetadataDiagnosticsV1 = {
      ...validNotRequested,
      authority: "capture_time",
      replay: validSummary.replay,
      device: validSummary.device,
    };

    expect(projectPrivateDebugSummaryV1(source)).toEqual({
      ok: true,
      value: validSummary,
    });
    expect(isPrivateDebugSummaryV1(validSummary)).toBe(true);

    const serialized = serializePrivateDebugSummaryV1(validSummary);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(new TextEncoder().encode(serialized.value).byteLength)
      .toBeLessThanOrEqual(PRIVATE_DEBUG_SUMMARY_MAX_BYTES);
    expect(parsePrivateDebugSummaryV1(serialized.value)).toEqual({
      ok: true,
      value: validSummary,
    });
    for (const forbidden of [
      "capture-opaque-1",
      "2026-08-30",
      "network",
      "console",
      "url",
      "userAgent",
    ]) {
      expect(serialized.value).not.toContain(forbidden);
    }
  });

  it("rejects non-capture authority and collected network or console input", () => {
    for (const candidate of [
      { ...validNotRequested, authority: "live_page" },
      { ...validNotRequested, authority: "not_rechecked" },
      {
        ...validNotRequested,
        network: { status: "collected", requestCount: 0, failureCount: 0, windowMs: 0 },
      },
      {
        ...validNotRequested,
        console: { status: "collected", logCount: 0, warnCount: 0, errorCount: 0, windowMs: 0 },
      },
    ]) {
      expect(projectPrivateDebugSummaryV1(candidate)).toMatchObject({ ok: false });
    }
  });

  it("rejects identifying, content-bearing, unknown, undefined, and accessor fields", () => {
    for (const candidate of [
      { ...validSummary, captureId: "capture-opaque-1" },
      { ...validSummary, observedAt: "2026-08-30T00:00:00.000Z" },
      { ...validSummary, origin: "https://secret.example.test" },
      { ...validSummary, userAgent: "Mozilla/5.0 secret" },
      { ...validSummary, locator: "#secret" },
      { ...validSummary, network: { status: "not_requested" } },
      { ...validSummary, console: { status: "not_requested" } },
      { ...validSummary, replay: { ...validSummary.replay, status: undefined } },
      { ...validSummary, executionAuthority: { ...authority, browserControl: true } },
    ]) {
      expect(validatePrivateDebugSummaryV1(candidate)).toMatchObject({ ok: false });
    }

    let getterCalls = 0;
    const accessor = { ...validSummary } as Record<string, unknown>;
    Object.defineProperty(accessor, "device", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return validSummary.device;
      },
    });
    expect(validatePrivateDebugSummaryV1(accessor)).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);
  });

  it("accepts status-only replay and device records but not non-canonical JSON", () => {
    const unavailable: PrivateDebugSummaryV1 = {
      ...validSummary,
      replay: { status: "not_available" },
      device: { status: "not_available" },
    };
    expect(validatePrivateDebugSummaryV1(unavailable)).toEqual({ ok: true, value: unavailable });
    const serialized = serializePrivateDebugSummaryV1(unavailable);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parsePrivateDebugSummaryV1(` ${serialized.value}`)).toMatchObject({ ok: false });
  });
});
