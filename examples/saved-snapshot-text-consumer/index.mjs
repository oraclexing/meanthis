import { createHash } from "node:crypto";
import { evaluateSavedSnapshotControlPolicy } from "@meanthis/schema";
import {
  bindSavedSnapshotTextConsumerContext,
  verifySavedSnapshotTextConsumerContext,
} from
  "../saved-snapshot-trusted-host/accepted-bundle.mjs";

export { bindSavedSnapshotTextConsumerContext };

export const SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES = 1_048_576;

/**
 * Parses and validates one saved-bundle JSON document once, then returns the
 * sensitive host context and the public-safe acceptance receipt as separate
 * planes. The receipt must remain outside model input.
 */
export function acceptSavedSnapshotTextConsumerBundleJson(value) {
  const accepted = parseAndBindSavedSnapshotTextConsumerBundleJson(value);
  if (accepted === null) return null;
  return {
    acceptedContext: accepted.context,
    consumerReceipt: createPublicConsumerReceipt(accepted.bundle, accepted.context),
  };
}

/**
 * Accepts the machine-readable JSON copied by the extension's Saved sites UI.
 * Presentation markdown is kept opaque and is never parsed to recover fields.
 */
export function bindSavedSnapshotTextConsumerContextJson(value) {
  return parseAndBindSavedSnapshotTextConsumerBundleJson(value)?.context ?? null;
}

/**
 * Proves that the supplied JSON ingress can be accepted by the public consumer
 * boundary without invoking a model or claiming OS clipboard readback.
 */
export function createSavedSnapshotPublicConsumerReceiptJson(value) {
  const accepted = parseAndBindSavedSnapshotTextConsumerBundleJson(value);
  return accepted === null
    ? null
    : createPublicConsumerReceipt(accepted.bundle, accepted.context);
}

function createPublicConsumerReceipt(bundle, context) {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-public-consumer-receipt",
    bundleCanonicalSha256: sha256(JSON.stringify(bundle)),
    consumerContextKind: context.kind,
    consumerContextSha256: context.contentSha256,
    consumerAttachmentCount: context.attachmentCount,
    consumerAuthorityStatus: context.authority.status,
    consumerRoutingPolicy: context.authority.routingPolicy,
    consumerStatus: "accepted",
    modelFieldsUsedCount: 0,
  };
}

function parseAndBindSavedSnapshotTextConsumerBundleJson(value) {
  const bundle = parseSavedSnapshotTextConsumerBundleJson(value);
  if (bundle === null) return null;
  const context = bindSavedSnapshotTextConsumerContext(bundle);
  return context === null ? null : { bundle, context };
}

function parseSavedSnapshotTextConsumerBundleJson(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (
    new TextEncoder().encode(value).byteLength >
      SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES
  ) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const DENIAL_CODES = new Set([
  "invalid_request",
  "invalid_authority",
  "invalid_expected_targets",
  "invalid_control_attempt",
  "invalid_evaluated_at",
  "live_recheck_required",
  "invalid_live_recheck",
  "control_attempt_mismatch",
  "origin_mismatch",
  "target_coverage_mismatch",
  "target_not_uniquely_matched",
  "live_recheck_time_invalid",
  "live_recheck_expired",
  "confirmation_required",
  "invalid_confirmation",
  "confirmation_denied",
  "recheck_receipt_mismatch",
  "confirmation_time_invalid",
]);

/**
 * A connector-shaped, non-controlling text-consumer example.
 *
 * The deterministic policy decision and effective boundary are fixed before
 * the model callback runs. Model output is retained only as untrusted text.
 */
export async function runSavedSnapshotTextConsumer({
  acceptedContext,
  controlEvidence,
  invokeTextConsumer,
}) {
  const attachmentContext = verifySavedSnapshotTextConsumerContext(acceptedContext);
  if (attachmentContext === null) return reject("invalid_saved_snapshot_context");
  if (typeof invokeTextConsumer !== "function") return reject("invalid_text_consumer");

  const decision = evaluateControlEvidence(attachmentContext, controlEvidence);
  const controlDecision = projectControlDecision(decision);
  const effectiveControlBoundary =
    deriveSavedSnapshotEffectiveControlBoundary(controlDecision);
  const consumerInput = {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-text-consumer-input",
    attachmentContext: structuredClone(attachmentContext),
    controlDecision: structuredClone(controlDecision),
  };

  let modelOutput;
  try {
    const value = await invokeTextConsumer(structuredClone(consumerInput));
    modelOutput = typeof value === "string" && value.trim().length > 0
      ? { status: "completed", value }
      : { status: "failed", value: null };
  } catch {
    modelOutput = { status: "failed", value: null };
  }

  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-text-consumer-result",
    status: "composed",
    attachmentContext: structuredClone(attachmentContext),
    modelOutput,
    effectiveControlBoundary: structuredClone(effectiveControlBoundary),
  };
}

export function deriveSavedSnapshotEffectiveControlBoundary(decision) {
  if (
    hasExactKeys(decision, ["allowed", "code"]) &&
    decision.allowed === true &&
    decision.code === "requirements_satisfied"
  ) {
    return {
      state: "eligible_for_host_review",
      allowed: true,
      code: decision.code,
      source: "deterministic_policy",
      modelFieldsUsed: [],
    };
  }
  if (
    hasExactKeys(decision, ["allowed", "code"]) &&
    decision.allowed === false &&
    DENIAL_CODES.has(decision.code)
  ) {
    return {
      state: "blocked",
      allowed: false,
      code: decision.code,
      source: "deterministic_policy",
      modelFieldsUsed: [],
    };
  }
  return {
    state: "blocked",
    allowed: false,
    code: "invalid_request",
    source: "deterministic_policy",
    modelFieldsUsed: [],
  };
}

function evaluateControlEvidence(attachmentContext, controlEvidence) {
  try {
    return evaluateSavedSnapshotControlPolicy({
      authority: structuredClone(attachmentContext.authority),
      expectedAttachmentIds: structuredClone(attachmentContext.attachmentIds),
      controlAttemptId: controlEvidence?.controlAttemptId,
      liveRecheck: structuredClone(controlEvidence?.liveRecheck),
      userConfirmation: structuredClone(controlEvidence?.userConfirmation),
      evaluatedAt: controlEvidence?.evaluatedAt,
    });
  } catch {
    return { allowed: false, code: "invalid_request" };
  }
}

function projectControlDecision(decision) {
  return {
    allowed: decision?.allowed === true,
    code: typeof decision?.code === "string" ? decision.code : "invalid_request",
  };
}

function reject(code) {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-text-consumer-result",
    status: "rejected",
    code,
  };
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
