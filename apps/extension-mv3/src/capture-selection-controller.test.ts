// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import type { ContextCaptureResult } from "./capture";
import type { RuntimeCaptureToken } from "./messages";
import {
  createCaptureSelectionController as createRawController,
  type CaptureSelectionControllerOptions,
} from "./capture-selection-controller";

const TOKEN: RuntimeCaptureToken = {
  origin: "https://app.example.test",
  epoch: "epoch-1",
  operationId: "op-1",
  replacement: null,
  routeLease: {
    epoch: "route-epoch-1",
    tabId: 7,
    selectedFrameId: 0,
    segments: [{
      frameId: 0,
      documentId: "document-1",
      origin: "https://app.example.test",
      pathname: "/settings",
    }],
  },
};
const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";

describe("createCaptureSelectionController", () => {
  test("runs the extension transaction in order and publishes its shared anchor", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const target = requireButton();
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(20, 40, 200, 100));
    const order: string[] = [];
    const publishCommitted = vi.fn(async () => { order.push("publish"); });
    const captureTarget = vi.fn(async () => { order.push("capture"); return captureResult(); });
    const controller = createController({
      beginCapture: async () => { order.push("begin"); return { ok: true, data: TOKEN }; },
      captureTarget,
      commitCapture: async () => { order.push("commit"); return successfulCommit(); },
      publishCommitted,
    });
    controller.setEnabled(true);

    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 115,
    }));
    await flushAsyncWork();

    expect(order).toEqual(["begin", "capture", "commit", "publish"]);
    expect(captureTarget).toHaveBeenCalledWith(target, {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
    });
    expect(publishCommitted).toHaveBeenCalledWith(
      target,
      successfulCommit().data,
      captureResult().record,
      { xRatio: 0.25, yRatio: 0.75 },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(publishCommitted.mock.calls[0]?.[4]?.isCurrent()).toBe(true);
    controller.dispose();
  });

  test("creates another annotation when the exact live element is selected again", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const beginCapture = vi.fn(async (replaceItemId?: string | null) => ({
      ok: true as const,
      data: { ...TOKEN, replacement: replaceItemId ? { itemId: replaceItemId } : null },
    }));
    const controller = createController({
      beginCapture,
    });
    controller.setEnabled(true);
    requireButton().click();
    await flushAsyncWork();

    expect(beginCapture).toHaveBeenCalledWith(null);
    controller.dispose();
  });

  test("does not need overlay ownership to add another annotation", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const captureTarget = vi.fn(async () => captureResult());
    const publishFailure = vi.fn(async () => undefined);
    const controller = createController({
      beginCapture,
      captureTarget,
      publishFailure,
    });
    controller.setEnabled(true);
    requireButton().click();
    await flushAsyncWork();

    expect(beginCapture).toHaveBeenCalledWith(null);
    expect(captureTarget).toHaveBeenCalledOnce();
    expect(publishFailure).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("collects coarse device diagnostics only for the one explicitly armed token", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const target = requireButton();
    const device = {
      status: "collected" as const,
      deviceClass: "desktop" as const,
      viewportClass: "large" as const,
      touch: "none" as const,
    };
    const collectMetadataDiagnosticsDevice = vi.fn(() => device);
    const commitCapture = vi.fn(async () => successfulCommit());
    const controller = createController({
      beginCapture: async () => ({
        ok: true,
        data: { ...TOKEN, collectBasicDiagnostics: true },
      }),
      collectMetadataDiagnosticsDevice,
      commitCapture,
    });
    controller.setEnabled(true);

    target.click();
    await flushAsyncWork();

    expect(collectMetadataDiagnosticsDevice).toHaveBeenCalledWith(target);
    expect(commitCapture).toHaveBeenCalledWith(
      expect.objectContaining({ collectBasicDiagnostics: true }),
      captureResult().record,
      device,
    );
    controller.dispose();
  });

  test("does not touch the diagnostics collector without the one-shot token marker", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const collectMetadataDiagnosticsDevice = vi.fn(() => ({ status: "not_available" as const }));
    const commitCapture = vi.fn(async () => successfulCommit());
    const controller = createController({
      collectMetadataDiagnosticsDevice,
      commitCapture,
    });
    controller.setEnabled(true);

    requireButton().click();
    await flushAsyncWork();

    expect(collectMetadataDiagnosticsDevice).not.toHaveBeenCalled();
    expect(commitCapture).toHaveBeenCalledWith(TOKEN, captureResult().record, undefined);
    controller.dispose();
  });

  test.each([
    ["begin", { beginCapture: async () => ({ ok: false as const, error: "begin failed" }) }],
    ["capture", { captureTarget: async () => ({ ok: false as const, error: "capture failed" }) }],
    ["commit", { commitCapture: async () => ({ ok: false as const, error: "commit failed" }) }],
  ] as const)("stops after a rejected %s stage", async (_stage, overrides) => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const target = requireButton();
    const previews: Array<HTMLElement | null> = [];
    const publishFailure = vi.fn(async () => undefined);
    const publishCommitted = vi.fn(async () => undefined);
    const controller = createController({
      ...overrides,
      previewTarget: (next) => previews.push(next),
      publishFailure,
      publishCommitted,
    });
    controller.setEnabled(true);
    target.click();
    await flushAsyncWork();

    expect(publishFailure).toHaveBeenCalledOnce();
    expect(publishCommitted).not.toHaveBeenCalled();
    expect(previews).toEqual([target, null]);
    controller.dispose();
  });

  test.each(["begin", "capture", "commit"] as const)(
    "stops a transaction after navigation invalidates its pending %s boundary",
    async (stage) => {
      document.body.innerHTML = '<button id="target">Save changes</button>';
      const target = requireButton();
      const releaseStage = deferred<void>();
      const beginCapture = vi.fn(async () => {
        if (stage === "begin") await releaseStage.promise;
        return { ok: true as const, data: TOKEN };
      });
      const captureTarget = vi.fn(async () => {
        if (stage === "capture") await releaseStage.promise;
        return captureResult();
      });
      const commitCapture = vi.fn(async () => {
        if (stage === "commit") await releaseStage.promise;
        return successfulCommit();
      });
      const publishFailure = vi.fn(async () => undefined);
      const publishCommitted = vi.fn(async () => undefined);
      const previews: Array<HTMLElement | null> = [];
      const controller = createController({
        beginCapture,
        captureTarget,
        commitCapture,
        publishFailure,
        publishCommitted,
        previewTarget: (next) => previews.push(next),
      });
      controller.setEnabled(true);
      target.click();
      await flushAsyncWork();

      controller.disableForNavigation();
      releaseStage.resolve();
      await flushAsyncWork();

      expect(beginCapture).toHaveBeenCalledOnce();
      expect(captureTarget).toHaveBeenCalledTimes(stage === "begin" ? 0 : 1);
      expect(commitCapture).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
      expect(publishCommitted).not.toHaveBeenCalled();
      expect(publishFailure).not.toHaveBeenCalled();
      expect(previews).toEqual([target, null]);
      controller.dispose();
    },
  );

  test("invalidates the context exposed to an in-flight publisher on dispose", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const releasePublish = deferred<void>();
    let isCurrent: (() => boolean) | undefined;
    const publishCommitted = vi.fn(async (_target, _receipt, _record, _anchor, context) => {
      isCurrent = context.isCurrent;
      await releasePublish.promise;
    });
    const controller = createController({ publishCommitted });
    controller.setEnabled(true);
    requireButton().click();
    await flushAsyncWork();

    expect(isCurrent?.()).toBe(true);
    controller.dispose();
    expect(isCurrent?.()).toBe(false);
    releasePublish.resolve();
    await flushAsyncWork();
  });

  test("serializes rapid page selections before publishing overlays", async () => {
    document.body.innerHTML = '<button id="first">First</button><button id="second">Second</button>';
    const firstRelease = deferred<void>();
    const order: string[] = [];
    const controller = createController({
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget: async (target) => {
        order.push(`capture:${target.id}`);
        if (target.id === "first") await firstRelease.promise;
        return captureResult();
      },
      publishCommitted: async (target) => { order.push(`publish:${target.id}`); },
    });
    controller.setEnabled(true);
    requireButton("#first").click();
    requireButton("#second").click();
    await flushAsyncWork();
    expect(order).toEqual(["capture:first"]);

    firstRelease.resolve();
    await flushAsyncWork();
    expect(order).toEqual([
      "capture:first",
      "publish:first",
      "capture:second",
      "publish:second",
    ]);
    controller.dispose();
  });

  test("keeps page-synthesized click and Escape outside the extension authority", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const beginCapture = vi.fn(async () => ({ ok: true as const, data: TOKEN }));
    const disableSelection = vi.fn(async () => undefined);
    const controller = createRawController({
      root: document,
      beginCapture,
      captureTarget: async () => captureResult(),
      commitCapture: async () => successfulCommit(),
      publishFailure: async () => undefined,
      publishCommitted: async () => undefined,
      disableSelection,
    });
    controller.setEnabled(true);
    requireButton().click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await flushAsyncWork();

    expect(beginCapture).not.toHaveBeenCalled();
    expect(disableSelection).not.toHaveBeenCalled();
    expect(controller.isEnabled()).toBe(true);
    controller.dispose();
  });

  test("converts unexpected adapter failures to one bounded error", async () => {
    document.body.innerHTML = '<button id="target">Save changes</button>';
    const publishFailure = vi.fn(async () => undefined);
    const controller = createController({
      captureTarget: async () => { throw new Error("private token"); },
      publishFailure,
    });
    controller.setEnabled(true);
    requireButton().click();
    await flushAsyncWork();

    expect(publishFailure).toHaveBeenCalledWith(SAFE_CAPTURE_ERROR);
    expect(JSON.stringify(publishFailure.mock.calls)).not.toContain("private token");
    controller.dispose();
  });
});

