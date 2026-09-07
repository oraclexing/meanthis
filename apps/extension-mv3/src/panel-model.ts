import {
  hydrateCaptureSessionFile,
  serializeCapturePageRoutingSection,
  type CapturePromptBundleFormat,
  type CaptureSessionFile,
  type CaptureSessionFileV2,
  type CaptureSessionFileV3,
} from "@meanthis/hub-core";
import {
  countAttachmentFeedbackTargets,
  serializeAttachmentFeedbackBundle,
  serializeAttachmentCompactHandoff,
  serializeAttachmentHandoff,
  type AttachmentFeedbackDetail,
} from "@meanthis/prompt";
import type {
  LocalBridgeCaptureAuthorityV1,
  LocalBridgeCaptureTargetV1,
  LocalBridgeCaptureV1,
  MetadataDiagnosticsV1,
  UIAttachment,
  UIAttachmentContentPart,
  UIAttachmentDisclosureMode,
} from "@meanthis/schema";
import {
  UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES,
  UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES,
  isUIAttachment,
  validateMetadataDiagnosticsV1,
} from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import { deriveCaptureRecordDisclosure } from "./disclosure-view";
import { translateEnglish, type UiAttachTranslate } from "./i18n";
import { deriveCaptureReplayMetadataDiagnosticsV1 } from "./metadata-diagnostics";
import {
  formatDisplayTime,
  type TimeDisplayPreference,
} from "./settings-preferences";
import type { OverlayRebindStatus } from "./messages";

