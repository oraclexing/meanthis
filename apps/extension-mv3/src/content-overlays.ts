import type {
  CaptureCommitReceipt,
  OverlayRestoreItem,
  OverlayStateMessage,
} from "./messages";
import type {
  PersistentOverlayController,
  PersistentOverlayAnchor,
  PersistentOverlayDisplayMode,
  PersistentOverlayItem,
  PersistentOverlayRelationPreview,
} from "@meanthis/web-picker";

export interface ContentOverlayCoordinator {
  setVisible(visible: boolean): void;
  setDisplayMode(mode: PersistentOverlayDisplayMode): void;
  commitTarget(
    target: HTMLElement,
    receipt: CaptureCommitReceipt,
    anchor?: PersistentOverlayAnchor,
  ): void;
  hasTarget(target: HTMLElement): boolean;
  resolveTarget(target: HTMLElement): ContentOverlayTargetResolution;
  bindRestored(
    item: OverlayStateMessage["items"][number] & Pick<OverlayRestoreItem, "anchor">,
    target: HTMLElement,
  ): void;
  unbindRestored(itemId: string): void;
  applyState(message: OverlayStateMessage): void;
  applyPreview(itemId: string | null): void;
  applyRelationPreview(sourceItemId: string, referenceItemId: string): void;
  applySelectionPreview(target: HTMLElement | null): void;
  readStatus(): ContentOverlayStatus;
}

export interface ContentOverlayStatus {
  appliedItemIds: string[];
  markerCount: number;
  selectionPreviewActive: boolean;
}

export type ContentOverlayTargetResolution =
  | { kind: "none" }
  | { kind: "exact"; itemId: string }
  | { kind: "ambiguous" };

interface BoundTarget {
  anchor?: PersistentOverlayAnchor;
  attachmentId: string;
  itemId: string;
  label: string;
  taskNote: string;
  target: HTMLElement;
}

interface PersistentOverlayReadback {
  readStatus(): {
    itemIds: string[];
    markerCount: number;
  };
}

