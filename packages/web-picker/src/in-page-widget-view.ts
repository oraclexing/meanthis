import type { AttachmentFeedbackDetail } from "@meanthis/prompt";
import {
  validatePrivateDebugSummaryV1,
  type PrivateDebugSummaryV1,
} from "@meanthis/schema";
import type { AnnotationLifecycle, AnnotationLifecycleState } from "./annotation-surface-controller.js";
import type { PersistentOverlayDisplayMode } from "./persistent-overlays.js";

export type InPageWidgetMode = "collapsed" | "ready" | "selecting" | "details" | "editing";
export type InPageWidgetReadiness = "hydrating" | "ready" | "error";
export type InPageWidgetReferenceScope = "page" | "site";

export type ClearStatus =
  | { clearState: "idle"; operationId: null }
  | { clearState: "pending"; operationId: string };

export type InPageWidgetBridgeState =
  | "unavailable"
  | "disconnected"
  | "pending"
  | "connected";

export type InPageWidgetReadAcknowledgementState =
  | "waiting"
  | "current"
  | "unavailable";

export type InPageWidgetBusyAction =
  | "save"
  | "remove"
  | "clear"
  | "copy"
  | "disclosure"
  | "connect"
  | "refresh"
  | "disconnect"
  | "selection"
  | "frame-scope"
  | "side-panel"
  | "diagnostics"
  | "lifecycle"
  | null;

export interface InPageWidgetInteraction {
  isTrusted: boolean;
}

export interface InPageWidgetLifecycleControlProposal {
  itemId: string;
  operationId: string;
  fingerprint: string;
  expectedState: AnnotationLifecycleState;
  nextState: AnnotationLifecycleState;
  expiresAt: string;
}

export interface InPageWidgetTargetViewModel {
  itemId: string;
  label: string;
  name: string;
  annotationLifecycle?: AnnotationLifecycle | null;
}

export interface InPageWidgetShortcutViewModel {
  id: string;
  label: string;
  note: string;
}

export interface InPageWidgetStatusViewModel {
  kind: "info" | "success" | "error";
  message: string;
}

export interface InPageWidgetFrameScopeViewModel {
  id: string;
  kind: "top" | "embedded";
  detail: string;
  depth: number;
  current: boolean;
  selectable: boolean;
  itemCount?: number | null;
}

export interface InPageWidgetViewModel {
  mode: InPageWidgetMode;
  readiness?: InPageWidgetReadiness;
  bridgeState: InPageWidgetBridgeState;
  bridgeInvitationRemainingSeconds?: number | null;
  bridgeSharedTargetCount?: number | null;
  bridgeSharedSequence?: number | null;
  bridgeReadAcknowledgementState?: InPageWidgetReadAcknowledgementState;
  disclosureRequired: boolean;
  clearConfirmationRequired?: boolean;
  clearStatus?: ClearStatus;
  connectionRequestText?: string | null;
  manualCopyText?: string | null;
  outputDetail?: AttachmentFeedbackDetail;
  displayMode?: PersistentOverlayDisplayMode;
  collectBasicDiagnosticsForNextCapture?: boolean;
  basicDiagnosticsCommandRevision?: number;
  privateDebugSummary?: PrivateDebugSummaryV1 | null;
  privateDebugSummaryCopied?: boolean;
  referenceScope?: InPageWidgetReferenceScope;
  pageTargetCount?: number;
  siteTargetCount?: number;
  siteLabel?: string;
  frameScopeOpen: boolean;
  frameScopes: readonly InPageWidgetFrameScopeViewModel[];
  targets: readonly InPageWidgetTargetViewModel[];
  lifecycleControlProposal?: InPageWidgetLifecycleControlProposal | null;
  activeItemId: string | null;
  taskNote: string;
  shortcuts: readonly InPageWidgetShortcutViewModel[];
  busyAction: InPageWidgetBusyAction;
  status: InPageWidgetStatusViewModel | null;
}

export interface InPageWidgetViewCallbacks {
  onExpand?(): void;
  onCollapse?(): void;
  onStartSelection?(): void;
  onStopSelection?(): void;
  onToggleFrameScopes?(): void;
  onCloseFrameScopes?(): void;
  onSelectFrameScope?(scopeId: string): void;
  onClear?(): void;
  onOpenSettings?(): void;
  onOpenFullSidePanel?(interaction: InPageWidgetInteraction): void;
  onOutputDetailChange?(detail: AttachmentFeedbackDetail): void;
  onDisplayModeChange?(mode: PersistentOverlayDisplayMode): void;
  onCollectBasicDiagnosticsChange?(enabled: boolean): void;
  onCopyPrivateDebugSummary?(interaction: InPageWidgetInteraction): void;
  onReferenceScopeChange?(scope: InPageWidgetReferenceScope): void;
  onAcknowledgeDisclosure?(): void;
  onCreateInvitation?(): void;
  onRefreshConnection?(): void;
  onDisconnect?(): void;
  onCopyInvitation?(text: string): void;
  onActivateTarget?(itemId: string): void;
  onTaskNoteChange?(itemId: string, note: string): void;
  onApplyShortcut?(itemId: string, shortcutId: string, note: string): void;
  onSave?(itemId: string, note: string): void;
  onCopy?(): void;
  onCloseEditor?(itemId: string): void;
  onEditTarget?(itemId: string): void;
  onRemoveTarget?(itemId: string): void;
  onMoreTarget?(itemId: string): void;
  onSetAnnotationLifecycle?(
    itemId: string,
    nextState: AnnotationLifecycleState,
    interaction: InPageWidgetInteraction,
  ): void;
  onApproveLifecycleControlProposal?(
    operationId: string,
    fingerprint: string,
    interaction: InPageWidgetInteraction,
  ): void;
  onRejectLifecycleControlProposal?(
    operationId: string,
    fingerprint: string,
    interaction: InPageWidgetInteraction,
  ): void;
}

export interface InPageWidgetStrings {
  brand: string;
  regionLabel: string;
  selectionToolbarLabel: string;
  selectedTargetsLabel: string;
  openLabel(count: number, state: string): string;
  closeWidget: string;
  copyForAgent: string;
  clearAll: string;
  clearConfirm: string;
  retryClear: string;
  clearPending: string;
  openSettings: string;
  openFullSidePanel: string;
  openingFullSidePanel: string;
  fullSidePanelOpened: string;
  fullSidePanelOpenFailed: string;
  referenceScopeLabel: string;
  currentPageScope(count: number): string;
  entireSiteScope(site: string, count: number): string;
  otherPagesCount(count: number): string;
  clearCurrentPage: string;
  clearEntireSite(site: string): string;
  clearCurrentPageConfirm: string;
  clearEntireSiteConfirm(site: string): string;
  outputDetailLabel: string;
  outputDetailHelp: string;
  outputDetailLevels: Record<AttachmentFeedbackDetail, string>;
  collectBasicDiagnosticsLabel: string;
  collectBasicDiagnosticsHelp: string;
  privateDebugSummaryReady: string;
  privateDebugSummaryNotCopied: string;
  privateDebugSummaryReplay(
    verifiedCount: number,
    ambiguousCount: number,
    missingCount: number,
  ): string;
  privateDebugSummaryReplayUnavailable: string;
  privateDebugSummaryDevice(
    deviceClass: string,
    viewportClass: string,
    touch: string,
  ): string;
  privateDebugSummaryDeviceUnavailable: string;
  copyPrivateDebugSummary: string;
  copyingPrivateDebugSummary: string;
  privateDebugSummaryCopied: string;
  privateDebugSummaryCopyFailed: string;
  annotationDisplayLabel: string;
  annotationDisplayLevels: Record<PersistentOverlayDisplayMode, string>;
  captureScope: string;
  topPage: string;
  embeddedFrame: string;
  currentScope: string;
  allScopesCount(count: number): string;
  captureScopeUnavailable: string;
  stateLabels: Record<InPageWidgetBridgeState, string>;
  startSelecting: string;
  stopSelecting: string;
  selectedCount(count: number): string;
  noTargets: string;
  activateTarget(label: string, name: string): string;
  editorHeading(label: string): string;
  editTarget(label: string): string;
  removeTarget(label: string): string;
  moreTarget(label: string): string;
  markResolved: string;
  reopen: string;
  resolved: string;
  annotationResolved: string;
  annotationReopened: string;
  annotationLifecycleUnconfirmed: string;
  markResolvedTarget(label: string): string;
  reopenTarget(label: string): string;
  lifecycleControlProposalHeading: string;
  lifecycleControlProposalFingerprint(fingerprint: string): string;
  lifecycleControlProposalTransition(
    expectedState: AnnotationLifecycleState,
    nextState: AnnotationLifecycleState,
  ): string;
  lifecycleControlProposalExpires(expiresAt: string): string;
  approveLifecycleControlProposal: string;
  rejectLifecycleControlProposal: string;
  closeEditor(label: string): string;
  edit: string;
  remove: string;
  more: string;
  unnamedTarget: string;
  taskNote: string;
  taskNoteLabel(label: string): string;
  taskNotePlaceholder: string;
  shortcuts: string;
  save: string;
  saving: string;
  copy: string;
  copying: string;
  disclosureHeading: string;
  disclosureIntro: string;
  disclosureData: string;
  disclosureLocal: string;
  disclosureRedaction: string;
  disclosureReceiver: string;
  disclosureFirstTrial: string;
  disclosureAcknowledge: string;
  disclosureAcknowledging: string;
  widgetDisconnected: string;
  reconnecting: string;
  taskNoteSaveFailed: string;
  taskNoteSaved: string;
  copySucceeded(count: number): string;
  copyFailed: string;
  operationFailed: string;
  sessionNotReady: string;
  disclosureLoadFailed: string;
  disclosureAcknowledgeFailed: string;
  shortcutBelow: string;
  shortcutBelowNote(label: string): string;
  bridgeControlsLabel: string;
  bridgeUnavailableHelp: string;
  bridgeDisconnectedHelp: string;
  bridgePendingHelp(remainingSeconds: number | null): string;
  bridgeConnectedHelp: string;
  bridgeConnectedTargets(count: number): string;
  bridgeReadAcknowledgementWaiting: string;
  bridgeReadAcknowledgementCurrent: string;
  bridgeReadAcknowledgementUnavailable: string;
  bridgeReadAcknowledgementLimitations: string;
  createInvitation: string;
  creatingInvitation: string;
  invitationLabel: string;
  copyInvitation: string;
  invitationCopied: string;
  invitationExpired: string;
  refreshConnection: string;
  refreshingConnection: string;
  disconnect: string;
  disconnecting: string;
}

export type InPageWidgetTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export interface CreateInPageWidgetViewOptions {
  document: Document;
  initialModel?: InPageWidgetViewModel;
  callbacks?: InPageWidgetViewCallbacks;
  strings?: InPageWidgetStringsOverride;
  resolveAssetUrl?: (assetName: string) => string;
}

export type InPageWidgetStringsOverride =
  & Partial<Omit<InPageWidgetStrings, "stateLabels" | "outputDetailLevels" | "annotationDisplayLevels">>
  & {
    stateLabels?: Partial<Record<InPageWidgetBridgeState, string>>;
    outputDetailLevels?: Partial<Record<AttachmentFeedbackDetail, string>>;
    annotationDisplayLevels?: Partial<Record<PersistentOverlayDisplayMode, string>>;
  };

export interface InPageWidgetView {
  readonly element: HTMLDivElement;
  update(model: InPageWidgetViewModel): void;
  focus(): void;
  dispose(): void;
}

const MAX_TARGETS = 26;
const MAX_SHORTCUTS = 8;
const MAX_FRAME_SCOPES = 256;
const MAX_FRAME_DEPTH = 32;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 18;
const MAX_NAME_LENGTH = 80;
const MAX_NOTE_LENGTH = 16_384;
const MAX_STATUS_LENGTH = 240;
const MAX_SCOPE_DETAIL_LENGTH = 240;
const MAX_LIFECYCLE_PROPOSAL_FINGERPRINT_LENGTH = 128;
const MAX_LIFECYCLE_PROPOSAL_FINGERPRINT_DISPLAY_LENGTH = 32;
const CLEAR_PENDING_STATUS_ID = "meanthis-clear-pending-status";
const IDLE_COLLAPSE_DELAY_MS = 300;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const UNSAFE_ID = /[\u0000-\u001f\u007f-\u009f]/u;

