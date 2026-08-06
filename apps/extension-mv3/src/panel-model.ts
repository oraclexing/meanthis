import {
  hydrateCaptureSessionFile,
  serializeCapturePageRoutingSection,
  type CapturePromptBundleFormat,
  type CaptureSessionFileV1,
} from "@meanthis/hub-core";
import {
  serializeAttachmentCompactHandoff,
  serializeAttachmentHandoff,
} from "@meanthis/prompt";
import type {
  LocalBridgeCaptureAuthorityV1,
  LocalBridgeCaptureV1,
  UIAttachment,
  UIAttachmentDisclosureMode,
} from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import { deriveCaptureRecordDisclosure } from "./disclosure-view";
import { translateEnglish, type UiAttachTranslate } from "./i18n";
import {
  formatDisplayTime,
  type TimeDisplayPreference,
} from "./settings-preferences";
import type { OverlayRebindStatus } from "./messages";

export interface PanelAgentCopyInput {
  file: CaptureSessionFileV1 | null;
  attachmentIds: string[];
  selectedItemId: string | null;
  selectedRecord: OriginCaptureRecord | null;
  viewMode: UIAttachmentDisclosureMode;
  intent: string;
  format?: CapturePromptBundleFormat;
}

export interface CaptureBoundaryView {
  title: string;
  message: string;
}

export function formatCurrentTargetStatus(
  status: OverlayRebindStatus | "unavailable",
  t: UiAttachTranslate = translateEnglish,
): string {
  return t(`current_target_${status}`);
}

export type PanelAgentCopyResult =
  | { ok: true; text: string; attachmentCount: number }
  | { ok: false; error: string };

export function buildPanelBridgeCapture(
  input: PanelAgentCopyInput,
  authority: LocalBridgeCaptureAuthorityV1,
): LocalBridgeCaptureV1 | null {
  if (!input.file) return null;
  const items = selectAgentCopyItems(input.file, input.attachmentIds);
  if (!items || items.length === 0) return null;

  const targets: LocalBridgeCaptureV1["targets"] = [];
  for (const [index, item] of items.entries()) {
    const disclosure = deriveCaptureRecordDisclosure(
      item.sourceRecord as OriginCaptureRecord,
      "agent_safe",
    );
    if (!disclosure.ok) return null;
    targets.push({
      attachmentId: item.id,
      label: item.labels.find((label) => label.trim())?.trim() ?? `${index + 1}`,
      taskNote: resolvePanelItemIntent(item, input.selectedItemId, input.intent),
      attachment: disclosure.record.attachment,
    });
  }

  const safeTitles = [...new Set(targets
    .map((target) => target.attachment.source.title?.trim())
    .filter((title): title is string => Boolean(title)))];

  return {
    captureId: input.file.session.id,
    title: safeTitles.length === 1 ? safeTitles[0] : null,
    origin: input.file.session.origin,
    updatedAt: input.file.session.updatedAt,
    authority,
    disclosureMode: "agent_safe",
    targets,
  };
}

export function buildPanelAgentCopy(
  input: PanelAgentCopyInput,
  translate: UiAttachTranslate = translateEnglish,
): PanelAgentCopyResult {
  const file = input.file;
  const scopedItems = file ? selectAgentCopyItems(file, input.attachmentIds) : [];
  if (scopedItems === null) {
    return { ok: false, error: translate("no_selected_capture") };
  }
  const items = scopedItems;
  if (items.length <= 1) {
    const sourceRecord = items[0]?.sourceRecord as OriginCaptureRecord | undefined;
    const record = sourceRecord ?? input.selectedRecord;
    if (!record) {
      return { ok: false, error: translate("no_selected_capture") };
    }
    const disclosure = deriveCaptureRecordDisclosure(
      record,
      resolveRecordDisclosureMode(
        record.attachment.policy.disclosureMode,
        input.viewMode,
      ),
    );
    if (!disclosure.ok) {
      return { ok: false, error: translate("unable_prepare_agent_context") };
    }
    const selectedRecord = disclosure.record;
    const intent = items.length === 1
      ? resolvePanelItemIntent(items[0], input.selectedItemId, input.intent)
      : input.intent;
    const compactSingleton = file !== null && items.length === 1 && input.format === "compact";
    const handoff = compactSingleton
      ? serializeAttachmentCompactHandoff(selectedRecord.attachment, {
          intent,
        })
      : serializeAttachmentHandoff(selectedRecord.attachment, {
          intent,
        });
    const routingSection = serializeCapturePageRoutingSection([
      {
        attachmentId: items[0]?.id ?? selectedRecord.attachment.id,
        label: items[0]?.labels.find((label) => label.trim()) ?? "A",
        record: selectedRecord,
      },
    ]);
    return {
      ok: true,
      text: routingSection ? `${handoff}\n\n${routingSection}` : handoff,
      attachmentCount: 1,
    };
  }

  if (!file) {
    return { ok: false, error: translate("no_capture_session") };
  }
  const scopedFile: CaptureSessionFileV1 = {
    ...file,
    session: { ...file.session, attachments: items },
  };
  const hydrated = hydrateCaptureSessionFile(scopedFile);
  if (!hydrated.ok) {
    return { ok: false, error: translate("invalid_capture_session") };
  }
  const attachmentLabels = Object.fromEntries(
    items.map((item, index) => [item.id, item.labels.find((label) => label.trim()) ?? `${index + 1}`]),
  );
  const intent = buildPanelBundleIntent(items, input.selectedItemId, input.intent);
  const attachmentIntents = Object.fromEntries(
    items.map((item) => [
      item.id,
      resolvePanelItemIntent(item, input.selectedItemId, input.intent),
    ]),
  );
  const bundle = hydrated.hub.buildPromptBundle({
    sessionId: hydrated.sessionId,
    attachmentIds: items.map((item) => item.id),
    attachmentLabels,
    attachmentIntents,
    disclosureMode: resolveBundleDisclosureMode(scopedFile, input.viewMode),
    format: input.format ?? "exact",
    intent,
  });
  if (!bundle.ok) {
    return { ok: false, error: translate("unable_prepare_agent_context") };
  }
  return { ok: true, text: bundle.markdown, attachmentCount: bundle.attachmentCount };
}

