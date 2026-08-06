import {
  evaluateSavedSnapshotControlPolicy,
} from "@meanthis/schema";
import { projectAcceptedSavedSnapshotPolicySubject } from "./accepted-bundle.mjs";

/**
 * A non-controlling trusted-host orchestration example.
 *
 * The host owns bundle acceptance, attempt-ID generation, the current clock,
 * and the two external evidence issuers. This function only sequences the
 * public policy guard and returns its decision. It never performs an action.
 */
export async function evaluateAcceptedSavedSnapshotWithTrustedHost({
  acceptedBundle,
  createControlAttemptId,
  issueLiveRecheck,
  issueUserConfirmation,
  nowIso,
}) {
  const savedSnapshot = projectAcceptedSavedSnapshotPolicySubject(acceptedBundle);
  if (
    savedSnapshot === null ||
    typeof createControlAttemptId !== "function" ||
    typeof issueLiveRecheck !== "function" ||
    typeof issueUserConfirmation !== "function" ||
    typeof nowIso !== "function"
  ) return deny("invalid_request");

  const controlAttemptId = callHost(createControlAttemptId);
  const readHostTime = createMonotonicClockReader(nowIso);
  const preflightAt = readHostTime();
  const preflight = evaluateSavedSnapshotControlPolicy({
    authority: savedSnapshot.authority,
    expectedAttachmentIds: savedSnapshot.attachmentIds,
    controlAttemptId,
    liveRecheck: null,
    userConfirmation: null,
    evaluatedAt: preflightAt,
  });
  if (preflight.allowed || preflight.code !== "live_recheck_required") {
    return preflight;
  }

  const liveRecheckResult = await callExternalIssuer(
    issueLiveRecheck,
    {
      controlAttemptId,
      savedSnapshot: structuredClone(savedSnapshot),
    },
  );
  if (!liveRecheckResult.ok) return preflight;

  const afterRecheckAt = readHostTime();
  const afterRecheck = evaluateSavedSnapshotControlPolicy({
    authority: savedSnapshot.authority,
    expectedAttachmentIds: savedSnapshot.attachmentIds,
    controlAttemptId,
    liveRecheck: liveRecheckResult.value,
    userConfirmation: null,
    evaluatedAt: afterRecheckAt,
  });
  if (afterRecheck.allowed || afterRecheck.code !== "confirmation_required") {
    return afterRecheck;
  }

  const confirmationResult = await callExternalIssuer(
    issueUserConfirmation,
    {
      attachmentIds: structuredClone(savedSnapshot.attachmentIds),
      controlAttemptId,
      liveRecheckReceiptId: liveRecheckResult.value?.receiptId,
      origin: savedSnapshot.authority.origin,
    },
  );
  if (!confirmationResult.ok) return afterRecheck;

  const finalEvaluationAt = readHostTime();
  return evaluateSavedSnapshotControlPolicy({
    authority: savedSnapshot.authority,
    expectedAttachmentIds: savedSnapshot.attachmentIds,
    controlAttemptId,
    liveRecheck: liveRecheckResult.value,
    userConfirmation: confirmationResult.value,
    evaluatedAt: finalEvaluationAt,
  });
}

function callHost(callback) {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

function createMonotonicClockReader(nowIso) {
  let previousTime = Number.NEGATIVE_INFINITY;
  return () => {
    const value = callHost(nowIso);
    if (typeof value !== "string") return undefined;
    let canonical;
    try {
      canonical = new Date(value).toISOString() === value;
    } catch {
      canonical = false;
    }
    const time = canonical ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time) || time < previousTime) return undefined;
    previousTime = time;
    return value;
  };
}

async function callExternalIssuer(issue, request) {
  try {
    return { ok: true, value: await issue(request) };
  } catch {
    return { ok: false };
  }
}

function deny(code) {
  return { allowed: false, code };
}
