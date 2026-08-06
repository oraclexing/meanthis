export interface PersistentOverlayItem {
  itemId: string;
  label: string;
  target: HTMLElement;
}

export interface PersistentOverlayRelationPreview {
  sourceItemId: string;
  referenceItemId: string;
}

export interface PersistentOverlayController {
  sync(
    items: PersistentOverlayItem[],
    activeItemId: string | null,
    relationPreview?: PersistentOverlayRelationPreview,
  ): void;
  refresh(): void;
  dispose(): void;
}

export interface PersistentOverlayControllerOptions {
  root: Document;
  relationRoleLabels?: {
    source: string;
    reference: string;
  };
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  cancelAnimationFrame?(handle: number): void;
  resizeObserverFactory?(onChange: () => void): OverlayResizeObserver;
  mutationObserverFactory?(onChange: () => void): OverlayMutationObserver;
}

export interface OverlayResizeObserver {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface OverlayMutationObserver {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

interface OverlayEntry {
  element: HTMLDivElement;
  label: HTMLSpanElement;
  target: HTMLElement;
}

interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function createPersistentOverlayController(
  options: PersistentOverlayControllerOptions,
): PersistentOverlayController {
  options.root.querySelectorAll("[data-ui-attach-overlay-root]").forEach((element) => {
    element.remove();
  });
  const rootView = options.root.defaultView;
  if (!rootView) {
    throw new Error("Persistent overlays require a document with a window.");
  }
  const view: Window = rootView;

  const requestFrame = options.requestAnimationFrame ?? (
    typeof view.requestAnimationFrame === "function"
      ? view.requestAnimationFrame.bind(view)
      : (callback: FrameRequestCallback) => view.setTimeout(
          () => callback(view.performance.now()),
          16,
        )
  );
  const cancelFrame = options.cancelAnimationFrame ?? (
    typeof view.cancelAnimationFrame === "function"
      ? view.cancelAnimationFrame.bind(view)
      : (handle: number) => view.clearTimeout(handle)
  );
  const host = options.root.createElement("div");
  host.dataset.uiAttachOverlayRoot = "true";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  const shadow = host.attachShadow({ mode: "open" });
  const style = options.root.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .ui-attach-overlay {
      position: fixed;
      box-sizing: border-box;
      pointer-events: none;
      border: 2px solid rgb(80, 146, 255);
      border-radius: 4px;
      background: rgba(80, 146, 255, 0.1);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.82), 0 3px 14px rgba(17, 37, 68, 0.2);
    }
    .ui-attach-overlay[data-active="true"] {
      border-color: rgb(255, 174, 45);
      background: rgba(255, 174, 45, 0.14);
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 4px 18px rgba(17, 37, 68, 0.3);
    }
    .ui-attach-label {
      position: absolute;
      top: 0;
      left: 0;
      display: grid;
      min-width: 24px;
      height: 24px;
      padding: 0 6px;
      place-items: center;
      border: 2px solid white;
      border-radius: 999px;
      background: rgb(42, 105, 211);
      color: white;
      font: 700 12px/1 system-ui, sans-serif;
      letter-spacing: 0;
      white-space: nowrap;
      box-shadow: 0 2px 7px rgba(17, 37, 68, 0.32);
    }
    .ui-attach-overlay[data-active="true"] .ui-attach-label {
      background: rgb(213, 117, 0);
    }
  `;
  shadow.append(style);
  options.root.documentElement.append(host);

  const entries = new Map<string, OverlayEntry>();
  let disposed = false;
  let pendingFrame: number | null = null;

  const scheduleRefresh = (): void => {
    if (disposed || pendingFrame !== null) return;
    pendingFrame = requestFrame(() => {
      pendingFrame = null;
      refresh();
    });
  };
  const resizeObserver = options.resizeObserverFactory?.(scheduleRefresh) ?? (
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => scheduleRefresh())
      : null
  );
  const mutationObserver = options.mutationObserverFactory?.(scheduleRefresh) ?? (
    typeof MutationObserver === "function"
      ? new MutationObserver(() => scheduleRefresh())
      : null
  );
  let observingMutations = false;

  view.addEventListener("scroll", scheduleRefresh, true);
  view.addEventListener("resize", scheduleRefresh);

  function sync(
    items: PersistentOverlayItem[],
    activeItemId: string | null,
    relationPreview?: PersistentOverlayRelationPreview,
  ): void {
    if (disposed) return;
    const retainedIds = new Set(items.map((item) => item.itemId));
    for (const [itemId, entry] of entries) {
      if (!retainedIds.has(itemId)) {
        resizeObserver?.unobserve(entry.target);
        entry.element.remove();
        entries.delete(itemId);
      }
    }

    for (const item of items) {
      let entry = entries.get(item.itemId);
      const created = entry === undefined;
      if (!entry) {
        const element = options.root.createElement("div");
        element.className = "ui-attach-overlay";
        element.dataset.itemId = item.itemId;
        const label = options.root.createElement("span");
        label.className = "ui-attach-label";
        element.append(label);
        shadow.append(element);
        entry = { element, label, target: item.target };
        entries.set(item.itemId, entry);
      }
      if (created) {
        resizeObserver?.observe(item.target);
      } else if (entry.target !== item.target) {
        resizeObserver?.unobserve(entry.target);
        resizeObserver?.observe(item.target);
      }
      entry.target = item.target;
      const relationRole = !relationPreview
        ? null
        : item.itemId === relationPreview.sourceItemId
          ? options.relationRoleLabels?.source ?? "Element"
          : item.itemId === relationPreview.referenceItemId
            ? options.relationRoleLabels?.reference ?? "Relative to"
            : null;
      entry.label.textContent = relationRole ? `${item.label} · ${relationRole}` : item.label;
      entry.element.dataset.active = (
        relationPreview ? relationRole !== null : item.itemId === activeItemId
      ) ? "true" : "false";
    }
    if (entries.size > 0 && !observingMutations) {
      mutationObserver?.observe(options.root.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      observingMutations = mutationObserver !== null;
    } else if (entries.size === 0 && observingMutations) {
      mutationObserver?.disconnect();
      observingMutations = false;
    }
    refresh();
  }

  function refresh(): void {
    if (disposed) return;
    const visibleEntries: Array<{ entry: OverlayEntry; bounds: OverlayRect }> = [];
    for (const entry of entries.values()) {
      if (!entry.target.isConnected) {
        entry.element.style.display = "none";
        continue;
      }
      const bounds = entry.target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        entry.element.style.display = "none";
        continue;
      }
      if (
        bounds.right <= 0 ||
        bounds.bottom <= 0 ||
        bounds.left >= view.innerWidth ||
        bounds.top >= view.innerHeight
      ) {
        entry.element.style.display = "none";
        continue;
      }
      entry.element.style.display = "block";
      entry.element.style.left = `${bounds.left}px`;
      entry.element.style.top = `${bounds.top}px`;
      entry.element.style.width = `${bounds.width}px`;
      entry.element.style.height = `${bounds.height}px`;
      visibleEntries.push({ entry, bounds });
    }

    const targetBounds = visibleEntries.map(({ bounds }) => bounds);
    const placedLabels: OverlayRect[] = [];
    for (const { entry, bounds } of visibleEntries) {
      const labelBounds = entry.label.getBoundingClientRect();
      const labelPosition = chooseLabelPosition({
        target: bounds,
        width: Math.max(24, labelBounds.width),
        height: Math.max(24, labelBounds.height),
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
        targetBounds,
        placedLabels,
      });
      entry.label.style.left = `${labelPosition.left - bounds.left}px`;
      entry.label.style.top = `${labelPosition.top - bounds.top}px`;
      placedLabels.push(labelPosition);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (pendingFrame !== null) {
      cancelFrame(pendingFrame);
      pendingFrame = null;
    }
    view.removeEventListener("scroll", scheduleRefresh, true);
    view.removeEventListener("resize", scheduleRefresh);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    entries.clear();
    host.remove();
  }

  return { sync, refresh, dispose };
}

function chooseLabelPosition(input: {
  target: OverlayRect;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  targetBounds: OverlayRect[];
  placedLabels: OverlayRect[];
}): OverlayRect {
  const margin = 4;
  const gap = 4;
  const { target, width, height } = input;
  const candidateOrigins: Array<{ left: number; top: number }> = [];
  const isWideRow = target.width >= Math.max(160, width * 4, target.height * 4);
  if (isWideRow) {
    const centeredTop = target.top + (target.height - height) / 2;
    candidateOrigins.push(
      { left: target.left - width - gap, top: centeredTop },
      { left: target.right + gap, top: centeredTop },
    );
  }
  const laneCount = Math.min(26, Math.max(4, input.placedLabels.length + 2));
  for (let lane = 0; lane < laneCount; lane += 1) {
    const verticalGap = gap + lane * (height + gap);
    const horizontalGap = gap + lane * (width + gap);
    candidateOrigins.push(
      { left: target.left, top: target.top - height - verticalGap },
      { left: target.right - width, top: target.top - height - verticalGap },
      { left: target.left, top: target.bottom + verticalGap },
      { left: target.right - width, top: target.bottom + verticalGap },
      { left: target.left - width - horizontalGap, top: target.top },
      { left: target.left - width - horizontalGap, top: target.bottom - height },
      { left: target.right + horizontalGap, top: target.top },
      { left: target.right + horizontalGap, top: target.bottom - height },
    );
  }
  const seenCandidates = new Set<string>();
  const candidates = candidateOrigins.flatMap(({ left, top }) => {
    const candidate = overlayRect(
      clamp(left, margin, Math.max(margin, input.viewportWidth - width - margin)),
      clamp(top, margin, Math.max(margin, input.viewportHeight - height - margin)),
      width,
      height,
    );
    const key = `${candidate.left}:${candidate.top}`;
    if (seenCandidates.has(key)) return [];
    seenCandidates.add(key);
    return [candidate];
  });

  let best = candidates[0] ?? overlayRect(margin, margin, width, height);
  let bestScore = Number.POSITIVE_INFINITY;
  candidates.forEach((candidate, priority) => {
    const labelCollisionArea = input.placedLabels.reduce(
      (total, placed) => total + overlapArea(candidate, placed),
      0,
    );
    const targetCollisionArea = input.targetBounds.reduce(
      (total, bounds) => total + overlapArea(candidate, bounds),
      0,
    );
    const score = labelCollisionArea * 100_000 + targetCollisionArea * 1_000 + priority;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
}

function overlayRect(left: number, top: number, width: number, height: number): OverlayRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function overlapArea(first: OverlayRect, second: OverlayRect): number {
  return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