function formatBridgeCountdown(remainingSeconds: number): string {
  const bounded = Math.max(0, Math.floor(remainingSeconds));
  const minutes = Math.floor(bounded / 60);
  const seconds = bounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const DEFAULT_MODEL: InPageWidgetViewModel = {
  mode: "collapsed",
  readiness: "ready",
  bridgeState: "unavailable",
  bridgeInvitationRemainingSeconds: null,
  bridgeSharedTargetCount: null,
  bridgeSharedSequence: null,
  bridgeReadAcknowledgementState: "unavailable",
  disclosureRequired: false,
  clearConfirmationRequired: false,
  clearStatus: { clearState: "idle", operationId: null },
  connectionRequestText: null,
  manualCopyText: null,
  outputDetail: "compact",
  displayMode: "hover",
  collectBasicDiagnosticsForNextCapture: false,
  basicDiagnosticsCommandRevision: 0,
  privateDebugSummary: null,
  privateDebugSummaryCopied: false,
  referenceScope: "page",
  pageTargetCount: 0,
  siteTargetCount: 0,
  siteLabel: "site",
  frameScopeOpen: false,
  frameScopes: [],
  targets: [],
  activeItemId: null,
  taskNote: "",
  shortcuts: [],
  busyAction: null,
  status: null,
};

export const DEFAULT_IN_PAGE_WIDGET_STRINGS: InPageWidgetStrings = {
  brand: "MeanThis",
  regionLabel: "MeanThis page references",
  selectionToolbarLabel: "Selection controls",
  selectedTargetsLabel: "Selected targets",
  openLabel: (count, state) => (
    `Open MeanThis, ${count} selected, ${state.toLocaleLowerCase()}`
  ),
  closeWidget: "Collapse MeanThis",
  copyForAgent: "Copy current references for agent",
  clearAll: "Clear all selected elements",
  clearConfirm: "Select Clear again to remove all selected elements.",
  retryClear: "Retry clearing page annotations",
  clearPending: "Clearing page annotations is still pending. Retry to confirm completion.",
  openSettings: "Open MeanThis details and settings",
  openFullSidePanel: "Open full side panel",
  openingFullSidePanel: "Opening full side panel…",
  fullSidePanelOpened: "Full side panel opened.",
  fullSidePanelOpenFailed: "MeanThis could not open the full side panel.",
  referenceScopeLabel: "Reference scope",
  currentPageScope: (count) => `Current page · ${count}`,
  entireSiteScope: (site, count) => `Entire ${site} site · ${count}`,
  otherPagesCount: (count) => `${count} on other pages`,
  clearCurrentPage: "Clear references from the current page",
  clearEntireSite: (site) => `Clear references from the entire ${site} site`,
  clearCurrentPageConfirm: "Select Clear again to remove references from the current page.",
  clearEntireSiteConfirm: (site) => (
    `Select Clear again to remove references from the entire ${site} site.`
  ),
  outputDetailLabel: "Output detail",
  outputDetailHelp: "Controls copied text only. MeanThis keeps the full captured reference.",
  outputDetailLevels: {
    compact: "Compact",
    standard: "Standard",
    detailed: "Detailed",
    forensic: "Forensic",
  },
  collectBasicDiagnosticsLabel: "Add a private troubleshooting summary to the next capture",
  collectBasicDiagnosticsHelp:
    "Includes replay result counts and coarse device classes. No page content, address, exact size, user agent, network, console, screenshot, or HAR. Used once. This summary is copied only when you choose Copy summary; a connected local Agent may separately receive the disclosed coarse diagnostics.",
  privateDebugSummaryReady: "Troubleshooting summary ready",
  privateDebugSummaryNotCopied: "Not copied yet",
  privateDebugSummaryReplay: (verifiedCount, ambiguousCount, missingCount) =>
    `${verifiedCount} verified · ${ambiguousCount} ambiguous · ${missingCount} missing`,
  privateDebugSummaryReplayUnavailable: "Replay summary unavailable",
  privateDebugSummaryDevice: (deviceClass, viewportClass, touch) =>
    `${titleCase(deviceClass)} · ${titleCase(viewportClass)} viewport · ${formatTouchClass(touch)}`,
  privateDebugSummaryDeviceUnavailable: "Device summary unavailable",
  copyPrivateDebugSummary: "Copy summary",
  copyingPrivateDebugSummary: "Copying summary…",
  privateDebugSummaryCopied: "Troubleshooting summary copied.",
  privateDebugSummaryCopyFailed:
    "Copy failed. Select the troubleshooting summary shown below to copy it manually.",
  annotationDisplayLabel: "Annotation display",
  annotationDisplayLevels: {
    full: "Full",
    hover: "Hover",
    markers: "Markers",
    hidden: "Hidden",
  },
  captureScope: "Capture scope",
  topPage: "Top page",
  embeddedFrame: "Embedded frame",
  currentScope: "Current scope",
  allScopesCount: (count) => `${count} across scopes`,
  captureScopeUnavailable: "This frame is not available for element selection.",
  stateLabels: {
    unavailable: "Agent bridge unavailable",
    disconnected: "Disconnected",
    pending: "Connecting",
    connected: "Connected",
  },
  startSelecting: "Select element",
  stopSelecting: "Stop selecting",
  selectedCount: (count) => `${count} selected`,
  noTargets: "No elements selected yet.",
  activateTarget: (label, name) => `Open target ${label}: ${name}`,
  editorHeading: (label) => `Target ${label}`,
  editTarget: (label) => `Edit target ${label}`,
  removeTarget: (label) => `Remove target ${label}`,
  moreTarget: (label) => `More options for target ${label}`,
  markResolved: "Mark resolved",
  reopen: "Reopen",
  resolved: "Resolved",
  annotationResolved: "Annotation resolved.",
  annotationReopened: "Annotation reopened.",
  annotationLifecycleUnconfirmed:
    "Annotation state was not updated. Refresh and try again.",
  markResolvedTarget: (label) => `Mark annotation ${label} resolved`,
  reopenTarget: (label) => `Reopen annotation ${label}`,
  lifecycleControlProposalHeading: "Agent lifecycle proposal",
  lifecycleControlProposalFingerprint: (fingerprint) => `Fingerprint: ${fingerprint}`,
  lifecycleControlProposalTransition: (expectedState, nextState) =>
    `Transition: ${expectedState} → ${nextState}`,
  lifecycleControlProposalExpires: (expiresAt) => `Expires: ${expiresAt}`,
  approveLifecycleControlProposal: "Approve",
  rejectLifecycleControlProposal: "Reject",
  closeEditor: (label) => `Close task editor for target ${label}`,
  edit: "Edit",
  remove: "Remove",
  more: "More",
  unnamedTarget: "Selected element",
  taskNote: "Task note",
  taskNoteLabel: (label) => `Task note for target ${label}`,
  taskNotePlaceholder: "Tell the agent what should change…",
  shortcuts: "Shortcuts",
  save: "Save",
  saving: "Saving…",
  copy: "Copy",
  copying: "Copying…",
  disclosureHeading: "Before your first capture",
  disclosureIntro:
    "MeanThis creates references for elements you choose. Each reference may also include page and nearby context.",
  disclosureData:
    "A selected reference can include the page URL and title, element structure, accessibility facts, labels, styles, bounds, locator evidence, selected and nearby text, and your task notes.",
  disclosureLocal:
    "Captures and session state stay in this browser profile. Copies leave only when you choose to copy, export, or connect the optional local agent bridge.",
  disclosureRedaction:
    "Agent-safe is the default and tries to redact likely sensitive text, but no mode guarantees that all sensitive information is removed.",
  disclosureReceiver:
    "Copy for agent writes to your system clipboard. While the optional local agent bridge is connected, Agent-safe context refreshes over that local connection.",
  disclosureFirstTrial:
    "For your first trial, use a non-sensitive, unauthenticated HTTP(S) page.",
  disclosureAcknowledge: "I understand — continue to Add elements",
  disclosureAcknowledging: "Saving acknowledgement…",
  widgetDisconnected: "MeanThis page tools disconnected. Open MeanThis again.",
  reconnecting: "MeanThis page tools are reconnecting…",
  taskNoteSaveFailed: "Task note was not saved.",
  taskNoteSaved: "Task note saved.",
  copySucceeded: (count) => `Copied ${count} elements for agent.`,
  copyFailed: "Copy failed. Select the text shown below to copy it manually.",
  operationFailed: "MeanThis action failed.",
  sessionNotReady: "The current page session is not ready yet.",
  disclosureLoadFailed: "MeanThis could not check the capture disclosure. Try again.",
  disclosureAcknowledgeFailed: "MeanThis could not save your acknowledgement. Try again.",
  shortcutBelow: "Place below",
  shortcutBelowNote: (label) => `Place ${label} below the reference element.`,
  bridgeControlsLabel: "Local agent connection",
  bridgeUnavailableHelp: "The local agent bridge is unavailable.",
  bridgeDisconnectedHelp: "Create a short-lived invitation for a local agent.",
  bridgePendingHelp: (remainingSeconds) => remainingSeconds === null
    ? "Copy this invitation into the local agent, then refresh the connection."
    : `Waiting for the agent to accept · Expires in ${formatBridgeCountdown(remainingSeconds)}`,
  bridgeConnectedHelp: "Agent-safe page context is available to the connected local agent.",
  bridgeConnectedTargets: (count) => `The connected local agent can read ${count} selected elements.`,
  bridgeReadAcknowledgementWaiting:
    "Waiting for the Agent client to retrieve the current share.",
  bridgeReadAcknowledgementCurrent:
    "The Agent client confirmed retrieval of the current share.",
  bridgeReadAcknowledgementUnavailable:
    "Unable to confirm whether the Agent client retrieved the current share.",
  bridgeReadAcknowledgementLimitations:
    "This does not mean the Agent understood or executed it.",
  createInvitation: "Create connection invitation",
  creatingInvitation: "Creating invitation…",
  invitationLabel: "Local agent connection invitation",
  copyInvitation: "Copy invitation",
  invitationCopied: "Invitation copied. Paste it into the local agent so it can accept the connection.",
  invitationExpired: "Connection invitation expired. Create a new invitation.",
  refreshConnection: "Refresh",
  refreshingConnection: "Refreshing…",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
};

export function createInPageWidgetStrings(
  translate: InPageWidgetTranslate,
): InPageWidgetStrings {
  const t = (
    key: string,
    fallback: string,
    values: Record<string, string | number> = {},
  ): string => {
    try {
      const localized = translate(key, values).trim();
      return localized && localized !== key
        ? fillNamedValues(localized, values)
        : fillNamedValues(fallback, values);
    } catch {
      return fillNamedValues(fallback, values);
    }
  };

  return {
    brand: "MeanThis",
    regionLabel: t("in_page_widget_region_label", DEFAULT_IN_PAGE_WIDGET_STRINGS.regionLabel),
    selectionToolbarLabel: t(
      "in_page_widget_selection_toolbar_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.selectionToolbarLabel,
    ),
    selectedTargetsLabel: t(
      "in_page_widget_selected_targets_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.selectedTargetsLabel,
    ),
    openLabel: (count, state) => t(
      "in_page_widget_open_label",
      "Open MeanThis, {count} selected, {state}",
      { count, state },
    ),
    closeWidget: t("in_page_widget_close", DEFAULT_IN_PAGE_WIDGET_STRINGS.closeWidget),
    copyForAgent: t(
      "in_page_widget_copy_for_agent",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.copyForAgent,
    ),
    clearAll: t("in_page_widget_clear_all", DEFAULT_IN_PAGE_WIDGET_STRINGS.clearAll),
    clearConfirm: t(
      "in_page_widget_clear_confirm",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.clearConfirm,
    ),
    retryClear: t(
      "in_page_widget_retry_clear",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.retryClear,
    ),
    clearPending: t(
      "in_page_widget_clear_pending",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.clearPending,
    ),
    openSettings: t(
      "in_page_widget_open_settings",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.openSettings,
    ),
    openFullSidePanel: t(
      "in_page_widget_open_full_side_panel",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.openFullSidePanel,
    ),
    openingFullSidePanel: t(
      "in_page_widget_opening_full_side_panel",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.openingFullSidePanel,
    ),
    fullSidePanelOpened: t(
      "in_page_widget_full_side_panel_opened",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.fullSidePanelOpened,
    ),
    fullSidePanelOpenFailed: t(
      "in_page_widget_full_side_panel_open_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.fullSidePanelOpenFailed,
    ),
    referenceScopeLabel: t(
      "in_page_widget_reference_scope_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.referenceScopeLabel,
    ),
    currentPageScope: (count) => t(
      "in_page_widget_current_page_scope",
      "Current page · {count}",
      { count },
    ),
    entireSiteScope: (site, count) => t(
      "in_page_widget_entire_site_scope",
      "Entire {site} site · {count}",
      { site, count },
    ),
    otherPagesCount: (count) => t(
      "in_page_widget_other_pages_count",
      "{count} on other pages",
      { count },
    ),
    clearCurrentPage: t(
      "in_page_widget_clear_current_page",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.clearCurrentPage,
    ),
    clearEntireSite: (site) => t(
      "in_page_widget_clear_entire_site",
      "Clear references from the entire {site} site",
      { site },
    ),
    clearCurrentPageConfirm: t(
      "in_page_widget_clear_current_page_confirm",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.clearCurrentPageConfirm,
    ),
    clearEntireSiteConfirm: (site) => t(
      "in_page_widget_clear_entire_site_confirm",
      "Select Clear again to remove references from the entire {site} site.",
      { site },
    ),
    outputDetailLabel: t(
      "in_page_widget_output_detail_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLabel,
    ),
    outputDetailHelp: t(
      "in_page_widget_output_detail_help",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailHelp,
    ),
    outputDetailLevels: {
      compact: t(
        "in_page_widget_output_detail_compact",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLevels.compact,
      ),
      standard: t(
        "in_page_widget_output_detail_standard",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLevels.standard,
      ),
      detailed: t(
        "in_page_widget_output_detail_detailed",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLevels.detailed,
      ),
      forensic: t(
        "in_page_widget_output_detail_forensic",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLevels.forensic,
      ),
    },
    collectBasicDiagnosticsLabel: t(
      "in_page_widget_collect_basic_diagnostics_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.collectBasicDiagnosticsLabel,
    ),
    collectBasicDiagnosticsHelp: t(
      "in_page_widget_collect_basic_diagnostics_help",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.collectBasicDiagnosticsHelp,
    ),
    privateDebugSummaryReady: t(
      "in_page_widget_private_debug_summary_ready",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryReady,
    ),
    privateDebugSummaryNotCopied: t(
      "in_page_widget_private_debug_summary_not_copied",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryNotCopied,
    ),
    privateDebugSummaryReplay: (verifiedCount, ambiguousCount, missingCount) => t(
      "in_page_widget_private_debug_summary_replay",
      "{verifiedCount} verified · {ambiguousCount} ambiguous · {missingCount} missing",
      { verifiedCount, ambiguousCount, missingCount },
    ),
    privateDebugSummaryReplayUnavailable: t(
      "in_page_widget_private_debug_summary_replay_unavailable",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryReplayUnavailable,
    ),
    privateDebugSummaryDevice: (deviceClass, viewportClass, touch) => t(
      "in_page_widget_private_debug_summary_device",
      "{deviceClass} · {viewportClass} viewport · {touch}",
      {
        deviceClass: t(
          `in_page_widget_private_debug_summary_device_${deviceClass}`,
          titleCase(deviceClass),
        ),
        viewportClass: t(
          `in_page_widget_private_debug_summary_viewport_${viewportClass}`,
          titleCase(viewportClass),
        ),
        touch: t(
          `in_page_widget_private_debug_summary_touch_${touch}`,
          formatTouchClass(touch),
        ),
      },
    ),
    privateDebugSummaryDeviceUnavailable: t(
      "in_page_widget_private_debug_summary_device_unavailable",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryDeviceUnavailable,
    ),
    copyPrivateDebugSummary: t(
      "in_page_widget_copy_private_debug_summary",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.copyPrivateDebugSummary,
    ),
    copyingPrivateDebugSummary: t(
      "in_page_widget_copying_private_debug_summary",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.copyingPrivateDebugSummary,
    ),
    privateDebugSummaryCopied: t(
      "in_page_widget_private_debug_summary_copied",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryCopied,
    ),
    privateDebugSummaryCopyFailed: t(
      "in_page_widget_private_debug_summary_copy_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.privateDebugSummaryCopyFailed,
    ),
    annotationDisplayLabel: t(
      "in_page_widget_annotation_display_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.annotationDisplayLabel,
    ),
    annotationDisplayLevels: {
      full: t("in_page_widget_annotation_display_full", "Full"),
      hover: t("in_page_widget_annotation_display_hover", "Hover"),
      markers: t("in_page_widget_annotation_display_markers", "Markers"),
      hidden: t("in_page_widget_annotation_display_hidden", "Hidden"),
    },
    captureScope: t("capture_scope", DEFAULT_IN_PAGE_WIDGET_STRINGS.captureScope),
    topPage: t("top_page", DEFAULT_IN_PAGE_WIDGET_STRINGS.topPage),
    embeddedFrame: t("embedded_frame", DEFAULT_IN_PAGE_WIDGET_STRINGS.embeddedFrame),
    currentScope: t("current_scope", DEFAULT_IN_PAGE_WIDGET_STRINGS.currentScope),
    allScopesCount: (count) => t(
      "in_page_widget_all_scopes_count",
      "{count} across scopes",
      { count },
    ),
    captureScopeUnavailable: t(
      "capture_scope_unavailable",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.captureScopeUnavailable,
    ),
    stateLabels: {
      unavailable: t(
        "in_page_widget_bridge_unavailable",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.stateLabels.unavailable,
      ),
      disconnected: t(
        "in_page_widget_bridge_disconnected",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.stateLabels.disconnected,
      ),
      pending: t(
        "in_page_widget_bridge_pending",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.stateLabels.pending,
      ),
      connected: t(
        "in_page_widget_bridge_connected",
        DEFAULT_IN_PAGE_WIDGET_STRINGS.stateLabels.connected,
      ),
    },
    startSelecting: t("add_elements", DEFAULT_IN_PAGE_WIDGET_STRINGS.startSelecting),
    stopSelecting: t("stop_selecting", DEFAULT_IN_PAGE_WIDGET_STRINGS.stopSelecting),
    selectedCount: (count) => t(
      "in_page_widget_selected_count",
      "{count} selected",
      { count },
    ),
    noTargets: t("no_targets_page", DEFAULT_IN_PAGE_WIDGET_STRINGS.noTargets),
    activateTarget: (label, name) => t(
      "in_page_widget_open_target",
      "Open target {label}: {name}",
      { label, name },
    ),
    editorHeading: (label) => t(
      "in_page_widget_target_heading",
      "Target {label}",
      { label },
    ),
    editTarget: (label) => t(
      "in_page_widget_edit_target",
      "Edit target {label}",
      { label },
    ),
    removeTarget: (label) => t(
      "in_page_widget_remove_target",
      "Remove target {label}",
      { label },
    ),
    moreTarget: (label) => t(
      "in_page_widget_more_target",
      "More options for target {label}",
      { label },
    ),
    markResolved: t("in_page_widget_mark_resolved", DEFAULT_IN_PAGE_WIDGET_STRINGS.markResolved),
    reopen: t("in_page_widget_reopen", DEFAULT_IN_PAGE_WIDGET_STRINGS.reopen),
    resolved: t("in_page_widget_resolved", DEFAULT_IN_PAGE_WIDGET_STRINGS.resolved),
    annotationResolved: t(
      "in_page_widget_annotation_resolved",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.annotationResolved,
    ),
    annotationReopened: t(
      "in_page_widget_annotation_reopened",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.annotationReopened,
    ),
    annotationLifecycleUnconfirmed: t(
      "in_page_widget_annotation_lifecycle_unconfirmed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.annotationLifecycleUnconfirmed,
    ),
    markResolvedTarget: (label) => t(
      "in_page_widget_mark_annotation_resolved",
      "Mark annotation {label} resolved",
      { label },
    ),
    reopenTarget: (label) => t(
      "in_page_widget_reopen_annotation",
      "Reopen annotation {label}",
      { label },
    ),
    lifecycleControlProposalHeading: t(
      "in_page_widget_lifecycle_control_proposal",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.lifecycleControlProposalHeading,
    ),
    lifecycleControlProposalFingerprint: (fingerprint) => t(
      "in_page_widget_lifecycle_control_proposal_fingerprint",
      "Fingerprint: {fingerprint}",
      { fingerprint },
    ),
    lifecycleControlProposalTransition: (expectedState, nextState) => t(
      "in_page_widget_lifecycle_control_proposal_transition",
      "Transition: {expected} → {next}",
      { expected: expectedState, next: nextState },
    ),
    lifecycleControlProposalExpires: (expiresAt) => t(
      "in_page_widget_lifecycle_control_proposal_expires",
      "Expires: {expiresAt}",
      { expiresAt },
    ),
    approveLifecycleControlProposal: t(
      "in_page_widget_lifecycle_control_proposal_approve",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.approveLifecycleControlProposal,
    ),
    rejectLifecycleControlProposal: t(
      "in_page_widget_lifecycle_control_proposal_reject",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.rejectLifecycleControlProposal,
    ),
    closeEditor: (label) => t(
      "in_page_widget_close_editor",
      "Close task editor for target {label}",
      { label },
    ),
    edit: t("in_page_widget_edit", DEFAULT_IN_PAGE_WIDGET_STRINGS.edit),
    remove: t("remove", DEFAULT_IN_PAGE_WIDGET_STRINGS.remove),
    more: t("in_page_widget_more", DEFAULT_IN_PAGE_WIDGET_STRINGS.more),
    unnamedTarget: t("selected_element", DEFAULT_IN_PAGE_WIDGET_STRINGS.unnamedTarget),
    taskNote: t("task", DEFAULT_IN_PAGE_WIDGET_STRINGS.taskNote),
    taskNoteLabel: (label) => t(
      "in_page_widget_task_note_label",
      "Task note for target {label}",
      { label },
    ),
    taskNotePlaceholder: t("intent_placeholder", DEFAULT_IN_PAGE_WIDGET_STRINGS.taskNotePlaceholder),
    shortcuts: t("relationship", DEFAULT_IN_PAGE_WIDGET_STRINGS.shortcuts),
    save: t("in_page_widget_save", DEFAULT_IN_PAGE_WIDGET_STRINGS.save),
    saving: t("in_page_widget_saving", DEFAULT_IN_PAGE_WIDGET_STRINGS.saving),
    copy: t("copy_for_agent", DEFAULT_IN_PAGE_WIDGET_STRINGS.copy),
    copying: t("in_page_widget_copying", DEFAULT_IN_PAGE_WIDGET_STRINGS.copying),
    disclosureHeading: t(
      "first_capture_disclosure_heading",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureHeading,
    ),
    disclosureIntro: t(
      "first_capture_disclosure_intro",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureIntro,
    ),
    disclosureData: t(
      "first_capture_disclosure_data",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureData,
    ),
    disclosureLocal: t(
      "first_capture_disclosure_local",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureLocal,
    ),
    disclosureRedaction: t(
      "first_capture_disclosure_redaction",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureRedaction,
    ),
    disclosureReceiver: t(
      "first_capture_disclosure_receiver",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureReceiver,
    ),
    disclosureFirstTrial: t(
      "first_capture_disclosure_first_trial",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureFirstTrial,
    ),
    disclosureAcknowledge: t(
      "acknowledge_and_return",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureAcknowledge,
    ),
    disclosureAcknowledging: t(
      "in_page_widget_disclosure_acknowledging",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureAcknowledging,
    ),
    widgetDisconnected: t(
      "in_page_widget_disconnected",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.widgetDisconnected,
    ),
    reconnecting: t(
      "in_page_widget_reconnecting",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.reconnecting,
    ),
    taskNoteSaveFailed: t(
      "in_page_widget_task_note_save_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.taskNoteSaveFailed,
    ),
    taskNoteSaved: t(
      "in_page_widget_task_note_saved",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.taskNoteSaved,
    ),
    copySucceeded: (count) => t(
      "in_page_widget_copy_succeeded",
      "Copied {count} elements for agent.",
      { count },
    ),
    copyFailed: t("in_page_widget_copy_failed", DEFAULT_IN_PAGE_WIDGET_STRINGS.copyFailed),
    operationFailed: t(
      "in_page_widget_operation_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.operationFailed,
    ),
    sessionNotReady: t(
      "in_page_widget_session_not_ready",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.sessionNotReady,
    ),
    disclosureLoadFailed: t(
      "in_page_widget_disclosure_load_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureLoadFailed,
    ),
    disclosureAcknowledgeFailed: t(
      "in_page_widget_disclosure_acknowledge_failed",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disclosureAcknowledgeFailed,
    ),
    shortcutBelow: t("in_page_widget_shortcut_below", DEFAULT_IN_PAGE_WIDGET_STRINGS.shortcutBelow),
    shortcutBelowNote: (label) => t(
      "in_page_widget_shortcut_below_note",
      "Place {label} below the reference element.",
      { label },
    ),
    bridgeControlsLabel: t(
      "in_page_widget_bridge_controls_label",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeControlsLabel,
    ),
    bridgeUnavailableHelp: t(
      "in_page_widget_bridge_unavailable_help",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeUnavailableHelp,
    ),
    bridgeDisconnectedHelp: t(
      "in_page_widget_bridge_disconnected_help",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeDisconnectedHelp,
    ),
    bridgePendingHelp: (remainingSeconds) => remainingSeconds === null
      ? t(
          "in_page_widget_bridge_pending_help",
          DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgePendingHelp(null),
        )
      : t(
          "in_page_widget_bridge_pending_countdown",
          "Waiting for the agent to accept · Expires in {remaining}",
          { remaining: formatBridgeCountdown(remainingSeconds) },
        ),
    bridgeConnectedHelp: t(
      "in_page_widget_bridge_connected_help",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeConnectedHelp,
    ),
    bridgeConnectedTargets: (count) => t(
      "connected_local_targets",
      "The connected local agent can read {count} selected elements.",
      { count },
    ),
    bridgeReadAcknowledgementWaiting: t(
      "local_bridge_read_ack_waiting",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeReadAcknowledgementWaiting,
    ),
    bridgeReadAcknowledgementCurrent: t(
      "local_bridge_read_ack_current",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeReadAcknowledgementCurrent,
    ),
    bridgeReadAcknowledgementUnavailable: t(
      "local_bridge_read_ack_unavailable",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeReadAcknowledgementUnavailable,
    ),
    bridgeReadAcknowledgementLimitations: t(
      "local_bridge_read_ack_limitations",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.bridgeReadAcknowledgementLimitations,
    ),
    createInvitation: t(
      "in_page_widget_create_invitation",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.createInvitation,
    ),
    creatingInvitation: t(
      "in_page_widget_creating_invitation",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.creatingInvitation,
    ),
    invitationLabel: t(
      "local_connection_request_aria",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.invitationLabel,
    ),
    copyInvitation: t(
      "in_page_widget_copy_invitation",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.copyInvitation,
    ),
    invitationCopied: t(
      "request_copied",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.invitationCopied,
    ),
    invitationExpired: t(
      "connection_invitation_expired",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.invitationExpired,
    ),
    refreshConnection: t(
      "in_page_widget_refresh_connection",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.refreshConnection,
    ),
    refreshingConnection: t(
      "in_page_widget_refreshing_connection",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.refreshingConnection,
    ),
    disconnect: t("disconnect", DEFAULT_IN_PAGE_WIDGET_STRINGS.disconnect),
    disconnecting: t(
      "in_page_widget_disconnecting",
      DEFAULT_IN_PAGE_WIDGET_STRINGS.disconnecting,
    ),
  };
}

export const IN_PAGE_WIDGET_CSS = `
.meanthis-widget-view {
  all: initial;
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  color-scheme: dark;
  color: #f6f7fb;
  font: 500 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-align: left;
  -webkit-font-smoothing: antialiased;
}

.meanthis-widget-view *,
.meanthis-widget-view *::before,
.meanthis-widget-view *::after {
  box-sizing: border-box;
}

.meanthis-widget-surface {
  width: 100%;
}

.meanthis-widget-surface[data-mode="collapsed"] {
  display: flex;
  justify-content: flex-end;
}

.meanthis-panel {
  display: block;
  overflow: hidden;
  width: 100%;
  padding: 0;
  border: 1px solid #303442;
  border-radius: 18px;
  background: #12141b;
  box-shadow: 0 18px 48px rgb(0 0 0 / 38%), 0 3px 10px rgb(0 0 0 / 24%);
}

.meanthis-panel[data-layout="workbar"] {
  width: max-content;
  max-width: 100%;
  height: 64px;
  border-color: #363944;
  border-radius: 999px;
  background: #15161b;
  box-shadow: none;
}

.meanthis-panel[data-layout="details"] {
  max-height: 560px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: thin;
}

.meanthis-panel[data-layout="scope"] {
  display: flex;
  width: min(360px, 100%);
  max-height: 344px;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.meanthis-panel[data-layout="scope"] .meanthis-workbar {
  flex: 0 0 auto;
  border: 1px solid #363944;
  border-radius: 999px;
  background: #15161b;
  box-shadow: 0 14px 34px rgb(0 0 0 / 38%), 0 2px 8px rgb(0 0 0 / 24%);
}

.meanthis-workbar {
  display: flex;
  width: max-content;
  max-width: 100%;
  min-width: 0;
  height: 62px;
  align-items: center;
  gap: 4px;
  padding: 7px 12px;
}

.meanthis-workbar-divider {
  flex: 0 0 auto;
  width: 1px;
  height: 26px;
  margin: 0 3px;
  background: #343742;
}

.meanthis-workbar-ending {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.meanthis-workbar-action {
  position: relative;
  display: inline-grid;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  padding: 0;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #d8dbe5;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.meanthis-workbar-action:hover {
  border-color: #3d414e;
  background: #242730;
  color: #fff;
}

.meanthis-workbar-action[aria-pressed="true"] {
  border-color: #776be0;
  background: #2b2748;
  color: #f4f2ff;
}

.meanthis-workbar-action[data-danger="true"]:hover {
  border-color: #78434a;
  background: #321d20;
  color: #ffb8be;
}

.meanthis-workbar-action[data-confirm="true"] {
  width: 40px;
  min-width: 40px;
  padding: 0;
  border-color: #9d4d56;
  background: #321d20;
  color: #ffd1d5;
  box-shadow: 0 0 0 2px rgb(157 77 86 / 32%);
}

.meanthis-workbar-action[data-confirm="true"]:hover {
  border-color: #c35d68;
  background: #472329;
  color: #fff;
}

.meanthis-workbar-action[data-confirm="true"] .meanthis-action-icon {
  width: 18px;
  height: 18px;
  opacity: 1;
}

.meanthis-workbar-action[data-busy="true"] .meanthis-action-icon {
  animation: meanthis-workbar-pulse 900ms ease-in-out infinite alternate;
}

.meanthis-action-icon {
  display: block;
  width: 21px;
  height: 21px;
  filter: brightness(0) invert(1);
  opacity: 0.86;
  pointer-events: none;
}

.meanthis-workbar-action:hover .meanthis-action-icon,
.meanthis-workbar-action[aria-pressed="true"] .meanthis-action-icon {
  opacity: 1;
}

.meanthis-workbar-count {
  position: absolute;
  top: 1px;
  right: 1px;
  display: inline-grid;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  place-items: center;
  border: 1px solid #15161b;
  border-radius: 999px;
  background: #8578ee;
  color: #101119;
  font-size: 9px;
  font-weight: 820;
  line-height: 1;
}

.meanthis-frame-scope-popover {
  display: grid;
  width: min(320px, 100%);
  max-height: 272px;
  overflow: hidden;
  border: 1px solid #363a48;
  border-radius: 15px;
  background: #151821;
  box-shadow: 0 16px 38px rgb(0 0 0 / 42%), 0 3px 10px rgb(0 0 0 / 24%);
}

.meanthis-frame-scope-heading {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #292d39;
  color: #f4f5fa;
}

.meanthis-frame-scope-heading > span {
  color: #9298a8;
  font-size: 10px;
  font-weight: 650;
}

.meanthis-frame-scope-tree {
  display: grid;
  max-height: 220px;
  gap: 3px;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px;
  scrollbar-width: thin;
}

.meanthis-frame-scope-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: #f0f2f8;
  text-align: left;
  cursor: pointer;
}

.meanthis-frame-scope-row:hover,
.meanthis-frame-scope-row[aria-current="true"] {
  border-color: #514a87;
  background: #27243e;
}

.meanthis-frame-scope-row[aria-current="true"] {
  box-shadow: inset 3px 0 #8b7cf5;
}

.meanthis-frame-scope-row:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.meanthis-frame-scope-kind {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 720;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meanthis-frame-scope-detail {
  min-width: 0;
  overflow: hidden;
  grid-column: 1;
  color: #9ca2b2;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meanthis-frame-scope-current {
  grid-column: 2;
  grid-row: 2;
  color: #bdb6ff;
  font-size: 9px;
  font-weight: 720;
  white-space: nowrap;
}

.meanthis-frame-scope-count {
  display: inline-grid;
  min-width: 20px;
  height: 20px;
  grid-column: 2;
  grid-row: 1;
  padding: 0 6px;
  place-items: center;
  border: 1px solid #4c5060;
  border-radius: 999px;
  background: #20232d;
  color: #d9dce7;
  font-size: 10px;
  font-weight: 760;
  line-height: 1;
}

@keyframes meanthis-workbar-pulse {
  from { opacity: 0.42; }
  to { opacity: 1; }
}

.meanthis-target-section {
  display: grid;
  gap: 9px;
  padding: 12px 14px 13px;
  border-bottom: 1px solid #272a35;
}

.meanthis-target-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #aeb3c1;
  font-size: 11px;
  font-weight: 680;
}

.meanthis-output-detail,
.meanthis-reference-scope {
  display: grid;
  gap: 5px;
  padding: 11px 14px 12px;
  border-bottom: 1px solid #272a35;
  background: #151721;
}

.meanthis-output-detail-field,
.meanthis-reference-scope-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.meanthis-output-detail-label,
.meanthis-reference-scope-label {
  color: #ececf4;
  font-size: 11px;
  font-weight: 720;
}

.meanthis-output-detail-select,
.meanthis-reference-scope-select {
  min-width: 128px;
  padding: 6px 28px 6px 9px;
  border: 1px solid #3b3f4d;
  border-radius: 8px;
  outline: 0;
  background: #1c1f28;
  color: #e6e7ee;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
}

.meanthis-output-detail-select:focus-visible,
.meanthis-reference-scope-select:focus-visible {
  outline: 2px solid #8d7ef4;
  outline-offset: 1px;
}

.meanthis-output-detail-help,
.meanthis-reference-scope-help {
  margin: 0;
  color: #8f95a5;
  font-size: 9px;
  line-height: 1.4;
}

.meanthis-basic-diagnostics {
  display: grid;
  gap: 5px;
  padding: 10px 14px 11px;
  border-bottom: 1px solid #272a35;
  background: #151721;
}

.meanthis-widget-view .meanthis-basic-diagnostics-field {
  display: flex !important;
  min-width: 0;
  align-items: center !important;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}

.meanthis-basic-diagnostics-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.meanthis-basic-diagnostics-label {
  color: #ececf4;
  font-size: 11px;
  font-weight: 720;
  line-height: 1.3;
}

.meanthis-basic-diagnostics-help {
  margin: 0;
  color: #8f95a5;
  font-size: 9px;
  line-height: 1.4;
}

.meanthis-private-debug-summary {
  display: grid;
  gap: 7px;
  margin-top: 5px;
  padding: 9px;
  border: 1px solid #3d4658;
  border-radius: 8px;
  background: #191d27;
}

.meanthis-private-debug-summary-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: #dfe7ff;
  font-size: 10px;
}

.meanthis-private-debug-summary-heading span {
  color: #7ed7a7;
  white-space: nowrap;
}

.meanthis-private-debug-summary-facts {
  display: grid;
  gap: 3px;
  color: #aeb5c5;
  font-size: 9px;
  line-height: 1.4;
}

.meanthis-private-debug-summary-copy {
  justify-self: start;
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input {
  appearance: none !important;
  -webkit-appearance: none !important;
  display: inline-grid !important;
  position: relative !important;
  width: 32px !important;
  min-width: 32px !important;
  max-width: 32px !important;
  height: 18px !important;
  min-height: 18px !important;
  max-height: 18px !important;
  margin: 0 !important;
  padding: 0 !important;
  flex: 0 0 32px !important;
  place-content: center !important;
  border: 1px solid #666c7c !important;
  border-radius: 999px !important;
  outline: 0;
  background: #1c1f28 !important;
  color: #8d7ef4;
  font: inherit;
  cursor: pointer;
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input::before {
  content: "";
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #aeb3c1;
  transform: translateX(-7px);
  transition: transform 120ms ease, background-color 120ms ease;
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input:checked {
  border-color: #8879f4 !important;
  background: #5649a6 !important;
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input:checked::before {
  background: #f8f7ff;
  transform: translateX(7px);
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input:focus-visible {
  outline: 2px solid #b0a6ff;
  outline-offset: 2px;
}

.meanthis-widget-view input.meanthis-basic-diagnostics-input:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.meanthis-annotation-display {
  display: grid;
  gap: 7px;
  padding: 10px 14px 11px;
  border-bottom: 1px solid #272a35;
  background: #151721;
}

.meanthis-annotation-display-label {
  color: #ececf4;
  font-size: 11px;
  font-weight: 720;
}

.meanthis-annotation-display-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}

.meanthis-widget-view .meanthis-annotation-display-option {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  min-width: 0 !important;
  padding: 4px 6px !important;
  color: #c7cad4;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}

.meanthis-widget-view input.meanthis-annotation-display-input {
  appearance: none !important;
  -webkit-appearance: none !important;
  display: inline-grid !important;
  position: static !important;
  width: 14px !important;
  min-width: 14px !important;
  max-width: 14px !important;
  height: 14px !important;
  min-height: 14px !important;
  max-height: 14px !important;
  margin: 0 !important;
  padding: 0 !important;
  flex: 0 0 14px !important;
  place-content: center !important;
  border: 1px solid #666c7c !important;
  border-radius: 50% !important;
  outline: 0;
  background: #1c1f28 !important;
  color: #8d7ef4;
  font: inherit;
  cursor: pointer;
}

.meanthis-widget-view input.meanthis-annotation-display-input::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  content: "";
  transform: scale(0);
  transition: transform 100ms ease;
}

.meanthis-widget-view input.meanthis-annotation-display-input:checked {
  border-color: currentColor !important;
}

.meanthis-widget-view input.meanthis-annotation-display-input:checked::before {
  transform: scale(1);
}

.meanthis-widget-view input.meanthis-annotation-display-input:focus-visible {
  outline: 2px solid #8d7ef4;
  outline-offset: 2px;
}

.meanthis-widget-view input.meanthis-annotation-display-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.meanthis-widget-view .meanthis-annotation-display-option:has(
  input.meanthis-annotation-display-input:disabled
) {
  cursor: not-allowed;
}

.meanthis-launcher,
.meanthis-button,
.meanthis-target-chip,
.meanthis-shortcut,
.meanthis-icon-button {
  appearance: none;
  border: 0;
  font: inherit;
  -webkit-tap-highlight-color: transparent;
}

.meanthis-launcher {
  position: relative;
  display: grid;
  width: 48px;
  height: 48px;
  padding: 8px;
  place-items: center;
  border: 1px solid #373b49;
  border-radius: 50%;
  background: #151821;
  color: #f8f8fc;
  box-shadow: 0 12px 34px rgb(0 0 0 / 34%);
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.meanthis-launcher:hover {
  border-color: #5a6072;
  background: #1b1e29;
  transform: translateY(-1px);
}

.meanthis-brand-mark {
  display: block;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  object-fit: contain;
}

.meanthis-launcher-copy {
  display: grid;
  gap: 1px;
  margin: 0 8px;
}

.meanthis-brand-name {
  color: #f7f7fb;
  font-size: 13px;
  font-weight: 720;
  letter-spacing: -0.01em;
}

.meanthis-connection {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #9da3b2;
  font-size: 10px;
  font-weight: 650;
}

.meanthis-connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #777d8d;
}

.meanthis-connection[data-state="connected"] .meanthis-connection-dot {
  background: #63d99a;
  box-shadow: 0 0 0 3px rgb(99 217 154 / 11%);
}

.meanthis-connection[data-state="pending"] .meanthis-connection-dot {
  background: #f2be62;
}

.meanthis-connection[data-state="disconnected"] .meanthis-connection-dot {
  background: #f17b82;
}

.meanthis-count {
  display: inline-grid;
  min-width: 25px;
  height: 25px;
  padding: 0 7px;
  place-items: center;
  border: 1px solid #454a5b;
  border-radius: 999px;
  background: #232632;
  color: #f7f7fb;
  font-size: 11px;
  font-weight: 750;
}

.meanthis-launcher .meanthis-count {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-color: #697185;
  background: #2b3040;
  font-size: 9px;
  box-shadow: 0 3px 10px rgb(0 0 0 / 34%);
}

.meanthis-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 14px 11px;
  border-bottom: 1px solid #272a35;
}

.meanthis-panel-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.meanthis-panel-identity .meanthis-brand-mark {
  width: 27px;
  height: 27px;
  border-radius: 9px;
  font-size: 13px;
}

.meanthis-panel-header-actions,
.meanthis-target-actions,
.meanthis-editor-actions,
.meanthis-editor-footer {
  display: flex;
  align-items: center;
  gap: 6px;
}

.meanthis-icon-button,
.meanthis-button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid #363a47;
  border-radius: 9px;
  background: #1c1f28;
  color: #d8dae3;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.meanthis-icon-button {
  min-width: 30px;
  padding: 0 8px;
}

.meanthis-icon-button:hover,
.meanthis-button:hover,
.meanthis-shortcut:hover,
.meanthis-target-chip:hover {
  border-color: #5a6072;
  background: #252936;
  color: #fff;
}

.meanthis-toolbar {
  display: grid;
  gap: 10px;
  padding: 12px 14px 13px;
  border-bottom: 1px solid #272a35;
}

.meanthis-disclosure {
  display: grid;
  gap: 10px;
  margin: 12px 14px 0;
  padding: 12px;
  border: 1px solid #4b456f;
  border-radius: 12px;
  background: #1b1930;
}

.meanthis-disclosure-title {
  margin: 0;
  color: #f7f5ff;
  font-size: 13px;
  font-weight: 760;
}

.meanthis-disclosure-copy {
  display: grid;
  max-height: 174px;
  gap: 7px;
  overflow-y: auto;
  padding-right: 4px;
  color: #c5c1db;
  font-size: 10px;
  line-height: 1.5;
  scrollbar-width: thin;
}

.meanthis-disclosure-copy p {
  margin: 0;
}

.meanthis-disclosure-trial {
  color: #eeeaff;
  font-weight: 680;
}

.meanthis-disclosure .meanthis-button-primary {
  width: 100%;
}

.meanthis-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.meanthis-button {
  padding: 0 11px;
  font-size: 12px;
  font-weight: 680;
}

.meanthis-button-primary {
  border-color: #8879f4;
  background: #8374ed;
  color: #101119;
}

.meanthis-button-primary:hover {
  border-color: #a99eff;
  background: #978aff;
  color: #090a0f;
}

.meanthis-button[data-selecting="true"] {
  border-color: #695fd1;
  background: #2a2746;
  color: #c9c3ff;
}

.meanthis-selected-count {
  color: #8f95a5;
  font-size: 11px;
}

.meanthis-bridge-controls {
  display: grid;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid #272a35;
  background: #151721;
}

.meanthis-full-panel-access {
  display: grid;
  padding: 11px 14px 12px;
  border-bottom: 1px solid #272a35;
  background: #151721;
}

.meanthis-full-panel-access .meanthis-button {
  width: 100%;
}

.meanthis-bridge-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #ececf4;
  font-size: 11px;
  font-weight: 720;
}

.meanthis-bridge-help {
  margin: 0;
  color: #9298a8;
  font-size: 10px;
  line-height: 1.45;
}

.meanthis-bridge-read-acknowledgement,
.meanthis-bridge-read-acknowledgement-limitations {
  margin: 4px 0 0;
  color: #aeb3c1;
  font-size: 10px;
  line-height: 1.45;
}

.meanthis-bridge-read-acknowledgement-limitations {
  color: #858b9b;
}

.meanthis-invitation {
  display: block;
  width: 100%;
  min-height: 58px;
  max-height: 110px;
  resize: vertical;
  padding: 8px 9px;
  border: 1px solid #373b48;
  border-radius: 9px;
  outline: 0;
  background: #0d0f15;
  color: #d9dbe5;
  font: 500 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
}

.meanthis-bridge-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.meanthis-target-list {
  display: flex;
  min-width: 0;
  gap: 6px;
  overflow-x: auto;
  padding: 1px 1px 3px;
  scrollbar-width: thin;
}

.meanthis-target-item {
  display: block;
  flex: 0 0 auto;
}

.meanthis-target-chip {
  display: flex;
  max-width: 150px;
  height: 32px;
  align-items: center;
  gap: 7px;
  padding: 0 9px 0 6px;
  border: 1px solid #363a47;
  border-radius: 999px;
  background: #1a1d26;
  color: #c7cad4;
  cursor: pointer;
}

.meanthis-target-chip[aria-pressed="true"] {
  border-color: #776be0;
  background: #282442;
  color: #f4f2ff;
}

.meanthis-target-label {
  display: inline-grid;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  place-items: center;
  border-radius: 999px;
  background: #343847;
  color: #fff;
  font-size: 10px;
  font-weight: 800;
}

.meanthis-target-chip[aria-pressed="true"] .meanthis-target-label {
  background: #8e80f4;
  color: #11121a;
}

.meanthis-target-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.meanthis-target-state {
  display: block;
  margin-top: 3px;
  color: #b7aeff;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
}

.meanthis-lifecycle-control-proposal {
  display: grid;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid #514d7c;
  border-radius: 10px;
  background: #17182a;
}

.meanthis-lifecycle-control-proposal-heading {
  color: #f0efff;
  font-size: 11px;
  font-weight: 750;
}

.meanthis-lifecycle-control-proposal-detail {
  overflow: hidden;
  color: #bcb9d9;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meanthis-lifecycle-control-proposal-fingerprint {
  color: #9f9abf;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.meanthis-lifecycle-control-proposal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.meanthis-lifecycle-control-proposal-actions .meanthis-button {
  min-height: 27px;
  padding: 0 9px;
  font-size: 10px;
}

.meanthis-empty {
  margin: 0;
  color: #858b9a;
  font-size: 11px;
}

.meanthis-editor {
  display: grid;
  gap: 12px;
  padding: 13px 14px 14px;
}

.meanthis-editor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.meanthis-editor-title {
  display: grid;
  min-width: 0;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: #f5f5fa;
  font-size: 13px;
}

.meanthis-editor-name {
  overflow: hidden;
  color: #aeb2c0;
  font-size: 11px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meanthis-editor-actions .meanthis-icon-button {
  min-width: auto;
  min-height: 27px;
  padding: 0 7px;
  font-size: 10px;
}

.meanthis-editor-actions .meanthis-close-editor {
  min-width: 27px;
  font-size: 16px;
  line-height: 1;
}

.meanthis-field {
  display: grid;
  gap: 6px;
  color: #c9ccd6;
  font-size: 11px;
  font-weight: 650;
}

.meanthis-task-note {
  display: block;
  width: 100%;
  min-height: 82px;
  max-height: 180px;
  resize: vertical;
  padding: 9px 10px;
  border: 1px solid #383c49;
  border-radius: 10px;
  outline: 0;
  background: #0d0f15;
  color: #f0f1f6;
  caret-color: #a99eff;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.48;
}

.meanthis-task-note::placeholder {
  color: #727887;
}

.meanthis-shortcuts-wrap {
  display: grid;
  gap: 6px;
}

.meanthis-shortcuts-label {
  color: #818797;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.meanthis-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.meanthis-shortcut {
  min-height: 27px;
  padding: 0 9px;
  border: 1px solid #333744;
  border-radius: 999px;
  background: #191c25;
  color: #b8bbc7;
  cursor: pointer;
  font-size: 10px;
  font-weight: 620;
}

.meanthis-editor-footer {
  justify-content: flex-end;
}

.meanthis-status {
  margin: 0 14px 13px;
  padding: 8px 10px;
  border: 1px solid #343846;
  border-radius: 9px;
  background: #1a1d26;
  color: #bbc0cc;
  font-size: 11px;
}

.meanthis-status[data-kind="success"] {
  border-color: #315f4a;
  background: #17271f;
  color: #8be0b3;
}

.meanthis-status[data-kind="error"] {
  border-color: #713f45;
  background: #2a191c;
  color: #ffabb1;
}

.meanthis-widget-view button:not(.meanthis-workbar-action):focus-visible,
.meanthis-widget-view textarea:focus-visible {
  outline: 2px solid #b0a6ff;
  outline-offset: 2px;
}

.meanthis-workbar-action:focus-visible {
  outline: none;
}

.meanthis-workbar-action:focus-visible::after {
  content: "";
  position: absolute;
  bottom: 3px;
  left: 50%;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: #b0a6ff;
  transform: translateX(-50%);
}

.meanthis-widget-view button:disabled:not([data-busy="true"]),
.meanthis-widget-view textarea:disabled:not([data-busy="true"]) {
  cursor: not-allowed;
  opacity: 0.58;
}

.meanthis-widget-view button:disabled[data-busy="true"],
.meanthis-widget-view textarea:disabled[data-busy="true"] {
  cursor: progress;
  opacity: 0.58;
}

.meanthis-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 380px) {
  .meanthis-widget-view {
    width: 100%;
  }

  .meanthis-panel {
    border-radius: 14px;
  }

  .meanthis-workbar {
    gap: 1px;
    padding: 6px;
  }

  .meanthis-workbar-action {
    width: 36px;
    height: 36px;
  }

  .meanthis-panel-header,
  .meanthis-disclosure,
  .meanthis-toolbar,
  .meanthis-full-panel-access,
  .meanthis-bridge-controls,
  .meanthis-editor {
    padding-right: 11px;
    padding-left: 11px;
  }

  .meanthis-editor-header {
    display: grid;
  }

  .meanthis-editor-actions {
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .meanthis-widget-view *,
  .meanthis-widget-view *::before,
  .meanthis-widget-view *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}

@media (forced-colors: active) {
  .meanthis-widget-view,
  .meanthis-panel,
  .meanthis-launcher,
  .meanthis-button,
  .meanthis-icon-button,
  .meanthis-workbar-action,
  .meanthis-frame-scope-popover,
  .meanthis-frame-scope-row,
  .meanthis-output-detail-select,
  .meanthis-basic-diagnostics,
  .meanthis-basic-diagnostics-input,
  .meanthis-target-chip,
  .meanthis-shortcut,
  .meanthis-task-note,
  .meanthis-invitation,
  .meanthis-disclosure,
  .meanthis-status {
    border-color: CanvasText;
    background: Canvas;
    color: CanvasText;
    forced-color-adjust: auto;
  }

  .meanthis-action-icon {
    filter: none;
    opacity: 1;
  }

  .meanthis-workbar-action:focus-visible::after {
    background: Highlight;
  }

  .meanthis-brand-mark,
  .meanthis-target-label,
  .meanthis-connection-dot {
    border: 1px solid CanvasText;
    background: ButtonFace;
    color: ButtonText;
    box-shadow: none;
  }

  .meanthis-target-chip[aria-pressed="true"],
  .meanthis-button[data-selecting="true"] {
    outline: 2px solid Highlight;
    outline-offset: 1px;
  }
}
`;

type WidgetAction =
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "toggle-selection" }
  | { kind: "toggle-frame-scopes" }
  | { kind: "select-frame-scope"; scopeId: string }
  | { kind: "clear" }
  | { kind: "open-settings" }
  | { kind: "open-full-panel" }
  | { kind: "reference-scope" }
  | { kind: "output-detail" }
  | { kind: "collect-basic-diagnostics" }
  | { kind: "copy-private-debug-summary" }
  | { kind: "display-mode" }
  | { kind: "acknowledge-disclosure" }
  | { kind: "create-invitation" }
  | { kind: "refresh-connection" }
  | { kind: "disconnect" }
  | { kind: "copy-invitation"; text: string }
  | { kind: "activate-target"; itemId: string }
  | { kind: "edit-target"; itemId: string }
  | { kind: "remove-target"; itemId: string }
  | { kind: "more-target"; itemId: string }
  | { kind: "set-annotation-lifecycle"; itemId: string; nextState: AnnotationLifecycleState }
  | { kind: "approve-lifecycle-control-proposal"; operationId: string; fingerprint: string }
  | { kind: "reject-lifecycle-control-proposal"; operationId: string; fingerprint: string }
  | { kind: "close-editor"; itemId: string }
  | { kind: "task-note"; itemId: string }
  | { kind: "apply-shortcut"; itemId: string; shortcutId: string; note: string }
  | { kind: "save"; itemId: string }
  | { kind: "copy" };

