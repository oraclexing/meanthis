import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createCaptureRecord,
  createSessionFile,
  reorderEveryKnownRecord,
} from "../test/session-fixtures";
import {
  createSessionExportFilename,
  deriveStoredSessionHandoff,
  deriveStoredSessionReview,
  EXTENSION_SESSION_MAX_BYTES,
  EXTENSION_SESSION_MAX_ITEMS,
  EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES,
  projectCaptureSessionFile,
  serializeCaptureSessionFile,
  toSessionFileSourceRecord,
} from "./session-file";

describe("extension capture session files", () => {
  test("matches the committed two-element extension session fixture bytes", () => {
    const fixtureText = readFileSync(
      new URL("../fixtures/two-element.capture-session.json", import.meta.url),
      "utf8",
    );
    const result = serializeCaptureSessionFile(createTwoElementExtensionSessionFile());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.file.session.title).toBeNull();
    expect(result.value.text).toBe(fixtureText);
    expect(result.value.byteLength).toBeLessThanOrEqual(EXTENSION_SESSION_MAX_BYTES);
  });

  test("removes derived record fields and preserves source disclosure", () => {
    const record = createCaptureRecord("save", "Save changes", "full_debug");
    const source = toSessionFileSourceRecord(record);

    expect(source).not.toHaveProperty("markdown");
    expect(source).not.toHaveProperty("summary");
    expect(source.attachment.policy.disclosureMode).toBe("full_debug");
    expect(source.intent).toBe(record.intent);
  });

  test("derives a bounded Agent-safe saved review from sensitive full-debug source", () => {
    const billing = createCaptureRecord("save", "Save changes", "full_debug");
    billing.intent = "Keep billing save primary.";
    billing.pageUrl = "https://app.example.test/settings?token=billing-secret#billing";
    billing.attachment.context.parentSummary = "section Billing for ada@example.com";
    billing.attachment.context.nearbyText = ["Signed in as ada@example.com"];
    const profile = createCaptureRecord("cancel", "Profile for bob@example.com", "full_debug");
    profile.intent = "Keep profile save secondary.";
    profile.attachment.context.parentSummary = "section Profile for bob@example.com";
    profile.attachment.context.selectorHints = ["token=sk-test-profile-secret"];
    const file = createSessionFile([billing, profile]);

    const review = deriveStoredSessionReview(file, file.session.origin, "epoch-1");

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value).toMatchObject({
      origin: "https://app.example.test",
      epoch: "epoch-1",
      routes: [{
        origin: "https://app.example.test",
        pathname: "/settings",
        frameKind: "top",
        targetCount: 2,
      }],
      items: [
        {
          label: "A",
          target: "button - Save changes",
          intent: "Keep billing save primary.",
          sourceDisclosureMode: "full_debug",
        },
        {
          label: "B",
          intent: "Keep profile save secondary.",
          sourceDisclosureMode: "full_debug",
        },
      ],
    });
    expect(Object.keys(review.value.items[0]).sort()).toEqual([
      "capturedAt",
      "intent",
      "label",
      "sourceDisclosureMode",
      "target",
    ]);
    const serialized = JSON.stringify(review.value);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("bob@example.com");
    expect(serialized).not.toContain("billing-secret");
    expect(serialized).not.toContain("sk-test-profile-secret");
    expect(serialized).not.toContain("att_save");
    expect(serialized).not.toContain("pageUrl");
    expect(serialized).not.toContain("tabId");
  });

  test("keeps top-level and embedded saved routes distinct without query or fragment data", () => {
    const top = createCaptureRecord("save", "Save changes", "agent_safe");
    top.pageUrl = "https://app.example.test/settings?mode=compact#billing";
    top.attachment.source.url = top.pageUrl;
    top.frameId = 0;
    const embedded = createCaptureRecord("cancel", "Cancel", "agent_safe");
    embedded.pageUrl = "https://app.example.test/settings?mode=embedded#actions";
    embedded.attachment.source.url = embedded.pageUrl;
    embedded.frameId = 4;
    const file = createSessionFile([top, embedded]);

    const review = deriveStoredSessionReview(file, file.session.origin, "epoch-1");

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.routes).toEqual([
      {
        origin: "https://app.example.test",
        pathname: "/settings",
        frameKind: "top",
        targetCount: 1,
      },
      {
        origin: "https://app.example.test",
        pathname: "/settings",
        frameKind: "embedded",
        targetCount: 1,
      },
    ]);
    expect(JSON.stringify(review.value.routes)).not.toContain("mode=");
    expect(JSON.stringify(review.value.routes)).not.toContain("#");
  });

  test("retains the canonical top page and nested frame route chain for saved review", () => {
    const embedded = createCaptureRecord("save", "Save changes", "agent_safe");
    embedded.origin = "https://app-companion.example.test";
    embedded.pageUrl = "https://app-companion.example.test/docs/reference?token=secret#method";
    embedded.attachment.source.url = embedded.pageUrl;
    embedded.attachment.policy.allowedDomains = [embedded.origin];
    embedded.frameId = 11;
    embedded.routeChain = [
      { origin: "https://docs.example.test", pathname: "/mcp/reference" },
      { origin: "https://shell.example.test", pathname: "/embedded" },
      { origin: embedded.origin, pathname: "/docs/reference" },
    ];
    const file = createSessionFile([embedded]);
    file.session.origin = embedded.origin;

    const review = deriveStoredSessionReview(file, embedded.origin, "epoch-1");

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.routes).toEqual([{
      origin: embedded.origin,
      pathname: "/docs/reference",
      frameKind: "embedded",
      targetCount: 1,
      topPage: { origin: "https://docs.example.test", pathname: "/mcp/reference" },
      frameChain: embedded.routeChain,
    }]);
    expect(JSON.stringify(review.value.routes)).not.toContain("token=secret");
    expect(JSON.stringify(review.value.routes)).not.toContain("#method");
  });

  test("sanitizes credential-bearing routes and omits redacted routes from review", () => {
    const credentialed = createCaptureRecord("save", "Save changes", "agent_safe");
    credentialed.pageUrl = "https://alice:route-secret@app.example.test/settings";
    credentialed.attachment.source.url = credentialed.pageUrl;
    const redacted = createCaptureRecord("cancel", "Cancel", "agent_safe");
    redacted.pageUrl = "https://app.example.test/%5Bredacted%3Apathname%5D";
    redacted.attachment.source.url = redacted.pageUrl;
    const file = createSessionFile([credentialed, redacted]);

    const review = deriveStoredSessionReview(file, file.session.origin, "epoch-1");

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.routes).toEqual([{
      origin: "https://app.example.test",
      pathname: "/settings",
      frameKind: "top",
      targetCount: 1,
    }]);
    expect(JSON.stringify(review.value)).not.toContain("route-secret");
    expect(JSON.stringify(review.value)).not.toContain("redacted%3Apathname");
  });

  test("rejects a saved review when the requested origin identity does not match", () => {
    const file = createSessionFile([createCaptureRecord("save", "Save changes")]);

    expect(deriveStoredSessionReview(file, "https://other.example.test", "epoch-1"))
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
  });

  test("derives a bounded saved-snapshot handoff with no live routing fields", () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    save.intent = "Keep Save changes primary.";
    save.pageUrl = "https://app.example.test/settings?token=stored-secret#private";
    save.tabId = 77;
    save.frameId = 4;
    save.routeChain = [
      { origin: "https://docs.example.test", pathname: "/host" },
      { origin: save.origin, pathname: "/settings" },
    ];
    save.attachment.context.nearbyText = ["ada@example.com", "token=stored-secret"];
    const cancel = createCaptureRecord("cancel", "Cancel", "agent_safe");
    cancel.intent = "Use a quieter style.";
    cancel.tabId = 77;
    cancel.frameId = 4;
    const file = createSessionFile([save, cancel]);
    const sourceBefore = structuredClone(file);

    const handoff = deriveStoredSessionHandoff(file, file.session.origin, "epoch-1");

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.value).toMatchObject({
      origin: file.session.origin,
      epoch: "epoch-1",
      format: "compact",
      bundle: {
        kind: "ui-attach.saved-snapshot-prompt-bundle",
        disclosureMode: "agent_safe",
        attachmentCount: 2,
        attachmentIds: ["att_save", "att_cancel"],
        authority: {
          status: "not_rechecked",
          routingPolicy: "omitted",
          evidencePolicy: "capture_time_observations_only",
          controlPolicy: "live_recheck_and_user_confirmation_required",
        },
      },
    });
    expect(Object.keys(handoff.value).sort()).toEqual([
      "bundle",
      "epoch",
      "format",
      "origin",
    ]);
    expect(Object.keys(handoff.value.bundle).sort()).toEqual([
      "attachmentCount",
      "attachmentIds",
      "attachmentRefs",
      "authority",
      "disclosureMode",
      "kind",
      "markdown",
      "sessionId",
      "title",
    ]);
    expect(handoff.value.bundle.markdown).toContain("Keep Save changes primary.");
    expect(handoff.value.bundle.markdown).toContain("Use a quieter style.");
    expect(handoff.value.bundle.markdown).toContain("page.getByRole");
    expect(handoff.value.bundle.markdown).toContain("not_rechecked");
    expect(handoff.value.bundle.markdown).not.toContain("stored-secret");
    expect(handoff.value.bundle.markdown).not.toContain("ada@example.com");
    expect(JSON.stringify(handoff.value.bundle)).not.toContain("pageInstanceId");
    expect(JSON.stringify(handoff.value.bundle)).not.toContain("tabId");
    expect(JSON.stringify(handoff.value.bundle)).not.toContain("frameId");
    expect(JSON.stringify(handoff.value.bundle)).not.toContain("docs.example.test");
    expect(file).toEqual(sourceBefore);
  });

  test("rejects empty or mismatched saved-snapshot handoffs", () => {
    const empty = createSessionFile([]);
    const populated = createSessionFile([createCaptureRecord("save", "Save changes")]);

    expect(deriveStoredSessionHandoff(empty, empty.session.origin, "epoch-1"))
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(deriveStoredSessionHandoff(populated, "https://other.example.test", "epoch-1"))
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
  });

  test("fails closed when a structured saved handoff exceeds the consumer markdown bound", () => {
    const oversized = createCaptureRecord("save", "Save changes");
    oversized.intent = "x".repeat(EXTENSION_SAVED_SNAPSHOT_MAX_MARKDOWN_BYTES + 1);
    const file = createSessionFile([oversized]);

    expect(deriveStoredSessionHandoff(file, file.session.origin, "epoch-1"))
      .toMatchObject({ ok: false, code: "SESSION_TOO_LARGE" });
  });

  test("preserves an opaque source anchor through canonical extension export", () => {
    const record = createCaptureRecord("save", "Save changes", "agent_safe");
    record.attachment.sourceAnchor = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.opaque-source-anchor",
      buildId: "A".repeat(43),
      sourceId: "B".repeat(43),
    };

    const projected = toSessionFileSourceRecord(record);
    const serialized = serializeCaptureSessionFile(createSessionFile([record]));

    expect(projected.attachment.sourceAnchor).toEqual(record.attachment.sourceAnchor);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(
      serialized.value.file.session.attachments[0].sourceRecord.attachment.sourceAnchor,
    ).toEqual(record.attachment.sourceAnchor);
  });

  test("preserves an embedded-frame boundary through canonical extension export", () => {
    const record = createCaptureRecord("save", "Documentation", "agent_safe");
    record.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      dominantViewport: true,
    };

    const projected = toSessionFileSourceRecord(record);
    const serialized = serializeCaptureSessionFile(createSessionFile([record]));

    expect(projected.attachment.boundary).toEqual(record.attachment.boundary);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(
      serialized.value.file.session.attachments[0].sourceRecord.attachment.boundary,
    ).toEqual(record.attachment.boundary);
  });

  test("produces byte-identical text from differently ordered objects", () => {
    const first = createSessionFile();
    const second = reorderEveryKnownRecord(first);

    const left = serializeCaptureSessionFile(first);
    const right = serializeCaptureSessionFile(second);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.text).toBe(right.value.text);
    expect(left.value.text).toBe(`${JSON.stringify(left.value.file, null, 2)}\n`);
  });

  test("sorts untyped replay attempt object keys without changing values", () => {
    const file = createSessionFile();
    file.session.attachments[0].sourceRecord.replayAttempts = [
      {
        z: "last",
        nested: { b: 2, a: 1 },
        list: [{ d: 4, c: 3 }, "keep", ["z", "a"]],
        a: "first",
      },
    ];

    const result = serializeCaptureSessionFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.file.session.attachments[0].sourceRecord.replayAttempts).toEqual([
      {
        a: "first",
        list: [{ c: 3, d: 4 }, "keep", ["z", "a"]],
        nested: { a: 1, b: 2 },
        z: "last",
      },
    ]);
  });

  test("returns safe validation issues without echoing rejected values", () => {
    const file = createSessionFile();
    file.session.id = "session-sk-test-1234567890";

    const result = serializeCaptureSessionFile(file);

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is invalid.",
      issues: [
        {
          path: "session.id",
          message: "Expected a session id in the form session-<positive integer>.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-1234567890");
  });

  test("sanitizes duplicate attachment id validation issue messages", () => {
    const file = createSessionFile();
    const secret = "sk-test-1234567890";
    file.session.attachments[0].id = secret;
    file.session.attachments[0].sourceRecord.attachment.id = secret;
    file.session.attachments[1].id = secret;
    file.session.attachments[1].sourceRecord.attachment.id = secret;

    const result = serializeCaptureSessionFile(file);

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is invalid.",
      issues: [
        {
          path: "session.attachments[1].id",
          message: "Duplicate attachment id.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("normalizes duplicate label validation issue messages", () => {
    const file = createSessionFile();
    file.session.attachments[1].labels = ["A"];

    const result = serializeCaptureSessionFile(file);

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Stored capture session is invalid.",
      issues: [
        {
          path: "session.attachments[1].labels[0]",
          message: "Duplicate label.",
        },
      ],
    });
  });

  test("reports the exact UTF-8 byte count and includes a trailing newline", () => {
    const file = createSessionFile([
      createCaptureRecord("save", "Save \u2713", "full_debug"),
    ]);

    const result = serializeCaptureSessionFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text.endsWith("\n")).toBe(true);
    expect(result.value.byteLength).toBe(new TextEncoder().encode(result.value.text).byteLength);
    expect(result.value.byteLength).toBeGreaterThan(result.value.text.length);
  });

  test("rejects a capture session at 1,048,577 bytes", () => {
    const file = createSessionFile();
    file.session.attachments[0].sourceRecord.intent = "";
    const baseline = serializeCaptureSessionFile(file);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    file.session.attachments[0].sourceRecord.intent = "x".repeat(
      EXTENSION_SESSION_MAX_BYTES + 1 - baseline.value.byteLength,
    );
    const projected = projectCaptureSessionFile(file);
    const text = `${JSON.stringify(projected, null, 2)}\n`;
    expect(new TextEncoder().encode(text).byteLength).toBe(1_048_577);

    expect(serializeCaptureSessionFile(file)).toEqual({
      ok: false,
      code: "SESSION_TOO_LARGE",
      error: "Capture session exceeds the 1 MiB export limit.",
    });
  });

  test("accepts a capture session at exactly 1,048,576 bytes", () => {
    const file = createSessionFile();
    file.session.attachments[0].sourceRecord.intent = "";
    const baseline = serializeCaptureSessionFile(file);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    file.session.attachments[0].sourceRecord.intent = "x".repeat(
      EXTENSION_SESSION_MAX_BYTES - baseline.value.byteLength,
    );
    const projected = projectCaptureSessionFile(file);
    const text = `${JSON.stringify(projected, null, 2)}\n`;
    expect(new TextEncoder().encode(text).byteLength).toBe(1_048_576);

    const result = serializeCaptureSessionFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.byteLength).toBe(1_048_576);
  });

  test("keeps cyclic and accessor-backed session values invalid without invoking getters", () => {
    const cyclicFile = createSessionFile();
    const cyclicAttempt: Record<string, unknown> = {};
    cyclicAttempt.self = cyclicAttempt;
    cyclicFile.session.attachments[0].sourceRecord.replayAttempts = [cyclicAttempt];

    const accessorFile = createSessionFile();
    const accessorAttempt: Record<string, unknown> = {};
    let getterInvoked = false;
    Object.defineProperty(accessorAttempt, "secret", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "sk-test-accessor-secret";
      },
    });
    accessorFile.session.attachments[0].sourceRecord.replayAttempts = [accessorAttempt];

    expect(serializeCaptureSessionFile(cyclicFile))
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(serializeCaptureSessionFile(accessorFile))
      .toMatchObject({ ok: false, code: "INVALID_SESSION_FILE" });
    expect(getterInvoked).toBe(false);
  });

  test("exports the exact session limits", () => {
    expect(EXTENSION_SESSION_MAX_ITEMS).toBe(26);
    expect(EXTENSION_SESSION_MAX_BYTES).toBe(1_048_576);
  });

  test.each([
    ["port", "https://Example.COM:8443", "example.com-8443"],
    ["IPv6", "https://[2001:db8::1]:8443", "2001-db8-1-8443"],
    ["Unicode", "https://münich.example", "xn-mnich-kva.example"],
    ["empty", "file:///", "origin"],
  ])("creates a safe host slug for a %s host", (_kind, origin, slug) => {
    expect(createSessionExportFilename(origin, new Date("2026-07-11T12:34:56.789Z"))).toBe(
      `meanthis-${slug}-20260711-123456-789.capture-session.json`,
    );
  });

  test("truncates the host slug to 80 characters", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.example`;
    const expectedSlug = new URL(`https://${host}`).host.toLowerCase().slice(0, 80);

    const filename = createSessionExportFilename(
      `https://${host}`,
      new Date("2026-07-11T12:34:56.789Z"),
    );

    expect(expectedSlug).toHaveLength(80);
    expect(filename).toBe(
      `meanthis-${expectedSlug}-20260711-123456-789.capture-session.json`,
    );
  });

  test("formats the filename timestamp in UTC with milliseconds", () => {
    expect(
      createSessionExportFilename(
        "https://app.example.test",
        new Date("2026-07-11T20:34:56.007+08:00"),
      ),
    ).toBe("meanthis-app.example.test-20260711-123456-007.capture-session.json");
  });
});

