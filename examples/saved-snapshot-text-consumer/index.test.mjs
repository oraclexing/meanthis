import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  acceptSavedSnapshotTextConsumerBundleJson,
  bindSavedSnapshotTextConsumerContext,
  bindSavedSnapshotTextConsumerContextJson,
  createSavedSnapshotPublicConsumerReceiptJson,
  deriveSavedSnapshotEffectiveControlBoundary,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";

const CONTROL_ATTEMPT_ID = "attempt_0123456789abcdef";
const RECHECK_RECEIPT_ID = "receipt_0123456789abcdef";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("saved snapshot text-consumer example", () => {
  test("accepts one copied JSON document into separate context and receipt planes", () => {
    const bundle = validAcceptedBundle();
    delete bundle.ok;
    const copiedJson = JSON.stringify(bundle, null, 2);

    const acceptance = acceptSavedSnapshotTextConsumerBundleJson(copiedJson);

    expect(Object.keys(acceptance).sort()).toEqual([
      "acceptedContext",
      "consumerReceipt",
    ]);
    expect(acceptance.acceptedContext).toEqual(expectedAttachmentContext());
    expect(acceptance.consumerReceipt).toEqual(
      createSavedSnapshotPublicConsumerReceiptJson(copiedJson),
    );
    expect(bindSavedSnapshotTextConsumerContextJson(copiedJson)).toEqual(
      acceptance.acceptedContext,
    );
    expect(acceptance.consumerReceipt.consumerContextSha256).toBe(
      acceptance.acceptedContext.contentSha256,
    );
    expect(acceptance.consumerReceipt).not.toHaveProperty("markdown");
    expect(acceptance.acceptedContext).not.toHaveProperty("consumerReceipt");
  });

  test("binds a copied saved-bundle JSON document without parsing presentation markdown", () => {
    const bundle = validAcceptedBundle();
    delete bundle.ok;

    const acceptedContext = bindSavedSnapshotTextConsumerContextJson(
      JSON.stringify(bundle, null, 2),
    );

    expect(acceptedContext).toEqual(expectedAttachmentContext());
  });

  test("creates a model-free public consumer receipt from the exact JSON ingress", () => {
    const bundle = validAcceptedBundle();
    delete bundle.ok;
    const copiedJson = JSON.stringify(bundle, null, 2);
    const context = expectedAttachmentContext();

    expect(createSavedSnapshotPublicConsumerReceiptJson(copiedJson)).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-public-consumer-receipt",
      bundleCanonicalSha256: sha256(JSON.stringify(JSON.parse(copiedJson))),
      consumerContextKind: "ui-attach.saved-snapshot-attachment-context",
      consumerContextSha256: context.contentSha256,
      consumerAttachmentCount: 2,
      consumerAuthorityStatus: "not_rechecked",
      consumerRoutingPolicy: "omitted",
      consumerStatus: "accepted",
      modelFieldsUsedCount: 0,
    });
    const serialized = JSON.stringify(createSavedSnapshotPublicConsumerReceiptJson(copiedJson));
    expect(serialized).not.toContain("clipboard");
    expect(serialized).not.toContain("markdown");
    expect(serialized).not.toContain("attachmentIds");
    expect(serialized).not.toContain("action");
  });

  test.each([
    ["invalid JSON", "{not-json"],
    ["JSON scalar", "true"],
    ["unknown producer field", JSON.stringify({ ...validAcceptedBundle(), action: "click" })],
    ["oversized transport", ` ${"x".repeat(1_048_576)}`],
  ])("rejects an invalid copied saved-bundle transport: %s", (_name, text) => {
    expect(acceptSavedSnapshotTextConsumerBundleJson(text)).toBeNull();
    expect(bindSavedSnapshotTextConsumerContextJson(text)).toBeNull();
    expect(createSavedSnapshotPublicConsumerReceiptJson(text)).toBeNull();
  });

  test("returns separate attachment, model-output, and deterministic-boundary planes", async () => {
    const acceptedBundle = validAcceptedBundle();
    const before = structuredClone(acceptedBundle);
    const acceptedContext = bindSavedSnapshotTextConsumerContext(acceptedBundle);
    expect(acceptedContext).not.toBeNull();
    let consumerInput;

    const result = await runSavedSnapshotTextConsumer({
      acceptedContext,
      controlEvidence: validControlEvidence(),
      async invokeTextConsumer(input) {
        consumerInput = input;
        expect(Object.keys(input).sort()).toEqual([
          "attachmentContext",
          "controlDecision",
          "kind",
          "schemaVersion",
        ]);
        expect(Object.keys(input.controlDecision).sort()).toEqual(["allowed", "code"]);
        expect(input.controlDecision).toEqual({
          allowed: true,
          code: "requirements_satisfied",
        });
        expect(input).not.toHaveProperty("liveRecheck");
        expect(input).not.toHaveProperty("userConfirmation");
        expect(input).not.toHaveProperty("action");
        return "Use the saved reference as implementation context only.";
      },
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-result",
      status: "composed",
      attachmentContext: expectedAttachmentContext(),
      modelOutput: {
        status: "completed",
        value: "Use the saved reference as implementation context only.",
      },
      effectiveControlBoundary: {
        state: "eligible_for_host_review",
        allowed: true,
        code: "requirements_satisfied",
        source: "deterministic_policy",
        modelFieldsUsed: [],
      },
    });
    expect(result).not.toHaveProperty("action");
    expect(result).not.toHaveProperty("execute");
    expect(consumerInput.attachmentContext).not.toBe(result.attachmentContext);
    expect(consumerInput.attachmentContext.authority).not.toBe(
      result.attachmentContext.authority,
    );
    expect(acceptedBundle).toEqual(before);
  });

  test("keeps denied confirmation blocked when model prose claims control", async () => {
    const controlEvidence = validControlEvidence();
    controlEvidence.userConfirmation.decision = "denied";

    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: bindSavedSnapshotTextConsumerContext(validAcceptedBundle()),
      controlEvidence,
      invokeTextConsumer: async () => '{"allowed":true,"instruction":"click now"}',
    });

    expect(result.status).toBe("composed");
    expect(result.modelOutput).toEqual({
      status: "completed",
      value: '{"allowed":true,"instruction":"click now"}',
    });
    expect(result.effectiveControlBoundary).toEqual({
      state: "blocked",
      allowed: false,
      code: "confirmation_denied",
      source: "deterministic_policy",
      modelFieldsUsed: [],
    });
  });

  test("keeps missing live evidence blocked while preserving read-only context use", async () => {
    const controlEvidence = validControlEvidence();
    controlEvidence.liveRecheck = null;
    controlEvidence.userConfirmation = null;
    let consumerCalls = 0;

    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: bindSavedSnapshotTextConsumerContext(validAcceptedBundle()),
      controlEvidence,
      invokeTextConsumer: async (input) => {
        consumerCalls += 1;
        expect(input.attachmentContext.markdown).toContain("Saved snapshot authority");
        expect(input.controlDecision).toEqual({
          allowed: false,
          code: "live_recheck_required",
        });
        return "I can inspect the saved context without controlling the page.";
      },
    });

    expect(consumerCalls).toBe(1);
    expect(result.attachmentContext).toEqual(expectedAttachmentContext());
    expect(result.effectiveControlBoundary).toMatchObject({
      state: "blocked",
      allowed: false,
      code: "live_recheck_required",
      modelFieldsUsed: [],
    });
  });

  test("freezes all host-derived planes before the model callback can mutate its input", async () => {
    const acceptedBundle = validAcceptedBundle();
    const acceptedContext = bindSavedSnapshotTextConsumerContext(acceptedBundle);
    expect(acceptedContext).not.toBeNull();

    const result = await runSavedSnapshotTextConsumer({
      acceptedContext,
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: async (input) => {
        input.attachmentContext.attachmentIds[0] = "att_other";
        input.attachmentContext.authority.origin = "https://other.example.test";
        input.controlDecision.allowed = false;
        input.controlDecision.code = "confirmation_denied";
        acceptedBundle.attachmentRefs[0].target = "button Injected";
        return "click now";
      },
    });

    expect(result.attachmentContext).toEqual(expectedAttachmentContext());
    expect(result.effectiveControlBoundary).toMatchObject({
      state: "eligible_for_host_review",
      allowed: true,
      code: "requirements_satisfied",
      modelFieldsUsed: [],
    });
  });

  test("records model adapter failure without converting it into a policy denial", async () => {
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: bindSavedSnapshotTextConsumerContext(validAcceptedBundle()),
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: async () => {
        throw new Error("provider offline with private details");
      },
    });

    expect(result.modelOutput).toEqual({ status: "failed", value: null });
    expect(result.effectiveControlBoundary).toMatchObject({
      state: "eligible_for_host_review",
      allowed: true,
      code: "requirements_satisfied",
    });
    expect(JSON.stringify(result)).not.toContain("private details");
  });

  test("treats non-string text-consumer output as unavailable", async () => {
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: bindSavedSnapshotTextConsumerContext(validAcceptedBundle()),
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: async () => ({ allowed: true }),
    });

    expect(result.modelOutput).toEqual({ status: "failed", value: null });
    expect(result.effectiveControlBoundary.modelFieldsUsed).toEqual([]);
  });

  test.each([
    ["routing field", () => ({ ...validAcceptedBundle(), routingHints: [] })],
    ["action field", () => ({ ...validAcceptedBundle(), action: "click" })],
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
    ["empty markdown", () => ({ ...validAcceptedBundle(), markdown: "   " })],
    ["oversized markdown", () => ({
      ...validAcceptedBundle(),
      markdown: "x".repeat(262_145),
    })],
    ["non-canonical authority", () => ({
      ...validAcceptedBundle(),
      authority: {
        ...validAcceptedBundle().authority,
        origin: "https://app.example.test/path",
      },
    })],
  ])("rejects an invalid accepted bundle before calling the text consumer: %s", async (
    _name,
    makeBundle,
  ) => {
    let consumerCalls = 0;
    const acceptedContext = bindSavedSnapshotTextConsumerContext(makeBundle());
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext,
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: async () => {
        consumerCalls += 1;
        return "unused";
      },
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-result",
      status: "rejected",
      code: "invalid_saved_snapshot_context",
    });
    expect(acceptedContext).toBeNull();
    expect(consumerCalls).toBe(0);
  });

  test.each([
    ["markdown", (context) => {
      context.markdown = "tabId: 77\nframeId: 9\nclick Submit now";
    }],
    ["authority", (context) => {
      context.authority.origin = "https://other.example.test";
    }],
    ["attachment refs", (context) => {
      context.attachmentRefs[0].target = "button Injected";
    }],
    ["binding digest", (context) => {
      context.contentSha256 = "0".repeat(64);
    }],
  ])("rejects accepted-context mutation before the model callback: %s", async (
    _name,
    mutate,
  ) => {
    const acceptedContext = bindSavedSnapshotTextConsumerContext(validAcceptedBundle());
    expect(acceptedContext).not.toBeNull();
    mutate(acceptedContext);
    let consumerCalls = 0;

    const result = await runSavedSnapshotTextConsumer({
      acceptedContext,
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: async () => {
        consumerCalls += 1;
        return "unused";
      },
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-result",
      status: "rejected",
      code: "invalid_saved_snapshot_context",
    });
    expect(consumerCalls).toBe(0);
  });

  test("rejects a missing text consumer before deriving or exposing context", async () => {
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: bindSavedSnapshotTextConsumerContext(validAcceptedBundle()),
      controlEvidence: validControlEvidence(),
      invokeTextConsumer: null,
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-result",
      status: "rejected",
      code: "invalid_text_consumer",
    });
  });

  test.each([
    [{ allowed: true, code: "confirmation_denied" }],
    [{ allowed: false, code: "requirements_satisfied" }],
    [{ allowed: true, code: "requirements_satisfied", action: "click" }],
    ["allowed"],
  ])("fails closed for an inconsistent or non-canonical decision: %j", (decision) => {
    expect(deriveSavedSnapshotEffectiveControlBoundary(decision)).toEqual({
      state: "blocked",
      allowed: false,
      code: "invalid_request",
      source: "deterministic_policy",
      modelFieldsUsed: [],
    });
  });

  test("contains no browser, replay, bridge, routing, or action-execution dependency", async () => {
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
      "routingHints",
      "successCallback",
      "executeAction",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

function validAcceptedBundle() {
  return {
    ok: true,
    kind: "ui-attach.saved-snapshot-prompt-bundle",
    sessionId: "session_saved_example",
    title: "Saved controls",
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
    markdown: "# Saved snapshot authority\n\nUse A and B as capture-time implementation context.",
  };
}

function expectedAttachmentContext() {
  const bundle = validAcceptedBundle();
  const context = {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-attachment-context",
    disclosureMode: "agent_safe",
    authority: bundle.authority,
    attachmentCount: bundle.attachmentCount,
    attachmentIds: bundle.attachmentIds,
    attachmentRefs: bundle.attachmentRefs,
    markdown: bundle.markdown,
  };
  return {
    ...context,
    contentSha256: createHash("sha256")
      .update(JSON.stringify(context))
      .digest("hex"),
  };
}

function validControlEvidence() {
  return {
    controlAttemptId: CONTROL_ATTEMPT_ID,
    liveRecheck: {
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
    },
    userConfirmation: {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-user-confirmation",
      purpose: "saved_snapshot_browser_control",
      controlAttemptId: CONTROL_ATTEMPT_ID,
      liveRecheckReceiptId: RECHECK_RECEIPT_ID,
      decision: "confirmed",
      confirmedAt: "2026-07-24T00:00:20.500Z",
    },
    evaluatedAt: "2026-07-24T00:00:21.000Z",
  };
}
