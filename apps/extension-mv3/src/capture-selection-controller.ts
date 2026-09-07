import type { ContextCaptureResult } from "./capture";
import {
  createElementSelectionController,
  type ElementSelectionActivationContext,
  type ElementSelectionController,
  type PersistentOverlayAnchor,
} from "@meanthis/web-picker";
import { getSelectableComposedTarget } from "./context-target";
import type { CaptureCommitReceipt, SessionCommandResponse } from "./messages";
import type { RuntimeCaptureToken } from "./messages";
import type { UIAttachmentSelectionPoint } from "@meanthis/schema";
import type { MetadataDiagnosticsDeviceV1 } from "@meanthis/schema";

const SAFE_CAPTURE_ERROR = "ui-attach capture failed.";

export type CaptureSelectionController = ElementSelectionController;

export interface CaptureSelectionControllerOptions {
  root: Document;
  beginCapture(replaceItemId?: string | null): Promise<SessionCommandResponse<RuntimeCaptureToken>>;
  captureTarget(
    target: HTMLElement,
    selectionPoint: UIAttachmentSelectionPoint | null,
  ): Promise<ContextCaptureResult>;
  commitCapture(
    token: RuntimeCaptureToken,
    record: Extract<ContextCaptureResult, { ok: true }>["record"],
    metadataDiagnosticsDevice?: MetadataDiagnosticsDeviceV1,
  ): Promise<SessionCommandResponse<CaptureCommitReceipt>>;
  collectMetadataDiagnosticsDevice?(target: HTMLElement): MetadataDiagnosticsDeviceV1;
  publishFailure(error: string): Promise<void>;
  publishCommitted(
    target: HTMLElement,
    receipt: CaptureCommitReceipt,
    record: Extract<ContextCaptureResult, { ok: true }>["record"],
    anchor: PersistentOverlayAnchor,
    context: ElementSelectionActivationContext,
  ): Promise<void>;
  previewTarget?(target: HTMLElement | null): void;
  disableSelection?(): Promise<void>;
  isTrustedActivationEvent?(event: MouseEvent): boolean;
  isTrustedKeyEvent?(event: KeyboardEvent): boolean;
  onEnabledChange?(enabled: boolean): void;
  pointerEventTarget?: EventTarget;
  resolveTarget?(event: MouseEvent): HTMLElement | null;
}

export function createCaptureSelectionController(
  options: CaptureSelectionControllerOptions,
): CaptureSelectionController {
  return createElementSelectionController({
    root: options.root,
    resolveTarget: (event) =>
      options.resolveTarget?.(event) ?? getSelectableComposedTarget(options.root, event),
    activateTarget: (target, anchor, selectionPoint, context) =>
      captureAndCommit(options, target, anchor, selectionPoint, context),
    previewTarget: options.previewTarget,
    requestDisable: options.disableSelection,
    reportFailure: () => options.publishFailure(SAFE_CAPTURE_ERROR),
    isTrustedActivationEvent: options.isTrustedActivationEvent ?? ((event) => event.isTrusted),
    isTrustedKeyEvent: options.isTrustedKeyEvent ?? ((event) => event.isTrusted),
    onEnabledChange: options.onEnabledChange,
    pointerEventTarget: options.pointerEventTarget,
    serializeActivations: true,
  });
}

async function captureAndCommit(
  options: CaptureSelectionControllerOptions,
  target: HTMLElement,
  anchor: PersistentOverlayAnchor,
  selectionPoint: UIAttachmentSelectionPoint | null,
  context: ElementSelectionActivationContext,
): Promise<void> {
  if (!context.isCurrent()) return;
  const begun = await options.beginCapture(null);
  if (!context.isCurrent()) return;
  if (!begun.ok) {
    await options.publishFailure(begun.error);
    return;
  }

  const metadataDiagnosticsDevice = begun.data.collectBasicDiagnostics === true
    ? options.collectMetadataDiagnosticsDevice?.(target) ?? { status: "not_available" as const }
    : undefined;

  const captured = await options.captureTarget(target, selectionPoint);
  if (!context.isCurrent()) return;
  if (!captured.ok) {
    await options.publishFailure(captured.error);
    return;
  }

  const committed = await options.commitCapture(
    begun.data,
    captured.record,
    metadataDiagnosticsDevice,
  );
  if (!context.isCurrent()) return;
  if (!committed.ok) {
    await options.publishFailure(committed.error);
    return;
  }

  await options.publishCommitted(target, committed.data, captured.record, anchor, context);
}