function buildPanelBundleIntent(
  items: CaptureSessionFileV1["session"]["attachments"],
  selectedItemId: string | null,
  selectedIntent: string,
): string {
  const taskNotes = items.flatMap((item, index) => {
    const intent = resolvePanelItemIntent(item, selectedItemId, selectedIntent);
    if (!intent) return [];
    return [{
      label: item.labels.find((label) => label.trim())?.trim() ?? `${index + 1}`,
      intent,
    }];
  });
  if (taskNotes.length === 0) return "";
  return [
    "Per-element task notes (JSON; labels match the attachment map):",
    JSON.stringify(taskNotes),
  ].join("\n");
}

function resolvePanelItemIntent(
  item: CaptureSessionFileV1["session"]["attachments"][number],
  selectedItemId: string | null,
  selectedIntent: string,
): string {
  return (item.id === selectedItemId
    ? selectedIntent
    : item.sourceRecord.intent).trim();
}

function selectAgentCopyItems(
  file: CaptureSessionFileV1,
  attachmentIds: string[],
): CaptureSessionFileV1["session"]["attachments"] | null {
  if (attachmentIds.length === 0 || new Set(attachmentIds).size !== attachmentIds.length) {
    return null;
  }
  const requested = new Set(attachmentIds);
  const items = file.session.attachments.filter((item) => requested.has(item.id));
  return items.length === requested.size ? items : null;
}

function resolveRecordDisclosureMode(
  available: UIAttachmentDisclosureMode,
  requested: UIAttachmentDisclosureMode,
): UIAttachmentDisclosureMode {
  const modes: UIAttachmentDisclosureMode[] = [
    "agent_safe",
    "developer_diagnostic",
    "full_debug",
  ];
  const rank: Record<UIAttachmentDisclosureMode, number> = {
    agent_safe: 0,
    developer_diagnostic: 1,
    full_debug: 2,
  };
  return modes[Math.min(rank[requested], rank[available])] ?? "agent_safe";
}

function resolveBundleDisclosureMode(
  file: CaptureSessionFileV1,
  requested: UIAttachmentDisclosureMode,
): UIAttachmentDisclosureMode {
  const rank: Record<UIAttachmentDisclosureMode, number> = {
    agent_safe: 0,
    developer_diagnostic: 1,
    full_debug: 2,
  };
  const availableRank = Math.min(
    ...file.session.attachments.map(
      (item) => rank[item.sourceRecord.attachment.policy.disclosureMode],
    ),
  );
  const available = (["agent_safe", "developer_diagnostic", "full_debug"] as const)[availableRank]
    ?? "agent_safe";
  return resolveRecordDisclosureMode(available, requested);
}

export interface CaptureMetadataInput {
  capturedAt: string;
  redactedFields: string[];
  sensitiveHints: string[];
  includedSensitiveFields: string[];
}

export interface CaptureMetadataView {
  capturedAt: string;
  redactedFields: string;
  sensitiveHints: string;
  includedSensitiveFields: string;
}

export type PanelStatusKind =
  | "active-origin-changed"
  | "clear-in-progress"
  | "copied"
  | "empty"
  | "export-started"
  | "failed"
  | "no-session"
  | "ready"
  | "session-cleared"
  | "session-item-removed"
  | "saving-session"
  | "session-saved"
  | "session-unchanged"
  | "session-full";

