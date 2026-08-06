import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  bindSavedSnapshotTextConsumerContext,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";
import { createSavedSnapshotTextConsumerAdapter } from "./provider-adapter.mjs";

describe("saved snapshot text-provider adapter", () => {
  test("passes one frozen exact consumer input to a provider and returns only text", async () => {
    const input = validConsumerInput();
    const before = structuredClone(input);
    let providerCalls = 0;
    const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
      timeoutMs: 1_000,
      async invokeProvider(request) {
        providerCalls += 1;
        expect(Object.keys(request).sort()).toEqual(["consumerInput", "signal"]);
        expect(request.consumerInput).toEqual(input);
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.signal.aborted).toBe(false);
        expect(Object.isFrozen(request)).toBe(true);
        expect(request.consumerInput).not.toBe(input);
        expect(request.consumerInput.attachmentContext).not.toBe(input.attachmentContext);
        expect(request.consumerInput.attachmentContext.attachmentIds).not.toBe(
          input.attachmentContext.attachmentIds,
        );
        expect(Object.isFrozen(request.consumerInput)).toBe(true);
        expect(Object.isFrozen(request.consumerInput.attachmentContext.authority)).toBe(true);
        expect(() => {
          request.consumerInput.controlDecision.allowed = false;
        }).toThrow();
        expect(request).not.toHaveProperty("routing");
        expect(request).not.toHaveProperty("action");
        return "Use the saved reference as implementation context.";
      },
    });

    expect(Object.isFrozen(invokeTextConsumer)).toBe(true);
    await expect(invokeTextConsumer(input)).resolves.toBe(
      "Use the saved reference as implementation context.",
    );
    expect(providerCalls).toBe(1);
    expect(input).toEqual(before);
  });

  test.each([
    ["extra action field", (input) => {
      input.action = "click";
    }],
    ["missing input kind", (input) => {
      delete input.kind;
    }],
    ["changed schema", (input) => {
      input.schemaVersion = "9.9.9";
    }],
    ["changed context", (input) => {
      input.attachmentContext.markdown = "changed";
    }],
    ["extra context routing field", (input) => {
      input.attachmentContext.routingHints = [];
    }],
    ["inconsistent decision", (input) => {
      input.controlDecision = { allowed: true, code: "confirmation_denied" };
    }],
    ["extra decision field", (input) => {
      input.controlDecision.action = "click";
    }],
  ])("rejects invalid consumer input before the provider: %s", async (_name, mutate) => {
    const input = validConsumerInput();
    mutate(input);
    let providerCalls = 0;
    const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
      timeoutMs: 1_000,
      invokeProvider: async () => {
        providerCalls += 1;
        return "unused";
      },
    });

    await expect(invokeTextConsumer(input)).rejects.toThrow(
      "Invalid saved-snapshot text-consumer input.",
    );
    expect(providerCalls).toBe(0);
  });

  test.each([
    ["private provider failure", async () => {
      throw new Error("secret endpoint and token details");
    }],
    ["blank text", async () => "   "],
    ["non-text response", async () => ({ text: "click now" })],
  ])("uses one fixed failure surface for %s", async (_name, invokeProvider) => {
    const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
      timeoutMs: 1_000,
      invokeProvider,
    });

    let error;
    try {
      await invokeTextConsumer(validConsumerInput());
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(new Error("Saved-snapshot text provider failed."));
    expect(error).not.toHaveProperty("cause");
    expect(`${error.message}\n${error.stack}`).not.toContain("secret");
    expect(`${error.message}\n${error.stack}`).not.toContain("token");
  });

  test("aborts and rejects at the bounded timeout even when a provider never settles", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
        timeoutMs: 5,
        invokeProvider: async (request) => {
          signal = request.signal;
          return new Promise(() => undefined);
        },
      });

      const pending = invokeTextConsumer(validConsumerInput());
      const rejected = expect(pending).rejects.toThrow(
        "Saved-snapshot text provider failed.",
      );
      await Promise.resolve();
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears the timer after success and preserves opaque text exactly", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const opaque = '  {"action":"click","routing":"model prose only"}  ';
      const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
        timeoutMs: 5,
        invokeProvider: async (request) => {
          signal = request.signal;
          return opaque;
        },
      });

      await expect(invokeTextConsumer(validConsumerInput())).resolves.toBe(opaque);
      await vi.advanceTimersByTimeAsync(10);
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps provider failure separate from the deterministic public boundary", async () => {
    const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
      timeoutMs: 1_000,
      invokeProvider: async () => {
        throw new Error("private endpoint and credential");
      },
    });
    const input = validConsumerInput();
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext: input.attachmentContext,
      controlEvidence: validControlEvidence(),
      invokeTextConsumer,
    });

    expect(result.modelOutput).toEqual({ status: "failed", value: null });
    expect(result.effectiveControlBoundary).toMatchObject({
      state: "eligible_for_host_review",
      allowed: true,
      code: "requirements_satisfied",
      modelFieldsUsed: [],
    });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  test.each([0, -1, 1.5, 600_001, "1000", null])(
    "rejects an invalid timeout before creating an adapter: %j",
    (timeoutMs) => {
      expect(() => createSavedSnapshotTextConsumerAdapter({
        timeoutMs,
        invokeProvider: async () => "unused",
      })).toThrow("Invalid saved-snapshot text provider adapter.");
    },
  );

  test.each([
    undefined,
    null,
    {},
    { timeoutMs: 1_000, invokeProvider: async () => "unused", action: "click" },
  ])("rejects a non-canonical adapter configuration: %j", (options) => {
    expect(() => createSavedSnapshotTextConsumerAdapter(options)).toThrow(
      "Invalid saved-snapshot text provider adapter.",
    );
  });

  test("contains no provider SDK, network, routing, browser, or executor dependency", async () => {
    const source = await readFile(new URL("./provider-adapter.mjs", import.meta.url), "utf8");
    for (const forbidden of [
      "openai",
      "ollama",
      "anthropic",
      "fetch(",
      "http://",
      "https://",
      "routingHints",
      "pageInstanceId",
      "tabId",
      "frameId",
      ".click(",
      "executeAction",
    ]) expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });
});

