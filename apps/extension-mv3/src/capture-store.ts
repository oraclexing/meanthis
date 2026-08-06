import {
  deriveCaptureRecordView,
  type CaptureRouteSegmentV1,
} from "@meanthis/hub-core";
import type { UIAttachment, UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { LocatorReplayAttempt } from "@meanthis/replay";

const MOST_RECENT_CAPTURE_KEY = "ui-attach:capture:latest";
export const DISCLOSURE_MODE_KEY = "ui-attach:disclosure-mode";

export interface ExtensionStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface OriginCaptureRecord {
  origin: string;
  pageUrl: string | null;
  pageTitle: string | null;
  attachment: UIAttachment;
  intent: string;
  markdown: string;
  summary?: string;
  replayAttempts?: LocatorReplayAttempt[];
  capturedAt: string;
  tabId?: number;
  frameId?: number;
  routeChain?: CaptureRouteSegmentV1[];
}

export function getCaptureStorageKey(origin: string): string {
  return `ui-attach:capture:${origin}`;
}

export async function saveLatestCapture(
  storage: ExtensionStorageArea,
  record: OriginCaptureRecord,
): Promise<OriginCaptureRecord> {
  const entries = getLatestCaptureStorageEntries(record);
  const normalizedRecord = entries[getCaptureStorageKey(record.origin)] as OriginCaptureRecord;

  await storage.set(entries);
  return normalizedRecord;
}

export function getLatestCaptureStorageEntries(
  record: OriginCaptureRecord,
): Record<string, OriginCaptureRecord> {
  if (record.attachment.policy.allowNetworkSend) {
    throw new Error("ui-attach extension storage requires allowNetworkSend=false");
  }

  const normalizedRecord = normalizeCaptureRecord(record);
  return {
    [getCaptureStorageKey(record.origin)]: normalizedRecord,
    [MOST_RECENT_CAPTURE_KEY]: normalizedRecord,
  };
}

export async function readLatestCapture(
  storage: ExtensionStorageArea,
  origin: string,
): Promise<OriginCaptureRecord | null> {
  const key = getCaptureStorageKey(origin);
  const values = await storage.get(key);
  const record = values[key];
  return isOriginCaptureRecord(record, origin) ? normalizeCaptureRecord(record) : null;
}

export async function readMostRecentCapture(
  storage: ExtensionStorageArea,
): Promise<OriginCaptureRecord | null> {
  const values = await storage.get(MOST_RECENT_CAPTURE_KEY);
  const record = values[MOST_RECENT_CAPTURE_KEY];
  return isOriginCaptureRecord(record) ? normalizeCaptureRecord(record) : null;
}

export function normalizeCaptureRecord(record: OriginCaptureRecord): OriginCaptureRecord {
  const result = deriveCaptureRecordView(
    record,
    record.attachment.policy.disclosureMode ?? "agent_safe",
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.record as OriginCaptureRecord;
}

export async function readDisclosureMode(
  storage: ExtensionStorageArea,
): Promise<UIAttachmentDisclosureMode> {
  const values = await storage.get(DISCLOSURE_MODE_KEY);
  const value = values[DISCLOSURE_MODE_KEY];
  return isDisclosureMode(value) ? value : "agent_safe";
}

export async function saveDisclosureMode(
  storage: ExtensionStorageArea,
  disclosureMode: UIAttachmentDisclosureMode,
): Promise<void> {
  await storage.set({ [DISCLOSURE_MODE_KEY]: disclosureMode });
}

function isOriginCaptureRecord(value: unknown, origin?: string): value is OriginCaptureRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "origin" in value &&
    typeof value.origin === "string" &&
    (origin === undefined || value.origin === origin) &&
    "attachment" in value &&
    typeof value.attachment === "object" &&
    value.attachment !== null
  );
}

function isDisclosureMode(value: unknown): value is UIAttachmentDisclosureMode {
  return value === "agent_safe" || value === "developer_diagnostic" || value === "full_debug";
}