function createController(
  overrides: Partial<CaptureSelectionControllerOptions> = {},
) {
  return createRawController({
    root: document,
    beginCapture: async () => ({ ok: true, data: TOKEN }),
    captureTarget: async () => captureResult(),
    commitCapture: async () => successfulCommit(),
    publishFailure: async () => undefined,
    publishCommitted: async () => undefined,
    isTrustedActivationEvent: () => true,
    ...overrides,
  });
}

function captureResult(): Extract<ContextCaptureResult, { ok: true }> {
  return {
    ok: true,
    json: "{}",
    record: {
      origin: "https://app.example.test",
      pageUrl: "https://app.example.test/settings",
      pageTitle: "Settings",
      attachment: {
        schemaVersion: "0.3.0",
        id: "att_save",
        capturedAt: "2026-07-11T10:00:00.000Z",
        source: { kind: "web", url: "https://app.example.test/settings", title: "Settings" },
        element: {
          tagName: "button",
          role: "button",
          text: "Save changes",
          accessibleName: "Save changes",
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          visible: true,
          enabled: true,
        },
        style: {
          display: "block",
          color: "rgb(0, 0, 0)",
          backgroundColor: "rgb(255, 255, 255)",
        },
        context: { parentSummary: null, nearbyText: [], selectorHints: [] },
        locatorBundle: { primary: null, candidates: [], stability: null },
        policy: {
          disclosureMode: "agent_safe",
          redactionLevel: "strict",
          actionMode: "suggest_patch",
          allowScreenshot: false,
          allowDomSnippet: false,
          allowNetworkSend: false,
          allowedDomains: ["https://app.example.test"],
          redactedFields: [],
          sensitiveHints: [],
          includedSensitiveFields: [],
        },
        artifacts: { screenshotCrop: null, overlayImage: null },
      },
      intent: "",
      markdown: "# Save changes",
      capturedAt: "2026-07-11T10:00:00.000Z",
    },
  };
}

function successfulCommit() {
  return {
    ok: true as const,
    data: {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    },
  };
}

function requireButton(selector = "#target"): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing ${selector}`);
  return button;
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  } as DOMRect;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
