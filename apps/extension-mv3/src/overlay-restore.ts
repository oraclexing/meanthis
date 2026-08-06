import type { OriginCaptureRecord } from "./capture-store";
import {
  OVERLAY_RESTORE_MAX_LOCATORS,
  type CaptureCommitReceipt,
  type OverlayReplayLocator,
  type OverlayRestoreItem,
} from "./messages";

export interface LiveOverlayCaptureOptions {
  record: OriginCaptureRecord;
  receipt: CaptureCommitReceipt;
  currentUrl: string;
  target: HTMLElement;
  trackCurrentRoute(): void;
  bindLiveTarget(target: HTMLElement, receipt: CaptureCommitReceipt): void;
  bindReplayTarget(item: OverlayRestoreItem, target: HTMLElement): Promise<void>;
}

export async function commitLiveOverlayCapture(
  options: LiveOverlayCaptureOptions,
): Promise<void> {
  if (!options.target.isConnected) return;
  options.trackCurrentRoute();
  options.bindLiveTarget(options.target, options.receipt);
  const currentItem = createCurrentOverlayRestoreItem(
    options.record,
    options.receipt,
    options.currentUrl,
  );
  if (!currentItem) return;
  await options.bindReplayTarget(currentItem, options.target);
}

export function createCurrentOverlayRestoreItem(
  record: OriginCaptureRecord,
  receipt: CaptureCommitReceipt,
  currentUrl: string,
): OverlayRestoreItem | null {
  const capturedRoute = canonicalRoute(record.pageUrl);
  const currentRoute = canonicalRoute(currentUrl);
  if (
    capturedRoute === null ||
    currentRoute === null ||
    record.origin !== capturedRoute.origin ||
    receipt.origin !== capturedRoute.origin ||
    currentRoute.origin !== capturedRoute.origin
  ) return null;
  const locators = capturedRoute.key === currentRoute.key
    ? collectVerifiedOverlayReplayLocators(record)
    : collectVerifiedContentAnchoredOverlayReplayLocators(record);
  if (locators.length === 0) return null;
  return {
    itemId: receipt.itemId,
    attachmentId: record.attachment.id,
    label: receipt.label,
    locators,
  };
}

export function collectOverlayReplayLocators(
  locatorBundle: OriginCaptureRecord["attachment"]["locatorBundle"],
): OverlayReplayLocator[] {
  const seen = new Set<string>();
  const locators: OverlayReplayLocator[] = [];
  for (const locator of [
    ...(locatorBundle.primary ? [locatorBundle.primary] : []),
    ...locatorBundle.candidates,
  ]) {
    if (locator.strategy === "coordinates" || locator.strategy === "xpath") continue;
    const key = `${locator.strategy}:${locator.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push({
      strategy: locator.strategy,
      value: locator.value,
      confidence: locator.confidence,
    });
    if (locators.length === OVERLAY_RESTORE_MAX_LOCATORS) break;
  }
  return locators;
}

export function collectVerifiedOverlayReplayLocators(
  record: {
    attachment: OriginCaptureRecord["attachment"];
    replayAttempts?: readonly unknown[];
  },
): OverlayReplayLocator[] {
  const locatorBundle = record.attachment.locatorBundle;
  const candidates = [
    ...(locatorBundle.primary ? [locatorBundle.primary] : []),
    ...locatorBundle.candidates,
  ];
  const candidatesByKey = new Map(
    candidates.map((locator) => [`${locator.strategy}:${locator.value}`, locator]),
  );
  const locators: OverlayReplayLocator[] = [];
  const seen = new Set<string>();
  const addLocator = (locator: (typeof candidates)[number] | undefined): void => {
    if (
      !locator ||
      locator.strategy === "coordinates" ||
      locator.strategy === "xpath" ||
      locators.length === OVERLAY_RESTORE_MAX_LOCATORS
    ) return;
    const key = `${locator.strategy}:${locator.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    locators.push({
      strategy: locator.strategy,
      value: locator.value,
      confidence: locator.confidence,
    });
  };

  for (const attempt of record.replayAttempts ?? []) {
    if (!isVerifiedStableIdentityAttempt(attempt)) continue;
    const candidate = candidatesByKey.get(`${attempt.strategy}:${attempt.value}`);
    if (!candidate || !isStableIdentityLocator(candidate)) continue;
    addLocator(candidate);
  }

  const stability = locatorBundle.stability;
  if (
    stability?.replayVerified !== true ||
    stability.uniqueness !== true ||
    !stability.verifiedBy ||
    !stability.verifiedValue
  ) {
    return locators;
  }

  const verifiedLocator = candidates.find(
    (locator) =>
      locator.strategy === stability.verifiedBy &&
      locator.value === stability.verifiedValue,
  );
  addLocator(verifiedLocator);
  return locators;
}

export function collectVerifiedContentAnchoredOverlayReplayLocators(
  record: {
    attachment: OriginCaptureRecord["attachment"];
    replayAttempts?: readonly unknown[];
  },
): OverlayReplayLocator[] {
  const candidates = [
    ...(record.attachment.locatorBundle.primary
      ? [record.attachment.locatorBundle.primary]
      : []),
    ...record.attachment.locatorBundle.candidates,
  ];
  const candidatesByKey = new Map(
    candidates.map((locator) => [`${locator.strategy}:${locator.value}`, locator]),
  );
  const locators: OverlayReplayLocator[] = [];
  const seen = new Set<string>();
  for (const attempt of record.replayAttempts ?? []) {
    if (!isVerifiedStableIdentityAttempt(attempt)) continue;
    const candidate = candidatesByKey.get(`${attempt.strategy}:${attempt.value}`);
    if (!candidate || !isContentAnchoredIdentityLocator(candidate)) continue;
    const key = `${candidate.strategy}:${candidate.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push({
      strategy: "css",
      value: candidate.value,
      confidence: candidate.confidence,
    });
    if (locators.length === OVERLAY_RESTORE_MAX_LOCATORS) break;
  }
  return locators;
}

function isStableIdentityLocator(locator: {
  strategy: string;
  value: string;
  notes?: string;
}): boolean {
  return locator.strategy === "playwright.testId" ||
    (locator.strategy === "css" && (
      locator.value.startsWith("#") ||
      /^\[data-[a-z0-9]+(?:-[a-z0-9]+)+\]$/.test(locator.value) ||
      locator.notes === "anchored structural fallback" ||
      isContentAnchoredIdentityLocator(locator)
    ));
}

function isContentAnchoredIdentityLocator(locator: {
  strategy: string;
  value: string;
  notes?: string;
}): boolean {
  return locator.strategy === "css" &&
    locator.notes === "descendant anchored fallback" &&
    locator.value.length <= 512 &&
    /^(?:article|li|\[role="(?:article|listitem)"\]):has\(a\[href="\/(?!\/)[^"?#\s\\]{1,256}"\]\) .+$/.test(
      locator.value,
    );
}

function isVerifiedStableIdentityAttempt(value: unknown): value is {
  strategy: string;
  value: string;
  replayVerified: true;
  uniqueness: true;
  matchCount: 1;
  visible: true;
} {
  if (typeof value !== "object" || value === null) return false;
  const attempt = value as Record<string, unknown>;
  return typeof attempt.strategy === "string" &&
    typeof attempt.value === "string" &&
    attempt.replayVerified === true &&
    attempt.uniqueness === true &&
    attempt.matchCount === 1 &&
    attempt.visible === true;
}

function canonicalRoute(value: string | null | undefined): { key: string; origin: string } | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { key: `${parsed.origin}${parsed.pathname}`, origin: parsed.origin };
  } catch {
    return null;
  }
}