export function sanitizeInPageWidgetViewModel(
  input: InPageWidgetViewModel,
): InPageWidgetViewModel {
  const source: Record<string, unknown> = isRecord(input) ? input : {};
  const targets: InPageWidgetTargetViewModel[] = [];
  const targetIds = new Set<string>();
  const rawTargets = Array.isArray(source.targets) ? source.targets : [];
  for (const rawTarget of rawTargets.slice(0, MAX_TARGETS)) {
    if (!isRecord(rawTarget)) continue;
    const itemId = validateOpaqueId(rawTarget.itemId);
    if (!itemId || targetIds.has(itemId)) continue;
    targetIds.add(itemId);
    targets.push({
      itemId,
      label: sanitizeSingleLine(rawTarget.label, MAX_LABEL_LENGTH) || fallbackLabel(targets.length),
      name: sanitizeSingleLine(rawTarget.name, MAX_NAME_LENGTH),
      annotationLifecycle: sanitizeAnnotationLifecycle(rawTarget.annotationLifecycle),
    });
  }
  const lifecycleControlProposal = sanitizeLifecycleControlProposal(
    readOwnDataProperty(source, "lifecycleControlProposal"),
  );

  const rawActiveItemId = source.activeItemId === null
    ? null
    : validateOpaqueId(source.activeItemId);
  const activeItemId = rawActiveItemId && targetIds.has(rawActiveItemId)
    ? rawActiveItemId
    : null;

  const shortcuts: InPageWidgetShortcutViewModel[] = [];
  const shortcutIds = new Set<string>();
  const rawShortcuts = Array.isArray(source.shortcuts) ? source.shortcuts : [];
  for (const rawShortcut of rawShortcuts.slice(0, MAX_SHORTCUTS)) {
    if (!isRecord(rawShortcut)) continue;
    const id = validateOpaqueId(rawShortcut.id);
    const label = sanitizeSingleLine(rawShortcut.label, MAX_NAME_LENGTH);
    const note = sanitizeMultiline(rawShortcut.note);
    if (!id || shortcutIds.has(id) || !label || !note) continue;
    shortcutIds.add(id);
    shortcuts.push({ id, label, note });
  }

  const frameScopes: InPageWidgetFrameScopeViewModel[] = [];
  const frameScopeIds = new Set<string>();
  let currentFrameScopeSeen = false;
  const rawFrameScopes = Array.isArray(source.frameScopes) ? source.frameScopes : [];
  for (const rawScope of rawFrameScopes.slice(0, MAX_FRAME_SCOPES)) {
    if (!isRecord(rawScope)) continue;
    const id = validateOpaqueId(rawScope.id);
    const kind = rawScope.kind === "top" || rawScope.kind === "embedded"
      ? rawScope.kind
      : null;
    const depth = typeof rawScope.depth === "number" && Number.isInteger(rawScope.depth) &&
        rawScope.depth >= 0 && rawScope.depth <= MAX_FRAME_DEPTH
      ? rawScope.depth
      : null;
    if (!id || frameScopeIds.has(id) || !kind || depth === null) continue;
    const currentScope = rawScope.current === true && !currentFrameScopeSeen;
    if (currentScope) currentFrameScopeSeen = true;
    const itemCount = rawScope.itemCount === undefined
      ? undefined
      : rawScope.itemCount === null
        ? null
        : typeof rawScope.itemCount === "number" && Number.isSafeInteger(rawScope.itemCount) &&
            rawScope.itemCount >= 0 && rawScope.itemCount <= MAX_TARGETS
          ? rawScope.itemCount
          : null;
    frameScopeIds.add(id);
    frameScopes.push({
      id,
      kind,
      detail: sanitizeSingleLine(rawScope.detail, MAX_SCOPE_DETAIL_LENGTH),
      depth,
      current: currentScope,
      selectable: rawScope.selectable === true,
      ...(itemCount === undefined ? {} : { itemCount }),
    });
  }

  let mode = isMode(source.mode) ? source.mode : "collapsed";
  if (mode === "editing" && activeItemId === null) mode = "ready";
  const status = sanitizeStatus(source.status);
  const connectionRequestText = typeof source.connectionRequestText === "string"
    ? sanitizeMultiline(source.connectionRequestText) || null
    : null;
  const manualCopyText = typeof source.manualCopyText === "string"
    ? sanitizeMultiline(source.manualCopyText).slice(0, 65_536) || null
    : null;
  const collectBasicDiagnosticsForNextCapture =
    source.collectBasicDiagnosticsForNextCapture === true;
  const privateDebugSummaryValidation = validatePrivateDebugSummaryV1(
    readOwnDataProperty(source, "privateDebugSummary"),
  );
  const privateDebugSummary = privateDebugSummaryValidation.ok
    ? privateDebugSummaryValidation.value
    : null;
  const privateDebugSummaryCopied = privateDebugSummary !== null &&
    readOwnDataProperty(source, "privateDebugSummaryCopied") === true;
  const basicDiagnosticsCommandRevision = Number.isSafeInteger(
      source.basicDiagnosticsCommandRevision,
    ) && Number(source.basicDiagnosticsCommandRevision) >= 0
    ? Number(source.basicDiagnosticsCommandRevision)
    : 0;
  const referenceScope = source.referenceScope === "site" ? "site" : "page";
  const pageTargetCount = sanitizeReferenceCount(source.pageTargetCount, targets.length);
  const siteTargetCount = Math.max(
    pageTargetCount,
    sanitizeReferenceCount(source.siteTargetCount, targets.length),
  );
  const siteLabel = sanitizeSingleLine(source.siteLabel, MAX_NAME_LENGTH) || "site";
  const bridgeSharedTargetCount = Number.isSafeInteger(source.bridgeSharedTargetCount) &&
      Number(source.bridgeSharedTargetCount) >= 0 && Number(source.bridgeSharedTargetCount) <= MAX_TARGETS
    ? Number(source.bridgeSharedTargetCount)
    : null;
  const bridgeSharedSequence = Number.isSafeInteger(source.bridgeSharedSequence) &&
      Number(source.bridgeSharedSequence) >= 0
    ? Number(source.bridgeSharedSequence)
    : null;
  const bridgeReadAcknowledgementState = source.bridgeReadAcknowledgementState === "waiting" ||
      source.bridgeReadAcknowledgementState === "current" ||
      source.bridgeReadAcknowledgementState === "unavailable"
    ? source.bridgeReadAcknowledgementState
    : "unavailable";
  const bridgeInvitationRemainingSeconds =
    Number.isSafeInteger(source.bridgeInvitationRemainingSeconds) &&
      Number(source.bridgeInvitationRemainingSeconds) >= 0 &&
      Number(source.bridgeInvitationRemainingSeconds) <= 86_400
      ? Number(source.bridgeInvitationRemainingSeconds)
      : null;

  return {
    mode,
    readiness: source.readiness === "hydrating" || source.readiness === "error"
      ? source.readiness
      : "ready",
    bridgeState: isBridgeState(source.bridgeState) ? source.bridgeState : "unavailable",
    bridgeInvitationRemainingSeconds,
    bridgeSharedTargetCount,
    bridgeSharedSequence,
    bridgeReadAcknowledgementState,
    disclosureRequired: source.disclosureRequired === true,
    clearConfirmationRequired: source.clearConfirmationRequired === true,
    clearStatus: sanitizeClearStatus(source.clearStatus),
    connectionRequestText,
    manualCopyText,
    outputDetail: isAttachmentFeedbackDetail(source.outputDetail)
      ? source.outputDetail
      : "compact",
    displayMode: source.displayMode === "full" || source.displayMode === "markers" ||
        source.displayMode === "hidden" || source.displayMode === "hover"
      ? source.displayMode
      : "hover",
    collectBasicDiagnosticsForNextCapture,
    basicDiagnosticsCommandRevision,
    privateDebugSummary,
    privateDebugSummaryCopied,
    referenceScope,
    pageTargetCount,
    siteTargetCount,
    siteLabel,
    frameScopeOpen: source.readiness !== "hydrating" && source.frameScopeOpen === true &&
      frameScopes.length > 1,
    frameScopes,
    targets,
    lifecycleControlProposal,
    activeItemId,
    taskNote: sanitizeMultiline(source.taskNote),
    shortcuts,
    busyAction: isBusyAction(source.busyAction) ? source.busyAction : null,
    status,
  };
}

