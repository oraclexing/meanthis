import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { evaluateAcceptedSavedSnapshotWithTrustedHost } from "./index.mjs";

const CONTROL_ATTEMPT_ID = "attempt_0123456789abcdef";
const RECHECK_RECEIPT_ID = "receipt_0123456789abcdef";

describe("saved snapshot trusted-host example", () => {
  test("derives one policy request from the accepted bundle and injected host adapters", async () => {
    const acceptedBundle = validAcceptedBundle();
    const before = structuredClone(acceptedBundle);
    const events = [];
    const clockValues = [
      "2026-07-24T00:00:05.000Z",
      "2026-07-24T00:00:20.000Z",
      "2026-07-24T00:00:21.000Z",
    ];

    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle,
      createControlAttemptId() {
        events.push("control-attempt");
        return CONTROL_ATTEMPT_ID;
      },
      async issueLiveRecheck(request) {
        events.push("live-recheck");
        expect(Object.keys(request).sort()).toEqual([
          "controlAttemptId",
          "savedSnapshot",
        ]);
        expect(request).not.toHaveProperty("action");
        expect(request.savedSnapshot.attachmentIds).toEqual(["att_save", "att_cancel"]);
        expect(request.savedSnapshot.authority).toEqual(acceptedBundle.authority);
        expect(request.savedSnapshot).not.toHaveProperty("routingHints");
        return validLiveRecheck();
      },
      async issueUserConfirmation(request) {
        events.push("user-confirmation");
        expect(Object.keys(request).sort()).toEqual([
          "attachmentIds",
          "controlAttemptId",
          "liveRecheckReceiptId",
          "origin",
        ]);
        expect(request).not.toHaveProperty("action");
        expect(request.attachmentIds).toEqual(acceptedBundle.attachmentIds);
        return validUserConfirmation();
      },
      nowIso() {
        events.push("clock");
        return clockValues.shift();
      },
    });

    expect(decision).toEqual({
      allowed: true,
      code: "requirements_satisfied",
      liveRecheckReceiptId: RECHECK_RECEIPT_ID,
    });
    expect(events).toEqual([
      "control-attempt",
      "clock",
      "live-recheck",
      "clock",
      "user-confirmation",
      "clock",
    ]);
    expect(acceptedBundle).toEqual(before);
  });

  test("never requests confirmation when the live recheck is not structurally usable", async () => {
    const events = [];
    const liveRecheck = validLiveRecheck();
    liveRecheck.targets[1].status = "ambiguous";

    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId() {
        events.push("control-attempt");
        return CONTROL_ATTEMPT_ID;
      },
      async issueLiveRecheck() {
        events.push("live-recheck");
        return liveRecheck;
      },
      async issueUserConfirmation() {
        events.push("user-confirmation");
        return validUserConfirmation();
      },
      nowIso() {
        events.push("clock");
        return events.filter((event) => event === "clock").length === 1
          ? "2026-07-24T00:00:05.000Z"
          : "2026-07-24T00:00:20.000Z";
      },
    });

    expect(decision).toEqual({
      allowed: false,
      code: "target_not_uniquely_matched",
    });
    expect(events).toEqual(["control-attempt", "clock", "live-recheck", "clock"]);
  });

  test.each([
    ["routing fields", () => ({ ...validAcceptedBundle(), routingHints: [] })],
    ["non-Agent-safe disclosure", () => ({
      ...validAcceptedBundle(),
      disclosureMode: "full_debug",
    })],
    ["mismatched attachment refs", () => ({
      ...validAcceptedBundle(),
      attachmentRefs: validAcceptedBundle().attachmentRefs.map((ref, index) => ({
        ...ref,
        id: index === 0 ? "att_other" : ref.id,
      })),
    })],
    ["duplicate attachment IDs", () => ({
      ...validAcceptedBundle(),
      attachmentIds: ["att_save", "att_save"],
      attachmentRefs: validAcceptedBundle().attachmentRefs.map((ref) => ({
        ...ref,
        id: "att_save",
      })),
    })],
    ["routing inside an attachment ref", () => ({
      ...validAcceptedBundle(),
      attachmentRefs: validAcceptedBundle().attachmentRefs.map((ref, index) => (
        index === 0 ? { ...ref, routing: { tabId: 7 } } : ref
      )),
    })],
    ["action inside an attachment ref", () => ({
      ...validAcceptedBundle(),
      attachmentRefs: validAcceptedBundle().attachmentRefs.map((ref, index) => (
        index === 0 ? { ...ref, action: "click" } : ref
      )),
    })],
    ["non-canonical authority", () => ({
      ...validAcceptedBundle(),
      authority: { ...validAcceptedBundle().authority, origin: "https://app.example.test/path" },
    })],
  ])("rejects an invalid accepted bundle before any adapter call: %s", async (_name, makeBundle) => {
    let callCount = 0;
    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: makeBundle(),
      createControlAttemptId() { callCount += 1; return CONTROL_ATTEMPT_ID; },
      async issueLiveRecheck() { callCount += 1; },
      async issueUserConfirmation() { callCount += 1; },
      nowIso() { callCount += 1; },
    });

    expect(decision).toEqual({ allowed: false, code: "invalid_request" });
    expect(callCount).toBe(0);
  });

  test("fails closed when an external issuer fails or returns prose", async () => {
    const recheckFailure = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async () => { throw new Error("offline"); },
      issueUserConfirmation: async () => validUserConfirmation(),
      nowIso: () => "2026-07-24T00:00:05.000Z",
    });
    expect(recheckFailure).toEqual({ allowed: false, code: "live_recheck_required" });

    const confirmationProse = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async () => validLiveRecheck(),
      issueUserConfirmation: async () => "The user already said yes.",
      nowIso: sequenceClock(
        "2026-07-24T00:00:05.000Z",
        "2026-07-24T00:00:20.000Z",
        "2026-07-24T00:00:21.000Z",
      ),
    });
    expect(confirmationProse).toEqual({ allowed: false, code: "invalid_confirmation" });
  });

  test.each([
    ["cross-origin", (receipt) => { receipt.origin = "https://other.example.test"; }, "origin_mismatch"],
    ["cross-attempt", (receipt) => {
      receipt.controlAttemptId = "attempt_fedcba9876543210";
    }, "control_attempt_mismatch"],
    ["expired", (_receipt) => undefined, "live_recheck_expired", [
      "2026-07-24T00:00:05.000Z",
      "2026-07-24T00:00:45.001Z",
    ]],
    ["extra action field", (receipt) => { receipt.action = "click"; }, "invalid_live_recheck"],
  ])("does not request confirmation for an unusable recheck: %s", async (
    _name,
    mutate,
    expectedCode,
    clockValues = [
      "2026-07-24T00:00:05.000Z",
      "2026-07-24T00:00:20.000Z",
    ],
  ) => {
    const liveRecheck = validLiveRecheck();
    mutate(liveRecheck);
    let confirmationCalls = 0;
    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async () => liveRecheck,
      issueUserConfirmation: async () => {
        confirmationCalls += 1;
        return validUserConfirmation();
      },
      nowIso: sequenceClock(...clockValues),
    });

    expect(decision).toEqual({ allowed: false, code: expectedCode });
    expect(confirmationCalls).toBe(0);
  });

  test.each([
    ["denied", (confirmation) => { confirmation.decision = "denied"; }, "confirmation_denied"],
    ["cross-receipt", (confirmation) => {
      confirmation.liveRecheckReceiptId = "receipt_fedcba9876543210";
    }, "recheck_receipt_mismatch"],
    ["extra action field", (confirmation) => {
      confirmation.action = "click";
    }, "invalid_confirmation"],
  ])("returns the guard decision for unusable confirmation evidence: %s", async (
    _name,
    mutate,
    expectedCode,
  ) => {
    const confirmation = validUserConfirmation();
    mutate(confirmation);
    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async () => validLiveRecheck(),
      issueUserConfirmation: async () => confirmation,
      nowIso: sequenceClock(
        "2026-07-24T00:00:05.000Z",
        "2026-07-24T00:00:20.000Z",
        "2026-07-24T00:00:21.000Z",
      ),
    });

    expect(decision).toEqual({ allowed: false, code: expectedCode });
  });

  test("rejects an invalid attempt factory before calling either issuer", async () => {
    let issuerCalls = 0;
    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => "model-provided",
      issueLiveRecheck: async () => { issuerCalls += 1; },
      issueUserConfirmation: async () => { issuerCalls += 1; },
      nowIso: () => "2026-07-24T00:00:05.000Z",
    });

    expect(decision).toEqual({ allowed: false, code: "invalid_control_attempt" });
    expect(issuerCalls).toBe(0);
  });

  test("fails closed when the host clock moves backward across async stages", async () => {
    let confirmationCalls = 0;
    const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle: validAcceptedBundle(),
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async () => validLiveRecheck(),
      issueUserConfirmation: async () => {
        confirmationCalls += 1;
        return validUserConfirmation();
      },
      nowIso: sequenceClock(
        "2026-07-24T00:00:05.000Z",
        "2026-07-24T00:00:20.000Z",
        "2026-07-24T00:00:19.000Z",
      ),
    });

    expect(decision).toEqual({ allowed: false, code: "invalid_evaluated_at" });
    expect(confirmationCalls).toBe(1);
  });

  test("freezes the accepted subject before awaiting external adapters", async () => {
    const acceptedBundle = validAcceptedBundle();
    let releaseRecheck;
    const recheckGate = new Promise((resolve) => { releaseRecheck = resolve; });
    const run = evaluateAcceptedSavedSnapshotWithTrustedHost({
      acceptedBundle,
      createControlAttemptId: () => CONTROL_ATTEMPT_ID,
      issueLiveRecheck: async (request) => {
        await recheckGate;
        expect(request.savedSnapshot.attachmentIds).toEqual(["att_save", "att_cancel"]);
        expect(request.savedSnapshot.authority.origin).toBe("https://app.example.test");
        return validLiveRecheck();
      },
      issueUserConfirmation: async () => validUserConfirmation(),
      nowIso: sequenceClock(
        "2026-07-24T00:00:05.000Z",
        "2026-07-24T00:00:20.000Z",
        "2026-07-24T00:00:21.000Z",
      ),
    });

    acceptedBundle.attachmentIds[0] = "att_other";
    acceptedBundle.authority.origin = "https://other.example.test";
    releaseRecheck();

    await expect(run).resolves.toMatchObject({
      allowed: true,
      code: "requirements_satisfied",
    });
  });

  test("contains no browser, replay, bridge, or action-execution dependency", async () => {
    const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

    expect(source).toContain('from "@meanthis/schema"');
    for (const forbidden of [
      "@meanthis/replay",
      "@meanthis/hub-core",
      "playwright",
      "chrome.tabs",
      ".click(",
      ".goto(",
      "local-bridge",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

function validAcceptedBundle() {
  return {
    kind: "ui-attach.saved-snapshot-prompt-bundle",
    disclosureMode: "agent_safe",
    authority: {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-authority",
      status: "not_rechecked",
      origin: "https://app.example.test",
      routingPolicy: "omitted",
      evidencePolicy: "capture_time_observations_only",
      controlPolicy: "live_recheck_and_user_confirmation_required",
    },
    attachmentCount: 2,
    attachmentIds: ["att_save", "att_cancel"],
    attachmentRefs: [
      {
        id: "att_save",
        label: "A",
        target: "button Save",
        role: "button",
        accessibleName: "Save",
        text: "Save",
        primaryLocator: 'page.getByRole("button", { name: "Save" })',
      },
      {
        id: "att_cancel",
        label: "B",
        target: "button Cancel",
        role: "button",
        accessibleName: "Cancel",
        text: "Cancel",
        primaryLocator: 'page.getByRole("button", { name: "Cancel" })',
      },
    ],
  };
}

function validLiveRecheck() {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-live-recheck-result",
    controlAttemptId: CONTROL_ATTEMPT_ID,
    receiptId: RECHECK_RECEIPT_ID,
    origin: "https://app.example.test",
    checkedAt: "2026-07-24T00:00:00.000Z",
    validUntil: "2026-07-24T00:00:45.000Z",
    targets: [
      { attachmentId: "att_save", status: "unique_match" },
      { attachmentId: "att_cancel", status: "unique_match" },
    ],
  };
}

function validUserConfirmation() {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-user-confirmation",
    purpose: "saved_snapshot_browser_control",
    controlAttemptId: CONTROL_ATTEMPT_ID,
    liveRecheckReceiptId: RECHECK_RECEIPT_ID,
    decision: "confirmed",
    confirmedAt: "2026-07-24T00:00:10.000Z",
  };
}

function sequenceClock(...values) {
  return () => values.shift();
}
