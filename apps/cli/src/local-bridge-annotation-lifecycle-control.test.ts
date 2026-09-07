import { describe, expect, test } from "vitest";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
} from "@meanthis/schema";
import { createAttachment } from "../../extension-mv3/test/session-fixtures";
import { createLocalBridgeState, startLocalBridgeHttpServer } from "./local-bridge";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentBodyRequestAuth,
  verifyLocalBridgeAgentBodyResponseProof,
} from "./local-bridge-agent-auth";

const EXTENSION_ORIGIN = "chrome-extension://bbiiccaidhlhdagmabkogleldjdnmlfn";
const INSTALLATION_ID = "5ea6b70f-48e8-4a7b-bc91-d943b0ef10f3";
const NOW = "2026-09-01T03:00:00.000Z";
const AGENT_TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};

function fixture() {
  let currentTime = Date.parse(NOW);
  const state = createLocalBridgeState({
    now: () => new Date(currentTime),
    randomInt: () => 482_193,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const paired = state.pair(EXTENSION_ORIGIN, {
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-pair",
    pairingCode: "482-193",
    installationId: INSTALLATION_ID,
  });
  if (!paired.ok) throw new Error(paired.code);
  expect(state.publish(EXTENSION_ORIGIN, paired.value.token, snapshot("open", 7, NOW))).toMatchObject({
    ok: true,
  });
  const proposal = {
    schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
    kind: ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
    operationId: "11111111-1111-4111-8111-111111111111",
    instanceId: paired.value.instanceId,
    captureId: "session-control",
    expectedSequence: 7,
    annotationId: "annotation-control",
    expectedState: "open" as const,
    nextState: "resolved" as const,
  };
  return {
    state,
    paired: paired.value,
    proposal,
    setTime(value: string) { currentTime = Date.parse(value); },
  };
}

describe("local bridge annotation lifecycle control owner", () => {
  test("binds submit, trusted claim, durable snapshot readback, and terminal receipt", () => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    expect(submitted.ok && submitted.value.record).toMatchObject({
      proposal: f.proposal,
      phase: "awaiting_user",
      status: { status: "pending" },
    });
    if (!submitted.ok) return;
    const reference = submitted.value.reference;
    expect(f.state.readNextAnnotationLifecycleOperation(EXTENSION_ORIGIN, f.paired.token))
      .toMatchObject({ ok: true, value: { record: { proposal: f.proposal } } });

    // A byte-new bridge snapshot may advance for unrelated publication work
    // while the exact annotation identity and lifecycle state remain current.
    expect(f.state.publish(
      EXTENSION_ORIGIN,
      f.paired.token,
      snapshot("open", 8, "2026-09-01T03:00:05.000Z"),
    )).toMatchObject({ ok: true });
    expect(f.state.submitAnnotationLifecycleOperation(f.proposal)).toEqual(submitted);

    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      reference,
    );
    expect(claimed.ok && claimed.value.record.phase).toBe("executing");
    if (!claimed.ok) return;

    expect(f.state.publish(
      EXTENSION_ORIGIN,
      f.paired.token,
      snapshot("resolved", 9, "2026-09-01T03:00:20.000Z"),
    )).toMatchObject({ ok: true });
    const receipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: reference.fingerprint,
      receiptId: "ledger-1111111111114111",
      status: "succeeded" as const,
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: "resolved" as const,
      readbackAuthority: "current_snapshot" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    };
    f.setTime(receipt.observedAt);
    const finalized = f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference, approval: claimed.value.approval, receipt },
    );
    expect(finalized.ok && finalized.value.record).toMatchObject({
      phase: "applied",
      receipt,
      status: { status: "succeeded", resultingState: "resolved" },
    });
    expect(f.state.readAnnotationLifecycleOperation(reference)).toEqual(finalized);
  });

  test.each([
    "missing snapshot",
    "old sequence",
    "wrong capture",
    "wrong lifecycle state",
    "wrong annotation timestamp",
  ] as const)("rejects succeeded current_snapshot receipt with %s", (scenario) => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    if (!claimed.ok) throw new Error(claimed.code);

    if (scenario === "missing snapshot") {
      expect(f.state.clearSharedCapture(EXTENSION_ORIGIN, f.paired.token)).toMatchObject({ ok: true });
    } else if (scenario !== "old sequence") {
      const next = snapshot(
        scenario === "wrong lifecycle state" ? "open" : "resolved",
        8,
        scenario === "wrong annotation timestamp"
          ? "2026-09-01T03:00:19.000Z"
          : "2026-09-01T03:00:20.000Z",
      );
      if (scenario === "wrong capture") next.capture.captureId = "other-capture";
      expect(f.state.publish(EXTENSION_ORIGIN, f.paired.token, next)).toMatchObject({ ok: true });
    }

    const receipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: submitted.value.reference.fingerprint,
      receiptId: `current-${scenario.replaceAll(" ", "-")}`,
      status: "succeeded" as const,
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: "resolved" as const,
      readbackAuthority: "current_snapshot" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    };
    f.setTime(receipt.observedAt);
    expect(f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference: submitted.value.reference, approval: claimed.value.approval, receipt },
    )).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.readAnnotationLifecycleOperation(submitted.value.reference))
      .toMatchObject({ ok: true, value: { record: { phase: "executing" } } });
  });

  test.each([
    "missing snapshot",
    "old snapshot",
  ] as const)("rejects succeeded durable_ledger receipt with %s", (scenario) => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    if (!claimed.ok) throw new Error(claimed.code);
    if (scenario === "missing snapshot") {
      expect(f.state.clearSharedCapture(EXTENSION_ORIGIN, f.paired.token)).toMatchObject({ ok: true });
    }
    const receipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: submitted.value.reference.fingerprint,
      receiptId: `ledger-${scenario.replaceAll(" ", "-")}`,
      status: "succeeded" as const,
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: "resolved" as const,
      readbackAuthority: "durable_ledger" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    };
    f.setTime(receipt.observedAt);
    expect(f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference: submitted.value.reference, approval: claimed.value.approval, receipt },
    )).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.readAnnotationLifecycleOperation(submitted.value.reference))
      .toMatchObject({ ok: true, value: { record: { phase: "executing" } } });
  });

  test("accepts a durable_ledger receipt only after the exact current snapshot is published", () => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    if (!claimed.ok) throw new Error(claimed.code);
    const observedAt = "2026-09-01T03:00:20.000Z";
    expect(f.state.publish(
      EXTENSION_ORIGIN,
      f.paired.token,
      snapshot("resolved", 8, observedAt),
    )).toMatchObject({ ok: true });
    const receipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: submitted.value.reference.fingerprint,
      receiptId: "ledger-current-snapshot",
      status: "succeeded" as const,
      observedAt,
      resultingState: "resolved" as const,
      readbackAuthority: "durable_ledger" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    };
    f.setTime(receipt.observedAt);
    const finalized = f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference: submitted.value.reference, approval: claimed.value.approval, receipt },
    );
    expect(finalized.ok && finalized.value.record).toMatchObject({
      phase: "applied",
      receipt: { readbackAuthority: "durable_ledger", resultingState: "resolved" },
    });
  });

  test.each([
    "resulting state",
    "operation id",
    "fingerprint",
  ] as const)("keeps durable_ledger finalization bound to exact %s", (scenario) => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    if (!claimed.ok) throw new Error(claimed.code);
    const receipt: Record<string, unknown> = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: submitted.value.reference.fingerprint,
      receiptId: `ledger-mismatch-${scenario.replaceAll(" ", "-")}`,
      status: "succeeded",
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: "resolved",
      readbackAuthority: "durable_ledger",
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
    if (scenario === "resulting state") receipt.resultingState = "open";
    if (scenario === "operation id") receipt.operationId = "22222222-2222-4222-8222-222222222222";
    if (scenario === "fingerprint") receipt.fingerprint = "b".repeat(64);
    f.setTime(receipt.observedAt as string);
    expect(f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference: submitted.value.reference, approval: claimed.value.approval, receipt },
    )).toEqual({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(f.state.readAnnotationLifecycleOperation(submitted.value.reference))
      .toMatchObject({ ok: true, value: { record: { phase: "executing" } } });
  });

  test.each([
    "missing authority",
    "unknown authority",
  ] as const)("fails closed for %s on owner finalization", (scenario) => {
    const f = fixture();
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    f.setTime("2026-09-01T03:00:10.000Z");
    const claimed = f.state.claimAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    if (!claimed.ok) throw new Error(claimed.code);
    const receipt = {
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_RECEIPT_KIND,
      operationId: f.proposal.operationId,
      fingerprint: submitted.value.reference.fingerprint,
      receiptId: `authority-${scenario.replaceAll(" ", "-")}`,
      status: "succeeded" as const,
      observedAt: "2026-09-01T03:00:20.000Z",
      resultingState: "resolved" as const,
      readbackAuthority: "current_snapshot" as const,
      executionAuthority: {
        grantedByCapture: false as const,
        browserControl: false as const,
        liveDomMutation: false as const,
      },
    } as Record<string, unknown>;
    if (scenario === "missing authority") delete receipt.readbackAuthority;
    else receipt.readbackAuthority = "snapshot";
    f.setTime(receipt.observedAt as string);
    const finalized = f.state.finalizeAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      { reference: submitted.value.reference, approval: claimed.value.approval, receipt },
    );
    expect(finalized.ok).toBe(false);
    expect(f.state.readAnnotationLifecycleOperation(submitted.value.reference))
      .toMatchObject({ ok: true, value: { record: { phase: "executing" } } });
  });

  test("rejects stale bindings and allows an exact user rejection without mutation", () => {
    const f = fixture();
    expect(f.state.submitAnnotationLifecycleOperation({
      ...f.proposal,
      expectedSequence: 6,
    })).toMatchObject({ ok: false, code: "SEQUENCE_MISMATCH" });
    const submitted = f.state.submitAnnotationLifecycleOperation(f.proposal);
    if (!submitted.ok) throw new Error(submitted.code);
    expect(f.state.publish(
      EXTENSION_ORIGIN,
      f.paired.token,
      snapshot("open", 8, "2026-09-01T03:00:04.000Z"),
    )).toMatchObject({ ok: true });
    expect(f.state.clearSharedCapture(EXTENSION_ORIGIN, f.paired.token)).toMatchObject({ ok: true });
    f.setTime("2026-09-01T03:00:05.000Z");
    const rejected = f.state.rejectAnnotationLifecycleOperation(
      EXTENSION_ORIGIN,
      f.paired.token,
      submitted.value.reference,
    );
    expect(rejected.ok && rejected.value.record).toMatchObject({
      phase: "rejected",
      status: { status: "rejected", resultingState: null },
    });
    expect(f.state.readNextAnnotationLifecycleOperation(EXTENSION_ORIGIN, f.paired.token))
      .toEqual({ ok: true, value: null });
    const readback = f.state.readInstance(f.paired.instanceId);
    expect(readback.ok && readback.value.snapshot).toBeNull();
  });

  test("keeps the production route unreachable until enabled, then authenticates exact raw bytes", async () => {
    const disabled = fixture();
    const disabledServer = await startLocalBridgeHttpServer(disabled.state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
    });
    try {
      const body = Buffer.from(JSON.stringify(disabled.proposal));
      const auth = createLocalBridgeAgentBodyRequestAuth(
        AGENT_TOKEN,
        "/v1/agent/annotation-lifecycle/proposals",
        body,
        { method: "POST" },
      );
      const response = await fetch(
        `${disabledServer.origin}/v1/agent/annotation-lifecycle/proposals`,
        {
          method: "POST",
          headers: { ...auth.headers, "content-type": "application/json" },
          body,
        },
      );
      expect(response.status).toBe(404);
    } finally {
      await disabledServer.close();
    }

    const enabled = fixture();
    const server = await startLocalBridgeHttpServer(enabled.state, {
      port: 0,
      agentToken: AGENT_TOKEN,
      ownerIdentity: OWNER_IDENTITY,
      enableAnnotationLifecycleControl: true,
    });
    try {
      const path = "/v1/agent/annotation-lifecycle/proposals";
      const body = Buffer.from(JSON.stringify(enabled.proposal));
      const auth = createLocalBridgeAgentBodyRequestAuth(AGENT_TOKEN, path, body, {
        method: "POST",
      });
      const response = await fetch(`${server.origin}${path}`, {
        method: "POST",
        headers: { ...auth.headers, "content-type": "application/json" },
        body,
      });
      const responseBytes = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(201);
      expect(verifyLocalBridgeAgentBodyResponseProof(
        AGENT_TOKEN,
        auth,
        response.status,
        responseBytes,
        response.headers.get(RESPONSE_PROOF_HEADER),
      )).toBe(true);
      const submitted = JSON.parse(responseBytes.toString("utf8"));
      expect(submitted.data.record).toMatchObject({ phase: "awaiting_user" });

      const pending = await fetch(`${server.origin}/v1/annotation-lifecycle/proposals`, {
        headers: {
          authorization: `Bearer ${enabled.paired.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({
        kind: "ui-attach.annotation-lifecycle-operation-delivery",
        data: { record: { proposal: enabled.proposal, phase: "awaiting_user" } },
      });

      const originlessPending = await fetch(`${server.origin}/v1/annotation-lifecycle/proposals`, {
        headers: { authorization: `Bearer ${enabled.paired.token}` },
      });
      expect(originlessPending.status).toBe(200);
      expect(await originlessPending.json()).toMatchObject({
        kind: "ui-attach.annotation-lifecycle-operation-delivery",
        data: { record: { proposal: enabled.proposal, phase: "awaiting_user" } },
      });

      const deniedOriginlessPending = await fetch(
        `${server.origin}/v1/annotation-lifecycle/proposals`,
        { headers: { authorization: "Bearer invalid" } },
      );
      expect(deniedOriginlessPending.status).toBe(401);

      const tampered = await fetch(`${server.origin}${path}`, {
        method: "POST",
        headers: { ...auth.headers, "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ ...enabled.proposal, expectedSequence: 8 })),
      });
      expect(tampered.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("serves an exact authority envelope only for the paired bearer", async () => {
    const f = fixture();
    const server = await startLocalBridgeHttpServer(f.state, {
      port: 0,
      enableAnnotationLifecycleControl: true,
    });
    const path = "/v1/annotation-lifecycle/authority";
    try {
      const missing = await fetch(`${server.origin}${path}`, {
        headers: { origin: EXTENSION_ORIGIN },
      });
      expect(missing.status).toBe(401);

      const invalid = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: "Bearer invalid",
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toMatchObject({
        schemaVersion: "0.1.0",
        kind: "ui-attach.local-bridge-error",
        ok: false,
        error: { code: "AUTH_DENIED" },
      });

      const wrongOrigin = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${f.paired.token}`,
          origin: "https://evil.example.test",
        },
      });
      expect(wrongOrigin.status).toBe(403);

      const direct = f.state.readAnnotationLifecycleControlAuthority(
        EXTENSION_ORIGIN,
        f.paired.token,
      );
      expect(direct.ok).toBe(true);
      if (!direct.ok) return;
      const response = await fetch(`${server.origin}${path}`, {
        headers: {
          authorization: `Bearer ${f.paired.token}`,
          origin: EXTENSION_ORIGIN,
        },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(["data", "kind", "ok", "schemaVersion"]);
      expect(Object.keys(body.data).sort()).toEqual(["connectionGeneration", "ownerGeneration"]);
      expect(body).toEqual({
        schemaVersion: "0.1.0",
        kind: "ui-attach.annotation-lifecycle-control-authority",
        ok: true,
        data: direct.value,
      });

      const originless = await fetch(`${server.origin}${path}`, {
        headers: { authorization: `Bearer ${f.paired.token}` },
      });
      expect(originless.status).toBe(200);
      expect(await originless.json()).toEqual(body);
    } finally {
      await server.close();
    }
  });
});

function snapshot(state: "open" | "resolved", sequence: number, updatedAt: string) {
  const attachment = createAttachment("agent_safe");
  return {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.local-bridge-snapshot" as const,
    sequence,
    publishedAt: updatedAt,
    page: {
      pageInstanceId: "chromium-tab:10:frame:0",
      route: "https://app.example.test/settings",
    },
    attachmentCount: 1,
    agentCopy: "# MeanThis Capture Bundle",
    capture: {
      captureId: "session-control",
      title: "Settings",
      origin: "https://app.example.test",
      updatedAt,
      authority: "capture_time" as const,
      disclosureMode: "agent_safe" as const,
      annotationLifecycleVersion: "v1" as const,
      targets: [{
        targetId: "target_control",
        attachmentId: attachment.id,
        label: "Save",
        taskNote: "",
        annotationId: "annotation-control",
        annotationIdScope: "capture_session" as const,
        annotationCreatedAt: NOW,
        annotationUpdatedAt: updatedAt,
        annotationLifecycle: {
          state,
          resolvedAt: state === "resolved" ? updatedAt : null,
        },
        attachment,
      }],
    },
  };
}
