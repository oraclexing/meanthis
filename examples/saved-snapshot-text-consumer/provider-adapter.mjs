import { verifySavedSnapshotTextConsumerContext } from
  "../saved-snapshot-trusted-host/accepted-bundle.mjs";
import { deriveSavedSnapshotEffectiveControlBoundary } from "./index.mjs";

const MAX_TIMEOUT_MS = 600_000;

/**
 * Wrap one host-supplied text provider as the callback expected by
 * runSavedSnapshotTextConsumer. This adapter validates and isolates input,
 * bounds the call, and preserves provider output as opaque text.
 */
export function createSavedSnapshotTextConsumerAdapter(options) {
  if (
    !hasExactKeys(options, ["timeoutMs", "invokeProvider"])
  ) throw new Error("Invalid saved-snapshot text provider adapter.");
  const { timeoutMs, invokeProvider } = options;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    typeof invokeProvider !== "function"
  ) throw new Error("Invalid saved-snapshot text provider adapter.");

  const invokeTextConsumer = async (input) => {
    const consumerInput = normalizeConsumerInput(input);
    if (consumerInput === null) {
      throw new Error("Invalid saved-snapshot text-consumer input.");
    }

    const controller = new AbortController();
    const request = Object.freeze({
      consumerInput: deepFreeze(consumerInput),
      signal: controller.signal,
    });
    let timeoutId;
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("Saved-snapshot text provider failed."));
      }, timeoutMs);
    });

    try {
      const value = await Promise.race([
        Promise.resolve().then(() => invokeProvider(request)),
        timeout,
      ]);
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Saved-snapshot text provider failed.");
      }
      return value;
    } catch {
      throw new Error("Saved-snapshot text provider failed.");
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return Object.freeze(invokeTextConsumer);
}

function normalizeConsumerInput(value) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "attachmentContext",
      "controlDecision",
    ]) ||
    value.schemaVersion !== "0.1.0" ||
    value.kind !== "ui-attach.saved-snapshot-text-consumer-input" ||
    !hasExactKeys(value.controlDecision, ["allowed", "code"])
  ) return null;
  const attachmentContext = verifySavedSnapshotTextConsumerContext(value.attachmentContext);
  const boundary = deriveSavedSnapshotEffectiveControlBoundary(value.controlDecision);
  if (
    attachmentContext === null ||
    boundary.allowed !== value.controlDecision.allowed ||
    boundary.code !== value.controlDecision.code
  ) return null;

  try {
    return {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-input",
      attachmentContext: structuredClone(attachmentContext),
      controlDecision: structuredClone(value.controlDecision),
    };
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}
