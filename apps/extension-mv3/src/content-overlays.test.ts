// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import type { PersistentOverlayController } from "./persistent-overlays";
import { createContentOverlayCoordinator } from "./content-overlays";

describe("createContentOverlayCoordinator", () => {
  test("keeps bindings while hidden and renders them when marker visibility is enabled", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays, { initiallyVisible: false });

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      label: "A",
    });
    expect(coordinator.hasTarget(target)).toBe(true);
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);

    coordinator.setVisible(true);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", target }],
      "att_save",
    );

    coordinator.setVisible(false);
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);
    expect(coordinator.hasTarget(target)).toBe(true);
  });

  test("adds test-click captures immediately and applies exact cleanup state", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.commitTarget(target, {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      label: "A",
    });
    expect(coordinator.hasTarget(target)).toBe(true);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", target }],
      "att_save",
    );

    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: null,
      items: [],
    });
    expect(coordinator.hasTarget(target)).toBe(false);
    expect(overlays.sync).toHaveBeenLastCalledWith([], null);
  });

  test("replaces a restored binding when the page rerenders the target", () => {
    const original = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(original, replacement);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A" }],
    });
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      original,
    );
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      replacement,
    );

    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", target: replacement }],
      "att_save",
    );
  });

  test("removes a stale binding while preserving active emphasis for a later rebind", () => {
    const target = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(target, replacement);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A" }],
    });
    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      target,
    );

    coordinator.unbindRestored("att_save");

    expect(coordinator.hasTarget(target)).toBe(false);
    expect(overlays.sync).toHaveBeenLastCalledWith([], "att_save");

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      replacement,
    );
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", target: replacement }],
      "att_save",
    );
  });

  test("previews another bound target without changing the persisted active target", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      cancel,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      ],
    });

    coordinator.applyPreview("att_save");
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", target: save },
      { itemId: "att_cancel", label: "B", target: cancel },
    ], "att_save");

    coordinator.applyPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", target: save },
      { itemId: "att_cancel", label: "B", target: cancel },
    ], "att_cancel");
  });

  test("adds one translucent selection target before capture and restores persisted emphasis", () => {
    const saved = document.createElement("button");
    const hovered = document.createElement("input");
    document.body.append(saved, hovered);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      saved,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_save",
      items: [{ itemId: "att_save", attachmentId: "att_save", label: "A" }],
    });

    coordinator.applySelectionPreview(hovered);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", target: saved },
      {
        itemId: "ui-attach-selection-preview",
        label: "Select",
        target: hovered,
      },
    ], "ui-attach-selection-preview");

    coordinator.applySelectionPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_save", label: "A", target: saved }],
      "att_save",
    );
  });

  test("previews both relationship targets and restores the persisted active target", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      cancel,
    );
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_cancel",
      items: [
        { itemId: "att_save", attachmentId: "att_save", label: "A" },
        { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      ],
    });

    coordinator.applyRelationPreview("att_save", "att_cancel");
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", target: save },
      { itemId: "att_cancel", label: "B", target: cancel },
    ], "att_cancel", {
      sourceItemId: "att_save",
      referenceItemId: "att_cancel",
    });

    coordinator.applyPreview(null);
    expect(overlays.sync).toHaveBeenLastCalledWith([
      { itemId: "att_save", label: "A", target: save },
      { itemId: "att_cancel", label: "B", target: cancel },
    ], "att_cancel");
  });

  test("clears an ephemeral preview when persisted overlay state changes", () => {
    const save = document.createElement("button");
    const cancel = document.createElement("button");
    document.body.append(save, cancel);
    const overlays = createOverlayHarness();
    const coordinator = createContentOverlayCoordinator(overlays);

    coordinator.bindRestored(
      { itemId: "att_save", attachmentId: "att_save", label: "A" },
      save,
    );
    coordinator.bindRestored(
      { itemId: "att_cancel", attachmentId: "att_cancel", label: "B" },
      cancel,
    );
    coordinator.applyPreview("att_save");
    coordinator.applyState({
      type: "ui-attach:overlay-state",
      origin: "https://app.example.test",
      activeItemId: "att_cancel",
      items: [{ itemId: "att_cancel", attachmentId: "att_cancel", label: "B" }],
    });

    expect(overlays.sync).toHaveBeenLastCalledWith(
      [{ itemId: "att_cancel", label: "B", target: cancel }],
      "att_cancel",
    );
  });
});

function createOverlayHarness(): PersistentOverlayController {
  return {
    sync: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  };
}
