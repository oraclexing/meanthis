// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { claimMeanThisSurface } from "./surface-claim";
import { createMeanThisWebWidget } from "./web-widget";

describe("createMeanThisWebWidget", () => {
  test("emits one snapshot for a changed display-mode radio and none for the current mode", () => {
    const onChange = vi.fn();
    const widget = createMeanThisWebWidget({
      root: document, initialOpen: true, debugInspectableDom: true, onChange,
    });
    widget.open();
    const view = widget.element;
    view?.querySelector<HTMLButtonElement>("[data-meanthis-action='open-settings']")?.click();
    const hover = view?.querySelector<HTMLInputElement>("input[value='hover']")!;
    const hidden = view?.querySelector<HTMLInputElement>("input[value='hidden']")!;
    expect(view?.querySelector("[data-meanthis-action='collect-basic-diagnostics']")).toBeNull();
    onChange.mockClear();
    hover.checked = true;
    hover.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    hidden.checked = true;
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.lastCall?.[0].displayMode).toBe("hidden");
    widget.destroy();
  });
  beforeEach(() => {
    document.documentElement.querySelectorAll("[data-meanthis-surface-claim]")
      .forEach((element) => element.remove());
    document.body.innerHTML = `
      <main data-surface>
        <button data-testid="save" type="button">Save changes</button>
        <img alt="Radar preview">
      </main>
    `;
  });

  test("mounts the shared view and captures multiple page elements", () => {
    const onChange = vi.fn();
    const widget = createMeanThisWebWidget({
      root: document,
      surface: "[data-surface]",
      initialOpen: true,
      onChange,
      writeText: vi.fn(async () => undefined),
    });

    expect(widget.status).toBe("claimed");
    expect(document.querySelectorAll("[data-meanthis-web-widget-host]")).toHaveLength(1);
    expect(widget.element?.shadowRoot).toBeNull();
    expect(widget.element?.hasAttribute("data-ui-attach-ignore")).toBe(true);

    expect(widget.startSelection()).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
    expect(widget.snapshot().targets).toHaveLength(1);
    expect(widget.snapshot().targets[0].attachment.element.text).toBe("Save changes");
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.textContent).toBe("1");
    expect(widget.snapshot().mode).toBe("selecting");
    expect(onChange).toHaveBeenCalled();

    document.querySelector<HTMLImageElement>("img")?.click();
    expect(widget.snapshot().targets.map((target) => target.label)).toEqual(["A", "B"]);
    expect(widget.snapshot().mode).toBe("selecting");

    widget.stopSelection();
    expect(widget.snapshot().mode).toBe("ready");

    widget.destroy();
    expect(document.querySelector("[data-meanthis-web-widget-host]")).toBeNull();
    expect(document.querySelector("[data-ui-attach-overlay-root]")).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-testid='save']")?.style.outline).toBe("");
  });

  test("previews the selectable target under the pointer without committing it", () => {
    const save = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const image = document.querySelector<HTMLImageElement>("img")!;
    const onChange = vi.fn();
    vi.spyOn(save, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect(260, 120, 160, 90));
    const widget = createMeanThisWebWidget({
      root: document,
      surface: "[data-surface]",
      initialOpen: true,
      onChange,
    });
    widget.startSelection();
    const changeCountBeforeHover = onChange.mock.calls.length;
    save.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));

    expect(widget.snapshot().targets).toHaveLength(0);
    expect(getOverlayShadow()?.querySelectorAll(".ui-attach-overlay")).toHaveLength(1);
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.textContent).toBe("Select");
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.tagName).toBe("SPAN");
    expect(getOverlayShadow()?.querySelector(".ui-attach-actions")).toBeNull();
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.getAttribute("aria-hidden"))
      .toBe("true");
    const previewCapsule = getOverlayShadow()
      ?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    expect(previewCapsule?.style.left).toBe("-32px");
    expect(previewCapsule?.style.top).toBe("21px");
    expect(onChange).toHaveBeenCalledTimes(changeCountBeforeHover);

    image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(getOverlayShadow()?.querySelectorAll(".ui-attach-overlay")).toHaveLength(1);
    expect(getOverlayShadow()?.querySelector<HTMLElement>(".ui-attach-overlay")?.style.left)
      .toBe("260px");
    expect(widget.snapshot().targets).toHaveLength(0);

    document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();

    save.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.textContent).toBe("Select");

    widget.stopSelection();
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();
    widget.destroy();
  });

  test("does not expand a captured marker until the pointer leaves and re-enters", () => {
    const save = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(save, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    save.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    save.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 130,
      clientY: 141,
    }));

    const overlay = getOverlayShadow()?.querySelector<HTMLElement>(".ui-attach-overlay");
    const capsule = overlay?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    if (!overlay || !capsule) throw new Error("captured marker fixture missing");
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("false");
    capsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
    capsule.dispatchEvent(new Event("pointerenter"));
    expect(overlay.dataset.actionsOpen).toBe("true");
    widget.destroy();
  });

  test("also guards a new annotation added to an already selected target", () => {
    const save = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(save, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const widget = createMeanThisWebWidget({ root: document, initialOpen: true });
    widget.startSelection();
    for (const [clientX, clientY] of [[50, 125], [210, 155]]) {
      save.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      }));
    }

    expect(widget.snapshot().targets[0]?.annotations).toHaveLength(2);
    const secondOverlay = Array.from(getOverlayShadow()?.querySelectorAll<HTMLElement>(
      ".ui-attach-overlay",
    ) ?? []).find((candidate) => (
      candidate.querySelector(".ui-attach-label")?.textContent === "2"
    ));
    const secondCapsule = secondOverlay
      ?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    if (!secondOverlay || !secondCapsule) throw new Error("second marker fixture missing");
    secondCapsule.dispatchEvent(new Event("pointerenter"));
    expect(secondOverlay.dataset.actionsOpen).toBe("false");
    secondCapsule.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: document.body }));
    secondCapsule.dispatchEvent(new Event("pointerenter"));
    expect(secondOverlay.dataset.actionsOpen).toBe("true");
    widget.destroy();
  });

  test("keeps debug-inspectable widget UI and its anchored editor outside armed selection", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    const ownedControl = document.createElement("button");
    ownedControl.textContent = "Debug control";
    widget.element?.append(ownedControl);
    widget.startSelection();

    target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    expect(getOverlayShadow()?.querySelector(".ui-attach-label")?.textContent).toBe("Select");
    ownedControl.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    ownedControl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    ownedControl.click();
    ownedControl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    await flushAsyncActions();

    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();
    expect(widget.snapshot()).toMatchObject({ mode: "selecting", targets: [] });

    target.click();
    const overlay = getOverlayShadow()?.querySelector<HTMLElement>(".ui-attach-overlay");
    overlay?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    await flushAsyncActions();
    const editor = getOverlayShadow()?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    expect(editor).not.toBeNull();
    editor?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    expect(getOverlayShadow()?.querySelector("[data-ui-attach-anchored-editor]")).toBeNull();
    expect(widget.snapshot()).toMatchObject({ mode: "selecting", targets: [{ annotations: [{}] }] });
    widget.destroy();
  });

  test("keeps one target with independent annotations for separated clicks", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(20, 40, 200, 100));
    const widget = createMeanThisWebWidget({ root: document, initialOpen: true });

    widget.startSelection();
    for (const [clientX, clientY] of [[45, 65], [120, 90], [195, 115]]) {
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      }));
    }

    const snapshot = widget.snapshot();
    expect(snapshot.targets).toHaveLength(1);
    expect(snapshot.targets[0]?.label).toBe("A");
    expect(snapshot.targets[0]?.annotations.map((annotation) => annotation.label))
      .toEqual(["1", "2", "3"]);
    expect(snapshot.targets[0]?.annotations.map((annotation) => annotation.selectionPoint))
      .toEqual([
        { kind: "element_relative_pointer", xRatio: 0.125, yRatio: 0.25 },
        { kind: "element_relative_pointer", xRatio: 0.5, yRatio: 0.5 },
        { kind: "element_relative_pointer", xRatio: 0.875, yRatio: 0.75 },
      ]);
    expect(Array.from(getOverlayShadow()?.querySelectorAll(".ui-attach-label") ?? [])
      .map((marker) => marker.textContent)).toEqual(["1", "2", "3"]);
    widget.stopSelection();

    const secondAnnotationId = snapshot.targets[0]!.annotations[1]!.annotationId;
    const thirdAnnotationId = snapshot.targets[0]!.annotations[2]!.annotationId;
    const removeAnnotation = async (annotationId: string): Promise<void> => {
      const overlay = Array.from(getOverlayShadow()?.querySelectorAll<HTMLElement>(
        ".ui-attach-overlay",
      ) ?? []).find((candidate) => candidate.dataset.itemId === annotationId);
      overlay?.querySelector<HTMLButtonElement>("[data-action='remove']")?.click();
      await flushAsyncActions();
    };

    await removeAnnotation(secondAnnotationId);
    expect(widget.snapshot().targets[0]?.annotations.map((annotation) => ({
      id: annotation.annotationId,
      label: annotation.label,
    }))).toEqual([
      { id: snapshot.targets[0]!.annotations[0]!.annotationId, label: "1" },
      { id: thirdAnnotationId, label: "2" },
    ]);
    expect(Array.from(getOverlayShadow()?.querySelectorAll(".ui-attach-label") ?? [])
      .map((marker) => marker.textContent)).toEqual(["1", "2"]);

    await removeAnnotation(thirdAnnotationId);
    expect(widget.snapshot().targets[0]?.annotations).toHaveLength(1);
    expect(widget.snapshot().targets[0]?.annotations[0]?.label).toBe("1");
    expect(Array.from(getOverlayShadow()?.querySelectorAll(".ui-attach-label") ?? [])
      .map((marker) => marker.textContent)).toEqual(["1"]);
    widget.destroy();
  });

  test("exposes opaque annotation identities scoped to the widget instance", () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const widget = createMeanThisWebWidget({ root: document, initialOpen: true });

    widget.startSelection();
    target.click();

    const snapshot = widget.snapshot();
    const targetSnapshot = snapshot.targets[0];
    const annotation = targetSnapshot?.annotations[0];
    if (!targetSnapshot || !annotation) throw new Error("annotation fixture missing");
    expect(annotation.annotationIdScope).toBe("widget_instance");
    expect(annotation.annotationId).not.toContain(targetSnapshot.targetId);
    expect(annotation.annotationId).toMatch(/^widget-.+::annotation-1$/);

    widget.destroy();
  });

  test("keeps annotation identity stable through note edits and copy", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const onCopy = vi.fn();
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
      onCopy,
      writeText: vi.fn(async () => undefined),
    });
    widget.startSelection();
    target.click();
    widget.stopSelection();

    const before = widget.snapshot().targets[0]?.annotations[0];
    if (!before) throw new Error("annotation fixture missing");
    const annotationId = before.annotationId;
    const overlay = Array.from(getOverlayShadow()?.querySelectorAll<HTMLElement>(
      ".ui-attach-overlay",
    ) ?? []).find((candidate) => candidate.dataset.itemId === annotationId);
    overlay?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    await flushAsyncActions();
    const editor = getOverlayShadow()?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    const note = editor?.querySelector<HTMLTextAreaElement>("textarea");
    if (!note) throw new Error("shared widget editor textarea missing");
    note.value = "Keep this annotation identity.";
    editor?.querySelector<HTMLButtonElement>("[data-action='save-note']")?.click();
    await flushAsyncActions();

    expect(widget.snapshot().targets[0]?.annotations[0]?.annotationId).toBe(annotationId);
    await widget.copy();
    expect(onCopy.mock.calls[0]?.[0].snapshot.targets[0]?.annotations[0]?.annotationId)
      .toBe(annotationId);

    widget.destroy();
  });

  test("creates open annotations and exposes resolved/reopened state in SDK copy", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const writeText = vi.fn(async () => undefined);
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      writeText,
    });
    widget.startSelection();
    target.click();
    widget.stopSelection();

    const annotation = widget.snapshot().targets[0]?.annotations[0];
    if (!annotation) throw new Error("annotation fixture missing");
    expect(annotation.annotationLifecycle).toEqual({ state: "open", resolvedAt: null });

    await expect(widget.setAnnotationLifecycle(annotation.annotationId, "resolved"))
      .resolves.toBe(true);
    expect(widget.snapshot().targets[0]?.annotations[0]?.annotationLifecycle).toMatchObject({
      state: "resolved",
      resolvedAt: expect.any(String),
    });
    const resolvedCopy = await widget.copy();
    expect(resolvedCopy).toContain("Annotation lifecycle: resolved");
    expect(resolvedCopy).toContain("reference metadata; not requested work");
    expect(writeText).toHaveBeenLastCalledWith(resolvedCopy);

    await expect(widget.setAnnotationLifecycle(annotation.annotationId, "open"))
      .resolves.toBe(true);
    expect(widget.snapshot().targets[0]?.annotations[0]?.annotationLifecycle)
      .toEqual({ state: "open", resolvedAt: null });
    const reopenedCopy = await widget.copy();
    expect(reopenedCopy).toContain("Annotation lifecycle: open");
    expect(reopenedCopy).toContain("reference metadata; not requested work");
    widget.destroy();
  });

  test("opens the shared editor from a selected-target chip and exposes lifecycle control", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    target.click();
    widget.stopSelection();

    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='activate-target']",
    )?.click();
    await flushAsyncActions();

    expect(widget.snapshot().mode).toBe("editing");
    const lifecycle = widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='set-annotation-lifecycle']",
    );
    expect(lifecycle?.textContent).toContain("Mark resolved");
    lifecycle?.click();
    await flushAsyncActions();
    expect(widget.snapshot().targets[0]?.annotations[0]?.annotationLifecycle.state)
      .toBe("resolved");
    widget.destroy();
  });

  test("does not reuse annotation identity after clear in the same widget instance", () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const widget = createMeanThisWebWidget({ root: document, initialOpen: true });
    widget.startSelection();
    target.click();

    const firstId = widget.snapshot().targets[0]?.annotations[0]?.annotationId;
    if (!firstId) throw new Error("first annotation fixture missing");
    widget.clear();
    expect(widget.snapshot().targets).toHaveLength(0);

    widget.startSelection();
    target.click();
    const secondId = widget.snapshot().targets[0]?.annotations[0]?.annotationId;
    if (!secondId) throw new Error("second annotation fixture missing");
    expect(secondId).not.toBe(firstId);
    expect(secondId).toMatch(/^widget-.+::annotation-2$/);

    widget.destroy();
  });

  test("focuses a nearby annotation instead of silently moving or duplicating it", () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(20, 40, 200, 100));
    const widget = createMeanThisWebWidget({ root: document, initialOpen: true });

    widget.startSelection();
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 90,
    }));
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 123,
      clientY: 92,
    }));

    expect(widget.snapshot().targets).toHaveLength(1);
    expect(widget.snapshot().targets[0]?.annotations).toHaveLength(1);
    expect(widget.snapshot().targets[0]?.annotations[0]?.selectionPoint).toEqual({
      kind: "element_relative_pointer",
      xRatio: 0.5,
      yRatio: 0.5,
    });
    widget.destroy();
  });

  test("uses shared overlay labels and edit/remove actions for selected targets", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    target.click();
    widget.open();

    const itemId = widget.snapshot().targets[0].annotations[0].annotationId;
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    expect(widget.element?.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("details");
    const overlay = Array.from(getOverlayShadow()?.querySelectorAll<HTMLElement>(
      ".ui-attach-overlay",
    ) ?? []).find((candidate) => candidate.dataset.itemId === itemId);
    overlay?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    await flushAsyncActions();
    expect(widget.element?.querySelector(".meanthis-editor")).toBeNull();
    expect(getOverlayShadow()?.querySelector("[data-ui-attach-anchored-editor]")).not.toBeNull();
    expect(widget.element?.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("details");
    const editor = getOverlayShadow()?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    const note = editor?.querySelector<HTMLTextAreaElement>("textarea");
    if (!note) throw new Error("shared widget editor textarea missing");
    note.value = "Move this action below the form.";
    editor?.querySelector<HTMLButtonElement>("[data-action='save-note']")?.click();
    await flushAsyncActions();
    expect(widget.snapshot().targets[0]?.annotations[0]?.taskNote)
      .toBe("Move this action below the form.");
    expect(widget.snapshot().mode).toBe("details");

    overlay?.querySelector<HTMLButtonElement>("[data-action='remove']")?.click();
    await flushAsyncActions();
    expect(widget.snapshot().targets).toHaveLength(0);
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();
    widget.destroy();
  });

  test("keeps the compact work mode when a marker removes one selected target", async () => {
    const save = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const image = document.querySelector<HTMLImageElement>("img")!;
    vi.spyOn(save, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 42));
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect(260, 120, 160, 90));
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });

    widget.startSelection();
    save.click();
    image.click();
    expect(widget.snapshot().mode).toBe("selecting");
    expect(widget.snapshot().targets).toHaveLength(2);
    widget.stopSelection();
    expect(widget.snapshot().mode).toBe("ready");

    const firstItemId = widget.snapshot().targets[0].annotations[0].annotationId;
    const firstOverlay = Array.from(getOverlayShadow()?.querySelectorAll<HTMLElement>(
      ".ui-attach-overlay",
    ) ?? []).find((candidate) => candidate.dataset.itemId === firstItemId);
    firstOverlay?.querySelector<HTMLButtonElement>(".ui-attach-label")?.click();
    firstOverlay?.querySelector<HTMLButtonElement>("[data-action='remove']")?.click();
    await flushAsyncActions();

    expect(widget.snapshot().targets).toHaveLength(1);
    expect(widget.snapshot().mode).toBe("ready");
    expect(widget.element?.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("workbar");

    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    expect(widget.snapshot().mode).toBe("details");
    expect(widget.element?.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("details");
    widget.destroy();
  });

  test("opens marker actions at the selected point and edits in the shared widget", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(40, 120, 180, 80));
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 85,
      clientY: 180,
    }));

    const capsule = getOverlayShadow()?.querySelector<HTMLElement>(".ui-attach-marker-capsule");
    const marker = capsule?.querySelector<HTMLButtonElement>(".ui-attach-label");
    expect(capsule?.style.left).toBe("31px");
    expect(capsule?.style.top).toBe("60px");
    marker?.click();
    expect(marker?.closest<HTMLElement>(".ui-attach-overlay")?.dataset.actionsOpen).toBe("true");
    expect(getOverlayShadow()?.querySelector("[data-ui-attach-anchored-editor]")).toBeNull();

    widget.stopSelection();
    const restoredMarker = getOverlayShadow()?.querySelector<HTMLButtonElement>(".ui-attach-label");
    const restoredOverlay = restoredMarker?.closest<HTMLElement>(".ui-attach-overlay");
    expect(getOverlayShadow()?.querySelector("[data-ui-attach-anchored-editor]")).toBeNull();
    // Actions opened while selection is armed remain usable after stopping;
    // clicking the marker here would correctly toggle that already-open rail closed.
    expect(restoredOverlay?.dataset.actionsOpen).toBe("true");
    restoredOverlay?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    await flushAsyncActions();
    expect(restoredOverlay?.dataset.actionsOpen).toBe("false");
    const editor = getOverlayShadow()?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    expect(editor).not.toBeNull();
    editor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(getOverlayShadow()?.querySelector("[data-ui-attach-anchored-editor]")).toBeNull();
    expect(widget.snapshot().targets[0]?.annotations[0]?.taskNote).toBe("");
    widget.destroy();
  });

  test("can expose the shared view in light DOM for local visual inspection", () => {
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });

    expect(widget.status).toBe("claimed");
    expect(widget.element?.dataset.meanthisInspectableDom).toBe("true");
    expect(widget.element?.hasAttribute("data-ui-attach-ignore")).toBe(false);
    expect(widget.element?.querySelector("[data-meanthis-widget-view]")).not.toBeNull();
    expect(widget.element?.style.width).toBe("fit-content");

    widget.collapse();
    expect(widget.element?.style.width).toBe("48px");
    expect(widget.element?.style.height).toBe("48px");
    expect(widget.element?.style.borderRadius).toBe("999px");
    expect(widget.element?.style.transition).toContain("width 170ms");

    widget.destroy();
  });

  test("hides capture scope when the SDK only owns the top document", () => {
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });

    const scope = widget.element?.querySelector("[data-meanthis-action='capture-scope']");
    expect(scope).toBeNull();
    expect(widget.snapshot().mode).toBe("ready");
    expect(widget.element?.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("workbar");
    widget.destroy();
  });

  test("copies one deterministic handoff for the selected items", async () => {
    const writeText = vi.fn(async () => undefined);
    const onCopy = vi.fn();
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
      writeText,
      onCopy,
    });
    widget.startSelection();
    const save = document.querySelector<HTMLButtonElement>("[data-testid='save']");
    if (!save) throw new Error("save fixture missing");
    vi.spyOn(save, "getBoundingClientRect").mockReturnValue(rect(20, 40, 200, 100));
    save.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 115,
      detail: 1,
    }));

    const text = await widget.copy();
    expect(text).toContain("# MeanThis Page References");
    expect(text).toContain("Target A");
    expect(text).toContain("Save changes");
    expect(text).toContain("Locator (capture-time, unverified, uniqueness unknown)");
    expect(text).not.toContain("Selection point:");
    expect(text).not.toContain("Policy audit");
    expect(writeText).toHaveBeenCalledWith(text);
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy.mock.calls[0]?.[0].snapshot.targets).toHaveLength(1);
    expect(onCopy.mock.calls[0]?.[0].snapshot.targets[0]?.annotations).toHaveLength(1);
    widget.stopSelection();
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    expect(widget.element?.querySelector(".meanthis-status")?.textContent)
      .toBe("Copied 1 annotation across 1 target.");

    widget.setOutputDetail("standard");
    const standard = await widget.copy();
    expect(standard).toContain("Selection point:");

    widget.setOutputDetail("forensic");
    const forensic = await widget.copy();
    expect(widget.snapshot().outputDetail).toBe("forensic");
    expect(forensic).toContain("Attachment ID:");
    expect(forensic).toContain("Policy audit (reference only):");
    expect(forensic!.length).toBeGreaterThan(text!.length);
    widget.destroy();
  });

  test("shows an explicit confirmation after the first clear action", () => {
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
    widget.open();

    const clear = widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='clear']",
    );
    clear?.click();

    expect(widget.snapshot().targets).toHaveLength(1);
    expect(widget.snapshot().mode).toBe("ready");
    const confirmation = widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='clear']",
    );
    expect(confirmation?.dataset.confirm).toBe("true");
    expect(confirmation?.querySelector(".meanthis-clear-confirm-label")).toBeNull();
    expect(widget.element?.querySelector(".meanthis-status")).toBeNull();

    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='clear']",
    )?.click();
    expect(widget.snapshot().targets).toHaveLength(0);
    widget.destroy();
  });

  test("confirmed clear removes markers and leaves element selection stopped", async () => {
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
    expect(widget.snapshot()).toMatchObject({ mode: "selecting" });
    expect(widget.snapshot().targets).toHaveLength(1);

    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='clear']",
    )?.click();
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='clear']",
    )?.click();
    await flushAsyncActions();

    expect(widget.snapshot()).toMatchObject({ mode: "ready", targets: [] });
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();

    document.querySelector<HTMLImageElement>("img")?.click();
    expect(widget.snapshot()).toMatchObject({ mode: "ready", targets: [] });
    widget.destroy();
  });

  test("imperative clear fences a deferred inline save from restoring ghost UI", async () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    widget.startSelection();
    target.click();
    widget.stopSelection();

    const overlay = getOverlayShadow()?.querySelector<HTMLElement>(".ui-attach-overlay");
    overlay?.querySelector<HTMLButtonElement>("[data-action='edit']")?.click();
    await flushAsyncActions();
    const editor = getOverlayShadow()?.querySelector<HTMLElement>("[data-ui-attach-anchored-editor]");
    const note = editor?.querySelector<HTMLTextAreaElement>("textarea");
    if (!note) throw new Error("shared widget editor textarea missing");
    note.value = "Deferred note";
    editor?.querySelector<HTMLButtonElement>("[data-action='save-note']")?.click();
    widget.clear();
    await flushAsyncActions();

    expect(widget.snapshot()).toMatchObject({ mode: "ready", targets: [] });
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    expect(widget.element?.querySelector(".meanthis-target-chip")).toBeNull();
    expect(widget.element?.querySelector(".meanthis-status")).toBeNull();
    expect(widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='copy']",
    )?.disabled).toBe(true);
    widget.destroy();
  });

  test("imperative clear fences deferred copy completion and success status", async () => {
    let releaseWrite!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }));
    const onCopy = vi.fn();
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
      writeText,
      onCopy,
    });
    widget.startSelection();
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
    widget.stopSelection();

    const copying = widget.copy();
    expect(writeText).toHaveBeenCalledOnce();
    widget.clear();
    releaseWrite();

    await expect(copying).resolves.toBeNull();
    expect(onCopy).not.toHaveBeenCalled();
    expect(widget.snapshot()).toMatchObject({ mode: "ready", targets: [] });
    widget.element?.querySelector<HTMLButtonElement>(
      "[data-meanthis-action='open-settings']",
    )?.click();
    expect(widget.element?.querySelector(".meanthis-status")).toBeNull();
    widget.destroy();
  });

  test("delivers one coherent pre-copy snapshot after a deferred write without clear", async () => {
    let releaseWrite!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }));
    const onCopy = vi.fn();
    const widget = createMeanThisWebWidget({ root: document, writeText, onCopy });
    widget.startSelection();
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
    widget.stopSelection();

    const copying = widget.copy();
    expect(writeText).toHaveBeenCalledOnce();
    releaseWrite();
    const text = await copying;

    expect(text).not.toBeNull();
    expect(onCopy).toHaveBeenCalledTimes(1);
    const event = onCopy.mock.calls[0]?.[0];
    expect(event?.text).toBe(text);
    expect(event?.snapshot.targets).toHaveLength(1);
    expect(event?.snapshot.targets[0]?.annotations).toHaveLength(1);
    expect(text?.match(/^\d+\. Target /gmu)).toHaveLength(1);
    widget.destroy();
  });

  test("expires clear confirmation without deleting selected elements", () => {
    vi.useFakeTimers();
    const widget = createMeanThisWebWidget({
      root: document,
      initialOpen: true,
      debugInspectableDom: true,
    });
    try {
      widget.startSelection();
      document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();
      widget.open();
      widget.element?.querySelector<HTMLButtonElement>(
        "[data-meanthis-action='clear']",
      )?.click();

      expect(widget.element?.querySelector<HTMLButtonElement>(
        "[data-meanthis-action='clear']",
      )?.dataset.confirm).toBe("true");
      vi.advanceTimersByTime(4_000);

      expect(widget.snapshot().targets).toHaveLength(1);
      expect(widget.element?.querySelector<HTMLButtonElement>(
        "[data-meanthis-action='clear']",
      )?.dataset.confirm).toBeUndefined();
    } finally {
      widget.destroy();
      vi.useRealTimers();
    }
  });

  test("delegates a second SDK instance to the first owner", () => {
    const first = createMeanThisWebWidget({ root: document });
    const second = createMeanThisWebWidget({ root: document });

    expect(first.status).toBe("claimed");
    expect(second.status).toBe("delegated");
    expect(document.querySelectorAll("[data-meanthis-web-widget-host]")).toHaveLength(1);
    expect(second.open()).toBe(true);
    expect(first.snapshot().mode).toBe("ready");
    second.destroy();
    expect(document.querySelectorAll("[data-meanthis-web-widget-host]")).toHaveLength(1);
    first.destroy();
  });

  test("does not mount when the extension already owns the page surface", () => {
    const extension = claimMeanThisSurface({ root: document, owner: "extension" });
    const widget = createMeanThisWebWidget({ root: document });

    expect(widget.status).toBe("delegated");
    expect(widget.element).toBeNull();
    expect(document.querySelector("[data-meanthis-web-widget-host]")).toBeNull();
    widget.destroy();
    expect(extension.element?.isConnected).toBe(true);
    extension.release();
  });

  test("does not overwrite a target style changed after selection", () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    const widget = createMeanThisWebWidget({ root: document });
    widget.startSelection();
    target.click();
    target.style.setProperty("outline", "5px solid red", "important");

    widget.clear();
    expect(target.style.outline).toBe("5px solid red");
    expect(getOverlayShadow()?.querySelector(".ui-attach-overlay")).toBeNull();
    widget.destroy();
  });

  test("restores an owned target style with its original priority", () => {
    const target = document.querySelector<HTMLButtonElement>("[data-testid='save']")!;
    target.style.setProperty("outline", "2px dotted green", "important");
    target.style.setProperty("outline-offset", "7px", "important");
    const widget = createMeanThisWebWidget({ root: document });
    widget.startSelection();
    target.click();

    widget.clear();
    expect(target.style.getPropertyValue("outline")).toBe("2px dotted green");
    expect(target.style.getPropertyPriority("outline")).toBe("important");
    expect(target.style.getPropertyValue("outline-offset")).toBe("7px");
    expect(target.style.getPropertyPriority("outline-offset")).toBe("important");
    widget.destroy();
  });

  test("returns detached attachment snapshots", () => {
    const widget = createMeanThisWebWidget({ root: document });
    widget.startSelection();
    document.querySelector<HTMLButtonElement>("[data-testid='save']")?.click();

    const first = widget.snapshot();
    (first.targets[0].attachment.element as { text: string }).text = "changed by caller";
    expect(widget.snapshot().targets[0].attachment.element.text).toBe("Save changes");
    widget.destroy();
  });

  test("unmounts when another actor removes its exact surface claim", async () => {
    const widget = createMeanThisWebWidget({ root: document });
    expect(widget.element?.isConnected).toBe(true);

    document.querySelector("[data-meanthis-surface-claim]")?.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(widget.element?.isConnected).toBe(false);
    expect(document.querySelector("[data-meanthis-web-widget-host]")).toBeNull();
    expect(widget.open()).toBe(false);
  });
});

function getOverlayShadow(): ShadowRoot | null {
  return document.querySelector<HTMLElement>("[data-ui-attach-overlay-root]")?.shadowRoot ?? null;
}

async function flushAsyncActions(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