export interface PanelAgentCopyInput {
  file: CaptureSessionFile | null;
  attachmentIds: string[];
  selectedItemId: string | null;
  selectedRecord: OriginCaptureRecord | null;
  viewMode: UIAttachmentDisclosureMode;
  intent: string;
  format?: CapturePromptBundleFormat;
  outputDetail?: AttachmentFeedbackDetail;
  /** Include only replay facts already present in this explicit capture. */
  includeReplayDiagnostics?: true;
  /** Capture-bound device facts supplied by the background authority. */
  metadataDiagnostics?: MetadataDiagnosticsV1;
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

const BRIDGE_LABEL_MAX_BYTES = 128;
const BRIDGE_TITLE_MAX_BYTES = 512;
const BRIDGE_TASK_NOTE_MAX_BYTES = 16_384;
const UTF8_ENCODER = new TextEncoder();

type BridgeAnnotationIdentity = Pick<
  LocalBridgeCaptureTargetV1,
  "annotationId" | "annotationIdScope" | "annotationCreatedAt" | "annotationUpdatedAt"
>;

type BridgeAnnotationProjection = BridgeAnnotationIdentity & {
  annotationLifecycle?: LocalBridgeCaptureTargetV1["annotationLifecycle"];
};

const UNKNOWN_BRIDGE_ANNOTATION_IDENTITY: BridgeAnnotationIdentity = {
  annotationId: null,
  annotationIdScope: "unknown",
  annotationCreatedAt: null,
  annotationUpdatedAt: null,
};

const BRIDGE_ANNOTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function bridgeJsonByteLength(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function boundBridgeText(value: string, maxBytes: number): string {
  if (UTF8_ENCODER.encode(value).byteLength <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = UTF8_ENCODER.encode(suffix).byteLength;
  if (maxBytes <= suffixBytes) return "";
  const contentBudget = maxBytes - suffixBytes;
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (byteLength + characterBytes > contentBudget) break;
    result += character;
    byteLength += characterBytes;
  }
  return `${result.trimEnd()}${suffix}`;
}

export function buildPanelBridgeCapture(
  input: PanelAgentCopyInput,
  authority: LocalBridgeCaptureAuthorityV1,
): LocalBridgeCaptureV1 | null {
  if (!input.file) return null;
  const items = selectAgentCopyItems(input.file, input.attachmentIds);
  if (!items || items.length === 0) return null;

  const targets: LocalBridgeCaptureV1["targets"] = [];
  const replayAttemptGroups: Array<readonly unknown[] | undefined> = [];
  const targetIds = new Set<string>();
  for (const [index, item] of items.entries()) {
    const disclosure = deriveCaptureRecordDisclosure(
      item.sourceRecord as OriginCaptureRecord,
      "agent_safe",
    );
    if (!disclosure.ok) return null;
    replayAttemptGroups.push(disclosure.record.replayAttempts);
    const label = item.labels.find((candidate) => candidate.trim())?.trim() ?? `${index + 1}`;
    const targetId = createBridgeTargetId(label, item.id, index, targetIds);
    targetIds.add(targetId);
    // The Hub deduplicates repeated extractor IDs at the session-item layer.
    // The bridge contract uses that canonical item ID both outside and inside
    // the attachment so several same-kind page elements remain distinguishable.
    const attachment = disclosure.record.attachment.id === item.id
      ? disclosure.record.attachment
      : { ...disclosure.record.attachment, id: item.id };
    const annotation = projectBridgeAnnotationProjection(input.file, item);
    if (annotation === null) return null;
    targets.push({
      targetId,
      attachmentId: item.id,
      label: boundBridgeText(label, BRIDGE_LABEL_MAX_BYTES),
      taskNote: boundBridgeText(
        resolvePanelItemIntent(item, input.selectedItemId, input.intent),
        BRIDGE_TASK_NOTE_MAX_BYTES,
      ),
      ...annotation,
      attachment,
    });
  }

  const safeTitles = [...new Set(targets
    .map((target) => target.attachment.source.title?.trim())
    .filter((title): title is string => Boolean(title)))];

  const replayDiagnostics = input.includeReplayDiagnostics
    ? deriveCaptureReplayMetadataDiagnosticsV1({
        captureId: input.file.session.id,
        observedAt: input.file.session.updatedAt,
        replayAttemptGroups,
      })
    : null;
  if (replayDiagnostics && !replayDiagnostics.ok) return null;
  let diagnostics = replayDiagnostics?.ok ? replayDiagnostics.value : null;
  if (input.metadataDiagnostics) {
    const supplied = validateMetadataDiagnosticsV1(input.metadataDiagnostics);
    if (
      !supplied.ok ||
      supplied.value.captureId !== input.file.session.id ||
      supplied.value.authority !== "capture_time" ||
      supplied.value.consent !== "explicit_capture" ||
      supplied.value.observedAt > input.file.session.updatedAt ||
      supplied.value.network.status !== "not_requested" ||
      supplied.value.console.status !== "not_requested" ||
      !diagnostics
    ) return null;
    const merged = validateMetadataDiagnosticsV1({
      ...diagnostics,
      observedAt: supplied.value.observedAt,
      device: supplied.value.device,
    });
    if (!merged.ok) return null;
    diagnostics = merged.value;
  }

  const capture: LocalBridgeCaptureV1 = {
    captureId: input.file.session.id,
    title: safeTitles.length === 1
      ? boundBridgeText(safeTitles[0]!, BRIDGE_TITLE_MAX_BYTES)
      : null,
    origin: input.file.session.origin,
    updatedAt: input.file.session.updatedAt,
    authority,
    disclosureMode: "agent_safe",
    ...(input.file.schemaVersion === "0.3.0" ? { annotationLifecycleVersion: "v1" as const } : {}),
    ...(diagnostics ? { metadataDiagnostics: diagnostics } : {}),
    targets,
  };
  if (bridgeJsonByteLength(capture) <= UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES) {
    return capture;
  }

  const envelopeBytes = bridgeJsonByteLength({ ...capture, targets: [] });
  const separatorsBytes = Math.max(0, targets.length - 1);
  const targetBudget = Math.floor(
    (UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES - envelopeBytes - separatorsBytes) /
      targets.length,
  );
  const compactTargets = targets.map((target) =>
    projectBridgeCaptureTarget(target, targetBudget)
  );
  if (compactTargets.some((target) => target === null)) return null;
  const compactCapture: LocalBridgeCaptureV1 = {
    ...capture,
    targets: compactTargets as LocalBridgeCaptureTargetV1[],
  };
  return bridgeJsonByteLength(compactCapture) <= UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES
    ? compactCapture
    : null;
}

function projectBridgeAnnotationProjection(
  file: CaptureSessionFile,
  item: CaptureSessionFile["session"]["attachments"][number],
): BridgeAnnotationProjection | null {
  if (file.schemaVersion !== "0.2.0" && file.schemaVersion !== "0.3.0") {
    return { ...UNKNOWN_BRIDGE_ANNOTATION_IDENTITY };
  }
  const v2Item = item as CaptureSessionFileV2["session"]["attachments"][number];
  const annotationId = readOwnDataProperty(v2Item, "annotationId");
  const annotationCreatedAt = readOwnDataProperty(v2Item, "createdAt");
  const annotationUpdatedAt = readOwnDataProperty(v2Item, "updatedAt");
  if (
    typeof annotationId !== "string" ||
    !BRIDGE_ANNOTATION_ID_PATTERN.test(annotationId) ||
    typeof annotationCreatedAt !== "string" ||
    !isCanonicalBridgeIsoDate(annotationCreatedAt) ||
    typeof annotationUpdatedAt !== "string" ||
    !isCanonicalBridgeIsoDate(annotationUpdatedAt) ||
    !isCanonicalBridgeIsoDate(file.session.updatedAt)
  ) {
    return null;
  }
  const createdAt = Date.parse(annotationCreatedAt);
  const updatedAt = Date.parse(annotationUpdatedAt);
  const captureUpdatedAt = Date.parse(file.session.updatedAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    !Number.isFinite(captureUpdatedAt) ||
    updatedAt < createdAt ||
    updatedAt > captureUpdatedAt
  ) {
    return null;
  }
  const identity: BridgeAnnotationProjection = {
    annotationId,
    annotationIdScope: "capture_session",
    annotationCreatedAt,
    annotationUpdatedAt,
  };
  if (file.schemaVersion !== "0.3.0") return identity;

  const lifecycle = projectBridgeAnnotationLifecycle(
    file as CaptureSessionFileV3,
    item as CaptureSessionFileV3["session"]["attachments"][number],
    annotationCreatedAt,
    annotationUpdatedAt,
  );
  return lifecycle === null ? null : { ...identity, annotationLifecycle: lifecycle };
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function projectBridgeAnnotationLifecycle(
  file: CaptureSessionFileV3,
  item: CaptureSessionFileV3["session"]["attachments"][number],
  annotationCreatedAt: string,
  annotationUpdatedAt: string,
): LocalBridgeCaptureTargetV1["annotationLifecycle"] | null {
  const raw = readOwnDataProperty(item, "annotationLifecycle");
  if (!isExactBridgeRecord(raw, ["state", "resolvedAt"])) return null;
  const state = readOwnDataProperty(raw, "state");
  const resolvedAt = readOwnDataProperty(raw, "resolvedAt");
  if (state === "open") return resolvedAt === null ? { state, resolvedAt } : null;
  if (state !== "resolved" || !isCanonicalBridgeIsoDate(resolvedAt)) return null;
  const createdAt = Date.parse(annotationCreatedAt);
  const updatedAt = Date.parse(annotationUpdatedAt);
  const resolvedAtMs = Date.parse(resolvedAt);
  const captureUpdatedAt = Date.parse(file.session.updatedAt);
  if (
    !Number.isFinite(resolvedAtMs) ||
    !Number.isFinite(captureUpdatedAt) ||
    createdAt > resolvedAtMs ||
    resolvedAtMs > updatedAt ||
    updatedAt > captureUpdatedAt
  ) return null;
  return { state, resolvedAt };
}

function isExactBridgeRecord(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function copyBridgeAnnotationIdentity(
  source: LocalBridgeCaptureTargetV1,
): Partial<BridgeAnnotationIdentity> {
  const value = source as unknown as Record<string, unknown>;
  const keys = [
    "annotationId",
    "annotationIdScope",
    "annotationCreatedAt",
    "annotationUpdatedAt",
  ] as const;
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  ) as Partial<BridgeAnnotationIdentity>;
}

function copyBridgeAnnotationLifecycle(
  source: LocalBridgeCaptureTargetV1,
): Pick<LocalBridgeCaptureTargetV1, "annotationLifecycle"> {
  const value = source as unknown as Record<string, unknown>;
  return Object.hasOwn(value, "annotationLifecycle")
    ? { annotationLifecycle: structuredClone(source.annotationLifecycle) }
    : {};
}

function isCanonicalBridgeIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function projectBridgeCaptureTarget(
  source: LocalBridgeCaptureTargetV1,
  maxBytes: number,
): LocalBridgeCaptureTargetV1 | null {
  const sourceAttachment = source.attachment;
  const target = {
    ...(source.targetId ? { targetId: source.targetId } : {}),
    attachmentId: source.attachmentId,
    label: source.label,
    taskNote: "",
    ...copyBridgeAnnotationIdentity(source),
    ...copyBridgeAnnotationLifecycle(source),
    attachment: {
      schemaVersion: sourceAttachment.schemaVersion,
      id: sourceAttachment.id,
      capturedAt: sourceAttachment.capturedAt,
      source: { kind: sourceAttachment.source.kind, url: null, title: null },
      element: {
        tagName: boundBridgeText(sourceAttachment.element.tagName, 128),
        role: sourceAttachment.element.role === null
          ? null
          : boundBridgeText(sourceAttachment.element.role, 256),
        text: null,
        accessibleName: null,
        bbox: { ...sourceAttachment.element.bbox },
        visible: sourceAttachment.element.visible,
        enabled: sourceAttachment.element.enabled,
      },
      style: structuredClone(sourceAttachment.style),
      context: { parentSummary: null, nearbyText: [], selectorHints: [] },
      locatorBundle: {
        primary: null,
        candidates: [],
        stability: {
          score: sourceAttachment.locatorBundle.stability.score,
          uniqueness: sourceAttachment.locatorBundle.stability.uniqueness,
          replayVerified: false,
          failureReason: null,
        },
      },
      policy: {
        disclosureMode: sourceAttachment.policy.disclosureMode,
        redactionLevel: sourceAttachment.policy.redactionLevel,
        actionMode: sourceAttachment.policy.actionMode,
        allowScreenshot: sourceAttachment.policy.allowScreenshot,
        allowDomSnippet: sourceAttachment.policy.allowDomSnippet,
        allowNetworkSend: sourceAttachment.policy.allowNetworkSend,
        allowedDomains: [],
        redactedFields: [...sourceAttachment.policy.redactedFields],
        sensitiveHints: [...sourceAttachment.policy.sensitiveHints],
        includedSensitiveFields: [...sourceAttachment.policy.includedSensitiveFields],
      },
      artifacts: { screenshotCrop: null, overlayImage: null },
    },
  } as LocalBridgeCaptureTargetV1;
  if (bridgeJsonByteLength(target) > maxBytes) return null;

  tryAssignBridgeValue(target, maxBytes, () => {
    if (sourceAttachment.sourceAnchor) {
      target.attachment.sourceAnchor = structuredClone(sourceAttachment.sourceAnchor);
    }
  }, () => { delete target.attachment.sourceAnchor; });
  tryAssignBridgeValue(target, maxBytes, () => {
    if (sourceAttachment.selectionPoint) {
      target.attachment.selectionPoint = structuredClone(sourceAttachment.selectionPoint);
    }
  }, () => { delete target.attachment.selectionPoint; });
  tryAssignBridgeValue(target, maxBytes, () => {
    if (sourceAttachment.boundary) {
      target.attachment.boundary = structuredClone(sourceAttachment.boundary);
    }
  }, () => { delete target.attachment.boundary; });

  const taskNoteBudget = Math.min(
    BRIDGE_TASK_NOTE_MAX_BYTES,
    Math.max(0, Math.floor((maxBytes - bridgeJsonByteLength(target)) / 3)),
  );
  assignBridgeTextWithinBudget(
    source.taskNote,
    taskNoteBudget,
    maxBytes,
    (value) => { target.taskNote = value; },
    () => { target.taskNote = ""; },
    target,
  );

  const primary = sourceAttachment.locatorBundle.primary;
  if (primary) {
    const preservedPrimary = structuredClone(primary);
    const preservedStability = structuredClone(sourceAttachment.locatorBundle.stability);
    tryAssignBridgeValue(target, maxBytes, () => {
      target.attachment.locatorBundle.primary = preservedPrimary;
      target.attachment.locatorBundle.stability = preservedStability;
    }, () => {
      target.attachment.locatorBundle.primary = null;
      target.attachment.locatorBundle.stability = {
        score: sourceAttachment.locatorBundle.stability.score,
        uniqueness: sourceAttachment.locatorBundle.stability.uniqueness,
        replayVerified: false,
        failureReason: null,
      };
    });
  }

  tryAssignBridgeValue(target, maxBytes, () => {
    target.attachment.source.url = sourceAttachment.source.url;
  }, () => { target.attachment.source.url = null; });
  assignNullableBridgeTextWithinBudget(
    sourceAttachment.source.title,
    512,
    maxBytes,
    (value) => { target.attachment.source.title = value; },
    target,
  );
  assignNullableBridgeTextWithinBudget(
    sourceAttachment.element.accessibleName,
    2_048,
    maxBytes,
    (value) => { target.attachment.element.accessibleName = value; },
    target,
  );
  assignNullableBridgeTextWithinBudget(
    sourceAttachment.element.text,
    4_096,
    maxBytes,
    (value) => { target.attachment.element.text = value; },
    target,
  );

  for (const sourcePart of sourceAttachment.element.contentParts ?? []) {
    const part: UIAttachmentContentPart = {
      kind: sourcePart.kind,
      tagName: sourcePart.tagName,
      role: sourcePart.role,
      text: null,
      accessibleName: null,
    };
    const parts = target.attachment.element.contentParts ?? [];
    parts.push(part);
    target.attachment.element.contentParts = parts;
    if (bridgeJsonByteLength(target) > maxBytes) {
      parts.pop();
      if (parts.length === 0) delete target.attachment.element.contentParts;
      break;
    }
    assignNullableBridgeTextWithinBudget(
      sourcePart.text,
      16_384,
      maxBytes,
      (value) => { part.text = value; },
      target,
    );
    assignNullableBridgeTextWithinBudget(
      sourcePart.accessibleName,
      16_384,
      maxBytes,
      (value) => { part.accessibleName = value; },
      target,
    );
  }

  assignNullableBridgeTextWithinBudget(
    sourceAttachment.context.parentSummary,
    2_048,
    maxBytes,
    (value) => { target.attachment.context.parentSummary = value; },
    target,
  );
  appendBridgeStringsWithinBudget(
    target,
    target.attachment.context.nearbyText,
    sourceAttachment.context.nearbyText,
    maxBytes,
  );
  appendBridgeStringsWithinBudget(
    target,
    target.attachment.context.selectorHints,
    sourceAttachment.context.selectorHints,
    maxBytes,
  );
  for (const candidate of sourceAttachment.locatorBundle.candidates) {
    target.attachment.locatorBundle.candidates.push(structuredClone(candidate));
    if (bridgeJsonByteLength(target) > maxBytes) {
      target.attachment.locatorBundle.candidates.pop();
      break;
    }
  }
  for (const key of ["allowedDomains"] as const) {
    appendBridgeStringsWithinBudget(
      target,
      target.attachment.policy[key],
      sourceAttachment.policy[key],
      maxBytes,
    );
  }

  return bridgeJsonByteLength(target) <= maxBytes && isUIAttachment(target.attachment)
    ? target
    : null;
}

function tryAssignBridgeValue(
  target: LocalBridgeCaptureTargetV1,
  maxBytes: number,
  assign: () => void,
  revert: () => void,
): void {
  assign();
  if (bridgeJsonByteLength(target) <= maxBytes) return;
  revert();
}

function assignNullableBridgeTextWithinBudget(
  source: string | null,
  maxFieldBytes: number,
  maxTargetBytes: number,
  assign: (value: string | null) => void,
  target: LocalBridgeCaptureTargetV1,
): void {
  if (source === null) return;
  assignBridgeTextWithinBudget(
    source,
    maxFieldBytes,
    maxTargetBytes,
    assign,
    () => { assign(null); },
    target,
  );
}

function assignBridgeTextWithinBudget(
  source: string,
  maxFieldBytes: number,
  maxTargetBytes: number,
  assign: (value: string) => void,
  clear: () => void,
  target: LocalBridgeCaptureTargetV1,
): void {
  clear();
  let budget = Math.max(0, maxFieldBytes);
  while (budget > 0) {
    assign(boundBridgeText(source, budget));
    const overflow = bridgeJsonByteLength(target) - maxTargetBytes;
    if (overflow <= 0) return;
    clear();
    budget -= Math.max(1, overflow);
  }
}

function appendBridgeStringsWithinBudget(
  target: LocalBridgeCaptureTargetV1,
  destination: string[],
  source: readonly string[],
  maxBytes: number,
): void {
  for (const value of source) {
    destination.push(value);
    if (bridgeJsonByteLength(target) <= maxBytes) continue;
    destination.pop();
    break;
  }
}

function createBridgeTargetId(
  label: string,
  attachmentId: string,
  index: number,
  existing: ReadonlySet<string>,
): string {
  const safeLabel = label.match(/^[A-Za-z0-9_-]{1,64}$/)?.[0];
  const base = safeLabel
    ? `target_${safeLabel}`
    : `target_${stableBridgeIdHash(attachmentId)}`;
  return existing.has(base) ? `${base}_${index + 1}` : base;
}

function stableBridgeIdHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
  if (input.outputDetail) {
    return buildPanelFeedbackCopy(input, items, translate);
  }
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
  const scopedFile = {
    ...file,
    session: { ...file.session, attachments: items },
  } as CaptureSessionFile;
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

function buildPanelFeedbackCopy(
  input: PanelAgentCopyInput,
  items: CaptureSessionFile["session"]["attachments"],
  translate: UiAttachTranslate,
): PanelAgentCopyResult {
  const candidates = items.length > 0
    ? items.map((item, index) => ({
        label: item.labels.find((label) => label.trim()) ?? String.fromCharCode(65 + index),
        taskNote: resolvePanelItemIntent(item, input.selectedItemId, input.intent),
        record: item.sourceRecord as OriginCaptureRecord,
      }))
    : input.selectedRecord
      ? [{ label: "A", taskNote: input.intent.trim(), record: input.selectedRecord }]
      : [];
  if (candidates.length === 0) {
    return { ok: false, error: translate("no_selected_capture") };
  }
  const entries = [];
  for (const candidate of candidates) {
    const disclosure = deriveCaptureRecordDisclosure(
      candidate.record,
      resolveRecordDisclosureMode(
        candidate.record.attachment.policy.disclosureMode,
        input.viewMode,
      ),
    );
    if (!disclosure.ok) {
      return { ok: false, error: translate("unable_prepare_agent_context") };
    }
    entries.push({
      label: candidate.label,
      taskNote: candidate.taskNote,
      attachment: disclosure.record.attachment,
    });
  }
  return {
    ok: true,
    text: serializeAttachmentFeedbackBundle(entries, { detail: input.outputDetail }),
    attachmentCount: countAttachmentFeedbackTargets(entries),
  };
}

export function buildPanelBridgeAgentCopy(
  input: PanelAgentCopyInput,
  translate: UiAttachTranslate = translateEnglish,
): PanelAgentCopyResult {
  const handoff = buildPanelAgentCopy(input, translate);
  if (!handoff.ok) return handoff;
  return UTF8_ENCODER.encode(handoff.text).byteLength <= UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES
    ? handoff
    : { ok: false, error: translate("unable_prepare_agent_context") };
}

function buildPanelBundleIntent(
  items: CaptureSessionFile["session"]["attachments"],
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
  item: CaptureSessionFile["session"]["attachments"][number],
  selectedItemId: string | null,
  selectedIntent: string,
): string {
  return (item.id === selectedItemId
    ? selectedIntent
    : item.sourceRecord.intent).trim();
}

function selectAgentCopyItems(
  file: CaptureSessionFile,
  attachmentIds: string[],
): CaptureSessionFile["session"]["attachments"] | null {
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
  file: CaptureSessionFile,
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
