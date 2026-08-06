import "./extension-api";
import { createBackgroundController } from "./background-controller";
import { createContentScriptAccess } from "./content-script-access";
import { createFirstCaptureDisclosureStore } from "./first-capture-disclosure";
import { createExtensionSessionStore } from "./session-store";
import {
  backgroundRuntimeFeatures,
  registerSurfaceBackground,
} from "./surface-background.development";
import { createToolbarEntryHandler } from "./toolbar-entry";
import {
  UI_ATTACH_CONTEXT_MENU_ID,
} from "./messages";

const storageAccessReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
])
  .then(() => true, () => false);
const store = createExtensionSessionStore({ storage: chrome.storage.local });
const firstCaptureDisclosure = createFirstCaptureDisclosureStore({
  storage: chrome.storage.local,
});
const contentScriptAccess = createContentScriptAccess({ chrome });
const controller = createBackgroundController({
  chrome,
  store,
  firstCaptureDisclosure,
  runtimeFeatures: backgroundRuntimeFeatures,
  storageAccessReady,
  ensureContentScript: contentScriptAccess.ensure,
});

const handleToolbarClick = createToolbarEntryHandler({
  action: chrome.action,
  ensureContentScript: contentScriptAccess.ensure,
  openSidePanel: async (openOptions) => {
    if (!chrome.sidePanel) throw new Error("Side panel API is unavailable.");
    await chrome.sidePanel.open(openOptions);
  },
  notifyReady: () => controller.refreshActivePage(),
  readyTitle: getLocalizedMessage("open_ui_attach", "Open MeanThis"),
  unsupportedPageTitle: getLocalizedMessage(
    "toolbar_unsupported_page",
    "MeanThis works on HTTP(S) pages. Open a web page and try again.",
  ),
  contentUnavailableTitle: getLocalizedMessage(
    "toolbar_content_unavailable",
    "MeanThis could not access this page. Reload it, then select MeanThis again.",
  ),
  sidePanelUnavailableTitle: getLocalizedMessage(
    "toolbar_side_panel_unavailable",
    "MeanThis could not open its side panel. Reload the page, then try again.",
  ),
});

chrome.action.onClicked.addListener((tab) => {
  void handleToolbarClick(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

ensureContextMenu();
controller.register();
registerSurfaceBackground();

function ensureContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: UI_ATTACH_CONTEXT_MENU_ID,
      title: getLocalizedMessage("add_page_element", "Add page element"),
      contexts: ["all"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
}

function getLocalizedMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}
