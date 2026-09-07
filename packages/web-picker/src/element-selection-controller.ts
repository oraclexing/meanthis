import type { PersistentOverlayAnchor } from "./persistent-overlays.js";
import type { UIAttachmentSelectionPoint } from "@meanthis/schema";

export interface ElementSelectionController {
  disableForNavigation(): void;
  dispose(): void;
  isEnabled(): boolean;
  requestDisable(): void;
  seedPreview(target: HTMLElement | null): boolean;
  setEnabled(enabled: boolean): void;
}

export interface ElementSelectionControllerOptions {
  root: Document;
  resolveTarget(event: MouseEvent): HTMLElement | null;
  isOwnedUiEvent?(event: Event): boolean;
  activateTarget(
    target: HTMLElement,
    anchor: PersistentOverlayAnchor,
    selectionPoint: UIAttachmentSelectionPoint | null,
    context: ElementSelectionActivationContext,
  ): void | Promise<void>;
  previewTarget?(target: HTMLElement | null): void;
  requestDisable?(): void | Promise<void>;
  reportFailure?(error: unknown): void | Promise<void>;
  serializeActivations?: boolean;
  isTrustedActivationEvent?(event: MouseEvent): boolean;
  isTrustedKeyEvent?(event: KeyboardEvent): boolean;
  onEnabledChange?(enabled: boolean): void;
  pointerEventTarget?: EventTarget;
}

export interface ElementSelectionActivationContext {
  isCurrent(): boolean;
}

/**
 * Owns the browser-event state machine shared by the SDK and extension
 * adapters. Capture storage, permissions, and publication remain adapter
 * responsibilities.
 */