function createTwoElementExtensionSessionFile() {
  const save = createCaptureRecord("save", "Save changes", "agent_safe");
  save.intent = "Keep A as the primary confirmation action.";
  save.replayAttempts = [
    {
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Save changes" })',
      count: 1,
      visible: true,
    },
  ];

  const cancel = createCaptureRecord("cancel", "Cancel", "full_debug");
  cancel.pageUrl = "https://app.example.test/settings?token=secret#billing";
  cancel.intent = "Keep B as the secondary cancellation action.";
  cancel.attachment.source = {
    ...cancel.attachment.source,
    url: cancel.pageUrl,
  };
  cancel.attachment.context = {
    ...cancel.attachment.context,
    nearbyText: ["Signed in as ada@example.com"],
    selectorHints: ["token=sk-test-1234567890"],
  };
  cancel.attachment.locatorBundle = {
    ...cancel.attachment.locatorBundle,
    candidates: [
      {
        strategy: "css",
        value: '[data-testid="cancel"]',
        confidence: 0.8,
      },
    ],
    stability: {
      ...cancel.attachment.locatorBundle.stability,
      verifiedValue: 'page.getByRole("button", { name: "Cancel" })',
    },
  };
  cancel.attachment.policy = {
    ...cancel.attachment.policy,
    includedSensitiveFields: [
      "source.url",
      "context.nearbyText",
      "context.selectorHints",
    ],
  };
  cancel.replayAttempts = [
    {
      z: "preserved last after sort",
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Cancel" })',
      nested: { token: "sk-test-1234567890", email: "ada@example.com" },
    },
  ];

  const file = createSessionFile([save, cancel]);
  file.session.title = null;
  return file;
}
