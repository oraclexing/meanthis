import {
  deriveCapturePageRoutingHint,
} from "@meanthis/hub-core";
import { isLocalBridgeSnapshot, type LocalBridgePageV1 } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import type {
  LocalAgentBridgeClient,
  LocalAgentBridgePublishInput,
} from "./local-agent-bridge";
import type { ActiveSessionCommandData } from "./messages";
import {
  buildPanelBridgeAgentCopy,
  buildPanelBridgeCapture,
  type PanelAgentCopyInput,
} from "./panel-model";
import { derivePanelCopyScope } from "./panel-session-model";

export type LocalAgentBridgeSessionPublisherBridge = Pick<
  LocalAgentBridgeClient,
  "publishSessionContext" | "clearSessionContext" | "clearSharedCapture"
>;

export interface LocalAgentBridgeSessionPublisher {
  reconcile(data: ActiveSessionCommandData): Promise<boolean>;
  clearActivePageContext(): Promise<boolean>;
}

interface PendingReconcile {
  revision: number;
  data: ActiveSessionCommandData;
}

interface ReconcileWaiter {
  revision: number;
  resolve(result: boolean): void;
}

/**
 * Publishes only the capture-time projection of an authoritative session
 * readback. Live observations and activity remain owned by their dedicated
 * background flows.
 */
export function createLocalAgentBridgeSessionPublisher(
  bridge: LocalAgentBridgeSessionPublisherBridge,
): LocalAgentBridgeSessionPublisher {
  let nextRevision = 0;
  let pending: PendingReconcile | null = null;
  let draining = false;
  const waiters: ReconcileWaiter[] = [];

  async function reconcile(data: ActiveSessionCommandData): Promise<boolean> {
    const revision = ++nextRevision;
    pending = { revision, data: structuredClone(data) };
    const completed = new Promise<boolean>((resolve) => {
      waiters.push({ revision, resolve });
    });
    if (!draining) {
      draining = true;
      void drain();
    }
    return completed;
  }

  async function drain(): Promise<void> {
    while (pending) {
      const current = pending;
      pending = null;
      let published = false;
      try {
        published = await reconcileOne(current.data);
      } catch {
        // Bridge availability must not make an authoritative session command fail.
      }
      resolveWaitersThrough(current.revision, published);
    }
    draining = false;
    if (pending) {
      draining = true;
      void drain();
    }
  }

  function resolveWaitersThrough(revision: number, result: boolean): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (waiter.revision > revision) continue;
      waiters.splice(index, 1);
      waiter.resolve(result);
    }
  }

  async function reconcileOne(data: ActiveSessionCommandData): Promise<boolean> {
    if (!data.enabled || !data.activePage) {
      return await clearSharedContextIfRelevant();
    }
    const focusedPage = deriveFocusedBridgePage(data.activePage);
    if (!focusedPage) {
      return await clearSharedContextIfRelevant();
    }
    if (!data.readback) {
      return await clearSharedContextIfRelevant();
    }
    const file = data.readback.file;
    if (data.readback.clearPending) {
      return await clearSharedContextIfRelevant();
    }
    if (!file) {
      return await publishFocusedPage(focusedPage);
    }
    if (file.session.attachments.length === 0) {
      return await publishFocusedPage(focusedPage);
    }

    const currentItemIds = data.currentItemIds === undefined
      ? null
      : new Set(data.currentItemIds);
    const excludedItemIds = currentItemIds === null
      ? new Set<string>()
      : new Set(file.session.attachments
          .map((item) => item.id)
          .filter((itemId) => !currentItemIds.has(itemId)));
    const selectedItemId = data.selectedItemId && (
        currentItemIds === null || currentItemIds.has(data.selectedItemId)
      )
      ? data.selectedItemId
      : null;
    const scope = derivePanelCopyScope(
      file,
      selectedItemId,
      data.activePage,
      currentItemIds ?? new Set(),
      excludedItemIds,
    );
    if (!scope?.current) {
      return await publishFocusedPage(focusedPage);
    }

    const selectedItem = selectedItemId && scope.itemIds.includes(selectedItemId)
      ? file.session.attachments.find((item) => item.id === selectedItemId) ?? null
      : null;
    const representativeItem = selectedItem ?? file.session.attachments.find(
      (item) => scope.itemIds.includes(item.id),
    );
    if (!representativeItem) {
      return await publishFocusedPage(focusedPage);
    }

    const record = representativeItem.sourceRecord as OriginCaptureRecord;
    if (!deriveCapturePageRoutingHint(record)) {
      return await publishFocusedPage(focusedPage);
    }

    const bridgeInput: PanelAgentCopyInput = {
      file,
      attachmentIds: scope.itemIds,
      selectedItemId: representativeItem.id,
      selectedRecord: record,
      viewMode: "agent_safe",
      intent: record.intent,
      includeReplayDiagnostics: true,
      ...(data.metadataDiagnostics
        ? { metadataDiagnostics: data.metadataDiagnostics }
        : {}),
    };
    const capture = buildPanelBridgeCapture(bridgeInput, "capture_time");
    if (!capture) {
      return await publishFocusedPage(focusedPage);
    }
    const handoff = buildPanelBridgeAgentCopy(bridgeInput);
    const input: LocalAgentBridgePublishInput = {
      page: focusedPage,
      attachmentCount: capture.targets.length,
      agentCopy: handoff.ok ? handoff.text : null,
      capture,
    };
    return await bridge.publishSessionContext(input);
  }

  async function publishFocusedPage(page: LocalBridgePageV1): Promise<boolean> {
    return await bridge.publishSessionContext({
      page,
      attachmentCount: 0,
      agentCopy: null,
    });
  }

  async function clearSharedContextIfRelevant(): Promise<boolean> {
    return await bridge.clearSessionContext();
  }

  async function clearActivePageContext(): Promise<boolean> {
    if (!bridge.clearSharedCapture) return false;
    try {
      return await bridge.clearSharedCapture();
    } catch {
      return false;
    }
  }

  return { reconcile, clearActivePageContext };
}

function deriveFocusedBridgePage(
  activePage: ActiveSessionCommandData["activePage"],
): LocalBridgePageV1 | null {
  if (
    !activePage ||
    !Number.isSafeInteger(activePage.tabId) ||
    activePage.tabId < 0 ||
    !Number.isSafeInteger(activePage.frameId) ||
    activePage.frameId < 0
  ) return null;
  const page = {
    pageInstanceId: `chromium-tab:${activePage.tabId}:frame:${activePage.frameId}`,
    route: `${activePage.origin}${activePage.pathname}`,
  };
  return isLocalBridgeSnapshot({
    schemaVersion: "0.1.0",
    kind: "ui-attach.local-bridge-snapshot",
    sequence: 0,
    publishedAt: "2026-01-01T00:00:00.000Z",
    page,
    attachmentCount: 0,
    agentCopy: null,
  }) ? page : null;
}
