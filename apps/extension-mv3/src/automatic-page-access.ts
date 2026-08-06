import type { UiAttachChrome } from "./extension-api";
import { UI_ATTACH_CONTENT_DEACTIVATE } from "./messages";

export const AUTOMATIC_PAGE_ACCESS_ORIGINS = [
  "http://*/*",
  "https://*/*",
] as const;

export interface AutomaticPageAccessController {
  read(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<boolean>;
}

export function createAutomaticPageAccessController(
  chrome: Pick<UiAttachChrome, "permissions" | "tabs">,
): AutomaticPageAccessController {
  const permissions = chrome.permissions;
  const origins = () => [...AUTOMATIC_PAGE_ACCESS_ORIGINS];

  async function read(): Promise<boolean> {
    return permissions.contains({ origins: origins() });
  }

  return {
    read,
    async setEnabled(enabled) {
      if (enabled) {
        // Keep this request as the first async browser call so it retains the switch gesture.
        const granted = await permissions.request({ origins: origins() });
        return granted ? read() : false;
      }

      await deactivateInjectedContent(chrome.tabs);
      await permissions.remove({ origins: origins() });
      const stillEnabled = await read();
      if (stillEnabled) {
        throw new Error("Automatic page access could not be removed.");
      }
      return false;
    },
  };
}

async function deactivateInjectedContent(tabs: Pick<UiAttachChrome, "tabs">["tabs"]): Promise<void> {
  let openTabs;
  try {
    openTabs = await tabs.query({});
  } catch {
    return;
  }
  await Promise.all(openTabs.map(async (tab) => {
    if (typeof tab.id !== "number") return;
    try {
      await tabs.sendMessage(tab.id, { type: UI_ATTACH_CONTENT_DEACTIVATE });
    } catch {
      // Tabs without an injected MeanThis endpoint need no cleanup.
    }
  }));
}
