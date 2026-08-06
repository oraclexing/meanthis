import type { ContextCaptureResult } from "./capture";
import { getSelectableComposedTarget } from "./context-target";
import type { CaptureCommitReceipt, SessionCommandResponse } from "./messages";
import type { CaptureToken } from "./session-state";

const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";

export interface TestClickCaptureController {
  disableForNavigation(): void;
  dispose(): void;
  isEnabled(): boolean;
  requestDisable(): void;
  seedPreview(target: HTMLElement | null): boolean;
  setEnabled(enabled: boolean): void;
}

export interface TestClickCaptureControllerOptions {
  root: Document;
  beginCapture(): Promise<SessionCommandResponse<CaptureToken>>;
  captureTarget(target: HTMLElement): Promise<ContextCaptureResult>;
  commitCapture(
    token: CaptureToken,
    record: Extract<ContextCaptureResult, { ok: true }>["record"],
  ): Promise<SessionCommandResponse<CaptureCommitReceipt>>;
  publishFailure(error: string): Promise<void>;
  publishCommitted(
    target: HTMLElement,
    receipt: CaptureCommitReceipt,
    record: Extract<ContextCaptureResult, { ok: true }>["record"],
  ): Promise<void>;
  isTargetCommitted?(target: HTMLElement): boolean;
  previewTarget?(target: HTMLElement | null): void;
  disableSelection?(): Promise<void>;
  isTrustedClickEvent?(event: MouseEvent): boolean;
  isTrustedKeyEvent?(event: KeyboardEvent): boolean;
  onEnabledChange?(enabled: boolean): void;
  pointerEventTarget?: EventTarget;
  resolveTarget?(event: MouseEvent): HTMLElement | null;
}

export function createTestClickCaptureController(
  options: TestClickCaptureControllerOptions,
): TestClickCaptureController {
  const eventRoot = options.root.defaultView;
  const pointerEventTarget = options.pointerEventTarget ?? eventRoot ?? options.root;
  let enabled = false;
  let disablePending = false;
  let pendingPointerClickTarget: EventTarget | null = null;
  let captureTail = Promise.resolve();
  let previewedTarget: HTMLElement | null = null;

  const handlePointerMove = (event: MouseEvent): void => {
    if (!enabled) return;
    updatePreview(resolveTarget(event));
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (
      !enabled ||
      event.key !== "Escape" ||
      !(options.isTrustedKeyEvent?.(event) ?? event.isTrusted)
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    requestDisable();
  };

  const handleClick = (event: MouseEvent): void => {
    if (!enabled || !(options.isTrustedClickEvent?.(event) ?? event.isTrusted)) {
      return;
    }
    if (event.type === "click" && pendingPointerClickTarget) {
      const isMatchingPointerClick = event.composedPath()[0] === pendingPointerClickTarget;
      pendingPointerClickTarget = null;
      if (isMatchingPointerClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }

    if (disablePending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const target = resolveTarget(event);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    clearPreview(true);
    captureTail = captureTail.then(
      () => captureAndCommit(target),
      () => captureAndCommit(target),
    );
  };

  const handlePointerDown = (event: MouseEvent): void => {
    if (!enabled || !(options.isTrustedClickEvent?.(event) ?? event.isTrusted)) return;
    pendingPointerClickTarget = null;
    if (!isPrimaryActivationPointer(event)) return;
    pendingPointerClickTarget = event.composedPath()[0] ?? null;
    handleClick(event);
  };

  const handlePointerCancel = (): void => {
    pendingPointerClickTarget = null;
  };

  function updatePreview(target: HTMLElement | null): void {
    if (previewedTarget === target) return;
    previewedTarget = target;
    options.previewTarget?.(target);
  }

  function clearPreview(force = false): void {
    if (!force && previewedTarget === null) return;
    previewedTarget = null;
    options.previewTarget?.(null);
  }

  function setEnabled(nextEnabled: boolean): void {
    const wasEnabled = enabled;
    enabled = nextEnabled;
    if (!nextEnabled) {
      disablePending = false;
      pendingPointerClickTarget = null;
    }
    if (wasEnabled && !nextEnabled) clearPreview(true);
    if (wasEnabled !== nextEnabled) options.onEnabledChange?.(nextEnabled);
  }

  function resolveTarget(event: MouseEvent): HTMLElement | null {
    return options.resolveTarget?.(event) ?? getSelectableComposedTarget(options.root, event);
  }

  function requestDisable(): void {
    if (!enabled || disablePending) return;
    disablePending = true;
    clearPreview(true);
    void disableSelection();
  }

  function disableForNavigation(): void {
    if (!enabled && !disablePending) return;
    setEnabled(false);
    void options.disableSelection?.().catch(() => {
      // Navigation is locally fail-closed even if the background already restarted or revoked.
    });
  }

  async function disableSelection(): Promise<void> {
    try {
      await options.disableSelection?.();
      setEnabled(false);
    } catch {
      disablePending = false;
      try {
        await options.publishFailure(SAFE_CAPTURE_ERROR);
      } catch {
        // Selection is already disabled locally; failure reporting stays best-effort.
      }
    }
  }

  async function captureAndCommit(target: HTMLElement): Promise<void> {
    try {
      if (options.isTargetCommitted?.(target)) return;

      const begun = await options.beginCapture();
      if (!begun.ok) {
        await options.publishFailure(begun.error);
        return;
      }

      const captured = await options.captureTarget(target);
      if (!captured.ok) {
        await options.publishFailure(captured.error);
        return;
      }

      const committed = await options.commitCapture(begun.data, captured.record);
      if (!committed.ok) {
        await options.publishFailure(committed.error);
        return;
      }

      await options.publishCommitted(target, committed.data, captured.record);
    } catch (error) {
      await options.publishFailure(SAFE_CAPTURE_ERROR);
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
  if (eventRoot) {
    eventRoot.addEventListener("keydown", handleKeyDown, { capture: true });
  } else {
    options.root.addEventListener("keydown", handleKeyDown, { capture: true });
  }

  return {
    disableForNavigation,
    dispose: () => {
      pointerEventTarget.removeEventListener("click", handleClick as EventListener, { capture: true });
      pointerEventTarget.removeEventListener("pointerdown", handlePointerDown as EventListener, {
        capture: true,
      });
      pointerEventTarget.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      pointerEventTarget.removeEventListener("pointermove", handlePointerMove as EventListener, {
        capture: true,
      });
      if (eventRoot) {
        eventRoot.removeEventListener("keydown", handleKeyDown, { capture: true });
      } else {
        options.root.removeEventListener("keydown", handleKeyDown, { capture: true });
      }
      if (enabled) setEnabled(false);
      else if (previewedTarget) clearPreview(true);
      pendingPointerClickTarget = null;
      disablePending = false;
    },
    isEnabled: () => enabled,
    requestDisable,
    seedPreview: (target) => {
      if (!enabled || disablePending || !target?.isConnected) return false;
      updatePreview(target);
      return true;
    },
    setEnabled,
  };
}

function isPrimaryActivationPointer(event: MouseEvent): boolean {
  const pointer = event as MouseEvent & { isPrimary?: boolean; pointerType?: string };
  if (event.button !== 0 || pointer.isPrimary === false) return false;
  return !pointer.pointerType || pointer.pointerType === "mouse" || pointer.pointerType === "pen";
}
