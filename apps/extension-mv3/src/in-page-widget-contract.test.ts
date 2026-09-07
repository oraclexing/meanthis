import { describe, expect, test } from "vitest";
import {
  UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
  UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
  createInPageWidgetLifecyclePortName,
  isInPageWidgetPrivateConnectEvent,
  parseInPageWidgetActionAckMessage,
  parseInPageWidgetActionMessage,
  parseInPageWidgetCommand,
  parseInPageWidgetCommandEnvelope,
  parseInPageWidgetLifecyclePortName,
  parseInPageWidgetPhaseMessage,
  parseInPageWidgetReadyMessage,
} from "./in-page-widget-contract";

const SURFACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const CAPABILITY = "A".repeat(43);

describe("in-page widget capability contract", () => {
  test("accepts only the narrow lease-bound command vocabulary", () => {
    expect(parseInPageWidgetCommand({ type: "ui-attach:widget-session-read" })).toEqual({
      type: "ui-attach:widget-session-read",
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-task-note-save",
      expectedEpoch: "epoch-1",
      itemId: "item-a",
      taskNote: "",
    })).not.toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-annotation-lifecycle-set",
      expectedEpoch: "epoch-1",
      itemId: "item-a",
      annotationId: "opaque-annotation-a",
      expectedState: "open",
      nextState: "resolved",
    })).toEqual({
      type: "ui-attach:widget-annotation-lifecycle-set",
      expectedEpoch: "epoch-1",
      itemId: "item-a",
      annotationId: "opaque-annotation-a",
      expectedState: "open",
      nextState: "resolved",
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-session-clear",
      expectedEpoch: "epoch-1",
      operationId: "clear-site-1",
      scope: "active-origin",
    })).toEqual({
      type: "ui-attach:widget-session-clear",
      expectedEpoch: "epoch-1",
      operationId: "clear-site-1",
      scope: "active-origin",
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:session-update-intent",
      origin: "https://attacker.example",
      epoch: "epoch-1",
      itemId: "item-a",
      intent: "replace",
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:local-agent-bridge",
      action: "repair-connection",
    })).toBeNull();
    for (const type of [
      "ui-attach:widget-frame-scope-list",
      "ui-attach:widget-bridge-create-invitation",
      "ui-attach:widget-bridge-refresh",
      "ui-attach:widget-bridge-disconnect",
      "ui-attach:widget-disclosure-read",
      "ui-attach:widget-disclosure-acknowledge",
    ]) {
      expect(parseInPageWidgetCommand({ type })).toEqual({ type });
    }
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-frame-scope-select",
      frameId: 3,
      documentId: "frame-document",
      origin: "https://frame.example",
      pathname: "/editor",
      expectedGeneration: 4,
    })).toEqual({
      type: "ui-attach:widget-frame-scope-select",
      frameId: 3,
      documentId: "frame-document",
      origin: "https://frame.example",
      pathname: "/editor",
      expectedGeneration: 4,
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: true,
      expectedGeneration: 4,
    })).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: true,
      expectedGeneration: 4,
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: false,
      expectedGeneration: 5,
    })).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: false,
      expectedGeneration: 5,
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-frame-scope-select",
      tabId: 7,
      frameId: 3,
      documentId: "frame-document",
      origin: "https://frame.example",
      pathname: "/editor",
      expectedGeneration: 4,
    })).toBeNull();
  });

  test("rejects extra fields, control characters, and unbounded text", () => {
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: 0,
      collectBasicDiagnostics: true,
    })).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: 0,
      collectBasicDiagnostics: true,
    });
    for (const command of [
      {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "explicit",
        expectedGeneration: 0,
        collectBasicDiagnostics: false,
      },
      {
        type: "ui-attach:widget-selection-set",
        enabled: false,
        intent: "explicit",
        expectedGeneration: 0,
        collectBasicDiagnostics: true,
      },
      {
        type: "ui-attach:widget-selection-set",
        enabled: true,
        intent: "resume",
        expectedGeneration: 0,
        collectBasicDiagnostics: true,
      },
    ]) expect(parseInPageWidgetCommand(command)).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: 0,
      tabId: 7,
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      expectedGeneration: 0,
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-selection-set",
      enabled: false,
      intent: "resume",
      expectedGeneration: 0,
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: Number.MAX_SAFE_INTEGER + 1,
    })).toBeNull();
    for (const command of [
      { type: "ui-attach:widget-basic-diagnostics-set" },
      { type: "ui-attach:widget-basic-diagnostics-set", enabled: undefined },
      { type: "ui-attach:widget-basic-diagnostics-set", enabled: "true" },
      { type: "ui-attach:widget-basic-diagnostics-set", enabled: true },
      { type: "ui-attach:widget-basic-diagnostics-set", enabled: true, expectedGeneration: -1 },
      {
        type: "ui-attach:widget-basic-diagnostics-set",
        enabled: true,
        expectedGeneration: 0,
        rawViewportWidth: 1920,
      },
    ]) expect(parseInPageWidgetCommand(command)).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-session-clear",
      expectedEpoch: null,
      operationId: " padded-operation ",
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-item-remove",
      expectedEpoch: "epoch-1",
      itemId: "item\nsecret",
    })).toBeNull();
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-task-note-save",
      expectedEpoch: "epoch-1",
      itemId: "item-a",
      taskNote: "x".repeat(16_385),
    })).toBeNull();
    for (const command of [
      {
        type: "ui-attach:widget-annotation-lifecycle-set",
        expectedEpoch: "epoch-1",
        itemId: "item-a",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "open",
      },
      {
        type: "ui-attach:widget-annotation-lifecycle-set",
        expectedEpoch: "epoch-1",
        itemId: "item-a",
        annotationId: undefined,
        expectedState: "open",
        nextState: "resolved",
      },
      {
        type: "ui-attach:widget-annotation-lifecycle-set",
        expectedEpoch: "epoch-1",
        itemId: "item-a",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "closed",
      },
      {
        type: "ui-attach:widget-annotation-lifecycle-set",
        expectedEpoch: "epoch-1",
        itemId: "item-a",
        annotationId: "opaque-annotation-a",
        expectedState: "open",
        nextState: "resolved",
        origin: "https://attacker.example",
      },
    ]) expect(parseInPageWidgetCommand(command)).toBeNull();
  });

  test("requires trusted exact Agent lifecycle control commands without invoking accessors", () => {
    const reference = {
      operationId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "a".repeat(64),
      ownerGeneration: 2,
      connectionGeneration: 3,
    };
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-lifecycle-control-read-next",
    })).toEqual({ type: "ui-attach:widget-lifecycle-control-read-next" });
    for (const action of ["approve", "reject"] as const) {
      expect(parseInPageWidgetCommand({
        type: `ui-attach:widget-lifecycle-control-${action}`,
        reference,
        userActivation: true,
      })).toEqual({
        type: `ui-attach:widget-lifecycle-control-${action}`,
        reference: expect.objectContaining(reference),
        userActivation: true,
      });
      expect(parseInPageWidgetCommand({
        type: `ui-attach:widget-lifecycle-control-${action}`,
        reference,
        userActivation: false,
      })).toBeNull();
    }

    let getterCalls = 0;
    const accessorReference = Object.defineProperty({}, "operationId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return reference.operationId;
      },
    });
    expect(parseInPageWidgetCommand({
      type: "ui-attach:widget-lifecycle-control-approve",
      reference: accessorReference,
      userActivation: true,
    })).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("requires an exact surface capability envelope", () => {
    const command = { type: "ui-attach:widget-session-read" };
    expect(parseInPageWidgetCommandEnvelope({
      type: UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
      surfaceId: SURFACE_ID,
      capability: CAPABILITY,
      command,
    })).not.toBeNull();
    expect(parseInPageWidgetCommandEnvelope({
      type: UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
      surfaceId: SURFACE_ID,
      capability: CAPABILITY,
      command,
      origin: "https://attacker.example",
    })).toBeNull();
  });

  test("round-trips the exact private lifecycle port name", () => {
    const name = createInPageWidgetLifecyclePortName(SURFACE_ID, CAPABILITY);
    expect(parseInPageWidgetLifecyclePortName(name)).toEqual({
      surfaceId: SURFACE_ID,
      capability: CAPABILITY,
    });
    expect(parseInPageWidgetLifecyclePortName(`${name}:extra`)).toBeNull();
    expect(parseInPageWidgetLifecyclePortName(name.replace(CAPABILITY, "secret"))).toBeNull();
  });

  test("accepts only the exact authenticated lifecycle ready acknowledgement", () => {
    expect(parseInPageWidgetReadyMessage({
      type: "ui-attach:in-page-widget-ready",
      surfaceId: SURFACE_ID,
    })).not.toBeNull();
    expect(parseInPageWidgetReadyMessage({
      type: "ui-attach:in-page-widget-ready",
      surfaceId: SURFACE_ID,
      capability: CAPABILITY,
    })).toBeNull();
  });

  test("binds each lifecycle action and acknowledgement to an exact opaque action id", () => {
    const actionId = "3c9e713d-63d3-42f0-a190-c8f4af77dfd2";
    expect(parseInPageWidgetActionMessage({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId,
      action: "more",
      itemId: "item-a",
    })).toEqual({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId,
      action: "more",
      itemId: "item-a",
    });
    expect(parseInPageWidgetActionMessage({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      action: "more",
      itemId: "item-a",
    })).toBeNull();
    expect(parseInPageWidgetActionMessage({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: "predictable",
      action: "more",
      itemId: "item-a",
    })).toBeNull();

    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "consumed",
    })).toEqual({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "consumed",
    });
    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "rejected",
    })).toEqual({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "rejected",
    });
    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "consumed",
      capability: CAPABILITY,
    })).toBeNull();
    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId: "wrong",
      outcome: "rejected",
    })).toBeNull();
    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      consumed: false,
    })).toBeNull();
    expect(parseInPageWidgetActionAckMessage({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId,
      outcome: "retryable",
    })).toBeNull();
  });

  test("accepts a private connect from the parent or an opaque extension sender", () => {
    const parent = {} as WindowProxy;
    const port = {} as MessagePort;
    const candidate = {
      data: { type: "meanthis.widget.connect" },
      ports: [port],
    };

    expect(isInPageWidgetPrivateConnectEvent({ ...candidate, source: parent }, parent)).toBe(true);
    // Chrome intentionally redacts MessageEvent.source for messages sent by
    // privileged extension code into a web-accessible extension frame.
    expect(isInPageWidgetPrivateConnectEvent({ ...candidate, source: null }, parent)).toBe(true);
    expect(isInPageWidgetPrivateConnectEvent({ ...candidate, source: {} as WindowProxy }, parent))
      .toBe(false);
    expect(isInPageWidgetPrivateConnectEvent({ ...candidate, source: null, ports: [] }, parent))
      .toBe(false);
    expect(isInPageWidgetPrivateConnectEvent({
      data: { type: "meanthis.widget.connect", extra: true },
      ports: [port],
      source: null,
    }, parent)).toBe(false);
  });

  test("accepts only bounded non-secret private handshake phases", () => {
    expect(parseInPageWidgetPhaseMessage({
      type: "meanthis.widget.phase",
      phase: "runtime-register-ok",
    })).toEqual({
      type: "meanthis.widget.phase",
      phase: "runtime-register-ok",
    });
    for (const phase of [
      "runtime-register-invalid-response",
      "runtime-register-handler-exception",
      "runtime-register-untrusted-response",
      "runtime-register-unknown-issue",
      "authenticated-ui-failed",
    ] as const) {
      expect(parseInPageWidgetPhaseMessage({
        type: "meanthis.widget.phase",
        phase,
      })).toEqual({ type: "meanthis.widget.phase", phase });
    }
    expect(parseInPageWidgetPhaseMessage({
      type: "meanthis.widget.phase",
      phase: "runtime-register-ok",
      capability: CAPABILITY,
    })).toBeNull();
    expect(parseInPageWidgetPhaseMessage({
      type: "meanthis.widget.phase",
      phase: "token-read",
    })).toBeNull();
  });
});
