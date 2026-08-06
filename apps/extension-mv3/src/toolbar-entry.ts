import type {
  UiAttachChromeAction,
  UiAttachChromeSidePanelOpenOptions,
  UiAttachChromeTab,
} from "./extension-api";

export type ToolbarEntryOutcome =
  | "ignored"
  | "superseded"
  | "ready"
  | "unsupported_page"
  | "content_unavailable"
  | "side_panel_unavailable";

export function createToolbarEntryHandler(options: {
  action: UiAttachChromeAction;
  ensureContentScript(tabId: number, frameId: number): Promise<boolean>;
  openSidePanel(options: UiAttachChromeSidePanelOpenOptions): Promise<void>;
  notifyReady?(): Promise<void>;
  readyTitle: string;
  unsupportedPageTitle: string;
  contentUnavailableTitle: string;
  sidePanelUnavailableTitle: string;
}): (tab: UiAttachChromeTab) => Promise<ToolbarEntryOutcome> {
  const latestRevisionByTab = new Map<number, number>();
  let nextRevision = 0;
  return async (tab) => {
    if (typeof tab.id !== "number" || !Number.isInteger(tab.id) || tab.id < 0) return "ignored";
    const revision = ++nextRevision;
    latestRevisionByTab.set(tab.id, revision);
    const unsupportedPage = isKnownUnsupportedPage(tab.url);
    const [contentAccess, sidePanel] = await Promise.allSettled([
      unsupportedPage ? Promise.resolve(false) : options.ensureContentScript(tab.id, 0),
      options.openSidePanel(resolveSidePanelOpenOptions({ ...tab, id: tab.id })),
    ]);
    if (latestRevisionByTab.get(tab.id) !== revision) return "superseded";
    let outcome: Exclude<ToolbarEntryOutcome, "ignored" | "superseded">;
    if (unsupportedPage) {
      outcome = "unsupported_page";
    } else if (sidePanel.status === "rejected") {
      outcome = "side_panel_unavailable";
    } else if (contentAccess.status === "fulfilled" && contentAccess.value === true) {
      outcome = "ready";
    } else {
      outcome = "content_unavailable";
    }
    await applyFeedback(options, tab.id, outcome);
    if (outcome === "ready" && options.notifyReady) {
      try {
        await options.notifyReady();
      } catch {
        // Toolbar access is already ready; a later panel focus can refresh safely.
      }
    }
    return outcome;
  };
}

export function resolveSidePanelOpenOptions(
  tab: UiAttachChromeTab & { id: number },
): UiAttachChromeSidePanelOpenOptions {
  return typeof tab.windowId === "number" &&
    Number.isInteger(tab.windowId) &&
    tab.windowId >= 0
    ? { windowId: tab.windowId }
    : { tabId: tab.id };
}

async function applyFeedback(
  options: {
    action: UiAttachChromeAction;
    readyTitle: string;
    unsupportedPageTitle: string;
    contentUnavailableTitle: string;
    sidePanelUnavailableTitle: string;
  },
  tabId: number,
  outcome: Exclude<ToolbarEntryOutcome, "ignored" | "superseded">,
): Promise<void> {
  const title = outcome === "ready"
    ? options.readyTitle
    : outcome === "unsupported_page"
      ? options.unsupportedPageTitle
      : outcome === "content_unavailable"
        ? options.contentUnavailableTitle
        : options.sidePanelUnavailableTitle;
  await Promise.allSettled([
    options.action.setBadgeText({ tabId, text: outcome === "ready" ? "" : "!" }),
    options.action.setTitle({ tabId, title }),
  ]);
}

function isKnownUnsupportedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return true;
  }
}
