import type { CaptureSessionFile } from "@meanthis/hub-core";
import type { UIAttachment, UIAttachmentDisclosureMode } from "@meanthis/schema";
import { formatAnnotationLabel } from "@meanthis/web-picker";
import type { OriginCaptureRecord } from "./capture-store";
import { deriveCaptureRecordDisclosure, type CaptureRecordDisclosureResult } from "./disclosure-view";
import type { ActivePageContext } from "./messages";
import { EXTENSION_SESSION_MAX_ITEMS } from "./session-file";

export interface PanelSessionRow {
  id: string;
  label: string;
  target: string;
  capturedAt: string;
  sourceDisclosureMode: UIAttachmentDisclosureMode;
  selected: boolean;
}

/** Matches overlay numbering: assign against the full session before any UI/copy scope filter. */
export function getPanelSessionAnnotationLabels(
  file: CaptureSessionFile | null,
): ReadonlyMap<string, string> {
  return new Map((file?.session.attachments ?? []).map((item, index) => [
    item.id,
    formatAnnotationLabel(index),
  ]));
}

export interface PanelSessionRowGroup {
  key: string;
  label: string;
  current: boolean;
  rows: PanelSessionRow[];
}

export interface PanelCopyScope {
  key: string;
  label: string;
  itemIds: string[];
  current: boolean;
}

export interface PanelCurrentScope {
  itemIds: string[];
  selectedItemId: string | null;
}

export interface SourceModeSummary {
  agent_safe: number;
  developer_diagnostic: number;
  full_debug: number;
}

export interface PanelSessionPreviewInput {
  file: CaptureSessionFile | null;
  legacyRecord: OriginCaptureRecord | null;
  selectedItemId: string | null;
  viewMode: UIAttachmentDisclosureMode;
}

export function summarizePanelSessionRows(
  file: CaptureSessionFile | null,
  selectedItemId: string | null,
  viewMode: UIAttachmentDisclosureMode,
  activePage: ActivePageContext | null = null,
): PanelSessionRow[] {
  if (!file) return [];
  const candidates = file.session.attachments.map((item, index) => {
    const sourceRecord = item.sourceRecord as OriginCaptureRecord;
    const disclosure = deriveCaptureRecordDisclosure(sourceRecord, viewMode);
    const attachment = disclosure.ok
      ? disclosure.record.attachment
      : sourceRecord.attachment;
    return {
      contextAttachment: disclosure.ok ? disclosure.record.attachment : null,
      groupKey: activePage ? getPanelSessionGroupIdentity(sourceRecord, activePage).key : "session",
      row: {
        id: item.id,
        label: item.labels.find((label) => label.trim().length > 0)?.trim() || formatItemLabel(index),
        target: summarizeTarget(attachment.element),
        capturedAt: item.sourceRecord.capturedAt,
        sourceDisclosureMode: sourceRecord.attachment.policy.disclosureMode,
        selected: item.id === selectedItemId,
      } satisfies PanelSessionRow,
    };
  });
  const duplicateGroups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const duplicateKey = JSON.stringify([candidate.groupKey, candidate.row.target]);
    const group = duplicateGroups.get(duplicateKey) ?? [];
    group.push(candidate);
    duplicateGroups.set(duplicateKey, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const contextAttachments = group.flatMap((candidate) => (
      candidate.contextAttachment ? [candidate.contextAttachment] : []
    ));
    if (contextAttachments.length !== group.length) continue;
    const contextLabels = deriveUniqueContextLabels(contextAttachments);
    if (!contextLabels) continue;
    for (const [index, candidate] of group.entries()) {
      candidate.row.target = `${candidate.row.target} · ${contextLabels[index]}`;
    }
  }
  return candidates.map((candidate) => candidate.row);
}

export function selectInitialSessionItemId(
  file: CaptureSessionFile | null,
  activePage?: ActivePageContext | null,
): string | null {
  if (activePage) {
    const current = file?.session.attachments.filter((item) =>
      isCurrentPageRecord(item.sourceRecord as OriginCaptureRecord, activePage),
    );
    return current?.at(-1)?.id ?? null;
  }
  return file?.session.attachments.at(-1)?.id ?? null;
}