export function createInPageWidgetView(
  options: CreateInPageWidgetViewOptions,
): InPageWidgetView {
  const doc = options.document;
  const callbacks = options.callbacks ?? {};
  const resolveAssetUrl = options.resolveAssetUrl ?? ((assetName: string) => `./icons/${assetName}`);
  const strings: InPageWidgetStrings = {
    ...DEFAULT_IN_PAGE_WIDGET_STRINGS,
    ...options.strings,
    stateLabels: {
      ...DEFAULT_IN_PAGE_WIDGET_STRINGS.stateLabels,
      ...options.strings?.stateLabels,
    },
    outputDetailLevels: {
      ...DEFAULT_IN_PAGE_WIDGET_STRINGS.outputDetailLevels,
      ...options.strings?.outputDetailLevels,
    },
    annotationDisplayLevels: {
      ...DEFAULT_IN_PAGE_WIDGET_STRINGS.annotationDisplayLevels,
      ...options.strings?.annotationDisplayLevels,
    },
  };
  const element = doc.createElement("div");
  element.className = "meanthis-widget-view";
  element.dataset.meanthisWidgetView = "true";
  const style = doc.createElement("style");
  style.textContent = IN_PAGE_WIDGET_CSS;
  const surface = doc.createElement("div");
  surface.className = "meanthis-widget-surface";
  surface.dataset.meanthisWidgetSurface = "true";
  element.append(style, surface);

  let current = sanitizeInPageWidgetViewModel(options.initialModel ?? DEFAULT_MODEL);
  let actions = new WeakMap<Element, WidgetAction>();
  let compositionDepth = 0;
  let disposed = false;
  let pointerInside = false;
  let idleCollapseTimer: number | null = null;

  const cancelIdleCollapse = (): void => {
    if (idleCollapseTimer === null) return;
    doc.defaultView?.clearTimeout(idleCollapseTimer);
    idleCollapseTimer = null;
  };

  const canIdleCollapse = (): boolean => current.mode === "ready" &&
    current.busyAction === null &&
    !current.disclosureRequired &&
    !current.clearConfirmationRequired &&
    !current.frameScopeOpen &&
    current.manualCopyText === null &&
    current.status?.kind !== "error";

  const scheduleIdleCollapse = (): void => {
    cancelIdleCollapse();
    const view = doc.defaultView;
    if (!view || pointerInside || element.contains(doc.activeElement) || !canIdleCollapse()) return;
    idleCollapseTimer = view.setTimeout(() => {
      idleCollapseTimer = null;
      if (
        disposed || !element.isConnected || pointerInside ||
        element.contains(doc.activeElement) || !canIdleCollapse()
      ) return;
      callbacks.onCollapse?.();
    }, IDLE_COLLAPSE_DELAY_MS);
  };

  const onClick = (event: Event): void => {
    if (disposed) return;
    const actionElement = findActionElement(event, actions);
    if (!actionElement) return;
    if (actionElement.matches("button:disabled")) return;
    const action = actions.get(actionElement);
    if (!action) return;

    switch (action.kind) {
      case "expand":
        callbacks.onExpand?.();
        break;
      case "collapse":
        callbacks.onCollapse?.();
        break;
      case "toggle-selection":
        if (current.mode === "selecting") callbacks.onStopSelection?.();
        else callbacks.onStartSelection?.();
        break;
      case "toggle-frame-scopes":
        callbacks.onToggleFrameScopes?.();
        break;
      case "select-frame-scope":
        callbacks.onSelectFrameScope?.(action.scopeId);
        break;
      case "clear":
        callbacks.onClear?.();
        break;
      case "open-settings":
        callbacks.onOpenSettings?.();
        break;
      case "open-full-panel":
        callbacks.onOpenFullSidePanel?.({ isTrusted: event.isTrusted });
        break;
      case "reference-scope":
        break;
      case "output-detail":
        break;
      case "collect-basic-diagnostics":
        break;
      case "copy-private-debug-summary":
        callbacks.onCopyPrivateDebugSummary?.({ isTrusted: event.isTrusted });
        break;
      case "acknowledge-disclosure":
        callbacks.onAcknowledgeDisclosure?.();
        break;
      case "create-invitation":
        callbacks.onCreateInvitation?.();
        break;
      case "refresh-connection":
        callbacks.onRefreshConnection?.();
        break;
      case "disconnect":
        callbacks.onDisconnect?.();
        break;
      case "copy-invitation":
        callbacks.onCopyInvitation?.(action.text);
        break;
      case "activate-target":
        callbacks.onActivateTarget?.(action.itemId);
        break;
      case "edit-target":
        callbacks.onEditTarget?.(action.itemId);
        break;
      case "remove-target":
        callbacks.onRemoveTarget?.(action.itemId);
        break;
      case "more-target":
        callbacks.onMoreTarget?.(action.itemId);
        break;
      case "set-annotation-lifecycle":
        callbacks.onSetAnnotationLifecycle?.(action.itemId, action.nextState, {
          isTrusted: event.isTrusted,
        });
        break;
      case "approve-lifecycle-control-proposal":
        callbacks.onApproveLifecycleControlProposal?.(
          action.operationId,
          action.fingerprint,
          { isTrusted: event.isTrusted },
        );
        break;
      case "reject-lifecycle-control-proposal":
        callbacks.onRejectLifecycleControlProposal?.(
          action.operationId,
          action.fingerprint,
          { isTrusted: event.isTrusted },
        );
        break;
      case "close-editor":
        callbacks.onCloseEditor?.(action.itemId);
        break;
      case "apply-shortcut": {
        const note = sanitizeMultiline(action.note);
        const textarea = surface.querySelector<HTMLTextAreaElement>(".meanthis-task-note");
        if (textarea) textarea.value = note;
        current = { ...current, taskNote: note };
        callbacks.onApplyShortcut?.(action.itemId, action.shortcutId, note);
        callbacks.onTaskNoteChange?.(action.itemId, note);
        break;
      }
      case "save": {
        const textarea = surface.querySelector<HTMLTextAreaElement>(".meanthis-task-note");
        const note = sanitizeMultiline(textarea?.value ?? current.taskNote);
        if (textarea) textarea.value = note;
        current = { ...current, taskNote: note };
        callbacks.onSave?.(action.itemId, note);
        break;
      }
      case "copy":
        callbacks.onCopy?.();
        break;
      case "task-note":
        break;
    }
  };

  const onInput = (event: Event): void => {
    if (disposed || typeof event.target !== "object" || event.target === null) return;
    const textarea = event.target as HTMLTextAreaElement;
    if (textarea.localName !== "textarea") return;
    const action = actions.get(textarea);
    if (action?.kind !== "task-note") return;
    if (compositionDepth > 0 || (event as InputEvent).isComposing === true) return;
    const note = sanitizeMultiline(textarea.value);
    if (textarea.value !== note) textarea.value = note;
    current = { ...current, taskNote: note };
    callbacks.onTaskNoteChange?.(action.itemId, note);
  };

  const onChange = (event: Event): void => {
    if (disposed || typeof event.target !== "object" || event.target === null) return;
    const control = event.target as HTMLSelectElement | HTMLInputElement;
    const action = actions.get(control);
    if (action?.kind === "output-detail" && control.localName === "select" &&
        isAttachmentFeedbackDetail(control.value)) {
      current = { ...current, outputDetail: control.value };
      callbacks.onOutputDetailChange?.(control.value);
      return;
    }
    if (action?.kind === "collect-basic-diagnostics" && control.localName === "input") {
      const input = control as HTMLInputElement;
      if (input.type !== "checkbox") return;
      const enabled = input.checked === true;
      current = { ...current, collectBasicDiagnosticsForNextCapture: enabled };
      input.setAttribute("aria-checked", String(enabled));
      callbacks.onCollectBasicDiagnosticsChange?.(enabled);
      return;
    }
    if (action?.kind === "reference-scope" && control.localName === "select" &&
        (control.value === "page" || control.value === "site")) {
      current = { ...current, referenceScope: control.value };
      callbacks.onReferenceScopeChange?.(control.value);
      return;
    }
    const input = control as HTMLInputElement;
    if (action?.kind === "display-mode" && input.localName === "input" && input.checked &&
        (input.value === "full" || input.value === "hover" || input.value === "markers" ||
          input.value === "hidden")) {
      current = { ...current, displayMode: input.value };
      callbacks.onDisplayModeChange?.(input.value);
    }
  };

  const onCompositionStart = (): void => {
    compositionDepth += 1;
  };

  const onCompositionEnd = (): void => {
    compositionDepth = Math.max(0, compositionDepth - 1);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      disposed ||
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      compositionDepth > 0 ||
      current.mode === "collapsed"
    ) {
      return;
    }

    let handled = false;
    if (current.frameScopeOpen && callbacks.onCloseFrameScopes) {
      callbacks.onCloseFrameScopes();
      handled = true;
    } else if (current.mode === "editing" && current.activeItemId && callbacks.onCloseEditor) {
      callbacks.onCloseEditor(current.activeItemId);
      handled = true;
    } else if (
      current.mode === "details" && !current.disclosureRequired && callbacks.onOpenSettings
    ) {
      callbacks.onOpenSettings();
      handled = true;
    } else if (current.mode === "selecting" && callbacks.onStopSelection) {
      callbacks.onStopSelection();
      handled = true;
    } else if (callbacks.onCollapse) {
      callbacks.onCollapse();
      handled = true;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onPointerEnter = (): void => {
    pointerInside = true;
    cancelIdleCollapse();
  };

  const onPointerLeave = (): void => {
    pointerInside = false;
    scheduleIdleCollapse();
  };

  const onFocusIn = (): void => {
    cancelIdleCollapse();
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget && element.contains(event.relatedTarget as Node)) return;
    scheduleIdleCollapse();
  };

  element.addEventListener("click", onClick);
  element.addEventListener("input", onInput);
  element.addEventListener("change", onChange);
  element.addEventListener("compositionstart", onCompositionStart);
  element.addEventListener("compositionend", onCompositionEnd);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("pointerenter", onPointerEnter);
  element.addEventListener("pointerleave", onPointerLeave);
  element.addEventListener("focusin", onFocusIn);
  element.addEventListener("focusout", onFocusOut);
  render(false, null);

  return {
    element,
    update(model): void {
      if (disposed) return;
      const activeElement = doc.activeElement;
      const hadFocus = activeElement !== null && element.contains(activeElement);
      const focusKey = hadFocus
        ? activeElement?.getAttribute("data-meanthis-focus-key") ?? null
        : null;
      const previousMode = current.mode;
      const previousFrameScopeOpen = current.frameScopeOpen;
      current = sanitizeInPageWidgetViewModel(model);
      if (!canIdleCollapse()) cancelIdleCollapse();
      render(hadFocus, focusKey, previousMode, previousFrameScopeOpen);
      if (previousMode !== current.mode && canIdleCollapse()) scheduleIdleCollapse();
    },
    focus(): void {
      if (disposed) return;
      focusElement(current.disclosureRequired
        ? "acknowledge-disclosure"
        : preferredFocusKey(current.mode));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelIdleCollapse();
      element.removeEventListener("click", onClick);
      element.removeEventListener("input", onInput);
      element.removeEventListener("change", onChange);
      element.removeEventListener("compositionstart", onCompositionStart);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerenter", onPointerEnter);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      actions = new WeakMap<Element, WidgetAction>();
      element.remove();
      element.replaceChildren();
    },
  };

  function render(
    restoreFocus: boolean,
    previousFocusKey: string | null,
    previousMode: InPageWidgetMode = current.mode,
    previousFrameScopeOpen: boolean = current.frameScopeOpen,
  ): void {
    compositionDepth = 0;
    actions = new WeakMap<Element, WidgetAction>();
    surface.replaceChildren();
    surface.dataset.mode = current.mode;
    surface.setAttribute("aria-busy", current.busyAction === null ? "false" : "true");

    if (current.mode === "collapsed") {
      surface.removeAttribute("role");
      surface.removeAttribute("aria-label");
      surface.append(renderLauncher());
    } else {
      surface.setAttribute("role", "region");
      surface.setAttribute("aria-label", strings.regionLabel);
      surface.append(renderPanel());
    }

    if (!restoreFocus) return;
    if (previousFocusKey && focusElement(previousFocusKey)) return;
    if (!previousFrameScopeOpen && current.frameScopeOpen) {
      const currentIndex = current.frameScopes.findIndex((scope) => scope.current && scope.selectable);
      if (focusElement(`frame-scope-${Math.max(0, currentIndex)}`)) return;
    }
    if (previousFrameScopeOpen && !current.frameScopeOpen) {
      if (focusElement("frame-scope-toggle")) return;
    }
    if (current.disclosureRequired) {
      focusElement("acknowledge-disclosure");
      return;
    }
    if (previousMode === "collapsed" && current.mode !== "collapsed") {
      focusElement("selection-toggle");
      return;
    }
    focusElement(preferredFocusKey(current.mode));
  }

  function renderLauncher(): HTMLButtonElement {
    const state = strings.stateLabels[current.bridgeState];
    const launcher = makeButton("expand", "meanthis-launcher", {
      kind: "expand",
    });
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", strings.openLabel(current.targets.length, state));
    launcher.append(brandMark());
    if (current.targets.length > 0) {
      launcher.append(textElement("span", "meanthis-count", String(current.targets.length)));
    }
    setFocusKey(launcher, "launcher");
    return launcher;
  }

  function renderPanel(): HTMLElement {
    const panel = createElement("section", "meanthis-panel");
    const hydrated = current.readiness === "ready";
    panel.setAttribute("aria-busy", String(!hydrated));
    const detailed = current.disclosureRequired
      || current.mode === "details"
      || current.mode === "editing"
      || current.manualCopyText !== null
      || current.status?.kind === "error";
    const scopeOpen = current.frameScopeOpen && !detailed;
    panel.dataset.layout = scopeOpen ? "scope" : detailed ? "details" : "workbar";
    if (scopeOpen) panel.append(renderFrameScopePicker());
    panel.append(renderWorkbar(detailed));
    const clearPending = current.clearStatus?.clearState === "pending";
    if (clearPending) {
      const status = current.status?.kind === "info"
        ? current.status
        : { kind: "info" as const, message: strings.clearPending };
      panel.append(renderStatus(status, CLEAR_PENDING_STATUS_ID));
    }
    if (!detailed || scopeOpen) return panel;
    if (current.disclosureRequired) panel.append(renderDisclosure());
    panel.append(renderReferenceScope());
    panel.append(renderTargetSection());
    if (current.mode === "details" && !current.disclosureRequired) {
      panel.append(renderOutputDetail());
      panel.append(renderAnnotationDisplay());
      if (typeof callbacks.onCollectBasicDiagnosticsChange === "function") {
        panel.append(renderBasicDiagnosticsOption());
      }
      panel.append(renderFullSidePanelAccess());
      panel.append(renderBridgeControls());
    }
    const activeTarget = current.targets.find((target) => target.itemId === current.activeItemId);
    if (current.mode === "editing" && activeTarget) panel.append(renderEditor(activeTarget));
    if (current.manualCopyText) panel.append(renderManualCopy(current.manualCopyText));
    if (current.status && !clearPending) panel.append(renderStatus(current.status));
    return panel;
  }

  function totalFrameScopeTargetCount(): number | null {
    if (current.frameScopes.length === 0 ||
        current.frameScopes.some((scope) => typeof scope.itemCount !== "number")) return null;
    return current.frameScopes.reduce((total, scope) => total + (scope.itemCount ?? 0), 0);
  }

  function renderWorkbar(detailed: boolean): HTMLElement {
    const toolbar = createElement("div", "meanthis-workbar");
    const hydrated = current.readiness === "ready";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", strings.selectionToolbarLabel);

    const selecting = current.mode === "selecting";
    const toggleSelection = makeIconButton(
      "toggle-selection",
      { kind: "toggle-selection" },
      selecting ? strings.stopSelecting : strings.startSelecting,
      selecting ? "pause.svg" : "play.svg",
    );
    const changingSelection = current.busyAction === "selection";
    toggleSelection.disabled = !hydrated || current.disclosureRequired ||
      current.busyAction === "disclosure" || changingSelection;
    toggleSelection.dataset.busy = String(changingSelection);
    toggleSelection.setAttribute("aria-pressed", String(selecting));
    setFocusKey(toggleSelection, "selection-toggle");

    const currentFrameScope = current.frameScopes.find((scope) => scope.current) ?? null;
    const captureScope = makeIconButton(
      "capture-scope",
      { kind: "toggle-frame-scopes" },
      strings.captureScope,
      "rectangle-group.svg",
    );
    captureScope.disabled = !hydrated || current.frameScopes.length <= 1 ||
      current.busyAction === "frame-scope";
    captureScope.dataset.busy = String(current.busyAction === "frame-scope");
    captureScope.setAttribute("aria-haspopup", "tree");
    captureScope.setAttribute("aria-expanded", String(current.frameScopeOpen));
    captureScope.setAttribute("aria-pressed", String((currentFrameScope?.depth ?? 0) > 0));
    setFocusKey(captureScope, "frame-scope-toggle");

    const copy = makeIconButton(
      "copy",
      { kind: "copy" },
      strings.copyForAgent,
      "document-duplicate.svg",
    );
    copy.disabled = !hydrated || current.targets.length === 0 || current.busyAction === "copy";
    copy.dataset.busy = String(current.busyAction === "copy");
    if (current.targets.length > 0) {
      copy.append(textElement("span", "meanthis-workbar-count", String(current.targets.length)));
    }
    const copyLabel = `${strings.copyForAgent} · ${strings.selectedCount(current.targets.length)}`;
    copy.setAttribute("aria-label", copyLabel);
    copy.title = copyLabel;
    setFocusKey(copy, "copy");

    const clearPending = current.clearStatus?.clearState === "pending";
    const clearTargetCount = current.targets.length;
    const clearScopeLabel = current.referenceScope === "site"
      ? strings.clearEntireSite(current.siteLabel ?? "site")
      : strings.clearCurrentPage;
    const clear = makeIconButton(
      "clear",
      { kind: "clear" },
      clearPending
        ? strings.retryClear
        : `${clearScopeLabel} · ${strings.selectedCount(clearTargetCount)}`,
      "trash.svg",
    );
    clear.disabled = !hydrated || (!clearPending && clearTargetCount === 0) ||
      current.busyAction === "clear";
    clear.dataset.danger = "true";
    clear.dataset.busy = String(current.busyAction === "clear");
    if (clearPending) {
      clear.setAttribute("aria-describedby", CLEAR_PENDING_STATUS_ID);
    } else if (current.clearConfirmationRequired) {
      clear.dataset.confirm = "true";
      const confirmation = current.referenceScope === "site"
        ? strings.clearEntireSiteConfirm(current.siteLabel ?? "site")
        : strings.clearCurrentPageConfirm;
      clear.setAttribute("aria-label", confirmation);
      clear.title = confirmation;
    }
    setFocusKey(clear, "clear");

    const settings = makeIconButton(
      "open-settings",
      { kind: "open-settings" },
      strings.openSettings,
      "settings.svg",
    );
    settings.disabled = !hydrated || changingSelection;
    settings.dataset.busy = String(changingSelection);
    settings.setAttribute("aria-pressed", String(detailed));
    setFocusKey(settings, "settings");

    const collapse = makeIconButton(
      "collapse",
      { kind: "collapse" },
      strings.closeWidget,
      "x-mark.svg",
    );
    setFocusKey(collapse, "collapse");

    const ending = createElement("span", "meanthis-workbar-ending");
    ending.append(divider(), collapse);

    toolbar.append(toggleSelection);
    if (current.frameScopes.length > 1) toolbar.append(captureScope);
    toolbar.append(copy, clear, settings, ending);
    return toolbar;
  }

  function renderFrameScopePicker(): HTMLElement {
    const popover = createElement("section", "meanthis-frame-scope-popover");
    popover.setAttribute("aria-label", strings.captureScope);
    const heading = createElement("div", "meanthis-frame-scope-heading");
    const totalTargetCount = totalFrameScopeTargetCount();
    heading.append(
      textElement("strong", "", strings.captureScope),
      textElement(
        "span",
        "",
        totalTargetCount === null
          ? strings.currentScope
          : strings.allScopesCount(totalTargetCount),
      ),
    );
    const tree = createElement("div", "meanthis-frame-scope-tree");
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", strings.captureScope);
    current.frameScopes.forEach((scope, index) => {
      const row = makeButton(
        "select-frame-scope",
        "meanthis-frame-scope-row",
        { kind: "select-frame-scope", scopeId: scope.id },
      );
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(scope.depth + 1));
      if (scope.current) row.setAttribute("aria-current", "true");
      row.disabled = !scope.selectable || current.busyAction === "frame-scope";
      row.style.paddingInlineStart = `${9 + Math.min(scope.depth, 6) * 14}px`;
      if (!scope.selectable) row.title = strings.captureScopeUnavailable;
      row.append(
        textElement(
          "span",
          "meanthis-frame-scope-kind",
          scope.kind === "top" ? strings.topPage : strings.embeddedFrame,
        ),
        textElement("span", "meanthis-frame-scope-detail", scope.detail),
      );
      if (typeof scope.itemCount === "number") {
        row.append(textElement("span", "meanthis-frame-scope-count", String(scope.itemCount)));
      }
      if (scope.current) {
        row.append(textElement("span", "meanthis-frame-scope-current", strings.currentScope));
      }
      setFocusKey(row, `frame-scope-${index}`);
      tree.append(row);
    });
    popover.append(heading, tree);
    return popover;
  }

  function renderTargetSection(): HTMLElement {
    const section = createElement("section", "meanthis-target-section");
    const heading = createElement("div", "meanthis-target-section-heading");
    heading.append(
      textElement("span", "", strings.selectedTargetsLabel),
      textElement("span", "meanthis-selected-count", strings.selectedCount(current.targets.length)),
    );
    section.append(heading, renderTargetList());
    return section;
  }

  function renderReferenceScope(): HTMLElement {
    const section = createElement("section", "meanthis-reference-scope");
    const field = createElement("label", "meanthis-reference-scope-field");
    field.append(textElement("span", "meanthis-reference-scope-label", strings.referenceScopeLabel));
    const select = doc.createElement("select");
    select.className = "meanthis-reference-scope-select";
    select.dataset.meanthisAction = "reference-scope";
    select.setAttribute("aria-label", strings.referenceScopeLabel);
    const pageCount = current.pageTargetCount ?? current.targets.length;
    const siteCount = Math.max(pageCount, current.siteTargetCount ?? current.targets.length);
    const siteLabel = current.siteLabel ?? "site";
    const page = doc.createElement("option");
    page.value = "page";
    page.textContent = strings.currentPageScope(pageCount);
    const site = doc.createElement("option");
    site.value = "site";
    site.textContent = strings.entireSiteScope(siteLabel, siteCount);
    select.append(page, site);
    select.value = current.referenceScope ?? "page";
    actions.set(select, { kind: "reference-scope" });
    setFocusKey(select, "reference-scope");
    field.append(select);
    section.append(field);
    if ((current.referenceScope ?? "page") === "page" && siteCount > pageCount) {
      section.append(textElement(
        "p",
        "meanthis-reference-scope-help",
        strings.otherPagesCount(siteCount - pageCount),
      ));
    }
    return section;
  }

  function renderOutputDetail(): HTMLElement {
    const section = createElement("section", "meanthis-output-detail");
    const field = createElement("label", "meanthis-output-detail-field");
    field.append(textElement("span", "meanthis-output-detail-label", strings.outputDetailLabel));
    const select = doc.createElement("select");
    select.className = "meanthis-output-detail-select";
    select.dataset.meanthisAction = "output-detail";
    select.setAttribute("aria-label", strings.outputDetailLabel);
    const levels: readonly AttachmentFeedbackDetail[] = [
      "compact",
      "standard",
      "detailed",
      "forensic",
    ];
    for (const level of levels) {
      const option = doc.createElement("option");
      option.value = level;
      option.textContent = strings.outputDetailLevels[level];
      select.append(option);
    }
    select.value = current.outputDetail ?? "compact";
    actions.set(select, { kind: "output-detail" });
    setFocusKey(select, "output-detail");
    field.append(select);
    section.append(
      field,
      textElement("p", "meanthis-output-detail-help", strings.outputDetailHelp),
    );
    return section;
  }

  function renderAnnotationDisplay(): HTMLElement {
    const section = createElement("section", "meanthis-annotation-display");
    const group = createElement("div", "meanthis-annotation-display-options");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", strings.annotationDisplayLabel);
    section.append(textElement("span", "meanthis-annotation-display-label", strings.annotationDisplayLabel));
    const modes: readonly PersistentOverlayDisplayMode[] = ["full", "hover", "markers", "hidden"];
    for (const mode of modes) {
      const label = createElement("label", "meanthis-annotation-display-option");
      const input = doc.createElement("input");
      input.className = "meanthis-annotation-display-input";
      input.type = "radio";
      input.name = "meanthis-annotation-display";
      input.value = mode;
      input.checked = (current.displayMode ?? "hover") === mode;
      input.disabled = current.readiness !== "ready";
      input.setAttribute("role", "radio");
      input.setAttribute("aria-label", strings.annotationDisplayLevels[mode]);
      input.dataset.meanthisAction = "display-mode";
      actions.set(input, { kind: "display-mode" });
      setFocusKey(input, `display-mode-${mode}`);
      label.append(input, textElement("span", "", strings.annotationDisplayLevels[mode]));
      group.append(label);
    }
    section.append(group);
    return section;
  }

  function renderBasicDiagnosticsOption(): HTMLElement {
    const section = createElement("section", "meanthis-basic-diagnostics");
    const field = createElement("label", "meanthis-basic-diagnostics-field");
    const copy = createElement("div", "meanthis-basic-diagnostics-copy");
    const label = textElement(
      "span",
      "meanthis-basic-diagnostics-label",
      strings.collectBasicDiagnosticsLabel,
    );
    const help = textElement(
      "p",
      "meanthis-basic-diagnostics-help",
      strings.collectBasicDiagnosticsHelp,
    );
    help.id = "meanthis-basic-diagnostics-help";
    const input = doc.createElement("input");
    input.className = "meanthis-basic-diagnostics-input";
    input.type = "checkbox";
    input.checked = current.collectBasicDiagnosticsForNextCapture === true;
    input.disabled = current.readiness !== "ready" || current.busyAction === "diagnostics";
    input.dataset.busy = String(current.busyAction === "diagnostics");
    input.dataset.commandRevision = String(current.basicDiagnosticsCommandRevision ?? 0);
    input.setAttribute("role", "switch");
    input.setAttribute("aria-label", strings.collectBasicDiagnosticsLabel);
    input.setAttribute("aria-checked", String(input.checked));
    input.setAttribute("aria-describedby", help.id);
    input.dataset.meanthisAction = "collect-basic-diagnostics";
    actions.set(input, { kind: "collect-basic-diagnostics" });
    setFocusKey(input, "collect-basic-diagnostics");
    copy.append(label, help);
    field.append(copy, input);
    section.append(field);
    const summary = current.privateDebugSummary;
    if (summary && typeof callbacks.onCopyPrivateDebugSummary === "function") {
      const preview = createElement("div", "meanthis-private-debug-summary");
      const heading = createElement("div", "meanthis-private-debug-summary-heading");
      const copyState = current.privateDebugSummaryCopied === true ? "copied" : "not_copied";
      preview.dataset.copyState = copyState;
      heading.append(
        textElement("strong", "", strings.privateDebugSummaryReady),
        textElement(
          "span",
          "",
          copyState === "copied"
            ? strings.privateDebugSummaryCopied
            : strings.privateDebugSummaryNotCopied,
        ),
      );
      const replayText = summary.replay.status === "collected"
        ? strings.privateDebugSummaryReplay(
            summary.replay.verifiedCount,
            summary.replay.ambiguousCount,
            summary.replay.missingCount,
          )
        : strings.privateDebugSummaryReplayUnavailable;
      const deviceText = summary.device.status === "collected"
        ? strings.privateDebugSummaryDevice(
            summary.device.deviceClass,
            summary.device.viewportClass,
            summary.device.touch,
          )
        : strings.privateDebugSummaryDeviceUnavailable;
      const summaryFacts = createElement("div", "meanthis-private-debug-summary-facts");
      summaryFacts.append(
        textElement("span", "", replayText),
        textElement("span", "", deviceText),
      );
      const copying = current.busyAction === "diagnostics";
      const copySummary = makeButton(
        "copy-private-debug-summary",
        "meanthis-button meanthis-private-debug-summary-copy",
        { kind: "copy-private-debug-summary" },
        strings.copyPrivateDebugSummary,
        copying ? strings.copyingPrivateDebugSummary : strings.copyPrivateDebugSummary,
      );
      copySummary.disabled = current.readiness !== "ready" || copying;
      copySummary.dataset.busy = String(copying);
      setFocusKey(copySummary, "copy-private-debug-summary");
      preview.append(heading, summaryFacts, copySummary);
      section.append(preview);
    }
    return section;
  }

  function renderFullSidePanelAccess(): HTMLElement {
    const section = createElement("section", "meanthis-full-panel-access");
    const opening = current.busyAction === "side-panel";
    const button = makeButton(
      "open-full-panel",
      "meanthis-button",
      { kind: "open-full-panel" },
      undefined,
      opening ? strings.openingFullSidePanel : strings.openFullSidePanel,
    );
    button.disabled = current.readiness !== "ready" || opening;
    button.dataset.busy = String(opening);
    setFocusKey(button, "open-full-panel");
    section.append(button);
    return section;
  }

  function renderBridgeControls(): HTMLElement {
    const sharedTargetCount = current.bridgeSharedTargetCount ?? null;
    const sharedSequence = current.bridgeSharedSequence ?? null;
    const readAcknowledgementState = current.bridgeReadAcknowledgementState ?? "unavailable";
    const section = createElement("section", "meanthis-bridge-controls");
    section.dataset.sharedTargetCount = sharedTargetCount === null
      ? "unknown"
      : String(sharedTargetCount);
    section.dataset.sharedSequence = sharedSequence === null
      ? "unknown"
      : String(sharedSequence);
    section.dataset.readAcknowledgementState = readAcknowledgementState;
    section.setAttribute("aria-label", strings.bridgeControlsLabel);
    const heading = createElement("div", "meanthis-bridge-heading");
    heading.append(
      textElement("span", "", strings.bridgeControlsLabel),
      connection(current.bridgeState),
    );
    section.append(heading);

    const helpByState: Record<InPageWidgetBridgeState, string> = {
      unavailable: strings.bridgeUnavailableHelp,
      disconnected: strings.bridgeDisconnectedHelp,
      pending: strings.bridgePendingHelp(current.bridgeInvitationRemainingSeconds ?? null),
      connected: sharedTargetCount !== null && sharedTargetCount > 0
        ? strings.bridgeConnectedTargets(sharedTargetCount)
        : strings.bridgeConnectedHelp,
    };
    section.append(textElement("p", "meanthis-bridge-help", helpByState[current.bridgeState]));

    if (current.bridgeState === "connected" && sharedSequence !== null) {
      const acknowledgement = textElement(
        "p",
        "meanthis-bridge-read-acknowledgement",
        readAcknowledgementState === "current"
          ? strings.bridgeReadAcknowledgementCurrent
          : readAcknowledgementState === "waiting"
            ? strings.bridgeReadAcknowledgementWaiting
            : strings.bridgeReadAcknowledgementUnavailable,
      );
      acknowledgement.dataset.state = readAcknowledgementState;
      acknowledgement.dataset.readAcknowledgementState = readAcknowledgementState;
      acknowledgement.dataset.sharedSequence = String(sharedSequence);
      acknowledgement.dataset.meanthisBridgeReadAcknowledgement = "true";
      acknowledgement.setAttribute("role", "status");
      acknowledgement.setAttribute("aria-live", "polite");
      acknowledgement.setAttribute("aria-atomic", "true");
      const limitations = textElement(
        "p",
        "meanthis-bridge-read-acknowledgement-limitations",
        strings.bridgeReadAcknowledgementLimitations,
      );
      limitations.dataset.state = readAcknowledgementState;
      limitations.dataset.readAcknowledgementState = readAcknowledgementState;
      limitations.dataset.sharedSequence = String(sharedSequence);
      limitations.dataset.meanthisBridgeReadAcknowledgementLimitations = "true";
      section.append(acknowledgement, limitations);
    }

    if (current.bridgeState === "disconnected") {
      const create = makeButton(
        "create-invitation",
        "meanthis-button meanthis-button-primary",
        { kind: "create-invitation" },
        undefined,
        current.busyAction === "connect"
          ? strings.creatingInvitation
          : strings.createInvitation,
      );
      create.disabled = current.busyAction === "connect";
      setFocusKey(create, "create-invitation");
      section.append(create);
      return section;
    }

    if (current.bridgeState === "pending") {
      if (current.connectionRequestText) {
        const invitation = doc.createElement("textarea");
        invitation.className = "meanthis-invitation";
        invitation.readOnly = true;
        invitation.rows = 3;
        invitation.value = current.connectionRequestText;
        invitation.setAttribute("aria-label", strings.invitationLabel);
        invitation.autocomplete = "off";
        invitation.spellcheck = false;
        section.append(invitation);
      }
      const actionsWrap = createElement("div", "meanthis-bridge-actions");
      if (current.connectionRequestText) {
        const copy = makeButton(
          "copy-invitation",
          "meanthis-button",
          { kind: "copy-invitation", text: current.connectionRequestText },
          undefined,
          strings.copyInvitation,
        );
        setFocusKey(copy, "copy-invitation");
        actionsWrap.append(copy);
      }
      const refresh = makeButton(
        "refresh-connection",
        "meanthis-button",
        { kind: "refresh-connection" },
        undefined,
        current.busyAction === "refresh"
          ? strings.refreshingConnection
          : strings.refreshConnection,
      );
      refresh.disabled = current.busyAction === "refresh";
      setFocusKey(refresh, "refresh-connection");
      actionsWrap.append(refresh);
      section.append(actionsWrap);
      return section;
    }

    if (current.bridgeState === "connected") {
      const actionsWrap = createElement("div", "meanthis-bridge-actions");
      const refresh = makeButton(
        "refresh-connection",
        "meanthis-button",
        { kind: "refresh-connection" },
        undefined,
        current.busyAction === "refresh"
          ? strings.refreshingConnection
          : strings.refreshConnection,
      );
      refresh.disabled = current.busyAction === "refresh";
      const disconnect = makeButton(
        "disconnect",
        "meanthis-button",
        { kind: "disconnect" },
        undefined,
        current.busyAction === "disconnect"
          ? strings.disconnecting
          : strings.disconnect,
      );
      disconnect.disabled = current.busyAction === "disconnect";
      setFocusKey(refresh, "refresh-connection");
      setFocusKey(disconnect, "disconnect");
      actionsWrap.append(refresh, disconnect);
      section.append(actionsWrap);
    }
    return section;
  }

  function renderDisclosure(): HTMLElement {
    const disclosure = createElement("section", "meanthis-disclosure");
    disclosure.setAttribute("aria-labelledby", "meanthis-widget-disclosure-title");
    const title = textElement(
      "h2",
      "meanthis-disclosure-title",
      strings.disclosureHeading,
    );
    title.id = "meanthis-widget-disclosure-title";
    const copy = createElement("div", "meanthis-disclosure-copy");
    copy.append(
      textElement("p", "", strings.disclosureIntro),
      textElement("p", "", strings.disclosureData),
      textElement("p", "", strings.disclosureLocal),
      textElement("p", "", strings.disclosureRedaction),
      textElement("p", "", strings.disclosureReceiver),
      textElement("p", "meanthis-disclosure-trial", strings.disclosureFirstTrial),
    );
    const acknowledge = makeButton(
      "acknowledge-disclosure",
      "meanthis-button meanthis-button-primary",
      { kind: "acknowledge-disclosure" },
      undefined,
      current.busyAction === "disclosure"
        ? strings.disclosureAcknowledging
        : strings.disclosureAcknowledge,
    );
    acknowledge.disabled = current.readiness !== "ready" ||
      current.busyAction === "disclosure";
    setFocusKey(acknowledge, "acknowledge-disclosure");
    disclosure.append(title, copy, acknowledge);
    return disclosure;
  }

  function renderTargetList(): HTMLElement {
    const list = createElement("div", "meanthis-target-list");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", strings.selectedTargetsLabel);
    if (current.targets.length === 0) {
      list.setAttribute("role", "group");
      list.append(textElement("p", "meanthis-empty", strings.noTargets));
      return list;
    }
    current.targets.forEach((target, index) => {
      const targetName = target.name || strings.unnamedTarget;
      const item = createElement("div", "meanthis-target-item");
      item.setAttribute("role", "listitem");
      const chip = makeButton(
        "activate-target",
        "meanthis-target-chip",
        { kind: "activate-target", itemId: target.itemId },
        strings.activateTarget(target.label, targetName),
      );
      chip.setAttribute("aria-pressed", String(target.itemId === current.activeItemId));
      chip.disabled = current.readiness !== "ready";
      chip.append(
        textElement("span", "meanthis-target-label", target.label),
        textElement("span", "meanthis-target-name", targetName),
      );
      setFocusKey(chip, `target-${index}`);
      item.append(chip);
      if (target.annotationLifecycle?.state === "resolved") {
        const state = textElement("span", "meanthis-target-state", strings.resolved);
        state.dataset.state = "resolved";
        item.append(state);
      }
      list.append(item);
    });
    return list;
  }

  function renderEditor(target: InPageWidgetTargetViewModel): HTMLElement {
    const targetName = target.name || strings.unnamedTarget;
    const editor = createElement("article", "meanthis-editor");
    editor.setAttribute("aria-label", strings.editorHeading(target.label));
    const header = createElement("header", "meanthis-editor-header");
    const heading = createElement("h2", "meanthis-editor-title");
    heading.append(
      textElement("span", "meanthis-target-label", target.label),
      textElement("span", "meanthis-editor-name", targetName),
    );
    const targetActions = createElement("div", "meanthis-editor-actions");
    targetActions.setAttribute("role", "group");
    targetActions.setAttribute("aria-label", strings.editorHeading(target.label));
    const edit = makeButton(
      "edit-target",
      "meanthis-icon-button",
      { kind: "edit-target", itemId: target.itemId },
      strings.editTarget(target.label),
      strings.edit,
    );
    const remove = makeButton(
      "remove-target",
      "meanthis-icon-button",
      { kind: "remove-target", itemId: target.itemId },
      strings.removeTarget(target.label),
      strings.remove,
    );
    edit.disabled = current.readiness !== "ready";
    remove.disabled = current.readiness !== "ready" || current.busyAction === "remove";
    const more = makeButton(
      "more-target",
      "meanthis-icon-button",
      { kind: "more-target", itemId: target.itemId },
      strings.moreTarget(target.label),
      strings.more,
    );
    more.disabled = current.readiness !== "ready";
    const lifecycle = target.annotationLifecycle;
    if (lifecycle && typeof callbacks.onSetAnnotationLifecycle === "function") {
      const nextState: AnnotationLifecycleState = lifecycle.state === "resolved" ? "open" : "resolved";
      const lifecycleButton = makeButton(
        "set-annotation-lifecycle",
        "meanthis-icon-button meanthis-annotation-lifecycle",
        { kind: "set-annotation-lifecycle", itemId: target.itemId, nextState },
        nextState === "resolved"
          ? strings.markResolvedTarget(target.label)
          : strings.reopenTarget(target.label),
        nextState === "resolved" ? strings.markResolved : strings.reopen,
      );
      lifecycleButton.disabled = current.readiness !== "ready" || current.busyAction !== null;
      lifecycleButton.dataset.busy = String(current.busyAction === "lifecycle");
      setFocusKey(lifecycleButton, "set-annotation-lifecycle");
      targetActions.append(lifecycleButton);
    }
    const close = makeButton(
      "close-editor",
      "meanthis-icon-button meanthis-close-editor",
      { kind: "close-editor", itemId: target.itemId },
      strings.closeEditor(target.label),
    );
    close.append(iconElement("x-mark.svg"));
    setFocusKey(edit, "edit-target");
    setFocusKey(remove, "remove-target");
    setFocusKey(more, "more-target");
    setFocusKey(close, "close-editor");
    targetActions.append(edit, remove, more, close);
    header.append(heading, targetActions);
    editor.append(header);
    const proposal = current.lifecycleControlProposal;
    if (proposal && current.activeItemId === target.itemId && proposal.itemId === target.itemId) {
      editor.append(renderLifecycleControlProposal(proposal));
    }

    const field = createElement("label", "meanthis-field");
    field.append(textElement("span", "", strings.taskNote));
    const textarea = doc.createElement("textarea");
    textarea.className = "meanthis-task-note";
    textarea.rows = 4;
    textarea.maxLength = MAX_NOTE_LENGTH;
    textarea.placeholder = strings.taskNotePlaceholder;
    textarea.value = current.taskNote;
    textarea.setAttribute("aria-label", strings.taskNoteLabel(target.label));
    textarea.autocomplete = "off";
    textarea.spellcheck = true;
    textarea.disabled = current.readiness !== "ready" || current.busyAction === "save";
    textarea.dataset.meanthisAction = "task-note";
    actions.set(textarea, { kind: "task-note", itemId: target.itemId });
    setFocusKey(textarea, "task-note");
    field.append(textarea);

    editor.append(field);
    if (current.shortcuts.length > 0) editor.append(renderShortcuts(target.itemId));
    editor.append(renderFooter(target.itemId));
    return editor;
  }

  function renderLifecycleControlProposal(
    proposal: InPageWidgetLifecycleControlProposal,
  ): HTMLElement {
    const card = createElement("section", "meanthis-lifecycle-control-proposal");
    card.dataset.itemId = proposal.itemId;
    card.dataset.operationId = proposal.operationId;
    card.setAttribute("aria-label", strings.lifecycleControlProposalHeading);
    const fingerprint = textElement(
      "span",
      "meanthis-lifecycle-control-proposal-detail meanthis-lifecycle-control-proposal-fingerprint",
      strings.lifecycleControlProposalFingerprint(formatLifecycleProposalFingerprint(proposal.fingerprint)),
    );
    fingerprint.dataset.fingerprint = proposal.fingerprint;
    fingerprint.title = proposal.fingerprint;
    const transition = textElement(
      "span",
      "meanthis-lifecycle-control-proposal-detail",
      strings.lifecycleControlProposalTransition(proposal.expectedState, proposal.nextState),
    );
    const expires = textElement(
      "time",
      "meanthis-lifecycle-control-proposal-detail",
      strings.lifecycleControlProposalExpires(proposal.expiresAt),
    );
    expires.dateTime = proposal.expiresAt;

    const actionsWrap = createElement("div", "meanthis-lifecycle-control-proposal-actions");
    actionsWrap.setAttribute("role", "group");
    actionsWrap.setAttribute("aria-label", strings.lifecycleControlProposalHeading);
    const approve = makeButton(
      "approve-lifecycle-control-proposal",
      "meanthis-button meanthis-button-primary",
      {
        kind: "approve-lifecycle-control-proposal",
        operationId: proposal.operationId,
        fingerprint: proposal.fingerprint,
      },
      strings.approveLifecycleControlProposal,
      strings.approveLifecycleControlProposal,
    );
    approve.disabled = current.readiness !== "ready" || current.busyAction !== null;
    setFocusKey(approve, "approve-lifecycle-control-proposal");
    const reject = makeButton(
      "reject-lifecycle-control-proposal",
      "meanthis-button",
      {
        kind: "reject-lifecycle-control-proposal",
        operationId: proposal.operationId,
        fingerprint: proposal.fingerprint,
      },
      strings.rejectLifecycleControlProposal,
      strings.rejectLifecycleControlProposal,
    );
    reject.disabled = current.readiness !== "ready" || current.busyAction !== null;
    setFocusKey(reject, "reject-lifecycle-control-proposal");
    actionsWrap.append(approve, reject);
    card.append(
      textElement("strong", "meanthis-lifecycle-control-proposal-heading", strings.lifecycleControlProposalHeading),
      fingerprint,
      transition,
      expires,
      actionsWrap,
    );
    return card;
  }

  function renderShortcuts(itemId: string): HTMLElement {
    const wrap = createElement("div", "meanthis-shortcuts-wrap");
    wrap.append(textElement("span", "meanthis-shortcuts-label", strings.shortcuts));
    const shortcuts = createElement("div", "meanthis-shortcuts");
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", strings.shortcuts);
    current.shortcuts.forEach((shortcut, index) => {
      const button = makeButton(
        "apply-shortcut",
        "meanthis-shortcut",
        {
          kind: "apply-shortcut",
          itemId,
          shortcutId: shortcut.id,
          note: shortcut.note,
        },
        undefined,
        shortcut.label,
      );
      setFocusKey(button, `shortcut-${index}`);
      shortcuts.append(button);
    });
    wrap.append(shortcuts);
    return wrap;
  }

  function renderFooter(itemId: string): HTMLElement {
    const footer = createElement("footer", "meanthis-editor-footer");
    const copy = makeButton(
      "copy",
      "meanthis-button",
      { kind: "copy" },
      undefined,
      current.busyAction === "copy" ? strings.copying : strings.copy,
    );
    copy.disabled = current.readiness !== "ready" || current.busyAction === "copy";
    const save = makeButton(
      "save",
      "meanthis-button meanthis-button-primary",
      { kind: "save", itemId },
      undefined,
      current.busyAction === "save" ? strings.saving : strings.save,
    );
    save.disabled = current.readiness !== "ready" || current.busyAction === "save";
    setFocusKey(copy, "copy");
    setFocusKey(save, "save");
    footer.append(copy, save);
    return footer;
  }

  function renderStatus(
    status: InPageWidgetStatusViewModel,
    id?: string,
  ): HTMLElement {
    const message = textElement("p", "meanthis-status", status.message);
    if (id) message.id = id;
    message.dataset.kind = status.kind;
    message.setAttribute("role", status.kind === "error" ? "alert" : "status");
    message.setAttribute("aria-live", status.kind === "error" ? "assertive" : "polite");
    return message;
  }

  function renderManualCopy(text: string): HTMLElement {
    const textarea = doc.createElement("textarea");
    textarea.className = "meanthis-invitation";
    textarea.readOnly = true;
    textarea.value = text;
    textarea.rows = 5;
    textarea.setAttribute("aria-label", strings.copy);
    setFocusKey(textarea, "manual-copy");
    return textarea;
  }

  function brandMark(): HTMLImageElement {
    const mark = doc.createElement("img");
    mark.className = "meanthis-brand-mark";
    mark.src = resolveAssetUrl("meanthis-32.png");
    mark.alt = "";
    mark.width = 32;
    mark.height = 32;
    mark.decoding = "async";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function launcherCopy(state: string): HTMLElement {
    const copy = createElement("span", "meanthis-launcher-copy");
    copy.append(
      textElement("span", "meanthis-brand-name", strings.brand),
      connection(current.bridgeState, state),
    );
    return copy;
  }

  function connection(bridgeState: InPageWidgetBridgeState, label?: string): HTMLElement {
    const connectionState = createElement("span", "meanthis-connection");
    connectionState.dataset.state = bridgeState;
    const dot = createElement("span", "meanthis-connection-dot");
    dot.setAttribute("aria-hidden", "true");
    connectionState.append(dot, doc.createTextNode(label ?? strings.stateLabels[bridgeState]));
    return connectionState;
  }

  function makeButton(
    actionName: string,
    className: string,
    action: WidgetAction,
    accessibleName?: string,
    visibleText?: string,
  ): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.meanthisAction = actionName;
    if (accessibleName) button.setAttribute("aria-label", accessibleName);
    if (visibleText) button.textContent = visibleText;
    actions.set(button, action);
    return button;
  }

  function makeIconButton(
    actionName: string,
    action: WidgetAction,
    accessibleName: string,
    iconFile: string,
  ): HTMLButtonElement {
    const button = makeButton(
      actionName,
      "meanthis-workbar-action",
      action,
      accessibleName,
    );
    button.title = accessibleName;
    button.append(iconElement(iconFile));
    return button;
  }

  function iconElement(iconFile: string): HTMLImageElement {
    const icon = doc.createElement("img");
    icon.className = "meanthis-action-icon";
    icon.src = resolveAssetUrl(iconFile);
    icon.alt = "";
    icon.width = 24;
    icon.height = 24;
    icon.decoding = "async";
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function divider(): HTMLElement {
    const created = createElement("span", "meanthis-workbar-divider");
    created.setAttribute("aria-hidden", "true");
    return created;
  }

  function createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className: string,
  ): HTMLElementTagNameMap[K] {
    const created = doc.createElement(tagName);
    if (className) created.className = className;
    return created;
  }

  function textElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className: string,
    text: string,
  ): HTMLElementTagNameMap[K] {
    const created = createElement(tagName, className);
    created.textContent = text;
    return created;
  }

  function setFocusKey(target: HTMLElement, key: string): void {
    target.dataset.meanthisFocusKey = key;
  }

  function focusElement(key: string): boolean {
    const candidate = Array.from(surface.querySelectorAll<HTMLElement>("[data-meanthis-focus-key]"))
      .find((target) => target.dataset.meanthisFocusKey === key && !isDisabled(target));
    candidate?.focus();
    return candidate !== undefined;
  }

}

