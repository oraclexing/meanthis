#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { hydrateCaptureSessionFile } from "@meanthis/hub-core";
import {
  acceptSavedSnapshotTextConsumerBundleJson,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";
import { createSavedSnapshotTextConsumerAdapter } from "./provider-adapter.mjs";

const CONTROL_ATTEMPT_ID = "attempt_0123456789abcdef";
const RECHECK_RECEIPT_ID = "receipt_0123456789abcdef";
const FIXTURE_URL = new URL(
  "../../apps/extension-mv3/fixtures/two-element.capture-session.json",
  import.meta.url,
);

const file = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
const hydrated = hydrateCaptureSessionFile(file);
if (!hydrated.ok) throw new Error("The canonical saved-snapshot fixture was invalid.");
const attachmentIds = file.session.attachments.map((item) => item.id);
const acceptedBundle = hydrated.hub.buildSavedSnapshotPromptBundle({
  sessionId: hydrated.sessionId,
  attachmentIds,
  attachmentLabels: Object.fromEntries(file.session.attachments.map((item, index) => [
    item.id,
    item.labels.find((label) => typeof label === "string" && label.trim())?.trim()
      ?? String.fromCharCode(65 + index),
  ])),
  attachmentIntents: Object.fromEntries(file.session.attachments.map((item) => [
    item.id,
    item.sourceRecord.intent,
  ])),
  format: "compact",
});
if (!acceptedBundle.ok) throw new Error(acceptedBundle.error);
const { ok: _ok, ...copiedBundle } = acceptedBundle;
const copiedBundleJson = JSON.stringify(copiedBundle, null, 2);
const acceptance = acceptSavedSnapshotTextConsumerBundleJson(copiedBundleJson);
if (acceptance === null) {
  throw new Error("The production saved bundle could not be accepted for text consumption.");
}
const { acceptedContext, consumerReceipt } = acceptance;
if (
  consumerReceipt.consumerContextSha256 !== acceptedContext.contentSha256 ||
  consumerReceipt.consumerAttachmentCount !== acceptedContext.attachmentCount ||
  consumerReceipt.modelFieldsUsedCount !== 0
) throw new Error("The production saved bundle could not produce a consumer receipt.");

const eligible = await runScenario("confirmed", "Implementation context retained.");
const denied = await runScenario("denied", '{"allowed":true}');
if (
  eligible.status !== "composed" ||
  eligible.modelOutput.status !== "completed" ||
  eligible.effectiveControlBoundary.state !== "eligible_for_host_review" ||
  eligible.effectiveControlBoundary.modelFieldsUsed.length !== 0 ||
  denied.status !== "composed" ||
  denied.modelOutput.status !== "completed" ||
  denied.effectiveControlBoundary.state !== "blocked" ||
  denied.effectiveControlBoundary.code !== "confirmation_denied" ||
  denied.effectiveControlBoundary.modelFieldsUsed.length !== 0
) throw new Error("Saved-snapshot text-consumer synthetic proof did not preserve its boundary.");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "0.1.0",
  kind: "ui-attach.saved-snapshot-text-consumer-synthetic-summary",
  ingress: "saved_bundle_json",
  consumerReceiptKind: consumerReceipt.kind,
  consumerReceiptModelFieldsUsed: consumerReceipt.modelFieldsUsedCount,
  attachmentCount: eligible.attachmentContext.attachmentCount,
  modelOutputStatuses: [eligible.modelOutput.status, denied.modelOutput.status],
  effectiveBoundaryStates: [
    eligible.effectiveControlBoundary.state,
    denied.effectiveControlBoundary.state,
  ],
  modelFieldsUsed: [
    eligible.effectiveControlBoundary.modelFieldsUsed.length,
    denied.effectiveControlBoundary.modelFieldsUsed.length,
  ],
}, null, 2)}\n`);

async function runScenario(decision, modelText) {
  const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
    timeoutMs: 1_000,
    invokeProvider: async ({ consumerInput, signal }) => {
      if (
        signal.aborted ||
        consumerInput.kind !== "ui-attach.saved-snapshot-text-consumer-input" ||
        consumerInput.attachmentContext.attachmentCount !== acceptedBundle.attachmentCount
      ) throw new Error("Synthetic provider request was invalid.");
      return modelText;
    },
  });
  return runSavedSnapshotTextConsumer({
    acceptedContext,
    controlEvidence: {
      controlAttemptId: CONTROL_ATTEMPT_ID,
      liveRecheck: {
        schemaVersion: "0.1.0",
        kind: "ui-attach.saved-snapshot-live-recheck-result",
        controlAttemptId: CONTROL_ATTEMPT_ID,
        receiptId: RECHECK_RECEIPT_ID,
        origin: acceptedBundle.authority.origin,
        checkedAt: "2026-07-24T00:00:10.000Z",
        validUntil: "2026-07-24T00:00:40.000Z",
        targets: acceptedBundle.attachmentIds.map((attachmentId) => ({
          attachmentId,
          status: "unique_match",
        })),
      },
      userConfirmation: {
        schemaVersion: "0.1.0",
        kind: "ui-attach.saved-snapshot-user-confirmation",
        purpose: "saved_snapshot_browser_control",
        controlAttemptId: CONTROL_ATTEMPT_ID,
        liveRecheckReceiptId: RECHECK_RECEIPT_ID,
        decision,
        confirmedAt: "2026-07-24T00:00:20.500Z",
      },
      evaluatedAt: "2026-07-24T00:00:21.000Z",
    },
    invokeTextConsumer,
  });
}