export function createElementSelectionController(
  options: ElementSelectionControllerOptions,
): ElementSelectionController {
  const eventRoot = options.root.defaultView;
  const pointerEventTarget = options.pointerEventTarget ?? eventRoot ?? options.root;
  let enabled = false;
  let disablePending = false;
  let pendingPointerClickTarget: EventTarget | null = null;
  let activationTail = Promise.resolve();
  let activationLifecycleGeneration = 0;
  let previewedTarget: HTMLElement | null = null;
  let previewGeneration = 0;
  let disposed = false;

  const handlePointerMove = (event: MouseEvent): void => {
    if (!enabled || disablePending || disposed) return;
    if (isOwnedUiEvent(event)) { clearPreview(); return; }
    updatePreview(options.resolveTarget(event));
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (
      !enabled
      || disablePending
      || disposed
      || event.key !== "Escape"
      || !(options.isTrustedKeyEvent?.(event) ?? true)
    ) return;
    if (isOwnedUiEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestDisable();
  };

  const handleClick = (event: MouseEvent): void => {
    if (
      !enabled
      || disposed
      || !(options.isTrustedActivationEvent?.(event) ?? true)
    ) return;
    if (isOwnedUiEvent(event)) { clearPreview(); return; }
    if (event.type === "click" && pendingPointerClickTarget) {
      const matchesHandledPointer = event.composedPath()[0] === pendingPointerClickTarget;
      pendingPointerClickTarget = null;
      if (matchesHandledPointer) {
        suppress(event);
        return;
      }
    }
    if (disablePending) {
      suppress(event);
      return;
    }

    const target = options.resolveTarget(event);
    if (!target) return;
    acceptActivation(event, target);
  };

  const handlePointerDown = (event: MouseEvent): void => {
    if (
      !enabled
      || disposed
      || !(options.isTrustedActivationEvent?.(event) ?? true)
    ) return;
    if (isOwnedUiEvent(event)) { clearPreview(); return; }
    pendingPointerClickTarget = null;
    if (!isPrimaryActivationPointer(event)) return;
    const target = options.resolveTarget(event);
    if (!target) return;
    pendingPointerClickTarget = event.composedPath()[0] ?? null;
    acceptActivation(event, target);
  };

  const handlePointerCancel = (): void => {
    pendingPointerClickTarget = null;
  };

  function updatePreview(target: HTMLElement | null): void {
    if (previewedTarget === target) return;
    previewedTarget = target;
    previewGeneration += 1;
    options.previewTarget?.(target);
  }

  function beginActivationPreview(target: HTMLElement): number {
    if (previewedTarget !== target) {
      previewedTarget = target;
      options.previewTarget?.(target);
    }
    previewGeneration += 1;
    return previewGeneration;
  }

  function isOwnedUiEvent(event: Event): boolean {
    return options.isOwnedUiEvent?.(event) === true || event.composedPath().some((node) => (
      node instanceof HTMLElement && node.hasAttribute("data-ui-attach-ignore")
    ));
  }

  function clearPreview(force = false): void {
    if (!force && previewedTarget === null) return;
    previewedTarget = null;
    previewGeneration += 1;
    options.previewTarget?.(null);
  }

  function acceptActivation(event: MouseEvent, target: HTMLElement): void {
    suppress(event);
    const activationPreviewGeneration = beginActivationPreview(target);
    const acceptedLifecycleGeneration = activationLifecycleGeneration;
    const selectionPoint = createElementSelectionPoint(target, event);
    const anchor = selectionPoint
      ? { xRatio: selectionPoint.xRatio, yRatio: selectionPoint.yRatio }
      : { xRatio: 0.5, yRatio: 0.5 };
    if (options.serializeActivations) {
      activationTail = activationTail.then(
        () => activate(
          target,
          anchor,
          selectionPoint,
          activationPreviewGeneration,
          acceptedLifecycleGeneration,
        ),
        () => activate(
          target,
          anchor,
          selectionPoint,
          activationPreviewGeneration,
          acceptedLifecycleGeneration,
        ),
      );
    } else {
      void activate(
        target,
        anchor,
        selectionPoint,
        activationPreviewGeneration,
        acceptedLifecycleGeneration,
      );
    }
  }

  function setEnabled(nextEnabled: boolean): void {
    if (disposed) return;
    const wasEnabled = enabled;
    enabled = nextEnabled;
    if (!nextEnabled) {
      activationLifecycleGeneration += 1;
      disablePending = false;
      pendingPointerClickTarget = null;
    }
    if (wasEnabled && !nextEnabled) clearPreview(true);
    if (wasEnabled !== nextEnabled) options.onEnabledChange?.(nextEnabled);
  }

  function requestDisable(): void {
    if (!enabled || disablePending || disposed) return;
    activationLifecycleGeneration += 1;
    disablePending = true;
    clearPreview(true);
    void persistDisable();
  }

  function disableForNavigation(): void {
    if (disposed || (!enabled && !disablePending)) return;
    setEnabled(false);
    void Promise.resolve(options.requestDisable?.()).catch(() => {
      // Navigation is locally fail-closed even if its external owner restarted.
    });
  }

  async function persistDisable(): Promise<void> {
    try {
      await options.requestDisable?.();
      setEnabled(false);
    } catch (error) {
      disablePending = false;
      try {
        await options.reportFailure?.(error);
      } catch {
        // Failure reporting must not make the page event loop unhandled.
      }
    }
  }

  async function activate(
    target: HTMLElement,
    anchor: PersistentOverlayAnchor,
    selectionPoint: UIAttachmentSelectionPoint | null,
    activationPreviewGeneration: number,
    acceptedLifecycleGeneration: number,
  ): Promise<void> {
    const context: ElementSelectionActivationContext = {
      isCurrent: () => (
        !disposed
        && enabled
        && !disablePending
        && activationLifecycleGeneration === acceptedLifecycleGeneration
      ),
    };
    if (!context.isCurrent()) return;
    let failed = false;
    let failure: unknown;
    try {
      await options.activateTarget(target, anchor, selectionPoint, context);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (
        previewGeneration === activationPreviewGeneration
        && previewedTarget === target
      ) {
        clearPreview(true);
      }
    }
    if (failed && context.isCurrent()) {
      try {
        await options.reportFailure?.(failure);
      } catch {
        // Adapter diagnostics remain best-effort.
      }
    }
  }

  pointerEventTarget.addEventListener("click", handleClick as EventListener, { capture: true });
  pointerEventTarget.addEventListener("pointerdown", handlePointerDown as EventListener, {
    capture: true,
  });
  pointerEventTarget.addEventListener("pointercancel", handlePointerCancel, { capture: true });
  pointerEventTarget.addEventListener("pointermove", handlePointerMove as EventListener, {
    capture: true,
  });
  (eventRoot ?? options.root).addEventListener("keydown", handleKeyDown as EventListener, {
    capture: true,
  });

  return {
    disableForNavigation,
    dispose(): void {
      if (disposed) return;
      activationLifecycleGeneration += 1;
      pointerEventTarget.removeEventListener("click", handleClick as EventListener, {
        capture: true,
      });
      pointerEventTarget.removeEventListener("pointerdown", handlePointerDown as EventListener, {
        capture: true,
      });
      pointerEventTarget.removeEventListener("pointercancel", handlePointerCancel, {
        capture: true,
      });
      pointerEventTarget.removeEventListener("pointermove", handlePointerMove as EventListener, {
        capture: true,
      });
      (eventRoot ?? options.root).removeEventListener("keydown", handleKeyDown as EventListener, {
        capture: true,
      });
      if (enabled) setEnabled(false);
      else if (previewedTarget) clearPreview(true);
      pendingPointerClickTarget = null;
      disablePending = false;
      disposed = true;
    },
    isEnabled: () => enabled,
    requestDisable,
    seedPreview(target): boolean {
      if (!enabled || disablePending || disposed || !target?.isConnected) return false;
      updatePreview(target);
      return true;
    },
    setEnabled,
  };
}

export function createElementSelectionAnchor(
  target: HTMLElement,
  event: MouseEvent,
): PersistentOverlayAnchor {
  const point = createElementSelectionPoint(target, event);
  return point
    ? { xRatio: point.xRatio, yRatio: point.yRatio }
    : { xRatio: 0.5, yRatio: 0.5 };
}

export function createElementSelectionPoint(
  target: HTMLElement,
  event: MouseEvent,
): UIAttachmentSelectionPoint | null {
  const bounds = target.getBoundingClientRect();
  if (
    bounds.width <= 0
    || bounds.height <= 0
    || (event.detail === 0 && event.clientX === 0 && event.clientY === 0)
  ) {
    return null;
  }
  return {
    kind: "element_relative_pointer",
    xRatio: clampRatio((event.clientX - bounds.left) / bounds.width),
    yRatio: clampRatio((event.clientY - bounds.top) / bounds.height),
  };
}

function isPrimaryActivationPointer(event: MouseEvent): boolean {
  const pointer = event as MouseEvent & { isPrimary?: boolean; pointerType?: string };
  if (event.button !== 0 || pointer.isPrimary === false) return false;
  return !pointer.pointerType || pointer.pointerType === "mouse" || pointer.pointerType === "pen";
}

function suppress(event: MouseEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}
