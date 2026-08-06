// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { createPersistentOverlayController } from "./persistent-overlays";

describe("createPersistentOverlayController", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll("[data-ui-attach-overlay-root]").forEach((element) => element.remove());
  });

  test("removes an orphaned overlay root left by a reloaded content script", () => {
    const staleHost = document.createElement("div");
    staleHost.dataset.uiAttachOverlayRoot = "true";
    staleHost.attachShadow({ mode: "open" }).append(document.createElement("div"));
    document.documentElement.append(staleHost);

    const controller = createPersistentOverlayController({ root: document });

    const hosts = document.querySelectorAll("[data-ui-attach-overlay-root]");
    expect(staleHost.isConnected).toBe(false);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(staleHost);
    controller.dispose();
  });

  test("shows persistent labeled overlays without changing the captured elements", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(40, 90, 180, 42));

    const controller = createPersistentOverlayController({ root: document });
    controller.sync(
      [
        { itemId: "item-a", label: "A", target: first },
        { itemId: "item-b", label: "B", target: second },
      ],
      "item-b",
    );

    const overlays = getOverlays();
    expect(overlays).toHaveLength(2);
    expect(overlays.map((overlay) => overlay.textContent)).toEqual(["A", "B"]);
    expect(overlays[0]?.style.left).toBe("12px");
    expect(overlays[0]?.style.top).toBe("24px");
    expect(overlays[1]?.dataset.active).toBe("true");
    expect(overlays[0]?.dataset.active).toBe("false");
    expect(first.style.outline).toBe("");
    expect(second.style.boxShadow).toBe("");
    expect(getOverlayHost().style.pointerEvents).toBe("none");

    controller.dispose();
  });

  test("uses a low-opacity fill so target text remains readable", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    const controller = createPersistentOverlayController({ root: document });
    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    const styles = getOverlayHost().shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(styles).toContain("background: rgba(80, 146, 255, 0.1)");
    expect(styles).toContain("background: rgba(255, 174, 45, 0.14)");
    controller.dispose();
  });

  test("temporarily emphasizes both relationship targets without losing the active target", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(40, 90, 180, 42));
    const controller = createPersistentOverlayController({ root: document });
    const items = [
      { itemId: "item-a", label: "A", target: first },
      { itemId: "item-b", label: "B", target: second },
    ];

    controller.sync(items, "item-b", {
      sourceItemId: "item-a",
      referenceItemId: "item-b",
    });
    expect(getOverlays().map((overlay) => overlay.dataset.active)).toEqual(["true", "true"]);
    expect(getOverlays().map((overlay) => overlay.textContent)).toEqual([
      "A · Element",
      "B · Relative to",
    ]);

    controller.sync(items, "item-b");
    expect(getOverlays().map((overlay) => overlay.dataset.active)).toEqual(["false", "true"]);
    expect(getOverlays().map((overlay) => overlay.textContent)).toEqual(["A", "B"]);
    controller.dispose();
  });

  test("uses localized relationship roles without changing stable A-Z labels", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(40, 90, 180, 42));
    const controller = createPersistentOverlayController({
      root: document,
      relationRoleLabels: {
        source: "元素",
        reference: "相对于",
      },
    });

    controller.sync(
      [
        { itemId: "item-a", label: "A", target: first },
        { itemId: "item-b", label: "B", target: second },
      ],
      null,
      { sourceItemId: "item-a", referenceItemId: "item-b" },
    );

    expect(getOverlays().map((overlay) => overlay.textContent)).toEqual([
      "A · 元素",
      "B · 相对于",
    ]);
    controller.dispose();
  });

  test("keeps an expanded relationship badge outside its target at the top and right viewport edges", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(980, 2, 40, 30));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync(
      [{ itemId: "item-a", label: "A", target }],
      null,
      { sourceItemId: "item-a", referenceItemId: "item-b" },
    );
    const label = getOverlays()[0]?.querySelector<HTMLElement>(".ui-attach-label");
    if (!label) throw new Error("overlay label missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(968, -10, 100, 24));

    controller.refresh();

    expect(label.style.left).toBe("-60px");
    expect(label.style.top).toBe("34px");
    controller.dispose();
  });

  test("places adjacent target badges without covering either target or each other", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(100, 100, 28, 28));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(112, 100, 28, 28));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync(
      [
        { itemId: "item-a", label: "A", target: first },
        { itemId: "item-b", label: "B", target: second },
      ],
      "item-b",
    );
    const overlays = getOverlays();
    const firstLabel = overlays[0]?.querySelector<HTMLElement>(".ui-attach-label");
    const secondLabel = overlays[1]?.querySelector<HTMLElement>(".ui-attach-label");
    if (!firstLabel || !secondLabel) throw new Error("overlay labels missing");
    vi.spyOn(firstLabel, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));
    vi.spyOn(secondLabel, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));

    controller.refresh();

    const firstBadge = styleRect(overlays[0], firstLabel, 24, 24);
    const secondBadge = styleRect(overlays[1], secondLabel, 24, 24);
    expect(overlapArea(firstBadge, rect(100, 100, 28, 28))).toBe(0);
    expect(overlapArea(secondBadge, rect(112, 100, 28, 28))).toBe(0);
    expect(overlapArea(firstBadge, secondBadge)).toBe(0);
    controller.dispose();
  });

  test("keeps a wide row badge beside its own target instead of neighboring content", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(960);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(285, 347, 710, 40));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");
    const overlay = getOverlays()[0];
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlay || !label) throw new Error("overlay fixture missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 40, 24));

    controller.refresh();

    const badge = styleRect(overlay, label, 40, 24);
    expect(badge.right).toBeLessThanOrEqual(target.getBoundingClientRect().left - 4);
    expect(badge.top).toBeGreaterThanOrEqual(target.getBoundingClientRect().top);
    expect(badge.bottom).toBeLessThanOrEqual(target.getBoundingClientRect().bottom);
    controller.dispose();
  });

  test("uses additional outside lanes for a dense row of selected targets", () => {
    const targets = Array.from({ length: 10 }, (_, index) => {
      const target = document.createElement("button");
      document.body.append(target);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
        rect(100 + index * 8, 100, 8, 8),
      );
      return target;
    });
    const controller = createPersistentOverlayController({ root: document });
    controller.sync(
      targets.map((target, index) => ({
        itemId: `item-${index}`,
        label: String.fromCharCode(65 + index),
        target,
      })),
      "item-9",
    );
    const overlays = getOverlays();
    const labels = overlays.map((overlay) => {
      const label = overlay.querySelector<HTMLElement>(".ui-attach-label");
      if (!label) throw new Error("overlay label missing");
      vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));
      return label;
    });

    controller.refresh();

    const badges = overlays.map((overlay, index) => styleRect(overlay, labels[index]!, 24, 24));
    for (let index = 0; index < badges.length; index += 1) {
      for (const target of targets) {
        expect(overlapArea(badges[index]!, target.getBoundingClientRect())).toBe(0);
      }
      for (let other = 0; other < index; other += 1) {
        expect(overlapArea(badges[index]!, badges[other]!)).toBe(0);
      }
    }
    controller.dispose();
  });

  test("hides a fully offscreen target and restores its clamped badge after scrolling back", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    const readBounds = vi.spyOn(target, "getBoundingClientRect")
      .mockReturnValue(rect(1200, 20, 40, 30));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync(
      [{ itemId: "item-a", label: "A", target }],
      null,
      { sourceItemId: "item-a", referenceItemId: "item-b" },
    );
    const overlay = getOverlays()[0];
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlay || !label) throw new Error("overlay fixture missing");
    expect(overlay.style.display).toBe("none");

    readBounds.mockReturnValue(rect(980, 2, 40, 30));
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(968, -10, 100, 24));
    controller.refresh();

    expect(overlay.style.display).toBe("block");
    expect(label.style.left).toBe("-60px");
    expect(label.style.top).toBe("34px");
    controller.dispose();
  });

  test("tracks viewport movement and removes stale overlays", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const readBounds = vi
      .spyOn(target, "getBoundingClientRect")
      .mockReturnValueOnce(rect(10, 20, 100, 30))
      .mockReturnValue(rect(30, 60, 100, 30));
    const queuedFrames: FrameRequestCallback[] = [];
    let notifyResize = (): void => undefined;
    let notifyMutation = (): void => undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnectResize = vi.fn();
    const observeMutations = vi.fn();
    const disconnectMutations = vi.fn();
    const controller = createPersistentOverlayController({
      root: document,
      requestAnimationFrame: (callback) => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      },
      cancelAnimationFrame: vi.fn(),
      resizeObserverFactory: (onChange) => {
        notifyResize = onChange;
        return { observe, unobserve, disconnect: disconnectResize };
      },
      mutationObserverFactory: (onChange) => {
        notifyMutation = onChange;
        return { observe: observeMutations, disconnect: disconnectMutations };
      },
    });

    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");
    expect(observe).toHaveBeenCalledWith(target);
    expect(observeMutations).toHaveBeenCalledWith(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.dispatchEvent(new Event("scroll"));
    queuedFrames.shift()?.(0);

    expect(readBounds).toHaveBeenCalledTimes(2);
    expect(getOverlays()[0]?.style.left).toBe("30px");
    expect(getOverlays()[0]?.style.top).toBe("60px");

    readBounds.mockReturnValue(rect(55, 75, 140, 38));
    notifyResize();
    queuedFrames.shift()?.(0);
    expect(getOverlays()[0]?.style.left).toBe("55px");
    expect(getOverlays()[0]?.style.width).toBe("140px");

    readBounds.mockReturnValue(rect(85, 105, 140, 38));
    notifyMutation();
    queuedFrames.shift()?.(0);
    expect(getOverlays()[0]?.style.left).toBe("85px");
    expect(getOverlays()[0]?.style.top).toBe("105px");

    controller.sync([], null);
    expect(unobserve).toHaveBeenCalledWith(target);
    expect(disconnectMutations).toHaveBeenCalled();
    expect(getOverlays()).toHaveLength(0);
    controller.dispose();
    expect(disconnectResize).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-ui-attach-overlay-root]")).toBeNull();
  });

  test("refreshes position-only reflow after a real text-node mutation", async () => {
    const precedingText = document.createTextNode("Short");
    const target = document.createElement("button");
    document.body.append(precedingText, target);
    const readBounds = vi
      .spyOn(target, "getBoundingClientRect")
      .mockReturnValueOnce(rect(20, 30, 100, 32))
      .mockReturnValue(rect(140, 30, 100, 32));
    const queuedFrames: FrameRequestCallback[] = [];
    const controller = createPersistentOverlayController({
      root: document,
      requestAnimationFrame: (callback) => {
        queuedFrames.push(callback);
        return queuedFrames.length;
      },
      cancelAnimationFrame: vi.fn(),
    });
    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    precedingText.data = "A much longer sibling label";
    await Promise.resolve();
    await Promise.resolve();
    queuedFrames.shift()?.(0);

    expect(readBounds).toHaveBeenCalledTimes(2);
    expect(getOverlays()[0]?.style.left).toBe("140px");
    controller.dispose();
  });
});

function getOverlayHost(): HTMLElement {
  const host = document.querySelector("[data-ui-attach-overlay-root]");
  if (!(host instanceof HTMLElement) || !host.shadowRoot) {
    throw new Error("overlay host missing");
  }
  return host;
}

function getOverlays(): HTMLElement[] {
  return Array.from(getOverlayHost().shadowRoot?.querySelectorAll<HTMLElement>(".ui-attach-overlay") ?? []);
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

function styleRect(
  overlay: HTMLElement,
  label: HTMLElement,
  width: number,
  height: number,
): DOMRect {
  return rect(
    Number.parseFloat(overlay.style.left) + Number.parseFloat(label.style.left),
    Number.parseFloat(overlay.style.top) + Number.parseFloat(label.style.top),
    width,
    height,
  );
}

function overlapArea(first: DOMRect, second: DOMRect): number {
  return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
}