export function sanitizeClearStatus(value: unknown): ClearStatus {
  try {
    if (value === undefined) return { clearState: "idle", operationId: null };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { clearState: "idle", operationId: null };
    }
    if (!hasExactClearStatusDataShape(value)) {
      return { clearState: "idle", operationId: null };
    }
    const clone = globalThis.structuredClone;
    if (typeof clone !== "function") return { clearState: "idle", operationId: null };
    const cloned = clone(value) as unknown;
    if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned) ||
        !hasExactClearStatusDataShape(cloned)) {
      return { clearState: "idle", operationId: null };
    }
    const clearState = Object.getOwnPropertyDescriptor(cloned, "clearState")!;
    const operationId = Object.getOwnPropertyDescriptor(cloned, "operationId")!;
    if (clearState.value === "idle" && operationId.value === null) {
      return { clearState: "idle", operationId: null };
    }
    if (clearState.value === "pending" && isClearOperationId(operationId.value)) {
      return { clearState: "pending", operationId: operationId.value };
    }
  } catch {
    // Untrusted proxies and accessors fail closed to the legacy idle state.
  }
  return { clearState: "idle", operationId: null };
}

function hasExactClearStatusDataShape(value: object): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("clearState") || !keys.includes("operationId")) {
    return false;
  }
  const clearState = Object.getOwnPropertyDescriptor(value, "clearState");
  const operationId = Object.getOwnPropertyDescriptor(value, "operationId");
  return Boolean(
    clearState && "value" in clearState && operationId && "value" in operationId,
  );
}

function isClearOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

function sanitizeStatus(value: unknown): InPageWidgetStatusViewModel | null {
  if (!isRecord(value) || !isStatusKind(value.kind)) return null;
  const message = sanitizeSingleLine(value.message, MAX_STATUS_LENGTH);
  return message ? { kind: value.kind, message } : null;
}

function validateOpaqueId(value: unknown): string {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_ID_LENGTH &&
      value.trim().length > 0 &&
      !UNSAFE_ID.test(value)
    ? value
    : "";
}

function sanitizeReferenceCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= MAX_TARGETS
    ? value
    : fallback;
}

const LIFECYCLE_CONTROL_PROPOSAL_KEYS = [
  "itemId",
  "operationId",
  "fingerprint",
  "expectedState",
  "nextState",
  "expiresAt",
] as const;

function sanitizeLifecycleControlProposal(
  value: unknown,
): InPageWidgetLifecycleControlProposal | null {
  if (!isRecord(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== LIFECYCLE_CONTROL_PROPOSAL_KEYS.length ||
      ownKeys.some((key) => (
        typeof key !== "string" || !isLifecycleControlProposalKey(key)
      ))
    ) return null;
    const fields: Record<string, unknown> = {};
    for (const key of LIFECYCLE_CONTROL_PROPOSAL_KEYS) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.value === undefined
      ) return null;
      fields[key] = descriptor.value;
    }
    const itemId = validateOpaqueId(fields.itemId);
    const operationId = sanitizeLifecycleProposalToken(fields.operationId, MAX_ID_LENGTH);
    const fingerprint = sanitizeLifecycleProposalToken(
      fields.fingerprint,
      MAX_LIFECYCLE_PROPOSAL_FINGERPRINT_LENGTH,
    );
    const expectedState = isAnnotationLifecycleState(fields.expectedState)
      ? fields.expectedState
      : null;
    const nextState = isAnnotationLifecycleState(fields.nextState)
      ? fields.nextState
      : null;
    const expiresAt = fields.expiresAt;
    if (
      !itemId ||
      !operationId ||
      !fingerprint ||
      !expectedState ||
      !nextState ||
      expectedState === nextState ||
      typeof expiresAt !== "string" ||
      !isCanonicalIsoDate(expiresAt)
    ) return null;
    return {
      itemId,
      operationId,
      fingerprint,
      expectedState,
      nextState,
      expiresAt,
    };
  } catch {
    return null;
  }
}

