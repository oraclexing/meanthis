import {
  isCaptureObservationGetMessage,
  isCaptureObservationResponse,
  UI_ATTACH_CAPTURE_OBSERVATION_GET,
  type ActivePageContext,
} from "./messages";
import type { CaptureObservationReader } from "./panel-capture-comparison";

type BrowserCaptureObservationApi = Pick<typeof chrome, "webNavigation" | "tabs">;

interface FrameScope {
  frameId: number;
  documentId: string;
  origin: string;
  pathname: string;
}

/** Read one current Agent-safe observation from the exact active frame document. */
export function createBrowserCaptureObservationReader(
  browser: BrowserCaptureObservationApi,
): CaptureObservationReader {
  return async (page, itemId, attachmentId) => {
    try {
      const request = {
        type: UI_ATTACH_CAPTURE_OBSERVATION_GET,
        origin: page.origin,
        pathname: page.pathname,
        itemId,
        attachmentId,
      };
      if (!isCaptureObservationGetMessage(request)) return null;

      const before = await readFrameScope(browser, page);
      if (!before) return null;
      const response = await browser.tabs.sendMessage(
        page.tabId,
        request,
        { frameId: page.frameId, documentId: before.documentId },
      );
      const after = await readFrameScope(browser, page);
      if (!after || !sameFrameScope(before, after)) return null;
      if (!isCaptureObservationResponse(response) || response.ok !== true) return null;

      const data = response.data;
      if (data.origin !== page.origin ||
          data.pathname !== page.pathname ||
          data.itemId !== itemId ||
          data.attachmentId !== attachmentId) {
        return null;
      }
      return {
        status: data.status,
        observation: data.observation,
      };
    } catch {
      return null;
    }
  };
}

async function readFrameScope(
  browser: BrowserCaptureObservationApi,
  page: ActivePageContext,
): Promise<FrameScope | null> {
  if (!isBoundedDocumentId(page.documentId) ||
      !Number.isSafeInteger(page.tabId) ||
      !Number.isSafeInteger(page.frameId) ||
      !isCanonicalPageScope(page.origin, page.pathname)) {
    return null;
  }
  const frame = await browser.webNavigation.getFrame({
    tabId: page.tabId,
    frameId: page.frameId,
  });
  if (!frame || typeof frame !== "object") return null;
  const candidate = frame as {
    documentId?: unknown;
    url?: unknown;
  };
  if (typeof candidate.documentId !== "string" ||
      candidate.documentId !== page.documentId ||
      typeof candidate.url !== "string") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return null;
  }
  if (url.origin !== page.origin || url.pathname !== page.pathname) return null;
  return {
    frameId: page.frameId,
    documentId: candidate.documentId,
    origin: url.origin,
    pathname: url.pathname,
  };
}

function sameFrameScope(left: FrameScope, right: FrameScope): boolean {
  return left.frameId === right.frameId &&
    left.documentId === right.documentId &&
    left.origin === right.origin &&
    left.pathname === right.pathname;
}

function isBoundedDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/\p{Cc}/u.test(value);
}

function isCanonicalPageScope(origin: unknown, pathname: unknown): boolean {
  if (typeof origin !== "string" || typeof pathname !== "string") return false;
  try {
    const originUrl = new URL(origin);
    if ((originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
        originUrl.origin !== origin) return false;
    const route = new URL(pathname, `${origin}/`);
    return pathname.startsWith("/") &&
      route.origin === origin &&
      route.pathname === pathname &&
      route.search === "" &&
      route.hash === "";
  } catch {
    return false;
  }
}