export function groupPanelSessionRows(
  file: CaptureSessionFile | null,
  rows: PanelSessionRow[],
  activePage: ActivePageContext | null,
  liveCurrentItemIds: ReadonlySet<string> = new Set(),
  liveExcludedItemIds: ReadonlySet<string> = new Set(),
): PanelSessionRowGroup[] {
  if (!file || rows.length === 0) return [];
  if (!activePage) {
    return [{ key: "session", label: "Captured targets", current: true, rows }];
  }

  const groups = new Map<string, PanelSessionRowGroup>();
  for (const [index, item] of file.session.attachments.entries()) {
    const row = rows[index];
    if (!row) continue;
    const record = item.sourceRecord as OriginCaptureRecord;
    const identity = getPanelSessionGroupIdentity(
      record,
      activePage,
      liveCurrentItemIds.has(item.id),
      liveExcludedItemIds.has(item.id),
    );
    const { current, frameId, key, pathname, sameTab } = identity;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: formatPanelSessionGroupLabel({ current, frameId, pathname, sameTab }),
        current,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((left, right) => Number(right.current) - Number(left.current));
}

export function derivePanelCopyScope(
  file: CaptureSessionFile | null,
  selectedItemId: string | null,
  activePage: ActivePageContext | null,
  liveCurrentItemIds: ReadonlySet<string> = new Set(),
  liveExcludedItemIds: ReadonlySet<string> = new Set(),
): PanelCopyScope | null {
  if (!file || !activePage) return null;
  const selectedItem = selectedItemId
    ? file.session.attachments.find((item) => item.id === selectedItemId)
    : file.session.attachments.find((item) => (
      getStrictPanelCopyIdentity(
        item.sourceRecord as OriginCaptureRecord,
        activePage,
        liveCurrentItemIds.has(item.id),
        liveExcludedItemIds.has(item.id),
      )?.current === true
    ));
  if (!selectedItem) return null;
  const selectedIdentity = getStrictPanelCopyIdentity(
    selectedItem.sourceRecord as OriginCaptureRecord,
    activePage,
    liveCurrentItemIds.has(selectedItem.id),
    liveExcludedItemIds.has(selectedItem.id),
  );
  if (!selectedIdentity) return null;
  const itemIds = file.session.attachments.flatMap((item) => (
    getStrictPanelCopyIdentity(
      item.sourceRecord as OriginCaptureRecord,
      activePage,
      liveCurrentItemIds.has(item.id),
      liveExcludedItemIds.has(item.id),
    )?.key ===
      selectedIdentity.key
      ? [item.id]
      : []
  ));
  if (itemIds.length === 0) return null;
  return {
    key: selectedIdentity.key,
    label: formatPanelSessionGroupLabel(selectedIdentity),
    itemIds,
    current: selectedIdentity.current,
  };
}

export function derivePanelCurrentScope(
  file: CaptureSessionFile | null,
  selectedItemId: string | null,
  activePage: ActivePageContext | null,
  authoritativeItemIds?: ReadonlySet<string>,
): PanelCurrentScope {
  const currentItems = file?.session.attachments.filter((item) => (
    authoritativeItemIds !== undefined
      ? authoritativeItemIds.has(item.id)
      : activePage === null || isCurrentPageRecord(
          item.sourceRecord as OriginCaptureRecord,
          activePage,
        )
  )) ?? [];
  const itemIds = currentItems.map((item) => item.id);
  return {
    itemIds,
    selectedItemId: selectedItemId && itemIds.includes(selectedItemId)
      ? selectedItemId
      : itemIds.at(-1) ?? null,
  };
}

function getStrictPanelCopyIdentity(
  record: OriginCaptureRecord,
  activePage: ActivePageContext,
  liveCurrent: boolean,
  liveExcluded: boolean,
): ReturnType<typeof getPanelSessionGroupIdentity> | null {
  if (liveExcluded) return null;
  const { frameId, tabId } = record;
  if (
    typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0 ||
    typeof frameId !== "number" || !Number.isInteger(frameId) || frameId < 0 ||
    !record.pageUrl
  ) {
    return null;
  }
  let pageUrl: URL;
  try {
    pageUrl = new URL(record.pageUrl);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(pageUrl.protocol) ||
    pageUrl.origin !== record.origin ||
    record.origin !== activePage.origin
  ) {
    return null;
  }
  const pathname = pageUrl.pathname || "/";
  const frameKindMatches = (frameId === 0) === (activePage.frameId === 0);
  if (liveCurrent && frameKindMatches) {
    return {
      key: "current",
      pathname: activePage.pathname,
      frameId: activePage.frameId,
      current: true,
      sameTab: true,
    };
  }
  const current = tabId === activePage.tabId &&
    frameId === activePage.frameId &&
    pathname === activePage.pathname;
  const sameTab = tabId === activePage.tabId;
  const key = current
    ? "current"
    : sameTab && frameId === 0
      ? `page:${pathname}`
      : sameTab
        ? `frame:${frameId}:${pathname}`
        : `tab:${tabId}:${frameId}:${pathname}`;
  return { key, pathname, frameId, current, sameTab };
}

function formatPanelSessionGroupLabel(identity: {
  current: boolean;
  frameId: number;
  pathname: string;
  sameTab: boolean;
}): string {
  return identity.current
    ? `Current page · ${identity.pathname}`
    : identity.sameTab && identity.frameId === 0
      ? `Other page · ${identity.pathname}`
      : identity.sameTab
        ? `Embedded frame · ${identity.pathname}`
        : `Other tab · ${identity.pathname}`;
}

function getPanelSessionGroupIdentity(
  record: OriginCaptureRecord,
  activePage: ActivePageContext,
  liveCurrent = false,
  liveExcluded = false,
): {
  key: string;
  pathname: string;
  frameId: number;
  current: boolean;
  sameTab: boolean;
} {
  const pathname = pathnameFromUrl(record.pageUrl) ?? "/";
  const frameId = record.frameId ?? 0;
  const frameKindMatches = (frameId === 0) === (activePage.frameId === 0);
  const current = !liveExcluded && (isCurrentPageRecord(record, activePage) || (
    liveCurrent &&
    record.origin === activePage.origin &&
    frameKindMatches
  ));
  if (current && liveCurrent && !isCurrentPageRecord(record, activePage)) {
    return {
      key: "current",
      pathname: activePage.pathname,
      frameId: activePage.frameId,
      current: true,
      sameTab: true,
    };
  }
  const sameTab = record.tabId === activePage.tabId;
  const key = current
    ? "current"
    : sameTab && frameId === 0
      ? `page:${pathname}`
      : sameTab
        ? `frame:${frameId}:${pathname}`
        : `tab:${record.tabId ?? "unknown"}:${frameId}:${pathname}`;
  return { key, pathname, frameId, current, sameTab };
}

export function summarizeSourceModes(file: CaptureSessionFile | null): SourceModeSummary {
  const summary: SourceModeSummary = {
    agent_safe: 0,
    developer_diagnostic: 0,
    full_debug: 0,
  };
  for (const item of file?.session.attachments ?? []) {
    summary[item.sourceRecord.attachment.policy.disclosureMode] += 1;
  }
  return summary;
}

export function requiresSourceExportConfirmation(file: CaptureSessionFile | null): boolean {
  const summary = summarizeSourceModes(file);
  return summary.developer_diagnostic > 0 || summary.full_debug > 0;
}

export function getSourceExportWarning(file: CaptureSessionFile | null): string | null {
  return requiresSourceExportConfirmation(file)
    ? "Export includes developer_diagnostic or full_debug source material. Review before sharing."
    : null;
}

export function formatSessionItemCount(file: CaptureSessionFile | null): string {
  return `${file?.session.attachments.length ?? 0}/${EXTENSION_SESSION_MAX_ITEMS} items`;
}

export function derivePanelSessionPreview(
  input: PanelSessionPreviewInput,
): CaptureRecordDisclosureResult {
  const record = findPreviewSourceRecord(input);
  if (!record) {
    return { ok: false, status: "No selected capture." };
  }
  return deriveCaptureRecordDisclosure(record, input.viewMode);
}

export function findPanelSessionItem(
  file: CaptureSessionFile | null,
  itemId: string | null,
): CaptureSessionFile["session"]["attachments"][number] | null {
  if (!file || !itemId) return null;
  return file.session.attachments.find((item) => item.id === itemId) ?? null;
}

function findPreviewSourceRecord(input: PanelSessionPreviewInput): OriginCaptureRecord | null {
  const item = findPanelSessionItem(input.file, input.selectedItemId);
  if (item) return item.sourceRecord as OriginCaptureRecord;
  return input.file ? null : input.legacyRecord;
}

function summarizeTarget(element: OriginCaptureRecord["attachment"]["element"]): string {
  const role = element.role ?? element.tagName;
  const name = element.accessibleName ?? element.text ?? "unnamed";
  return `${role} - ${name}`;
}

function deriveUniqueContextLabels(attachments: UIAttachment[]): string[] | null {
  const parentLabels = shortenUniqueContextValues(
    attachments.map((attachment) => normalizeContext(attachment.context.parentSummary)),
  );
  if (parentLabels) return parentLabels;

  const candidateRows = attachments.map((attachment) => {
    const excluded = new Set([
      normalizeContext(attachment.element.accessibleName)?.toLowerCase(),
      normalizeContext(attachment.element.text)?.toLowerCase(),
      normalizeContext(summarizeTarget(attachment.element))?.toLowerCase(),
    ].filter((value): value is string => Boolean(value)));
    return attachment.context.nearbyText
      .map(normalizeContext)
      .filter((value): value is string => Boolean(value))
      .filter((value) => !excluded.has(value.toLowerCase()));
  });
  const frequencies = new Map<string, number>();
  for (const row of candidateRows) {
    for (const value of new Set(row.map((candidate) => candidate.toLowerCase()))) {
      frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
    }
  }
  const uniqueValues = candidateRows.map((row) => row.find(
    (candidate) => frequencies.get(candidate.toLowerCase()) === 1,
  ) ?? null);
  return shortenUniqueContextValues(uniqueValues);
}

function shortenUniqueContextValues(values: Array<string | null>): string[] | null {
  if (values.some((value) => value === null)) return null;
  const normalized = values as string[];
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    return null;
  }
  const tokenRows = normalized.map((value) => value.split(" "));
  let sharedPrefixLength = 0;
  while (
    tokenRows.every((tokens) => tokens.length > sharedPrefixLength + 1) &&
    tokenRows.every(
      (tokens) => tokens[sharedPrefixLength]?.toLowerCase() ===
        tokenRows[0]?.[sharedPrefixLength]?.toLowerCase(),
    )
  ) {
    sharedPrefixLength += 1;
  }
  const labels = tokenRows.map((tokens) => truncateContext(
    tokens.slice(sharedPrefixLength).join(" "),
  ));
  if (
    labels.some((label) => !isMeaningfulContext(label)) ||
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  ) {
    return null;
  }
  return labels;
}

function normalizeContext(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function truncateContext(value: string): string {
  const maxLength = 72;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function isMeaningfulContext(value: string): boolean {
  const genericTokens = new Set([
    "a", "article", "aside", "button", "dialog", "div", "fieldset", "footer", "form",
    "group", "header", "li", "main", "menu", "nav", "navigation", "option", "panel",
    "section", "span", "table", "td", "tr",
  ]);
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .some((token) => token.length > 0 && !genericTokens.has(token) && token !== "redacted");
}

export function isCurrentPageRecord(record: OriginCaptureRecord, activePage: ActivePageContext): boolean {
  return record.tabId === activePage.tabId &&
    (record.frameId ?? 0) === activePage.frameId &&
    record.origin === activePage.origin &&
    pathnameFromUrl(record.pageUrl) === activePage.pathname;
}

function pathnameFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).pathname;
  } catch {
    return null;
  }
}

function formatItemLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
