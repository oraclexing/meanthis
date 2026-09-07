// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { createPersistentOverlayController } from "./persistent-overlays";

describe("shared createPersistentOverlayController", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect(getOverlayHost().dataset.uiAttachIgnore).toBe("true");
    expect(getOverlayHost().getAttribute("aria-hidden")).toBe("true");
    expect(getOverlayHost().shadowRoot?.querySelector("button")).toBeNull();

    controller.dispose();
  });

  test("reads back only connected production markers as a sorted defensive clone", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    const third = document.createElement("button");
    document.body.append(first, second, third);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(40, 90, 180, 42));
    vi.spyOn(third, "getBoundingClientRect").mockReturnValue(rect(80, 160, 160, 40));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync([
      { itemId: "item-10", label: "10", target: first },
      { itemId: "item-2", label: "2", target: second },
      { itemId: "item-1", label: "1", target: third },
    ], null);

    const firstStatus = controller.readStatus();
    expect(firstStatus).toEqual({
      itemIds: ["item-1", "item-10", "item-2"],
      markerCount: 3,
    });
    firstStatus.itemIds.splice(0);
    firstStatus.markerCount = 99;
    expect(controller.readStatus()).toEqual({
      itemIds: ["item-1", "item-10", "item-2"],
      markerCount: 3,
    });

    getOverlays()
      .find((overlay) => overlay.dataset.itemId === "item-10")
      ?.querySelector(".ui-attach-marker-capsule")
      ?.remove();
    expect(controller.readStatus()).toEqual({
      itemIds: ["item-1", "item-2"],
      markerCount: 2,
    });

    controller.dispose();
  });

  test("reads connected shadow DOM markers that are not tracked by controller entries", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    const controller = createPersistentOverlayController({ root: document });
    controller.sync([{ itemId: "tracked", label: "1", target }], null);

    const untrackedOverlay = document.createElement("div");
    untrackedOverlay.className = "ui-attach-overlay";
    untrackedOverlay.dataset.itemId = "untracked";
    const untrackedMarker = document.createElement("div");
    untrackedMarker.className = "ui-attach-marker-capsule";
    untrackedOverlay.append(untrackedMarker);
    getOverlayHost().shadowRoot?.append(untrackedOverlay);

    controller.sync([], null);

    expect(controller.readStatus()).toEqual({ itemIds: ["untracked"], markerCount: 1 });
    controller.dispose();
  });

  test("preserves duplicate and missing marker ids for coordinator fail-closed validation", () => {
    const controller = createPersistentOverlayController({ root: document });
    const shadow = getOverlayHost().shadowRoot!;
    for (const itemId of ["duplicate", "duplicate", null]) {
      const overlay = document.createElement("div");
      overlay.className = "ui-attach-overlay";
      if (itemId !== null) overlay.dataset.itemId = itemId;
      const marker = document.createElement("div");
      marker.className = "ui-attach-marker-capsule";
      overlay.append(marker);
      shadow.append(overlay);
    }

    expect(controller.readStatus()).toEqual({
      itemIds: ["duplicate", "duplicate"],
      markerCount: 3,
    });
    controller.dispose();
  });

  test("reports hidden markers but clears immediately after sync empty, host detach, or dispose", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 24, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(40, 90, 180, 42));
    const controller = createPersistentOverlayController({ root: document });

    controller.sync([
      { itemId: "item-b", label: "B", target: first },
      { itemId: "item-a", label: "A", target: second },
    ], null);
    controller.setDisplayMode("hidden");
    expect(controller.readStatus()).toEqual({ itemIds: ["item-a", "item-b"], markerCount: 2 });

    controller.sync([], null);
    expect(controller.readStatus()).toEqual({ itemIds: [], markerCount: 0 });

    controller.sync([{ itemId: "item-a", label: "A", target: first }], null);
    getOverlayHost().remove();
    expect(controller.readStatus()).toEqual({ itemIds: [], markerCount: 0 });

    controller.dispose();
    expect(controller.readStatus()).toEqual({ itemIds: [], markerCount: 0 });
  });

  test("renders accessible edit, remove, and more controls that only disclose item ids", () => {
    const target = document.createElement("button");
    target.textContent = "Private page text";
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onMore = vi.fn();
    const controller = createPersistentOverlayController({
      root: document,
      onEdit,
      onRemove,
      onMore,
      actionLabels: {
        edit: "Edit",
        remove: "Remove selected element",
        more: "More",
        open: "Open actions for annotation",
      },
    });

    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    const host = getOverlayHost();
    const overlay = getOverlays()[0];
    if (!overlay) throw new Error("overlay missing");
    const visual = overlay.querySelector<HTMLElement>(".ui-attach-overlay-visual");
    const capsule = overlay.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay.querySelector<HTMLElement>(".ui-attach-label");
    const actions = overlay.querySelector<HTMLElement>(".ui-attach-actions");
    const edit = getActionButton(overlay, "edit");
    const remove = getActionButton(overlay, "remove");
    const more = getActionButton(overlay, "more");

    expect(host.hasAttribute("aria-hidden")).toBe(false);
    expect(host.dataset.uiAttachIgnore).toBe("true");
    expect(visual?.getAttribute("aria-hidden")).toBe("true");
    expect(capsule).toBeInstanceOf(HTMLDivElement);
    expect(label?.parentElement).toBe(capsule);
    expect(actions?.parentElement).toBe(capsule);
    expect(label).toBeInstanceOf(HTMLButtonElement);
    expect(label?.getAttribute("aria-hidden")).toBeNull();
    expect(label?.getAttribute("aria-label")).toBe("Open actions for annotation A");
    expect(label?.getAttribute("aria-expanded")).toBe("false");
    expect(label?.title).toBe("");
    expect(actions?.style.pointerEvents).toBe("none");
    expect([edit, remove, more].map((button) => button.style.pointerEvents)).toEqual([
      "",
      "",
      "",
    ]);
    expect([edit, remove, more].map((button) => button.type)).toEqual([
      "button",
      "button",
      "button",
    ]);
    expect([edit, remove, more].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Edit",
      "Remove selected element",
      "More",
    ]);
    expect([edit, remove, more].map((button) => button.title)).toEqual(["", "", ""]);
    expect([edit, remove, more].map((button) => button.textContent)).toEqual(["", "", ""]);
    expect([edit, remove, more].map((button) =>
      button.querySelector("svg")?.getAttribute("data-icon")
    )).toEqual(["edit", "remove", "more"]);
    expect(Array.from(remove.querySelectorAll("path"), (path) => path.getAttribute("d"))).toEqual([
      "M6 6l12 12",
      "M18 6 6 18",
    ]);
    expect(Array.from(more.querySelectorAll("path"), (path) => path.getAttribute("d"))).toEqual([
      "M12 6h.01",
      "M12 12h.01",
      "M12 18h.01",
    ]);

    label?.click();
    expect(overlay.dataset.actionsOpen).toBe("true");
    expect(label?.getAttribute("aria-expanded")).toBe("true");
    expect(onEdit).not.toHaveBeenCalled();
    edit.click();
    expect(overlay.dataset.actionsOpen).toBe("false");
    expect(label?.getAttribute("aria-expanded")).toBe("false");
    remove.click();
    more.click();

    expect(onEdit.mock.calls).toEqual([["item-a"]]);
    expect(onRemove.mock.calls).toEqual([["item-a"]]);
    expect(onMore.mock.calls).toEqual([["item-a"]]);
    expect(target.isConnected).toBe(true);
    expect(getOverlays()).toHaveLength(1);
    for (const calls of [onEdit.mock.calls, onRemove.mock.calls, onMore.mock.calls]) {
      expect(JSON.stringify(calls)).not.toContain("Private page text");
    }
    controller.dispose();
  });

  test("marks only labels with a non-empty task note without changing marker geometry", async () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(rect(180, 40, 120, 36));
    const onSave = vi.fn();
    const controller = createPersistentOverlayController({
      root: document,
      editor: { onSave },
      onMore: vi.fn(),
    });

    controller.sync([
      { itemId: "without-note", label: "1", taskNote: "  \n ", target: first },
      { itemId: "with-note", label: "2", taskNote: "Keep this spacing.", target: second },
    ], null);

    const withoutNote = getOverlays()
      .find((overlay) => overlay.dataset.itemId === "without-note")
      ?.querySelector<HTMLButtonElement>(".ui-attach-label");
    const withNote = getOverlays()
      .find((overlay) => overlay.dataset.itemId === "with-note")
      ?.querySelector<HTMLButtonElement>(".ui-attach-label");
    const withoutNoteBadge = getOverlays()
      .find((overlay) => overlay.dataset.itemId === "without-note")
      ?.querySelector<HTMLElement>(".ui-attach-note-badge");
    const withNoteOverlay = getOverlays()
      .find((overlay) => overlay.dataset.itemId === "with-note");
    const withNoteBadge = withNoteOverlay?.querySelector<HTMLElement>(".ui-attach-note-badge");
    const styles = getOverlayHost().shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(withoutNote?.dataset.hasTaskNote).toBe("false");
    expect(withoutNote?.getAttribute("aria-label")).toBe("Open actions for annotation 1");
    expect(withNote?.dataset.hasTaskNote).toBe("true");
    expect(withNote?.getAttribute("aria-label")).toBe(
      "Open actions for annotation 2; Has task note",
    );
    expect(withoutNoteBadge?.dataset.visible).toBe("false");
    expect(withNoteBadge?.dataset.visible).toBe("true");
    expect(withNoteBadge?.parentElement).toBe(withNoteOverlay);
    expect(styles).toContain(".ui-attach-note-badge {");
    expect(styles).toContain("width: 9px;");
    expect(styles).toContain("transform: translate(-50%, -50%);");
    expect(styles).toContain(".ui-attach-marker-capsule {");
    expect(styles).toContain("overflow: hidden;");

    controller.sync([
      { itemId: "without-note", label: "1", taskNote: "Now documented", target: first },
      { itemId: "with-note", label: "2", taskNote: "", target: second },
    ], null);

    expect(withoutNote?.dataset.hasTaskNote).toBe("true");
    expect(withNote?.dataset.hasTaskNote).toBe("false");
    expect(withoutNoteBadge?.dataset.visible).toBe("true");
    expect(withNoteBadge?.dataset.visible).toBe("false");
    expect(withNote?.getAttribute("aria-label")).toBe("Open actions for annotation 2");

    expect(controller.openEditor("without-note")).toBe(true);
    const editor = getOverlayHost().shadowRoot?.querySelector<HTMLElement>(
      ".ui-attach-anchored-editor",
    );
    const textarea = editor?.querySelector<HTMLTextAreaElement>(".ui-attach-editor-textarea");
    const save = editor?.querySelector<HTMLButtonElement>('[data-action="save-note"]');
    if (!textarea || !save) throw new Error("task-note editor missing");
    textarea.value = "";
    save.click();
    await vi.waitFor(() => expect(withoutNote?.dataset.hasTaskNote).toBe("false"));
    expect(onSave).toHaveBeenCalledWith("without-note", "");
    expect(withoutNote?.getAttribute("aria-label")).toBe("Open actions for annotation 1");
    controller.dispose();
  });

  test("only action buttons receive pointer events and suppress page interactions", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const onRemove = vi.fn();
    const pagePointerDown = vi.fn();
    const pageClick = vi.fn();
    document.addEventListener("pointerdown", pagePointerDown);
    document.addEventListener("click", pageClick);
    const controller = createPersistentOverlayController({ root: document, onRemove });
    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    const overlay = getOverlays()[0];
    if (!overlay) throw new Error("overlay missing");
    const remove = getActionButton(overlay, "remove");
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true, composed: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });

    remove.dispatchEvent(pointerDown);
    remove.dispatchEvent(click);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(pagePointerDown).not.toHaveBeenCalled();
    expect(pageClick).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith("item-a");
    expect(getOverlayHost().style.pointerEvents).toBe("none");
    expect(overlay.style.pointerEvents).toBe("none");

    document.removeEventListener("pointerdown", pagePointerDown);
    document.removeEventListener("click", pageClick);
    controller.dispose();
  });

  test("expands its marker into an elevated action capsule with a hover-leave grace period", () => {
    vi.useFakeTimers();
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const controller = createPersistentOverlayController({
      root: document,
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onMore: vi.fn(),
    });
    controller.sync([{ itemId: "item-a", label: "A", target }], null);

    const overlay = getOverlays()[0];
    if (!overlay) throw new Error("overlay missing");
    const edit = getActionButton(overlay, "edit");
    const capsule = overlay.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay.querySelector<HTMLButtonElement>(".ui-attach-label");
    const actions = overlay.querySelector<HTMLElement>(".ui-attach-actions");
    if (!capsule || !label || !actions) throw new Error("overlay actions missing");
    const styles = getOverlayHost().shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(overlay.dataset.active).toBe("false");
    expect(overlay.dataset.actionsOpen).toBe("false");

    target.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("false");
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("true");
    capsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: edit }));
    expect(overlay.dataset.actionsOpen).toBe("true");
    capsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
    vi.advanceTimersByTime(149);
    expect(overlay.dataset.actionsOpen).toBe("true");
    vi.advanceTimersByTime(1);
    expect(overlay.dataset.actionsOpen).toBe("false");

    edit.focus();
    expect(getOverlayHost().shadowRoot?.activeElement).toBe(edit);
    expect(styles).not.toContain('.ui-attach-overlay[data-active="true"] .ui-attach-actions');
    expect(styles).toContain(".ui-attach-marker-capsule {\n      position: absolute;");
    expect(styles).toContain("width: var(--ui-attach-marker-closed-width, 28px);");
    expect(styles).toContain("height: 28px;");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain('.ui-attach-overlay[data-actions-open="true"] .ui-attach-marker-capsule');
    expect(styles).toContain("width: var(--ui-attach-marker-open-width, 28px);");
    expect(styles).toContain("height: 32px;");
    expect(styles).toContain('.ui-attach-overlay[data-actions-open="true"] {\n      z-index: 3;');
    expect(styles).toContain(".ui-attach-overlay:focus-within {\n      z-index: 2;");
    expect(styles).toContain("border-radius: 999px;");
    expect(styles).not.toContain("transform: scaleX(0.12);");
    expect(styles).toContain(".ui-attach-action {\n      all: unset;");
    expect(styles).toContain(".ui-attach-overlay:focus-within .ui-attach-action");
    expect(styles).toContain("pointer-events: auto;");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (forced-colors: active)");
    controller.dispose();
  });

  test("requires a real pointer re-entry before opening actions for a captured marker", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const onMore = vi.fn();
    const controller = createPersistentOverlayController({ root: document, onMore });

    controller.sync([{
      itemId: "preview",
      label: "Select",
      interactive: false,
      target,
    }], "preview");
    controller.suppressActionsUntilPointerReentry?.("captured");
    controller.sync([{
      itemId: "captured",
      label: "1",
      target,
      anchor: { xRatio: 0.5, yRatio: 0.5 },
    }], "captured");

    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLButtonElement>(".ui-attach-label");
    if (!overlay || !capsule || !label) throw new Error("captured marker fixture missing");

    controller.sync([{
      itemId: "captured",
      label: "1",
      target,
      anchor: { xRatio: 0.5, yRatio: 0.5 },
    }], "captured");
    controller.refresh();
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("false");
    expect(overlay.dataset.pointerReentryPending).toBe("true");

    // A real browser can retarget the capture click to the label inserted under
    // the pointer. That click must be isolated without opening or invoking the
    // newly-created action rail.
    label.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: 1,
    }));
    expect(overlay.dataset.actionsOpen).toBe("false");
    expect(overlay.dataset.pointerReentryPending).toBe("true");
    getActionButton(overlay, "more").dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: 1,
    }));
    expect(overlay.dataset.actionsOpen).toBe("false");
    expect(overlay.dataset.pointerReentryPending).toBe("true");
    expect(onMore).not.toHaveBeenCalled();

    capsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
    expect(overlay.dataset.actionsOpen).toBe("false");
    expect(overlay.dataset.pointerReentryPending).toBe("false");
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("true");

    controller.dispose();
  });

  test("keeps keyboard focus available and clears capture hover intent while hidden", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
    controller.suppressActionsUntilPointerReentry?.("captured");
    controller.sync([{
      itemId: "captured",
      label: "1",
      target,
      anchor: { xRatio: 0.5, yRatio: 0.5 },
    }], "captured");
    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLButtonElement>(".ui-attach-label");
    if (!overlay || !capsule || !label) throw new Error("captured marker fixture missing");

    label.focus();
    expect(overlay.dataset.actionsOpen).toBe("true");
    label.blur();

    controller.suppressActionsUntilPointerReentry?.("captured");
    controller.setDisplayMode("hidden");
    controller.setDisplayMode("hover");
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("true");
    controller.dispose();
  });

  test("does not consume the first real hover when viewport clamping moves the marker off the capture point", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 40, 120, 36));
    const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
    controller.suppressActionsUntilPointerReentry?.("captured");
    controller.sync([{
      itemId: "captured",
      label: "1",
      target,
      anchor: { xRatio: 0, yRatio: 0.5 },
    }], "captured");

    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    if (!overlay || !capsule) throw new Error("edge marker fixture missing");
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("true");
    controller.dispose();
  });

  test("keeps only the newest hovered marker capsule open when annotations overlap", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
    controller.sync([
      { itemId: "item-a", label: "1", target, anchor: { xRatio: 0.3, yRatio: 0.5 } },
      { itemId: "item-b", label: "2", target, anchor: { xRatio: 0.7, yRatio: 0.5 } },
    ], "item-b");

    const [first, second] = getOverlays();
    const firstCapsule = first?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const secondCapsule = second?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    if (!first || !second || !firstCapsule || !secondCapsule) throw new Error("overlay capsules missing");

    firstCapsule.dispatchEvent(new Event("pointerenter"));
    expect(first.dataset.actionsOpen).toBe("true");
    secondCapsule.dispatchEvent(new Event("pointerenter"));
    expect(first.dataset.actionsOpen).toBe("false");
    expect(second.dataset.actionsOpen).toBe("true");
    controller.dispose();
  });

  test("restores the same-target durable active visual after a hovered capsule leaves", () => {
    vi.useFakeTimers();
    try {
      const target = document.createElement("button");
      document.body.append(target);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
      const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
      controller.sync([
        { itemId: "item-1", label: "1", target, anchor: { xRatio: 0.3, yRatio: 0.5 } },
        { itemId: "item-2", label: "2", target, anchor: { xRatio: 0.7, yRatio: 0.5 } },
      ], "item-1");
      const [active, hovered] = getOverlays();
      const hoveredCapsule = hovered?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
      if (!active || !hovered || !hoveredCapsule) throw new Error("same-target overlays missing");
      expect(active.querySelector(".ui-attach-overlay-visual")).not.toBeNull();

      hoveredCapsule.dispatchEvent(new Event("pointerenter"));
      expect(hovered.dataset.hovered).toBe("true");
      expect(active.dataset.suppressedActive).toBe("true");
      expect(active.dataset.targetActive).toBe("false");

      hoveredCapsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
      vi.advanceTimersByTime(150);
      expect(hovered.dataset.hovered).toBe("false");
      expect(active.dataset.suppressedActive).toBe("false");
      expect(active.dataset.targetActive).toBe("true");
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a durable active target distinct while a marker on another target is hovered", () => {
    vi.useFakeTimers();
    try {
      const activeTarget = document.createElement("button");
      const hoveredTarget = document.createElement("button");
      document.body.append(activeTarget, hoveredTarget);
      vi.spyOn(activeTarget, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
      vi.spyOn(hoveredTarget, "getBoundingClientRect").mockReturnValue(rect(180, 40, 120, 36));
      const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
      controller.sync([
        { itemId: "item-6", label: "6", target: activeTarget },
        { itemId: "item-2", label: "2", target: hoveredTarget },
      ], "item-6");
      const [active, hovered] = getOverlays();
      const hoveredCapsule = hovered?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
      if (!active || !hovered || !hoveredCapsule) throw new Error("cross-target overlays missing");
      expect(active.dataset.targetActive).toBe("true");

      hoveredCapsule.dispatchEvent(new Event("pointerenter"));
      expect(hovered.dataset.hovered).toBe("true");
      expect(hovered.dataset.actionsOpen).toBe("true");
      expect(active.dataset.targetActive).toBe("true");

      hoveredCapsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
      vi.advanceTimersByTime(150);
      expect(hovered.dataset.hovered).toBe("false");
      expect(active.dataset.targetActive).toBe("true");
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("pins a marker to the selected point and preserves its relative anchor after reflow", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const readBounds = vi.spyOn(target, "getBoundingClientRect")
      .mockReturnValue(rect(100, 200, 200, 100));
    const controller = createPersistentOverlayController({
      root: document,
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onMore: vi.fn(),
    });
    controller.sync([{
      itemId: "item-a",
      label: "A",
      target,
      anchor: { xRatio: 0.25, yRatio: 0.75 },
    }], "item-a");
    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlay || !capsule || !label) throw new Error("anchored overlay fixture missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));

    controller.refresh();
    expect(capsule.dataset.placement).toBe("right");
    expect(capsule.style.left).toBe("36px");
    expect(capsule.style.top).toBe("75px");
    expect(capsule.style.getPropertyValue("--ui-attach-marker-closed-width")).toBe("28px");
    expect(capsule.style.getPropertyValue("--ui-attach-marker-open-width")).toBe("120px");

    readBounds.mockReturnValue(rect(300, 400, 400, 200));
    controller.refresh();
    expect(capsule.style.left).toBe("86px");
    expect(capsule.style.top).toBe("150px");
    controller.dispose();
  });

  test("defaults to right expansion while it fits and only flips left after reflow requires it", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    const readBounds = vi.spyOn(target, "getBoundingClientRect")
      .mockReturnValue(rect(600, 100, 200, 40));
    const controller = createPersistentOverlayController({
      root: document,
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onMore: vi.fn(),
    });
    controller.sync([{
      itemId: "item-a",
      label: "1",
      target,
      anchor: { xRatio: 0.5, yRatio: 0.5 },
    }], "item-a");
    const capsule = getOverlays()[0]?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = getOverlays()[0]?.querySelector<HTMLElement>(".ui-attach-label");
    if (!capsule || !label) throw new Error("overlay marker missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));

    controller.refresh();
    expect(capsule.dataset.placement).toBe("right");
    expect(capsule.style.left).toBe("86px");
    expect(capsule.style.right).toBe("");

    readBounds.mockReturnValue(rect(900, 100, 100, 40));
    controller.refresh();
    expect(capsule.dataset.placement).toBe("left");
    expect(capsule.style.left).toBe("auto");
    expect(capsule.style.right).toBe("36px");
    controller.dispose();
  });

  test("renders only controls backed by callbacks", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });

    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    const overlay = getOverlays()[0];
    if (!overlay) throw new Error("overlay missing");
    expect(overlay.querySelector('[data-action="edit"]')).toBeNull();
    expect(overlay.querySelector('[data-action="remove"]')).toBeNull();
    expect(getActionButton(overlay, "more")).toBeInstanceOf(HTMLButtonElement);
    controller.dispose();
  });

  test("uses compact icons with accessible labels and no duplicate native tooltips", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(12, 40, 120, 36));
    const controller = createPersistentOverlayController({
      root: document,
      onEdit: vi.fn(),
      onMore: vi.fn(),
    });

    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");

    const overlay = getOverlays()[0];
    if (!overlay) throw new Error("overlay missing");
    const edit = getActionButton(overlay, "edit");
    const more = getActionButton(overlay, "more");
    expect(edit.textContent).toBe("");
    expect(more.textContent).toBe("");
    expect(edit.querySelector("svg")?.getAttribute("data-icon")).toBe("edit");
    expect(more.querySelector("svg")?.getAttribute("data-icon")).toBe("more");
    expect(edit.getAttribute("aria-label")).toBe("Edit selected element");
    expect(edit.title).toBe("");
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

  test("places the number and actions inside one marker capsule", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(100, 100, 60, 30));
    const controller = createPersistentOverlayController({ root: document, onEdit: vi.fn() });
    controller.sync([{ itemId: "item-a", label: "A", target }], "item-a");
    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    const actions = overlay?.querySelector<HTMLElement>(".ui-attach-actions");
    if (!overlay || !capsule || !label || !actions) throw new Error("overlay fixture missing");

    expect(Array.from(capsule.children)).toEqual([label, actions]);
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
    const controller = createPersistentOverlayController({
      root: document,
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onMore: vi.fn(),
    });

    controller.sync(
      [{ itemId: "item-a", label: "A", target }],
      null,
      { sourceItemId: "item-a", referenceItemId: "item-b" },
    );
    const overlay = getOverlays()[0];
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!capsule || !label) throw new Error("overlay marker missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(968, -10, 100, 24));

    controller.refresh();

    expect(capsule.dataset.placement).toBe("left");
    expect(capsule.style.left).toBe("auto");
    expect(capsule.style.right).toBe("0px");
    expect(capsule.style.top).toBe("48px");
    expect(capsule.style.getPropertyValue("--ui-attach-marker-open-width")).toBe("192px");
    expect(Array.from(
      capsule.querySelectorAll<HTMLElement>(".ui-attach-action"),
      (action) => action.dataset.action,
    )).toEqual(["edit", "remove", "more"]);
    const styles = getOverlayHost().shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(styles).not.toContain(
      '.ui-attach-marker-capsule[data-placement="left"] .ui-attach-actions {\n' +
      "      flex-direction: row-reverse;",
    );
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
    const firstCapsule = overlays[0]?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const secondCapsule = overlays[1]?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const firstLabel = overlays[0]?.querySelector<HTMLElement>(".ui-attach-label");
    const secondLabel = overlays[1]?.querySelector<HTMLElement>(".ui-attach-label");
    if (!firstCapsule || !secondCapsule || !firstLabel || !secondLabel) {
      throw new Error("overlay markers missing");
    }
    vi.spyOn(firstLabel, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));
    vi.spyOn(secondLabel, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));

    controller.refresh();

    const firstBadge = capsuleStyleRect(overlays[0], firstCapsule, 28, 28);
    const secondBadge = capsuleStyleRect(overlays[1], secondCapsule, 28, 28);
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
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlay || !capsule || !label) throw new Error("overlay fixture missing");
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 40, 24));

    controller.refresh();

    const badge = capsuleStyleRect(overlay, capsule, 40, 28);
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
    const markers = overlays.map((overlay) => {
      const capsule = overlay.querySelector<HTMLElement>(".ui-attach-marker-capsule");
      const label = overlay.querySelector<HTMLElement>(".ui-attach-label");
      if (!capsule || !label) throw new Error("overlay marker missing");
      vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 24));
      return { capsule, label };
    });

    controller.refresh();

    const badges = overlays.map((overlay, index) => (
      capsuleStyleRect(overlay, markers[index]!.capsule, 28, 28)
    ));
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
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const label = overlay?.querySelector<HTMLElement>(".ui-attach-label");
    if (!overlay || !capsule || !label) throw new Error("overlay fixture missing");
    expect(overlay.style.display).toBe("none");

    readBounds.mockReturnValue(rect(980, 2, 40, 30));
    vi.spyOn(label, "getBoundingClientRect").mockReturnValue(rect(968, -10, 100, 24));
    controller.refresh();

    expect(overlay.style.display).toBe("block");
    expect(capsule.dataset.placement).toBe("right");
    expect(capsule.style.left).toBe("-60px");
    expect(capsule.style.right).toBe("");
    expect(capsule.style.top).toBe("48px");
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

  test("tracks scrolling inside the target shadow root", () => {
    const pageHost = document.createElement("div");
    const pageShadow = pageHost.attachShadow({ mode: "open" });
    const scroller = document.createElement("div");
    const target = document.createElement("button");
    scroller.append(target);
    pageShadow.append(scroller);
    document.body.append(pageHost);
    const readBounds = vi.spyOn(target, "getBoundingClientRect")
      .mockReturnValueOnce(rect(10, 20, 100, 30))
      .mockReturnValue(rect(30, 80, 100, 30));
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
    scroller.dispatchEvent(new Event("scroll"));

    expect(queuedFrames).toHaveLength(1);
    queuedFrames.shift()?.(0);
    expect(readBounds).toHaveBeenCalledTimes(2);
    expect(getOverlays()[0]?.style.left).toBe("30px");
    expect(getOverlays()[0]?.style.top).toBe("80px");
    controller.dispose();
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

describe("persistent overlay display modes", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll("[data-ui-attach-overlay-root]").forEach((element) => element.remove());
  });

  test("defaults to hover, de-duplicates a full target visual, and restores hidden bindings", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(20, 40, 180, 42));
    const controller = createPersistentOverlayController({ root: document, onMore: vi.fn() });
    controller.sync([
      { itemId: "one", label: "1", target },
      { itemId: "two", label: "2", target },
      { itemId: "three", label: "3", target },
    ], "two");
    const shadow = getOverlayHost().shadowRoot!;
    expect(getOverlayHost().dataset.displayMode).toBe("hover");
    expect(shadow.querySelectorAll(".ui-attach-marker-capsule")).toHaveLength(3);
    expect(shadow.querySelectorAll(".ui-attach-overlay-visual")).toHaveLength(1);
    const firstCapsule = shadow.querySelector<HTMLElement>(".ui-attach-marker-capsule")!;
    firstCapsule.dispatchEvent(new Event("pointerenter"));
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.highlightVisible)
      .toBe("true");
    firstCapsule.querySelector<HTMLButtonElement>(".ui-attach-label")?.focus();
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.highlightVisible)
      .toBe("true");
    controller.setDisplayMode("hidden");
    expect(shadow.activeElement).toBeNull();
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.focusActive).toBe("false");
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.actionsOpen).toBe("false");

    controller.setDisplayMode("hidden");
    expect(getOverlayHost().dataset.displayMode).toBe("hidden");
    expect(shadow.querySelectorAll(".ui-attach-marker-capsule")).toHaveLength(3);
    expect(shadow.querySelector<HTMLButtonElement>(".ui-attach-label")?.tabIndex).toBe(-1);
    controller.setTemporaryHighlight("one");
    expect(getOverlayHost().dataset.temporaryHighlight).toBe("true");
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.temporaryPreview)
      .toBe("true");
    expect(shadow.querySelector<HTMLElement>(".ui-attach-overlay")?.dataset.highlightVisible)
      .toBe("true");
    controller.setDisplayMode("full");
    expect(shadow.querySelectorAll(".ui-attach-marker-capsule")).toHaveLength(3);
    expect(shadow.querySelectorAll(".ui-attach-overlay-visual")).toHaveLength(1);
    controller.dispose();
  });

  test("keeps a non-interactive preview visible without stealing durable marker actions", () => {
    const target = document.createElement("button");
    document.body.append(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(20, 40, 180, 42));
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onMore = vi.fn();
    const controller = createPersistentOverlayController({
      root: document,
      editor: { onSave: vi.fn() },
      onEdit,
      onRemove,
      onMore,
    });
    controller.sync([
      { itemId: "durable", label: "1", taskNote: "Keep me", target },
      { itemId: "preview", label: "Select", interactive: false, target },
    ], "durable");
    controller.setTemporaryHighlight("preview");

    const shadow = getOverlayHost().shadowRoot!;
    const durable = shadow.querySelector<HTMLElement>("[data-item-id='durable']")!;
    const preview = shadow.querySelector<HTMLElement>("[data-item-id='preview']")!;
    durable.querySelector<HTMLButtonElement>(".ui-attach-label")?.click();
    expect(durable.dataset.actionsOpen).toBe("true");

    preview.querySelector<HTMLElement>(".ui-attach-marker-capsule")
      ?.dispatchEvent(new Event("pointerenter"));
    preview.querySelector<HTMLElement>(".ui-attach-label")?.click();

    expect(preview.querySelector(".ui-attach-label")?.tagName).toBe("SPAN");
    expect(preview.querySelector(".ui-attach-actions")).toBeNull();
    expect(preview.querySelector("button")).toBeNull();
    expect(preview.dataset.temporaryPreview).toBe("true");
    expect(shadow.querySelector<HTMLElement>("[data-highlight-visible='true']")).not.toBeNull();
    expect(durable.dataset.actionsOpen).toBe("true");
    expect(controller.openEditor("preview")).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onMore).not.toHaveBeenCalled();
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

function getActionButton(
  overlay: HTMLElement,
  action: "edit" | "remove" | "more",
): HTMLButtonElement {
  const button = overlay.querySelector(`[data-action="${action}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${action} action missing`);
  }
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

function capsuleStyleRect(
  overlay: HTMLElement,
  capsule: HTMLElement,
  width: number,
  height: number,
): DOMRect {
  const localLeft = capsule.style.left !== "" && capsule.style.left !== "auto"
    ? Number.parseFloat(capsule.style.left)
    : Number.parseFloat(overlay.style.width) - Number.parseFloat(capsule.style.right) - width;
  return rect(
    Number.parseFloat(overlay.style.left) + localLeft,
    Number.parseFloat(overlay.style.top) + Number.parseFloat(capsule.style.top) - height / 2,
    width,
    height,
  );
}

function overlapArea(first: DOMRect, second: DOMRect): number {
  return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
}
