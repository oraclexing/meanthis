import { serializeAttachmentMarkdown, serializeAttachmentSummary } from "@meanthis/prompt";
import { applyReplayResult, verifyAttachmentLocator } from "@meanthis/replay";
import type { LocatorReplayAttempt, ReplayPageLike } from "@meanthis/replay";
import type {
  UIAttachment,
  UIAttachmentBoundary,
  UIAttachmentDisclosureMode,
  UIAttachmentLocator,
  UIAttachmentSelectionPoint,
} from "@meanthis/schema";
import { extractElementAttachment } from "@meanthis/web-extractor";
import type { OriginCaptureRecord } from "./capture-store";
import { createOriginScope } from "./origin";
import { createDomReplayPage } from "./replay-dom";

export type ContextCaptureResult =
  | {
      ok: true;
      json: string;
      record: OriginCaptureRecord;
    }
  | {
      ok: false;
      error: string;
    };

export interface CaptureElementTargetOptions {
  locationHref?: string;
  documentTitle?: string;
  tabId?: number;
  frameId?: number;
  disclosureMode?: UIAttachmentDisclosureMode;
  selectionPoint?: UIAttachmentSelectionPoint | null;
}

export async function captureElementTarget(
  target: HTMLElement,
  options: CaptureElementTargetOptions,
): Promise<ContextCaptureResult> {
  let scope;
  try {
    scope = createOriginScope(options.locationHref ?? globalThis.location?.href ?? "");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to capture this page.",
    };
  }

  const policyAttachment = withExtensionPolicy(
    withEmbeddedFrameBoundary(
      extractElementAttachment(target, {
        locationHref: options.locationHref,
        documentTitle: options.documentTitle ?? globalThis.document?.title ?? null,
        disclosureMode: options.disclosureMode,
      }),
      target,
      scope.redactedUrl,
    ),
    scope.origin,
    scope.redactedFields,
  );
  const extractedAttachment = options.selectionPoint
    ? { ...policyAttachment, selectionPoint: { ...options.selectionPoint } }
    : policyAttachment;
  const replayPage = createDomReplayPage(target.ownerDocument);
  const replayResult = await verifyAttachmentLocator(replayPage, extractedAttachment);
  const stableIdentityAttempts = await verifyStableIdentity(
    replayPage,
    extractedAttachment,
  );
  const attachment = applyReplayResult(extractedAttachment, replayResult);
  const summary = serializeAttachmentSummary(attachment);
  const markdown = serializeAttachmentMarkdown(attachment);
  const record: OriginCaptureRecord = {
    origin: scope.origin,
    pageUrl: attachment.source.url ?? scope.redactedUrl,
    pageTitle: attachment.source.title,
    attachment,
    intent: "",
    markdown,
    summary,
    replayAttempts: mergeReplayAttempts(replayResult.attempts, stableIdentityAttempts),
    capturedAt: attachment.capturedAt,
    tabId: options.tabId,
    frameId: options.frameId,
  };

  return {
    ok: true,
    json: JSON.stringify(attachment, null, 2),
    record,
  };
}

function withEmbeddedFrameBoundary(
  attachment: UIAttachment,
  target: HTMLElement,
  pageUrl: string,
): UIAttachment {
  if (target.tagName.toLowerCase() !== "iframe") return attachment;

  const pageOrigin = new URL(pageUrl).origin;
  const { frameOrigin, framePathname } = getCanonicalFrameLocation(target, pageUrl);
  const originRelation: UIAttachmentBoundary["originRelation"] = frameOrigin === null
    ? "opaque_or_unavailable"
    : frameOrigin === pageOrigin
      ? "same_origin"
      : "cross_origin";

  return {
    ...attachment,
    boundary: {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation,
      frameOrigin,
      framePathname,
      dominantViewport: isDominantViewportTarget(target),
    },
  };
}