function isLifecycleControlProposalKey(
  value: string,
): value is typeof LIFECYCLE_CONTROL_PROPOSAL_KEYS[number] {
  return (LIFECYCLE_CONTROL_PROPOSAL_KEYS as readonly string[]).includes(value);
}

function sanitizeLifecycleProposalToken(value: unknown, maxLength: number): string {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      value.trim() === value &&
      /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : "";
}

function isAnnotationLifecycleState(value: unknown): value is AnnotationLifecycleState {
  return value === "open" || value === "resolved";
}

function formatLifecycleProposalFingerprint(value: string): string {
  return value.length > MAX_LIFECYCLE_PROPOSAL_FINGERPRINT_DISPLAY_LENGTH
    ? `${value.slice(0, MAX_LIFECYCLE_PROPOSAL_FINGERPRINT_DISPLAY_LENGTH)}…`
    : value;
}

function readOwnDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable === true && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeAnnotationLifecycle(value: unknown): AnnotationLifecycle | null {
  if (!isRecord(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => (
      typeof key !== "string" || (key !== "state" && key !== "resolvedAt")
    ))) return null;
    const stateDescriptor = Reflect.getOwnPropertyDescriptor(value, "state");
    const resolvedAtDescriptor = Reflect.getOwnPropertyDescriptor(value, "resolvedAt");
    if (!stateDescriptor || stateDescriptor.enumerable !== true || !("value" in stateDescriptor) ||
        !resolvedAtDescriptor || resolvedAtDescriptor.enumerable !== true ||
        !("value" in resolvedAtDescriptor)) return null;
    const state = stateDescriptor.value;
    const resolvedAt = resolvedAtDescriptor.value;
    if (state !== "open" && state !== "resolved") return null;
    if (state === "open") return resolvedAt === null ? { state, resolvedAt: null } : null;
    return typeof resolvedAt === "string" && isCanonicalIsoDate(resolvedAt)
      ? { state, resolvedAt }
      : null;
  } catch {
    return null;
  }
}

function isCanonicalIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sanitizeSingleLine(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(UNSAFE_TEXT, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultiline(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_TEXT, "")
    .slice(0, MAX_NOTE_LENGTH);
}

function fallbackLabel(index: number): string {
  return String.fromCharCode(65 + Math.min(index, 25));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is InPageWidgetMode {
  return value === "collapsed" || value === "ready" || value === "selecting" ||
    value === "details" || value === "editing";
}

function isAttachmentFeedbackDetail(value: unknown): value is AttachmentFeedbackDetail {
  return value === "compact" || value === "standard" ||
    value === "detailed" || value === "forensic";
}

function isBridgeState(value: unknown): value is InPageWidgetBridgeState {
  return value === "unavailable" || value === "disconnected" || value === "pending" || value === "connected";
}

function isBusyAction(value: unknown): value is Exclude<InPageWidgetBusyAction, null> {
  return value === "save" ||
    value === "remove" ||
    value === "clear" ||
    value === "copy" ||
    value === "disclosure" ||
    value === "connect" ||
    value === "refresh" ||
    value === "disconnect" ||
    value === "selection" ||
    value === "frame-scope" ||
    value === "side-panel" ||
    value === "diagnostics" ||
    value === "lifecycle";
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function formatTouchClass(value: string): string {
  if (value === "none") return "No touch";
  if (value === "coarse") return "Coarse touch";
  return "Touch unknown";
}

function fillNamedValues(
  message: string,
  values: Record<string, string | number>,
): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) => (
    Object.hasOwn(values, name) ? String(values[name]) : token
  ));
}

function isStatusKind(value: unknown): value is InPageWidgetStatusViewModel["kind"] {
  return value === "info" || value === "success" || value === "error";
}

function findActionElement(
  event: Event,
  actions: WeakMap<Element, WidgetAction>,
): Element | null {
  for (const entry of event.composedPath()) {
    if (typeof entry === "object" && entry !== null && actions.has(entry as Element)) {
      return entry as Element;
    }
  }
  return null;
}

function preferredFocusKey(mode: InPageWidgetMode): string {
  if (mode === "collapsed") return "launcher";
  if (mode === "editing") return "task-note";
  return "selection-toggle";
}

function isDisabled(target: HTMLElement): boolean {
  return target.matches("button:disabled, textarea:disabled, input:disabled, select:disabled");
}
