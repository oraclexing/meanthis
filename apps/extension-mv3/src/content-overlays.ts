import type {
  CaptureCommitReceipt,
  OverlayStateMessage,
} from "./messages";
import type {
  PersistentOverlayController,
  PersistentOverlayItem,
  PersistentOverlayRelationPreview,
} from "./persistent-overlays";

export interface ContentOverlayCoordinator {
  setVisible(visible: boolean): void;
  commitTarget(target: HTMLElement, receipt: CaptureCommitReceipt): void;
  hasTarget(target: HTMLElement): boolean;
  bindRestored(item: OverlayStateMessage["items"][number], target: HTMLElement): void;
  unbindRestored(itemId: string): void;
  applyState(message: OverlayStateMessage): void;
  applyPreview(itemId: string | null): void;
  applyRelationPreview(sourceItemId: string, referenceItemId: string): void;
  applySelectionPreview(target: HTMLElement | null): void;
}

interface BoundTarget {
  attachmentId: string;
  itemId: string;
  label: string;
  target: HTMLElement;
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
  let visible = options.initiallyVisible !== false;

  function setVisible(nextVisible: boolean): void {
    if (visible === nextVisible) return;
    visible = nextVisible;
    render();
  }

  function commitTarget(target: HTMLElement, receipt: CaptureCommitReceipt): void {
    bound.set(receipt.itemId, {
      attachmentId: receipt.itemId,
      itemId: receipt.itemId,
      label: receipt.label,
      target,
    });
    activeItemId = receipt.itemId;
    previewItemId = null;
    relationPreview = null;
    render();
  }

  function hasTarget(target: HTMLElement): boolean {
    return Array.from(bound.values()).some((item) => item.target === target);
  }

  function bindRestored(
    item: OverlayStateMessage["items"][number],
    target: HTMLElement,
  ): void {
    const existing = bound.get(item.itemId);
    if (
      existing?.target === target &&
      existing.attachmentId === item.attachmentId &&
      existing.label === item.label
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

  function render(): void {
    if (!visible) {
      overlays.sync([], null);
      return;
    }
    const items: PersistentOverlayItem[] = Array.from(bound.values(), (item) => ({
      itemId: item.itemId,
      label: item.label,
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
          target: selectionPreviewTarget,
        });
      }
      overlays.sync(items, selectionItemId);
      return;
    }
    if (relationPreview) {
      overlays.sync(items, activeItemId, relationPreview);
    } else {
      overlays.sync(items, previewItemId ?? activeItemId);
    }
  }

  return {
    setVisible,
    commitTarget,
    hasTarget,
    bindRestored,
    unbindRestored,
    applyState,
    applyPreview,
    applyRelationPreview,
    applySelectionPreview,
  };
}