export function getCanonicalFrameLocation(
  target: HTMLElement,
  pageUrl: string,
): { frameOrigin: string | null; framePathname: string | null } {
  const page = new URL(pageUrl);
  const sandbox = target.getAttribute("sandbox");
  if (
    sandbox !== null &&
    !sandbox.split(/\s+/).some((token) => token.toLowerCase() === "allow-same-origin")
  ) {
    return { frameOrigin: null, framePathname: null };
  }

  const source = target.getAttribute("src");
  if (target.hasAttribute("srcdoc") || !source?.trim()) {
    return { frameOrigin: page.origin, framePathname: page.pathname };
  }
  try {
    const hasExplicitDocumentBase = target.ownerDocument.querySelector("base[href]") !== null;
    const documentBase = hasExplicitDocumentBase ? target.ownerDocument.baseURI : page.href;
    const url = new URL(source, documentBase);
    if (url.protocol === "about:" && (url.pathname === "blank" || url.pathname === "srcdoc")) {
      return { frameOrigin: page.origin, framePathname: page.pathname };
    }
    return url.protocol === "http:" || url.protocol === "https:"
      ? { frameOrigin: url.origin, framePathname: url.pathname }
      : { frameOrigin: null, framePathname: null };
  } catch {
    return { frameOrigin: null, framePathname: null };
  }
}

function isDominantViewportTarget(target: HTMLElement): boolean {
  const view = target.ownerDocument.defaultView;
  const viewportWidth = target.ownerDocument.documentElement.clientWidth || view?.innerWidth || 0;
  const viewportHeight = target.ownerDocument.documentElement.clientHeight || view?.innerHeight || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) return false;

  const rect = target.getBoundingClientRect();
  const visibleWidth = Math.max(
    0,
    Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
  );
  const visibleCoverage = (visibleWidth * visibleHeight) / (viewportWidth * viewportHeight);
  return visibleCoverage >= 0.75;
}

async function verifyStableIdentity(
  page: ReplayPageLike,
  attachment: UIAttachment,
): Promise<LocatorReplayAttempt[]> {
  const attempts: LocatorReplayAttempt[] = [];
  for (const stableLocator of findStableIdentityLocators(attachment)) {
    const result = await verifyAttachmentLocator(page, {
      ...attachment,
      locatorBundle: {
        ...attachment.locatorBundle,
        primary: stableLocator,
        candidates: [],
      },
    });
    attempts.push(...result.attempts);
  }
  return attempts;
}

function findStableIdentityLocators(attachment: UIAttachment): UIAttachmentLocator[] {
  const locators = [
    ...(attachment.locatorBundle.primary ? [attachment.locatorBundle.primary] : []),
    ...attachment.locatorBundle.candidates,
  ];
  return [
    locators.find((locator) => locator.strategy === "playwright.testId"),
    locators.find((locator) =>
      locator.strategy === "css" &&
      (locator.value.startsWith("#") || isStableDataAttributeSelector(locator.value))
    ),
    locators.find((locator) =>
      locator.strategy === "css" &&
      (locator.notes === "anchored structural fallback" ||
        locator.notes === "descendant anchored fallback")
    ),
  ].filter((locator): locator is UIAttachmentLocator => locator !== undefined);
}

function isStableDataAttributeSelector(value: string): boolean {
  return /^\[data-[a-z0-9]+(?:-[a-z0-9]+)+\]$/.test(value);
}

function mergeReplayAttempts(
  primaryAttempts: LocatorReplayAttempt[],
  identityAttempts: LocatorReplayAttempt[],
): LocatorReplayAttempt[] {
  const seen = new Set<string>();
  return [...primaryAttempts, ...identityAttempts].filter((attempt) => {
    const key = `${attempt.strategy}:${attempt.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withExtensionPolicy(
  attachment: UIAttachment,
  origin: string,
  redactedFields: string[],
): UIAttachment {
  const nextRedactedFields = new Set(attachment.policy.redactedFields);
  const nextSensitiveHints = new Set(attachment.policy.sensitiveHints);
  const includedSensitiveFields = new Set(attachment.policy.includedSensitiveFields);
  for (const field of redactedFields) {
    nextSensitiveHints.add(field);
    if (!includedSensitiveFields.has(field)) {
      nextRedactedFields.add(field);
    }
  }

  return {
    ...attachment,
    policy: {
      ...attachment.policy,
      allowNetworkSend: false,
      allowedDomains: [origin],
      redactedFields: [...nextRedactedFields].sort(),
      sensitiveHints: [...nextSensitiveHints].sort(),
      includedSensitiveFields: [...includedSensitiveFields].sort(),
    },
  };
}
