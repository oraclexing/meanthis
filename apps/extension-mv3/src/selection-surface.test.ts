// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import type { ContextCaptureResult } from "./capture";
import { createCaptureRecord } from "../test/session-fixtures";
import { createSelectionSurfaceController } from "./selection-surface";
import { createCaptureSelectionController } from "./capture-selection-controller";
import type { RuntimeCaptureToken } from "./messages";

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

describe("selection surface", () => {
  test("removes orphaned selection blockers left by a reloaded content script", () => {
    const staleHost = document.createElement("div");
    staleHost.dataset.uiAttachSelectionSurface = "true";
    const staleGuard = document.createElement("style");
    staleGuard.dataset.uiAttachSelectionFrameGuard = "true";
    document.documentElement.append(staleGuard, staleHost);

    const surface = createSelectionSurfaceController({ root: document });
    surface.setEnabled(true);

    expect(staleHost.isConnected).toBe(false);
    expect(staleGuard.isConnected).toBe(false);
    expect(document.querySelectorAll("[data-ui-attach-selection-surface]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-ui-attach-selection-frame-guard]")).toHaveLength(1);
    surface.dispose();
  });

  test("maps a trusted surface click to the iframe host and removes itself on stop", async () => {
    document.body.innerHTML = '<iframe id="docs" title="Documentation"></iframe>';
    const frame = document.querySelector("#docs");
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error("iframe fixture missing");
    }
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      bottom: 210,
      height: 180,
      left: 20,
      right: 340,
      top: 30,
      width: 320,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    });
    const hitTest = vi.fn(() => {
      expect(document.querySelector("[data-ui-attach-selection-frame-guard]")).toBeNull();
      return frame;
    });
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest,
    });
    const captureTarget = vi.fn(async () => createCaptureResult());
    const controller = createCaptureSelectionController({
      root: document,
      beginCapture: async () => ({ ok: true, data: TOKEN }),
      captureTarget,
      commitCapture: async () => ({
        ok: true,
        data: { itemId: "att_frame", attachmentId: "att_frame", label: "A", count: 1 },
      }),
      publishFailure: async () => {},
      publishCommitted: async () => {},
      pointerEventTarget: surface.eventTarget,
      resolveTarget: (event) => surface.resolveTarget(event),
      onEnabledChange: (enabled) => surface.setEnabled(enabled),
      isTrustedActivationEvent: () => true,
    });

    controller.setEnabled(true);
    const host = document.querySelector<HTMLElement>("[data-ui-attach-selection-surface]");
    expect(host).not.toBeNull();
    expect(host?.hasAttribute("data-ui-attach-ignore")).toBe(false);
    expect(document.querySelector("[data-ui-attach-selection-frame-guard]")
      ?.hasAttribute("data-ui-attach-ignore")).toBe(true);
    expect(
      document.querySelector("[data-ui-attach-selection-frame-guard]")?.textContent,
    ).toContain("iframe { pointer-events: none !important; }");
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");
    const proxy = eventTarget.querySelector<HTMLElement>(
      "[data-ui-attach-selection-frame-proxy]",
    );
    expect(proxy?.style.background).toBe("rgba(80, 146, 255, 0.08)");
    expect(proxy?.style.left).toBe("20px");
    expect(proxy?.style.top).toBe("30px");
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: 40,
      clientY: 60,
    });
    proxy?.dispatchEvent(click);
    await flushAsyncWork();

    expect(click.defaultPrevented).toBe(true);
    expect(captureTarget).toHaveBeenCalledWith(frame, {
      kind: "element_relative_pointer",
      xRatio: 0.0625,
      yRatio: 1 / 6,
    });
    expect(hitTest).toHaveBeenCalledOnce();

    controller.disableForNavigation();
    await flushAsyncWork();
    expect(document.querySelector("[data-ui-attach-selection-surface]")).toBeNull();
    expect(document.querySelector("[data-ui-attach-selection-frame-guard]")).toBeNull();
    expect(eventTarget.querySelector("[data-ui-attach-selection-frame-proxy]")).toBeNull();
    controller.dispose();
    surface.dispose();
  });

  test("uses underlying paint order instead of treating a frame proxy as the target", () => {
    document.body.innerHTML = [
      '<iframe id="docs" title="Documentation"></iframe>',
      '<button id="dialog-action">Continue</button>',
    ].join("");
    const frame = document.querySelector("#docs");
    const button = document.querySelector("#dialog-action");
    if (!(frame instanceof HTMLIFrameElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("occlusion fixture missing");
    }
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      bottom: 210,
      height: 180,
      left: 20,
      right: 340,
      top: 30,
      width: 320,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    });
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => button,
    });
    surface.setEnabled(true);
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");
    const proxy = eventTarget.querySelector<HTMLElement>(
      "[data-ui-attach-selection-frame-proxy]",
    );
    if (!proxy) throw new Error("frame proxy missing");

    let resolved: HTMLElement | null = null;
    eventTarget.addEventListener(
      "click",
      (event) => {
        resolved = surface.resolveTarget(event as MouseEvent);
      },
      { once: true },
    );
    proxy.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      composed: true,
      clientX: 40,
      clientY: 60,
    }));

    expect(resolved).toBe(button);
    surface.dispose();
  });

  test("descends through open shadow roots when resolving the painted target", () => {
    document.body.innerHTML = '<div id="shadow-host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLDivElement)) throw new Error("shadow host fixture missing");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Open inner action";
    shadow.append(button);
    Object.defineProperty(shadow, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => button),
    });
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => host,
    });
    surface.setEnabled(true);
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");

    let resolved: HTMLElement | null = null;
    eventTarget.addEventListener("click", (event) => {
      resolved = surface.resolveTarget(event as MouseEvent);
    }, { once: true });
    eventTarget.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      composed: true,
      clientX: 40,
      clientY: 60,
    }));

    expect(resolved).toBe(button);
    expect(shadow.elementFromPoint).toHaveBeenCalledWith(40, 60);
    surface.dispose();
  });

  test("stops at a closed shadow host without exposing its internal target", () => {
    document.body.innerHTML = '<div id="shadow-host" aria-label="Opaque component host"></div>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLDivElement)) throw new Error("shadow host fixture missing");
    const closed = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.textContent = "Closed private action";
    closed.append(button);
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => host,
    });
    surface.setEnabled(true);
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");

    let resolved: HTMLElement | null = null;
    eventTarget.addEventListener("click", (event) => {
      resolved = surface.resolveTarget(event as MouseEvent);
    }, { once: true });
    eventTarget.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      composed: true,
      clientX: 40,
      clientY: 60,
    }));

    expect(host.shadowRoot).toBeNull();
    expect(resolved).toBe(host);
    expect(resolved).not.toBe(button);
    surface.dispose();
  });

  test("refreshes frame proxy geometry after layout signals and cancels queued work", () => {
    document.body.innerHTML = '<iframe id="docs" title="Documentation"></iframe>';
    const frame = document.querySelector("#docs");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("iframe fixture missing");
    let bounds = createRect(20, 30, 320, 180);
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => bounds);
    let scheduled: FrameRequestCallback | null = null;
    let nextHandle = 0;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      scheduled = callback;
      nextHandle += 1;
      return nextHandle;
    });
    const cancelAnimationFrame = vi.fn();
    const surface = createSelectionSurfaceController({
      root: document,
      requestAnimationFrame,
      cancelAnimationFrame,
    });

    surface.setEnabled(true);
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");
    const proxy = eventTarget.querySelector<HTMLElement>(
      "[data-ui-attach-selection-frame-proxy]",
    );
    if (!proxy) throw new Error("frame proxy missing");
    expect(proxy.style.left).toBe("20px");
    expect(proxy.style.top).toBe("30px");

    bounds = createRect(70, 90, 240, 120);
    window.dispatchEvent(new Event("scroll"));
    const refresh = scheduled;
    if (!refresh) throw new Error("frame refresh was not scheduled");
    refresh(16);
    expect(proxy.style.left).toBe("70px");
    expect(proxy.style.top).toBe("90px");
    expect(proxy.style.width).toBe("240px");
    expect(proxy.style.height).toBe("120px");

    window.dispatchEvent(new Event("scroll"));
    surface.setEnabled(false);
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(eventTarget.querySelector("[data-ui-attach-selection-frame-proxy]")).toBeNull();
    surface.dispose();
  });

  test("tracks position-only transitions for their full active lifetime", () => {
    document.body.innerHTML = '<iframe id="docs" title="Documentation"></iframe>';
    const frame = document.querySelector("#docs");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("iframe fixture missing");
    let bounds = createRect(20, 30, 320, 180);
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => bounds);
    let scheduled: FrameRequestCallback | null = null;
    let nextHandle = 0;
    const surface = createSelectionSurfaceController({
      root: document,
      requestAnimationFrame: (callback) => {
        scheduled = callback;
        nextHandle += 1;
        return nextHandle;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const takeFrame = (): FrameRequestCallback => {
      const callback = scheduled;
      if (!callback) throw new Error("frame refresh was not scheduled");
      scheduled = null;
      return callback;
    };
    surface.setEnabled(true);
    const eventTarget = surface.eventTarget;
    if (!(eventTarget instanceof ShadowRoot)) throw new Error("selection shadow root missing");
    const proxy = eventTarget.querySelector<HTMLElement>(
      "[data-ui-attach-selection-frame-proxy]",
    );
    if (!proxy) throw new Error("frame proxy missing");

    frame.dispatchEvent(new Event("transitionrun", { bubbles: true }));
    bounds = createRect(60, 30, 320, 180);
    takeFrame()(16);
    expect(proxy.style.left).toBe("60px");

    bounds = createRect(100, 30, 320, 180);
    takeFrame()(32);
    expect(proxy.style.left).toBe("100px");

    frame.dispatchEvent(new Event("transitionend", { bubbles: true }));
    takeFrame()(48);
    expect(scheduled).toBeNull();
    surface.dispose();
  });

  test("stops motion refresh when an animated target detaches without cancel", async () => {
    document.body.innerHTML = [
      '<div id="moving-banner"></div>',
      '<iframe id="docs" title="Documentation"></iframe>',
    ].join("");
    const movingBanner = document.querySelector("#moving-banner");
    const frame = document.querySelector("#docs");
    if (!(movingBanner instanceof HTMLDivElement) || !(frame instanceof HTMLIFrameElement)) {
      throw new Error("motion fixture missing");
    }
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(createRect(20, 30, 320, 180));
    let scheduled: FrameRequestCallback | null = null;
    let nextHandle = 0;
    const surface = createSelectionSurfaceController({
      root: document,
      requestAnimationFrame: (callback) => {
        scheduled = callback;
        nextHandle += 1;
        return nextHandle;
      },
      cancelAnimationFrame: vi.fn(),
    });
    surface.setEnabled(true);

    movingBanner.dispatchEvent(new Event("animationstart", { bubbles: true }));
    movingBanner.remove();
    await Promise.resolve();
    const refresh = scheduled;
    if (!refresh) throw new Error("motion refresh was not scheduled");
    scheduled = null;
    refresh(16);

    expect(scheduled).toBeNull();
    surface.dispose();
  });

  test("keeps body and extension-owned nodes outside the selection boundary", () => {
    document.body.innerHTML = '<div data-ui-attach-ignore><button>Internal</button></div>';
    const ignored = document.querySelector("button");
    const hits = [document.body, ignored];
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => hits.shift() ?? null,
    });
    surface.setEnabled(true);
    const host = document.querySelector<HTMLElement>("[data-ui-attach-selection-surface]");
    if (!host) throw new Error("selection surface missing");
    expect(host.hasAttribute("data-ui-attach-ignore")).toBe(false);
    expect(ignored?.closest("[data-ui-attach-ignore]")).not.toBeNull();

    let resolved: HTMLElement | null | undefined;
    const observe = (event: MouseEvent): void => {
      resolved = surface.resolveTarget(event);
    };
    document.addEventListener("pointermove", observe, { once: true, capture: true });
    surface.eventTarget.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true }),
    );
    expect(resolved).toBeNull();

    document.addEventListener("pointermove", observe, { once: true, capture: true });
    surface.eventTarget.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true }),
    );
    expect(resolved).toBeNull();
    surface.dispose();
  });

  test("preserves activation-target promotion for ordinary page controls", () => {
    document.body.innerHTML = '<button id="save"><span>Save changes</span></button>';
    const button = document.querySelector("button");
    const label = document.querySelector("span");
    if (!(button instanceof HTMLButtonElement) || !(label instanceof HTMLSpanElement)) {
      throw new Error("button fixture missing");
    }
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => {
        expect(document.querySelector("[data-ui-attach-selection-frame-guard]")).toBeNull();
        return label;
      },
    });
    surface.setEnabled(true);
    const host = document.querySelector<HTMLElement>("[data-ui-attach-selection-surface]");
    if (!host) throw new Error("selection surface missing");

    let resolved: HTMLElement | null | undefined;
    document.addEventListener(
      "pointermove",
      (event) => {
        resolved = surface.resolveTarget(event);
      },
      { once: true, capture: true },
    );
    surface.eventTarget.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true }),
    );

    expect(resolved).toBe(button);
    surface.dispose();
  });

  test("promotes SVG paint hits to their HTML activation control", () => {
    document.body.innerHTML = [
      '<button id="zoom-in" aria-label="Zoom in">',
      '<svg viewBox="0 0 24 24"><path id="zoom-icon" d="M12 5v14M5 12h14" /></svg>',
      "</button>",
    ].join("");
    const button = document.querySelector("button");
    const iconPath = document.querySelector("path");
    if (!(button instanceof HTMLButtonElement) || !(iconPath instanceof SVGElement)) {
      throw new Error("SVG-backed button fixture missing");
    }
    const surface = createSelectionSurfaceController({
      root: document,
      hitTest: () => iconPath,
    });
    surface.setEnabled(true);

    let resolved: HTMLElement | null | undefined;
    document.addEventListener(
      "pointermove",
      (event) => {
        resolved = surface.resolveTarget(event);
      },
      { once: true, capture: true },
    );
    surface.eventTarget.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, composed: true }),
    );

    expect(resolved).toBe(button);
    surface.dispose();
  });
});

function createCaptureResult(): ContextCaptureResult {
  return {
    ok: true,
    json: "{}",
    record: createCaptureRecord("frame", "Documentation"),
  };
}

function createRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