export function createContentOverlayCoordinator(
  overlays: PersistentOverlayController,
  options: { initiallyVisible?: boolean } = {},
): ContentOverlayCoordinator {
  const bound = new Map<string, BoundTarget>();
  let activeItemId: string | null = null;
  let previewItemId: string | null = null;
  let relationPreview: PersistentOverlayRelationPreview | null = null;
  let selectionPreviewTarget: HTMLElement | null = null;
  let leaseVisible = options.initiallyVisible !== false;
  let displayMode: PersistentOverlayDisplayMode = "hover";

  function setVisible(nextVisible: boolean): void {
    if (leaseVisible === nextVisible) return;
    leaseVisible = nextVisible;
    render();
  }

  function setDisplayMode(nextMode: PersistentOverlayDisplayMode): void {
    displayMode = nextMode;
    render();
  }

  function commitTarget(
    target: HTMLElement,
    receipt: CaptureCommitReceipt,
    anchor?: PersistentOverlayAnchor,
  ): void {
    if (selectionPreviewTarget === target) {
      overlays.suppressActionsUntilPointerReentry?.(receipt.itemId);
    }
    bound.set(receipt.itemId, {
      ...(anchor ? { anchor } : {}),
      attachmentId: receipt.itemId,
      itemId: receipt.itemId,
      label: receipt.annotationLabel,
      taskNote: "",
      target,
    });
    activeItemId = receipt.itemId;
    previewItemId = null;
    relationPreview = null;
    render();
  }

  function hasTarget(target: HTMLElement): boolean {
    return resolveTarget(target).kind !== "none";
  }

  function resolveTarget(target: HTMLElement): ContentOverlayTargetResolution {
    const matches = Array.from(bound.values()).filter((item) => item.target === target);
    if (matches.length === 0) return { kind: "none" };
    if (matches.length !== 1) return { kind: "ambiguous" };
    return { kind: "exact", itemId: matches[0]!.itemId };
  }

  function bindRestored(
    item: OverlayStateMessage["items"][number] & Pick<OverlayRestoreItem, "anchor">,
    target: HTMLElement,
  ): void {
    const existing = bound.get(item.itemId);
    if (
      existing?.target === target &&
      existing.attachmentId === item.attachmentId &&
      existing.label === item.label &&
      existing.taskNote === item.taskNote &&
      sameAnchor(existing.anchor, item.anchor)
    ) {
      return;
    }
    bound.set(item.itemId, { ...item, target });
    render();
  }

  function unbindRestored(itemId: string): void {
    if (!bound.delete(itemId)) return;
    if (previewItemId === itemId) previewItemId = null;
    if (
      relationPreview?.sourceItemId === itemId ||
      relationPreview?.referenceItemId === itemId
    ) {
      relationPreview = null;
    }
    render();
  }

  function applyState(message: OverlayStateMessage): void {
    const retained = new Set(message.items.map((item) => item.itemId));
    for (const itemId of bound.keys()) {
      if (!retained.has(itemId)) bound.delete(itemId);
    }

    for (const item of message.items) {
      const existing = bound.get(item.itemId);
      if (existing) {
        existing.label = item.label;
        existing.attachmentId = item.attachmentId;
        existing.taskNote = item.taskNote;
        continue;
      }
    }
    activeItemId = message.activeItemId;
    previewItemId = null;
    relationPreview = null;
    render();
  }

  function applyPreview(itemId: string | null): void {
    previewItemId = itemId;
    relationPreview = null;
    render();
  }

  function applyRelationPreview(sourceItemId: string, referenceItemId: string): void {
    previewItemId = null;
    relationPreview = { sourceItemId, referenceItemId };
    render();
  }

  function applySelectionPreview(target: HTMLElement | null): void {
    selectionPreviewTarget = target;
    render();
  }

  function readStatus(): ContentOverlayStatus {
    const status = (overlays as PersistentOverlayController & PersistentOverlayReadback)
      .readStatus();
    const sortedItemIds = [...status.itemIds].sort();
    if (
      status.markerCount !== status.itemIds.length ||
      new Set(status.itemIds).size !== status.itemIds.length ||
      status.itemIds.some((itemId, index) => itemId !== sortedItemIds[index])
    ) {
      throw new Error("Persistent overlay readback violated the shared status contract.");
    }
    return {
      appliedItemIds: [...status.itemIds],
      markerCount: status.markerCount,
      selectionPreviewActive: selectionPreviewTarget !== null,
    };
  }

  function render(): void {
    const effectiveMode: PersistentOverlayDisplayMode = leaseVisible ? displayMode : "hidden";
    if (!leaseVisible && !selectionPreviewTarget) {
      overlays.setTemporaryHighlight?.(null);
      overlays.setDisplayMode?.(effectiveMode);
      overlays.sync([], null);
      return;
    }
    overlays.setDisplayMode?.(effectiveMode);
    const items: PersistentOverlayItem[] = Array.from(bound.values(), (item) => ({
      ...(item.anchor ? { anchor: item.anchor } : {}),
      itemId: item.itemId,
      label: item.label,
      taskNote: item.taskNote,
      target: item.target,
    }));
    if (selectionPreviewTarget) {
      const matched = Array.from(bound.values()).find(
        (item) => item.target === selectionPreviewTarget,
      );
      const selectionItemId = matched?.itemId ?? "ui-attach-selection-preview";
      if (!matched) {
        items.push({
          itemId: selectionItemId,
          label: "Select",
          interactive: false,
          target: selectionPreviewTarget,
        });
      }
      overlays.setTemporaryHighlight?.(selectionItemId);
      overlays.sync(items, activeItemId);
      return;
    }
    overlays.setTemporaryHighlight?.(previewItemId);
    if (relationPreview) {
      overlays.sync(items, activeItemId, relationPreview);
    } else {
      overlays.sync(items, activeItemId);
    }
  }

  return {
    setVisible,
    setDisplayMode,
    commitTarget,
    hasTarget,
    resolveTarget,
    bindRestored,
    unbindRestored,
    applyState,
    applyPreview,
    applyRelationPreview,
    applySelectionPreview,
    readStatus,
  };
}

function sameAnchor(
  left: PersistentOverlayAnchor | undefined,
  right: PersistentOverlayAnchor | undefined,
): boolean {
  return left?.xRatio === right?.xRatio && left?.yRatio === right?.yRatio;
}
