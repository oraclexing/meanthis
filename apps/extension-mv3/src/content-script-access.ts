import type { UiAttachChrome } from "./extension-api";
import {
  UI_ATTACH_CONTENT_DEACTIVATE,
  UI_ATTACH_CONTENT_PROTOCOL_VERSION,
  UI_ATTACH_CONTENT_READY_GET,
} from "./messages";

const CONTENT_SCRIPT_FILE = "assets/content.js";

export interface ContentScriptAccess {
  ensure(tabId: number, frameId: number, documentId?: string): Promise<boolean>;
}

export function createContentScriptAccess(options: {
  chrome: Pick<UiAttachChrome, "scripting" | "tabs">;
}): ContentScriptAccess {
  const chrome = options.chrome;
  const pendingRequests = new Map<string, Promise<boolean>>();
  const frameAccessStates = new Map<string, FrameAccessState>();

  return {
    ensure(tabId, frameId, documentId) {
      const requestKey = `${tabId}:${frameId}:${documentId ?? "unbound"}`;
      const current = pendingRequests.get(requestKey);
      if (current) return current;
      const frameKey = `${tabId}:${frameId}`;
      const frameState = frameAccessStates.get(frameKey) ?? {
        activeRequests: 0,
        mutationAttempted: false,
      };
      frameState.activeRequests += 1;
      frameAccessStates.set(frameKey, frameState);
      let operation: Promise<boolean>;
      operation = ensureAccess(chrome, frameState, tabId, frameId, documentId).finally(() => {
        if (pendingRequests.get(requestKey) === operation) pendingRequests.delete(requestKey);
        frameState.activeRequests -= 1;
        if (
          frameState.activeRequests === 0 &&
          frameAccessStates.get(frameKey) === frameState
        ) {
          frameAccessStates.delete(frameKey);
        }
      });
      pendingRequests.set(requestKey, operation);
      return operation;
    },
  };
}

interface FrameAccessState {
  activeRequests: number;
  mutationAttempted: boolean;
  mutation?: Promise<boolean>;
}

async function ensureAccess(
  chrome: Pick<UiAttachChrome, "scripting" | "tabs">,
  frameState: FrameAccessState,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  const readiness = await probeCurrentEndpoint(chrome, tabId, frameId, documentId);
  if (readiness === "ready") return true;
  if (readiness === "invalid") return false;
  if (frameState.mutationAttempted) {
    if (frameState.mutation) await frameState.mutation;
    return await probeCurrentEndpoint(chrome, tabId, frameId, documentId) === "ready";
  }
  frameState.mutationAttempted = true;
  const mutation = mutateAccess(chrome, tabId, frameId, documentId);
  frameState.mutation = mutation;
  return await mutation;
}

async function mutateAccess(
  chrome: Pick<UiAttachChrome, "scripting" | "tabs">,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  if (!await deactivatePreviousEndpoint(chrome, tabId, frameId, documentId)) return false;
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
  return await probeCurrentEndpoint(chrome, tabId, frameId, documentId) === "ready";
}

async function deactivatePreviousEndpoint(
  chrome: Pick<UiAttachChrome, "tabs">,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<boolean> {
  try {
    const response = await sendContentMessage(chrome, tabId, frameId, documentId, {
      type: UI_ATTACH_CONTENT_DEACTIVATE,
    });
    return isExactReadyResponse(response);
  } catch {
    // No listener is the expected first-install state and must not block injection.
    return true;
  }
}

type EndpointReadiness = "ready" | "invalid" | "unavailable";

async function probeCurrentEndpoint(
  chrome: Pick<UiAttachChrome, "tabs">,
  tabId: number,
  frameId: number,
  documentId?: string,
): Promise<EndpointReadiness> {
  try {
    const response = await sendContentMessage(chrome, tabId, frameId, documentId, {
      type: UI_ATTACH_CONTENT_READY_GET,
      protocolVersion: UI_ATTACH_CONTENT_PROTOCOL_VERSION,
    });
    if (isExactReadyResponse(response)) return "ready";
    return response === undefined ? "unavailable" : "invalid";
  } catch {
    return "unavailable";
  }
}

function sendContentMessage(
  chrome: Pick<UiAttachChrome, "tabs">,
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  message: Record<string, unknown>,
): Promise<unknown> {
  return chrome.tabs.sendMessage(
    tabId,
    message,
    { frameId, ...(documentId ? { documentId } : {}) },
  );
}

function isExactReadyResponse(value: unknown): value is { ok: true; data: null } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.ok === true && record.data === null;
}
