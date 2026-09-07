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
  | "side_panel_unavailable"
  | "widget_unavailable";

export function createToolbarEntryHandler(options: {
  action: UiAttachChromeAction;
  ensureContentScript(tabId: number, frameId: number): Promise<boolean>;
  showInPageWidget?(tabId: number): Promise<boolean>;
  openSidePanel(options: UiAttachChromeSidePanelOpenOptions): Promise<void>;
  notifyReady?(): Promise<void>;
  readyTitle: string;
  unsupportedPageTitle: string;
  contentUnavailableTitle: string;
  sidePanelUnavailableTitle: string;
  widgetUnavailableTitle: string;
}): (tab: UiAttachChromeTab) => Promise<ToolbarEntryOutcome> {
  const latestRevisionByTab = new Map<number, number>();
  let nextRevision = 0;
  const sidePanelFallbackPages = new Map<number, string>();
  return async (tab) => {
    if (typeof tab.id !== "number" || !Number.isInteger(tab.id) || tab.id < 0) return "ignored";
    const tabId = tab.id;
    const revision = ++nextRevision;
    latestRevisionByTab.set(tabId, revision);
    const unsupportedPage = isKnownUnsupportedPage(tab.url);
    const pageKey = JSON.stringify([tab.windowId ?? null, tab.url ?? null]);
    const openPanelNow = unsupportedPage || !options.showInPageWidget ||
      sidePanelFallbackPages.get(tabId) === pageKey;
    if (sidePanelFallbackPages.get(tabId) !== pageKey) sidePanelFallbackPages.delete(tabId);
    // Invoke synchronously inside this click, before content injection or widget
    // readiness can consume Chrome's transient user activation.
    const panelResult = openPanelNow
      ? settle(() => options.openSidePanel(resolveSidePanelOpenOptions({ ...tab, id: tabId })))
      : null;
    const contentAccess = await settle(() => unsupportedPage
      ? Promise.resolve(false) : options.ensureContentScript(tabId, 0));
    if (latestRevisionByTab.get(tabId) !== revision) return "superseded";
    let outcome: Exclude<ToolbarEntryOutcome, "ignored" | "superseded">;
    if (panelResult) {
      const surface = await panelResult;
      if (unsupportedPage) outcome = "unsupported_page";
      else if (surface.status === "rejected") outcome = "side_panel_unavailable";
      else outcome = contentAccess.status === "fulfilled" && contentAccess.value
        ? "ready" : "content_unavailable";
    } else {
      const widget = contentAccess.status === "fulfilled" && contentAccess.value
        ? await settle(() => options.showInPageWidget!(tabId)) : null;
      if (latestRevisionByTab.get(tabId) !== revision) return "superseded";
      if (widget?.status === "fulfilled" && widget.value) outcome = "ready";
      else {
        sidePanelFallbackPages.set(tabId, pageKey);
        outcome = "widget_unavailable";
      }
    }
    if (latestRevisionByTab.get(tabId) !== revision) return "superseded";
    await applyFeedback(options, tabId, outcome);
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
    widgetUnavailableTitle: string;
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
        : outcome === "widget_unavailable"
          ? options.widgetUnavailableTitle
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

function settle<T>(action: () => Promise<T>): Promise<
  { status: "fulfilled"; value: T } | { status: "rejected" }
> {
  try {
    return action().then((value) => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const }));
  } catch {
    return Promise.resolve({ status: "rejected" as const });
  }
}