function validConsumerInput() {
  const acceptedContext = bindSavedSnapshotTextConsumerContext(validAcceptedBundle());
  if (acceptedContext === null) throw new Error("Test fixture did not bind.");
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-text-consumer-input",
    attachmentContext: acceptedContext,
    controlDecision: { allowed: true, code: "requirements_satisfied" },
  };
}

function validAcceptedBundle() {
  return {
    ok: true,
    kind: "ui-attach.saved-snapshot-prompt-bundle",
    sessionId: "session_provider_adapter",
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
    attachmentCount: 1,
    attachmentIds: ["att_save"],
    attachmentRefs: [{
      id: "att_save",
      label: "A",
      target: "button Save",
      role: "button",
      accessibleName: "Save",
      text: "Save",
      primaryLocator: 'page.getByRole("button", { name: "Save" })',
    }],
    markdown: "# Saved snapshot authority\n\nUse A as capture-time implementation context.",
  };
}

function validControlEvidence() {
  return {
    controlAttemptId: "attempt_0123456789abcdef",
    liveRecheck: {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-live-recheck-result",
      controlAttemptId: "attempt_0123456789abcdef",
      receiptId: "receipt_0123456789abcdef",
      origin: "https://app.example.test",
      checkedAt: "2026-07-24T00:00:00.000Z",
      validUntil: "2026-07-24T00:00:45.000Z",
      targets: [{ attachmentId: "att_save", status: "unique_match" }],
    },
    userConfirmation: {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-user-confirmation",
      purpose: "saved_snapshot_browser_control",
      controlAttemptId: "attempt_0123456789abcdef",
      liveRecheckReceiptId: "receipt_0123456789abcdef",
      decision: "confirmed",
      confirmedAt: "2026-07-24T00:00:20.500Z",
    },
    evaluatedAt: "2026-07-24T00:00:21.000Z",
  };
}
