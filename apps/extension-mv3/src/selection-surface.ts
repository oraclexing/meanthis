import { getSelectableComposedTarget, getSelectableTarget } from "./context-target";

export interface SelectionSurfaceController {
  dispose(): void;
  eventTarget: EventTarget;
  resolveTarget(event: MouseEvent): HTMLElement | null;
  setEnabled(enabled: boolean): void;
}

export interface SelectionSurfaceControllerOptions {
  root: Document;
  cancelAnimationFrame?(handle: number): void;
  hitTest?(x: number, y: number): Element | null;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
}

export function createSelectionSurfaceController(
  options: SelectionSurfaceControllerOptions,
): SelectionSurfaceController {
  options.root.querySelectorAll(
    "[data-ui-attach-selection-surface], [data-ui-attach-selection-frame-guard]",
  ).forEach((element) => {
    element.remove();
  });
  const hitTest = options.hitTest ?? ((x, y) => options.root.elementFromPoint(x, y));
  const frameInputGuard = options.root.createElement("style");
  frameInputGuard.dataset.uiAttachSelectionFrameGuard = "true";
  frameInputGuard.dataset.uiAttachIgnore = "true";
  frameInputGuard.textContent = "iframe { pointer-events: none !important; }";
  const host = options.root.createElement("div");
  host.dataset.uiAttachSelectionSurface = "true";
  host.dataset.uiAttachIgnore = "true";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    display: "block",
    pointerEvents: "auto",
    zIndex: "2147483647",
    cursor: "default",
    background: "transparent",
  });
  const shadow = host.attachShadow({ mode: "closed" });
  const shield = options.root.createElement("div");
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "auto",
    // Painted per-frame proxies below keep OOPIF input in the parent renderer.
    background: "transparent",
    zIndex: "0",
  });
  shadow.append(shield);
  const frameProxies = new Map<HTMLIFrameElement, HTMLDivElement>();
  const view = options.root.defaultView;
  const requestFrame = options.requestAnimationFrame
    ?? (view && typeof view.requestAnimationFrame === "function"
      ? (callback: FrameRequestCallback) => view.requestAnimationFrame(callback)
      : null);
  const cancelFrame = options.cancelAnimationFrame
    ?? (view && typeof view.cancelAnimationFrame === "function"
      ? (handle: number) => view.cancelAnimationFrame(handle)
      : null);
  const trackedFrames = new Set<HTMLIFrameElement>();
  const activeMotionTargets = new Set<Node>();
  let frameSyncHandle: number | null = null;
  const resizeObserver = view && typeof view.ResizeObserver === "function"
    ? new view.ResizeObserver(() => scheduleFrameProxySync())
    : null;
  const mutationObserver = view && typeof view.MutationObserver === "function"
    ? new view.MutationObserver((records) => {
      let pageLayoutChanged = false;
      for (const record of records) {
        if (record.type === "childList") {
          for (const node of record.addedNodes) trackFramesWithin(node);
          if ([...record.addedNodes, ...record.removedNodes].some((node) => !isExtensionOwned(node))) {
            pageLayoutChanged = true;
          }
        } else if (!isExtensionOwned(record.target)) {
          pageLayoutChanged = true;
        }
      }
      if (pageLayoutChanged) scheduleFrameProxySync();
    })
    : null;

  function syncFrameProxies(): void {
    for (const frame of [...trackedFrames]) {
      if (!frame.isConnected) {
        untrackFrame(frame);
        continue;
      }
      let proxy = frameProxies.get(frame);
      if (!proxy) {
        proxy = options.root.createElement("div");
        proxy.dataset.uiAttachSelectionFrameProxy = "true";
        Object.assign(proxy.style, {
          position: "fixed",
          boxSizing: "border-box",
          pointerEvents: "auto",
          background: "rgba(80, 146, 255, 0.08)",
          outline: "1px solid rgba(80, 146, 255, 0.35)",
          outlineOffset: "-1px",
          transform: "translateZ(0)",
          willChange: "transform",
          zIndex: "1",
        });
        frameProxies.set(frame, proxy);
        shadow.append(proxy);
      }
      const bounds = frame.getBoundingClientRect();
      proxy.style.display = bounds.width > 0 && bounds.height > 0
        ? "block"
        : "none";
      proxy.style.left = `${bounds.left}px`;
      proxy.style.top = `${bounds.top}px`;
      proxy.style.width = `${bounds.width}px`;
      proxy.style.height = `${bounds.height}px`;
    }
  }

  function scheduleFrameProxySync(): void {
    if (!host.isConnected || frameSyncHandle !== null) return;
    if (!requestFrame) {
      syncFrameProxies();
      return;
    }
    frameSyncHandle = requestFrame(() => {
      frameSyncHandle = null;
      if (!host.isConnected) return;
      syncFrameProxies();
      if (hasActiveDocumentMotion()) scheduleFrameProxySync();
    });
  }

  function handleMotionStart(event: Event): void {
    const target = getNodeTarget(event.target);
    if (!target || isExtensionOwned(target)) return;
    activeMotionTargets.add(target);
    scheduleFrameProxySync();
  }

  function handleMotionEnd(event: Event): void {
    const target = getNodeTarget(event.target);
    if (target) activeMotionTargets.delete(target);
  }

  function handleLayoutSignal(event: Event): void {
    if (!isExtensionOwnedTarget(event.target)) scheduleFrameProxySync();
  }

  function hasActiveDocumentMotion(): boolean {
    for (const target of activeMotionTargets) {
      if (!target.isConnected) activeMotionTargets.delete(target);
    }
    if (activeMotionTargets.size > 0) return true;
    if (typeof options.root.getAnimations !== "function") return false;
    return options.root.getAnimations().some((animation) => animation.playState === "running");
  }

  function trackFramesWithin(node: Node): void {
    const candidate = node as Node & ParentNode & { localName?: string };
    if (candidate.localName === "iframe") trackFrame(candidate as HTMLIFrameElement);
    if (typeof candidate.querySelectorAll !== "function") return;
    for (const frame of candidate.querySelectorAll("iframe")) trackFrame(frame);
  }

  function trackFrame(frame: HTMLIFrameElement): void {
    if (trackedFrames.has(frame)) return;
    trackedFrames.add(frame);
    resizeObserver?.observe(frame);
  }

  function untrackFrame(frame: HTMLIFrameElement): void {
    trackedFrames.delete(frame);
    resizeObserver?.unobserve(frame);
    frameProxies.get(frame)?.remove();
    frameProxies.delete(frame);
  }

  function isExtensionOwned(node: Node): boolean {
    return node.nodeType === 1
      && (node as Element).closest("[data-ui-attach-ignore]") !== null;
  }

  function isExtensionOwnedTarget(target: EventTarget | null): boolean {
    const node = getNodeTarget(target);
    return node !== null && isExtensionOwned(node);
  }

  function getNodeTarget(target: EventTarget | null): Node | null {
    return target !== null && "nodeType" in target ? target as Node : null;
  }

  function startFrameProxySync(): void {
    trackFramesWithin(options.root);
    mutationObserver?.observe(options.root.documentElement, {
      attributeFilter: ["class", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    resizeObserver?.observe(options.root.documentElement);
    view?.addEventListener("resize", scheduleFrameProxySync);
    view?.addEventListener("scroll", scheduleFrameProxySync, { capture: true, passive: true });
    options.root.addEventListener("animationstart", handleMotionStart, { capture: true });
    options.root.addEventListener("animationend", handleMotionEnd, { capture: true });
    options.root.addEventListener("animationcancel", handleMotionEnd, { capture: true });
    options.root.addEventListener("transitionrun", handleMotionStart, { capture: true });
    options.root.addEventListener("transitionend", handleMotionEnd, { capture: true });
    options.root.addEventListener("transitioncancel", handleMotionEnd, { capture: true });
    options.root.addEventListener("load", handleLayoutSignal, { capture: true });
    options.root.addEventListener("loadedmetadata", handleLayoutSignal, { capture: true });
    options.root.fonts?.addEventListener("loadingdone", scheduleFrameProxySync);
    syncFrameProxies();
    if (hasActiveDocumentMotion()) scheduleFrameProxySync();
  }

  function stopFrameProxySync(): void {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    view?.removeEventListener("resize", scheduleFrameProxySync);
    view?.removeEventListener("scroll", scheduleFrameProxySync, { capture: true });
    options.root.removeEventListener("animationstart", handleMotionStart, { capture: true });
    options.root.removeEventListener("animationend", handleMotionEnd, { capture: true });
    options.root.removeEventListener("animationcancel", handleMotionEnd, { capture: true });
    options.root.removeEventListener("transitionrun", handleMotionStart, { capture: true });
    options.root.removeEventListener("transitionend", handleMotionEnd, { capture: true });
    options.root.removeEventListener("transitioncancel", handleMotionEnd, { capture: true });
    options.root.removeEventListener("load", handleLayoutSignal, { capture: true });
    options.root.removeEventListener("loadedmetadata", handleLayoutSignal, { capture: true });
    options.root.fonts?.removeEventListener("loadingdone", scheduleFrameProxySync);
    if (frameSyncHandle !== null && cancelFrame) cancelFrame(frameSyncHandle);
    frameSyncHandle = null;
    for (const proxy of frameProxies.values()) proxy.remove();
    frameProxies.clear();
    trackedFrames.clear();
    activeMotionTargets.clear();
  }

  function setEnabled(enabled: boolean): void {
    if (!enabled) {
      stopFrameProxySync();
      host.remove();
      frameInputGuard.remove();
      return;
    }
    if (host.isConnected) return;

    options.root.documentElement.append(frameInputGuard);
    options.root.documentElement.append(host);
    startFrameProxySync();
  }

  function resolveTarget(event: MouseEvent): HTMLElement | null {
    const path = event.composedPath();
    if (!host.isConnected || (!path.includes(host) && !path.includes(shadow))) {
      return getSelectableComposedTarget(options.root, event);
    }

    const previousDisplay = host.style.display;
    const guardParent = frameInputGuard.parentNode;
    const guardNextSibling = frameInputGuard.nextSibling;
    host.style.display = "none";
    frameInputGuard.remove();
    try {
      return getSelectableTarget(options.root, hitTest(event.clientX, event.clientY));
    } finally {
      if (guardParent) {
        guardParent.insertBefore(frameInputGuard, guardNextSibling);
      }
      host.style.display = previousDisplay;
    }
  }

  return {
    dispose: () => setEnabled(false),
    eventTarget: shadow,
    resolveTarget,
    setEnabled,
  };
}
