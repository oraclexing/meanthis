export const MEANTHIS_SURFACE_CLAIM_VERSION = "1";
export const MEANTHIS_SURFACE_CLAIM_SELECTOR =
  `[data-meanthis-surface-claim="${MEANTHIS_SURFACE_CLAIM_VERSION}"]`;
export const MEANTHIS_SURFACE_OPEN_REQUEST = "meanthis:surface-open-request";

export type MeanThisSurfaceOwner = "sdk" | "extension";
export type MeanThisSurfaceClaimStatus = "claimed" | "delegated" | "conflict";

export interface ClaimMeanThisSurfaceOptions {
  root?: Document;
  owner: MeanThisSurfaceOwner;
  onOpenRequest?: () => void;
  onClaimLost?: () => void;
}

export interface MeanThisSurfaceClaim {
  readonly status: MeanThisSurfaceClaimStatus;
  readonly owner: MeanThisSurfaceOwner;
  readonly currentOwner: MeanThisSurfaceOwner | null;
  readonly element: HTMLElement | null;
  requestOpen(): boolean;
  release(): void;
}

/**
 * Coordinates one visible MeanThis surface per top document.
 *
 * The DOM marker is deliberately non-sensitive. It is an availability and UI
 * arbitration signal only; it never authenticates extension messages or
 * carries a capability, invitation, task note, or capture data.
 */
export function claimMeanThisSurface(
  options: ClaimMeanThisSurfaceOptions,
): MeanThisSurfaceClaim {
  const root = options.root ?? document;
  const parent = root.documentElement;
  if (!parent) throw new Error("MeanThis requires a document element.");

  const existing = [...root.querySelectorAll<HTMLElement>(MEANTHIS_SURFACE_CLAIM_SELECTOR)];
  if (existing.length > 1) {
    return createPassiveClaim("conflict", options.owner, null, null);
  }
  if (existing.length === 1) {
    const element = existing[0];
    const currentOwner = parseSurfaceOwner(element.dataset.meanthisSurfaceOwner);
    if (!currentOwner || !hasExactClaimShape(element, currentOwner)) {
      return createPassiveClaim("conflict", options.owner, null, element);
    }
    return createPassiveClaim("delegated", options.owner, currentOwner, element);
  }

  const element = root.createElement("span");
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  element.dataset.meanthisSurfaceClaim = MEANTHIS_SURFACE_CLAIM_VERSION;
  element.dataset.meanthisSurfaceOwner = options.owner;
  element.dataset.uiAttachIgnore = "true";
  const onOpen = (): void => options.onOpenRequest?.();
  element.addEventListener(MEANTHIS_SURFACE_OPEN_REQUEST, onOpen);
  parent.append(element);

  let released = false;
  const Observer = root.defaultView?.MutationObserver;
  const observer = Observer
    ? new Observer(() => {
        if (released || ownsCurrentClaim(root, element, options.owner)) return;
        released = true;
        observer?.disconnect();
        element.removeEventListener(MEANTHIS_SURFACE_OPEN_REQUEST, onOpen);
        options.onClaimLost?.();
      })
    : null;
  observer?.observe(root, { childList: true, subtree: true, attributes: true });

  return {
    status: "claimed",
    owner: options.owner,
    currentOwner: options.owner,
    element,
    requestOpen(): boolean {
      if (released || !ownsCurrentClaim(root, element, options.owner)) return false;
      return element.dispatchEvent(new Event(MEANTHIS_SURFACE_OPEN_REQUEST));
    },
    release(): void {
      if (released) return;
      released = true;
      observer?.disconnect();
      element.removeEventListener(MEANTHIS_SURFACE_OPEN_REQUEST, onOpen);
      if (ownsCurrentClaim(root, element, options.owner)) element.remove();
    },
  };
}

function createPassiveClaim(
  status: Exclude<MeanThisSurfaceClaimStatus, "claimed">,
  owner: MeanThisSurfaceOwner,
  currentOwner: MeanThisSurfaceOwner | null,
  element: HTMLElement | null,
): MeanThisSurfaceClaim {
  return {
    status,
    owner,
    currentOwner,
    element,
    requestOpen(): boolean {
      if (status !== "delegated" || !element?.isConnected) return false;
      if (!currentOwner || !hasExactClaimShape(element, currentOwner)) return false;
      return element.dispatchEvent(new Event(MEANTHIS_SURFACE_OPEN_REQUEST));
    },
    release(): void {
      // A delegated or conflicting claimant never removes another surface.
    },
  };
}

function ownsCurrentClaim(
  root: Document,
  element: HTMLElement,
  owner: MeanThisSurfaceOwner,
): boolean {
  const matches = root.querySelectorAll<HTMLElement>(MEANTHIS_SURFACE_CLAIM_SELECTOR);
  return matches.length === 1 && matches[0] === element && hasExactClaimShape(element, owner);
}

function hasExactClaimShape(element: HTMLElement, owner: MeanThisSurfaceOwner): boolean {
  return element.dataset.meanthisSurfaceClaim === MEANTHIS_SURFACE_CLAIM_VERSION &&
    element.dataset.meanthisSurfaceOwner === owner &&
    element.dataset.uiAttachIgnore === "true" &&
    element.hidden && element.getAttribute("aria-hidden") === "true";
}

function parseSurfaceOwner(value: string | undefined): MeanThisSurfaceOwner | null {
  return value === "sdk" || value === "extension" ? value : null;
}
