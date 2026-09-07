import type { ExtensionStorageArea } from "./capture-store";

export interface UiAttachChromeEvent<T extends (...args: never[]) => unknown> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
}

export interface UiAttachChromeMessageSender {
  id?: string;
  documentId?: string;
  frameId?: number;
  url?: string;
  tab?: {
    id?: number;
    url?: string;
    windowId?: number;
  };
}

export interface UiAttachChromeContextMenuClickData {
  frameId?: number;
  frameUrl?: string;
  menuItemId: string | number;
  pageUrl?: string;
}

export interface UiAttachChromeTab {
  id?: number;
  url?: string;
  windowId?: number;
}

export interface UiAttachChromeAction {
  onClicked: UiAttachChromeEvent<(tab: UiAttachChromeTab) => void>;
  setBadgeText(details: { tabId: number; text: string }): Promise<void>;
  setTitle(details: { tabId: number; title: string }): Promise<void>;
}

export interface UiAttachChromeI18n {
  getMessage(key: string): string;
  getUILanguage(): string;
}

export interface UiAttachChromeAlarms {
  create(name: string, alarmInfo: { delayInMinutes: number }): void;
  clear(name: string): Promise<boolean>;
  onAlarm: UiAttachChromeEvent<(alarm: { name: string }) => void>;
}

export interface UiAttachChromePort {
  name: string;
  sender?: UiAttachChromeMessageSender;
  disconnect(): void;
  onDisconnect: UiAttachChromeEvent<() => void>;
  onMessage?: UiAttachChromeEvent<(message: unknown) => void>;
  postMessage?(message: unknown): void;
}

export interface UiAttachChromeRuntime {
  id: string;
  lastError?: {
    message: string;
  };
  onInstalled: UiAttachChromeEvent<() => void>;
  onConnect: UiAttachChromeEvent<(port: UiAttachChromePort) => void>;
  onMessage: UiAttachChromeEvent<
    (
      message: unknown,
      sender: UiAttachChromeMessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void
  >;
  connect(options: { name: string }): UiAttachChromePort;
  getURL(path: string): string;
  openOptionsPage(): Promise<void>;
  sendMessage(message: unknown): Promise<unknown>;
  sendNativeMessage(application: string, message: object): Promise<unknown>;
}

export interface UiAttachChromePermissions {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
}

export interface UiAttachChromeFrame {
  documentId?: string;
  frameId: number;
  parentFrameId: number;
  url: string;
}

export interface UiAttachChromeFrameDetails {
  documentId?: string;
  parentFrameId: number;
  url: string;
}

export interface UiAttachChromeNavigationCommittedDetails {
  documentId?: string;
  frameId: number;
  parentFrameId: number;
  tabId: number;
  url: string;
}

export interface UiAttachChromeWebNavigation {
  getAllFrames(details: { tabId: number }): Promise<UiAttachChromeFrame[] | undefined>;
  getFrame(
    details: { tabId: number; frameId?: number; documentId?: string },
  ): Promise<UiAttachChromeFrameDetails | undefined>;
  onCommitted: UiAttachChromeEvent<(details: UiAttachChromeNavigationCommittedDetails) => void>;
  onHistoryStateUpdated: UiAttachChromeEvent<
    (details: UiAttachChromeNavigationCommittedDetails) => void
  >;
}

export interface UiAttachChromeContextMenus {
  create(options: {
    contexts: string[];
    documentUrlPatterns?: string[];
    id: string;
    title: string;
  }): void;
  onClicked: UiAttachChromeEvent<
    (info: UiAttachChromeContextMenuClickData, tab?: UiAttachChromeTab) => void
  >;
  removeAll(callback?: () => void): void;
}

export interface UiAttachChromeSidePanel {
  open(options: UiAttachChromeSidePanelOpenOptions): Promise<void>;
}

export type UiAttachChromeSidePanelOpenOptions =
  | { tabId: number; windowId?: never }
  | { tabId?: never; windowId: number };

export interface UiAttachChromeScripting {
  executeScript(options: {
    files: string[];
    target: {
      tabId: number;
      documentIds?: string[];
      frameIds?: number[];
    };
  }): Promise<unknown[]>;
}

export interface UiAttachChromeStorage {
  local: ExtensionStorageArea & {
    setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
  };
  session: ExtensionStorageArea & {
    setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
  };
  onChanged: UiAttachChromeEvent<
    (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, areaName: string) => void
  >;
}

export interface UiAttachChromeTabs {
  query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<UiAttachChromeTab[]>;
  create(createProperties: { url: string; active?: boolean }): Promise<UiAttachChromeTab>;
  update(
    tabId: number,
    updateProperties: { active?: boolean },
  ): Promise<UiAttachChromeTab>;
  sendMessage(
    tabId: number,
    message: unknown,
    options?: { documentId?: string; frameId?: number },
  ): Promise<unknown>;
  onActivated: UiAttachChromeEvent<
    (activeInfo: { tabId: number; windowId: number }) => void
  >;
  onUpdated: UiAttachChromeEvent<
    (
      tabId: number,
      changeInfo: { status?: string; url?: string },
      tab: UiAttachChromeTab,
    ) => void
  >;
}

export interface UiAttachChromeWindows {
  update(
    windowId: number,
    updateInfo: { focused: boolean },
  ): Promise<{ focused?: boolean; id?: number }>;
}

export interface UiAttachChrome {
  action: UiAttachChromeAction;
  alarms: UiAttachChromeAlarms;
  contextMenus: UiAttachChromeContextMenus;
  i18n?: UiAttachChromeI18n;
  permissions: UiAttachChromePermissions;
  runtime: UiAttachChromeRuntime;
  scripting: UiAttachChromeScripting;
  sidePanel?: UiAttachChromeSidePanel;
  storage: UiAttachChromeStorage;
  tabs: UiAttachChromeTabs;
  windows?: UiAttachChromeWindows;
  webNavigation: UiAttachChromeWebNavigation;
}

declare global {
  const chrome: UiAttachChrome;
}
