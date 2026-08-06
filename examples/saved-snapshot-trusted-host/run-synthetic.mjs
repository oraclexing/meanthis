#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { hydrateCaptureSessionFile } from "@meanthis/hub-core";
import { evaluateAcceptedSavedSnapshotWithTrustedHost } from "./index.mjs";

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

const clockValues = [
  "2026-07-24T00:00:05.000Z",
  "2026-07-24T00:00:20.000Z",
  "2026-07-24T00:00:21.000Z",
];
const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
  acceptedBundle,
  createControlAttemptId: () => CONTROL_ATTEMPT_ID,
  issueLiveRecheck: async ({ controlAttemptId, savedSnapshot }) => ({
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-live-recheck-result",
    controlAttemptId,
    receiptId: RECHECK_RECEIPT_ID,
    origin: savedSnapshot.authority.origin,
    checkedAt: "2026-07-24T00:00:10.000Z",
    validUntil: "2026-07-24T00:00:40.000Z",
    targets: savedSnapshot.attachmentIds.map((attachmentId) => ({
      attachmentId,
      status: "unique_match",
    })),
  }),
  issueUserConfirmation: async ({ controlAttemptId, liveRecheckReceiptId }) => ({
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-user-confirmation",
    purpose: "saved_snapshot_browser_control",
    controlAttemptId,
    liveRecheckReceiptId,
    decision: "confirmed",
    confirmedAt: "2026-07-24T00:00:20.500Z",
  }),
  nowIso: () => clockValues.shift(),
});
if (!decision.allowed) {
  throw new Error(`Trusted-host synthetic example was denied: ${decision.code}`);
}
process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
