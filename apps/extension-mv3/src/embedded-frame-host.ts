import type { OverlayReplayLocator } from "./messages";
import { getCanonicalFrameLocation } from "./capture";
import { resolveDomReplayTarget } from "./replay-dom";

export interface EmbeddedFrameHostInspection {
  frameHostCount: number;
  frameOrigin: string | null;
  framePathname: string | null;
}

export async function inspectEmbeddedFrameHost(
  root: Document,
  locators: ReadonlyArray<OverlayReplayLocator>,
): Promise<EmbeddedFrameHostInspection | null> {
  const target = await resolveDomReplayTarget(root, locators);
  if (!target || target.tagName.toLowerCase() !== "iframe") return null;
  const location = getCanonicalFrameLocation(
    target,
    root.defaultView?.location.href ?? root.baseURI,
  );
  return {
    frameHostCount: countFrameHosts(root),
    ...location,
  };
}

function countFrameHosts(root: Document): number {
  let count = 0;
  const visit = (element: Element): void => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "iframe" || tagName === "frame") count += 1;
    Array.from(element.children).forEach(visit);
    Array.from(element.shadowRoot?.children ?? []).forEach(visit);
  };
  if (root.documentElement) visit(root.documentElement);
  return count;
}
