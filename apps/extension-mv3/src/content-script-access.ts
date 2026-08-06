import type { UiAttachChrome } from "./extension-api";
import { UI_ATTACH_CONTENT_READY_GET } from "./messages";

const CONTENT_SCRIPT_FILE = "assets/content.js";

export interface ContentScriptAccess {
  ensure(tabId: number, frameId: number, documentId?: string): Promise<boolean>;
}

export function createContentScriptAccess(options: {
  chrome: Pick<UiAttachChrome, "scripting" | "tabs">;
}): ContentScriptAccess {
  const chrome = options.chrome;
  const pending = new Map<string, Promise<boolean>>();

  return {
    ensure(tabId, frameId, documentId) {
      const key = `${tabId}:${frameId}:${documentId ?? "unbound"}`;
      const current = pending.get(key);
      if (current) return current;
      let operation: Promise<boolean>;
      operation = ensureAccess(chrome, tabId, frameId, documentId).finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
      });
      pending.set(key, operation);
      return operation;
    },
  };
}

async function ensureAccess(
  chrome: Pick<UiAttachChrome, "scripting" | "tabs">,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (await endpointReady(chrome, tabId, frameId, documentId)) return true;
  try {
    await chrome.scripting.executeScript({
      files: [CONTENT_SCRIPT_FILE],
      target: documentId
        ? { tabId, documentIds: [documentId] }
        : { tabId, frameIds: [frameId] },
    });
  } catch {
    return false;
  }
  return endpointReady(chrome, tabId, frameId, documentId);
}

async function endpointReady(
  chrome: Pick<UiAttachChrome, "tabs">,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: UI_ATTACH_CONTENT_READY_GET },
      { frameId, ...(documentId ? { documentId } : {}) },
    );
    return isExactReadyResponse(response);
  } catch {
    return false;
  }
}

function isExactReadyResponse(value: unknown): value is { ok: true; data: null } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.ok === true && record.data === null;
}