const PANEL_ACTION_FAILED = "Panel action failed. Try again.";
const SELECTION_ACTIVE_PAGE_RECOVERY =
  "Open a regular HTTP(S) page, then select Add elements again.";
const SELECTION_CONTENT_RECOVERY =
  "MeanThis cannot reach this page. Reload it, then select Add elements again.";
const SELECTION_PERMISSION_RECOVERY =
  "Page access is required before selection.";
const SELECTION_GENERIC_RECOVERY =
  "MeanThis could not start selection. Reload the page and try again.";
const FRAME_PERMISSION_DENIED =
  "Frame access was not granted. Nothing inside the frame was captured.";
const FRAME_PERMISSION_UNAVAILABLE =
  "Frame access is unavailable in this browser. Reload the extension and try again.";
const FRAME_UNAVAILABLE =
  "The embedded frame changed or could not be found. Capture its boundary again.";
const FRAME_AMBIGUOUS =
  "More than one matching embedded frame is open. MeanThis will not guess which one you intended.";
const FRAME_PERMISSION_CLEANUP_FAILED =
  "Chrome could not release temporary frame access. Selection was stopped; review MeanThis site access in the extension settings.";
const ACTIONABLE_PANEL_FAILURES = new Set([
  SELECTION_ACTIVE_PAGE_RECOVERY,
  SELECTION_CONTENT_RECOVERY,
  SELECTION_PERMISSION_RECOVERY,
  SELECTION_GENERIC_RECOVERY,
  FRAME_PERMISSION_DENIED,
  FRAME_PERMISSION_UNAVAILABLE,
  FRAME_UNAVAILABLE,
  FRAME_AMBIGUOUS,
  FRAME_PERMISSION_CLEANUP_FAILED,
]);
const ACTIONABLE_PANEL_FAILURE_KEYS = new Map([
  [SELECTION_ACTIVE_PAGE_RECOVERY, "open_regular_page"],
  [SELECTION_CONTENT_RECOVERY, "content_unavailable"],
  [SELECTION_PERMISSION_RECOVERY, "permission_recovery"],
  [SELECTION_GENERIC_RECOVERY, "selection_generic_recovery"],
  [FRAME_PERMISSION_DENIED, "frame_permission_denied"],
  [FRAME_PERMISSION_UNAVAILABLE, "frame_permission_unavailable"],
  [FRAME_UNAVAILABLE, "frame_unavailable"],
  [FRAME_AMBIGUOUS, "frame_ambiguous"],
  [FRAME_PERMISSION_CLEANUP_FAILED, "frame_permission_cleanup_failed"],
]);

export function composePanelMarkdown(
  attachmentMarkdown: string,
  intent: string,
  attachmentSummary = "",
): string {
  const trimmedIntent = intent.trim();
  const trimmedSummary = attachmentSummary.trim();
  const sections: string[] = [];
  if (trimmedIntent) {
    sections.push(["## User Intent", "", trimmedIntent].join("\n"));
  }

  if (trimmedSummary) {
    sections.push(trimmedSummary);
  }

  sections.push(attachmentMarkdown);
  return sections.join("\n\n");
}

export function formatPanelStatus(
  kind: PanelStatusKind,
  message = "",
  translate: UiAttachTranslate = translateEnglish,
): string {
  if (kind === "no-session") {
    return translate("ready_add_elements");
  }

  if (kind === "saving-session") {
    return translate("saving_session");
  }

  if (kind === "session-saved") {
    return translate("session_saved");
  }

  if (kind === "session-item-removed") {
    return translate("session_item_removed");
  }

  if (kind === "session-cleared") {
    return translate("selection_cleared");
  }

  if (kind === "session-unchanged") {
    return translate("session_unchanged");
  }

  if (kind === "session-full") {
    return translate("session_full");
  }

  if (kind === "clear-in-progress") {
    return translate("clear_in_progress");
  }

  if (kind === "export-started") {
    const filename = message.trim();
    return filename
      ? translate("export_started_named", { filename })
      : translate("export_started");
  }

  if (kind === "active-origin-changed") {
    return translate("active_origin_changed");
  }

  if (kind === "empty") {
    return translate("ready_add_elements");
  }

  if (kind === "failed") {
    return translate("capture_failed_with_message", {
      message: message || translate("unable_capture_selected"),
    });
  }

  if (kind === "copied") {
    return message || translate("copied");
  }

  return translate("capture_ready");
}

export function formatCaptureFailureStatus(
  message: string,
  translate: UiAttachTranslate = translateEnglish,
): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("26") ||
    normalized.includes("session_full") ||
    normalized.includes("limit reached")
  ) {
    return formatPanelStatus("session-full", "", translate);
  }
  if (normalized.includes("clear") && normalized.includes("progress")) {
    return formatPanelStatus("clear-in-progress", "", translate);
  }
  if (normalized.includes("unsupported") || normalized.includes("canonical http")) {
    return translate("page_cannot_capture");
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("access denied") ||
    normalized.includes("does not have access")
  ) {
    return translate("permission_recovery");
  }
  if (
    normalized.includes("stale") ||
    normalized.includes("page changed") ||
    normalized.includes("no longer")
  ) {
    return translate("page_changed_recovery");
  }
  if (
    normalized.includes("unavailable") ||
    normalized.includes("not available") ||
    normalized.includes("cannot reach")
  ) {
    return translate("content_unavailable");
  }
  return translate("capture_generic_recovery");
}

export function formatElementSelectionFailureStatus(
  code: string,
  translate: UiAttachTranslate = translateEnglish,
): string {
  if (code === "ACTIVE_PAGE_UNAVAILABLE" || code === "UNSUPPORTED_ORIGIN") {
    return translate("open_regular_page");
  }
  if (code === "CONTENT_UNAVAILABLE") return translate("content_unavailable");
  if (code === "PERMISSION_DENIED" || code === "ACCESS_DENIED") {
    return translate("permission_recovery");
  }
  if (code === "FRAME_PERMISSION_DENIED") return translate("frame_permission_denied");
  if (code === "FRAME_PERMISSION_UNAVAILABLE") return translate("frame_permission_unavailable");
  if (code === "FRAME_UNAVAILABLE") return translate("frame_unavailable");
  if (code === "FRAME_AMBIGUOUS") return translate("frame_ambiguous");
  if (code === "FRAME_PERMISSION_CLEANUP_FAILED") {
    return translate("frame_permission_cleanup_failed");
  }
  return translate("selection_generic_recovery");
}

export function formatPanelActionFailureStatus(
  error: unknown,
  translate: UiAttachTranslate = translateEnglish,
): string {
  const message = error instanceof Error ? error.message : "";
  const key = ACTIONABLE_PANEL_FAILURE_KEYS.get(message);
  return ACTIONABLE_PANEL_FAILURES.has(message) && key
    ? translate(key)
    : translate("panel_action_failed");
}

export function formatSelectionStoppedStatus(
  hasElements: boolean,
  translate: UiAttachTranslate = translateEnglish,
): string {
  return hasElements
    ? translate("selection_stopped_with_elements")
    : translate("selection_stopped_empty");
}

export function formatCaptureMetadata(
  input: CaptureMetadataInput,
  translate: UiAttachTranslate = translateEnglish,
  timeDisplayPreference: TimeDisplayPreference = "utc",
): CaptureMetadataView {
  return {
    capturedAt: formatDisplayTime(input.capturedAt, timeDisplayPreference),
    redactedFields: formatFieldList(input.redactedFields, translate),
    sensitiveHints: formatFieldList(input.sensitiveHints, translate),
    includedSensitiveFields: formatFieldList(input.includedSensitiveFields, translate),
  };
}

export function summarizeElement(
  attachment: UIAttachment,
  translate: UiAttachTranslate = translateEnglish,
): string {
  const element = attachment.element;
  const name = element.accessibleName ?? element.text ?? translate("unnamed");
  const role = element.role ?? element.tagName;
  return `${role} · ${name}`;
}

export function formatCaptureBoundaryView(
  attachment: UIAttachment,
  translate: UiAttachTranslate = translateEnglish,
): CaptureBoundaryView | null {
  if (attachment.boundary?.kind !== "embedded_frame") return null;
  return {
    title: translate("embedded_frame"),
    message: translate("embedded_frame_boundary_notice"),
  };
}

export function summarizeLocator(
  attachment: UIAttachment,
  translate: UiAttachTranslate = translateEnglish,
): string {
  const primary = attachment.locatorBundle.primary;
  if (!primary) {
    return translate("no_primary_locator");
  }

  return translate("locator_summary", {
    strategy: primary.strategy,
    confidence: primary.confidence,
    replay: summarizeReplayStatus(attachment, translate),
  });
}

function summarizeReplayStatus(attachment: UIAttachment, translate: UiAttachTranslate): string {
  const stability = attachment.locatorBundle.stability;
  if (stability.replayVerified) {
    return translate("replay_verified");
  }

  return stability.failureReason
    ? translate("replay_failed", { reason: stability.failureReason })
    : translate("replay_not_verified");
}

function formatFieldList(values: string[], translate: UiAttachTranslate): string {
  return values.length ? values.join(", ") : translate("none");
}
