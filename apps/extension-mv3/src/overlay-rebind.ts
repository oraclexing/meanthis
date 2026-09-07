import type {
  OverlayRebindStatus,
  OverlayRebindStatusItem,
  OverlayRestoreData,
  OverlayRestoreItem,
  OverlayStateMessage,
} from "./messages";
import {
  isDomReplayTargetVisible,
  resolveDomReplayTargetResult,
} from "./replay-dom";

export interface OverlayRebindController {
  restore(data: OverlayRestoreData): Promise<void>;
  applyState(message: OverlayStateMessage): void;
  trackCurrentRoute(): void;
  commitCurrent(item: OverlayRestoreItem, target: HTMLElement): Promise<void>;
  readStatus(): OverlayRebindStatusItem[];
  readCurrentTarget(itemId: string, attachmentId: string): OverlayRebindTargetRead;
  isCurrentTarget(read: OverlayRebindTargetRead): boolean;
  dispose(): void;
}

export type OverlayRebindTargetReadStatus =
  | OverlayRebindStatus
  | "stale"
  | "unavailable";

export interface OverlayRebindTargetRead {
  itemId: string;
  attachmentId: string;
  status: OverlayRebindTargetReadStatus;
  target: HTMLElement | null;
  revision: number;
  origin: string;
  pathname: string;
}

interface OverlayNavigationLike {
  addEventListener(type: "currententrychange", listener: EventListener): void;
  removeEventListener(type: "currententrychange", listener: EventListener): void;
}

export function createOverlayRebindController(options: {
  root: Document;
  bindTarget: (item: OverlayRestoreItem, target: HTMLElement) => void;
  unbindTarget?: (itemId: string) => void;
  onRouteChange?: () => void;
  routePollIntervalMs?: number;
  resolveTarget?: typeof resolveDomReplayTargetResult;
}): OverlayRebindController {
  const descriptors = new Map<string, OverlayRestoreItem>();
  const statuses = new Map<string, OverlayRebindStatus>();
  const trackedTargets = new Map<string, HTMLElement>();
  const pendingRebindItemIds = new Set<string>();
  const scheduledRebindItemIds = new Set<string>();
  let revision = 0;
  let scheduled = false;
  let rebindRequested = false;
  let rebindPromise: Promise<void> | null = null;
  let disposed = false;
  let restoreRouteKey: string | null = null;
  let routePollHandle: number | null = null;
  const view = options.root.defaultView;
  const navigation = (view as (Window & { navigation?: OverlayNavigationLike }) | null)
    ?.navigation;
  const MutationObserverConstructor = options.root.defaultView?.MutationObserver;
  const observer = MutationObserverConstructor
    ? new MutationObserverConstructor((records) => handleMutations(records))
    : null;
  if (observer && options.root.documentElement) {
    observer.observe(options.root.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  view?.addEventListener("popstate", handlePotentialRouteChange);
  navigation?.addEventListener("currententrychange", handlePotentialRouteChange);

  async function restore(data: OverlayRestoreData): Promise<void> {
    const previousDescriptors = new Map(descriptors);
    const previousStatuses = new Map(statuses);
    const previousTargets = new Map(trackedTargets);
    const sameRoute = restoreRouteKey !== null && restoreRouteKey === currentRouteKey();
    const rebindItemIds: string[] = [];
    revision += 1;
    descriptors.clear();
    statuses.clear();
    trackedTargets.clear();
    pendingRebindItemIds.clear();
    scheduledRebindItemIds.clear();
    data.items.forEach((item) => {
      const descriptor = {
        ...item,
        locators: item.locators.map((locator) => ({ ...locator })),
      };
      descriptors.set(item.itemId, descriptor);
      const previousDescriptor = previousDescriptors.get(item.itemId);
      const previousStatus = previousStatuses.get(item.itemId);
      const previousTarget = previousTargets.get(item.itemId);
      const retainTarget = sameRoute &&
        previousStatus === "restored" &&
        sameReplayDescriptor(previousDescriptor, descriptor) &&
        previousTarget?.isConnected === true &&
        isDomReplayTargetVisible(previousTarget);
      if (retainTarget) {
        statuses.set(item.itemId, "restored");
        trackedTargets.set(item.itemId, previousTarget);
        options.bindTarget(descriptor, previousTarget);
      } else {
        statuses.set(item.itemId, "checking");
        rebindItemIds.push(item.itemId);
      }
    });
    restoreRouteKey = descriptors.size > 0 ? currentRouteKey() : null;
    updateRouteWatcher();
    await requestRebind(rebindItemIds);
  }

  async function commitCurrent(item: OverlayRestoreItem, target: HTMLElement): Promise<void> {
    if (disposed || !target.isConnected || item.locators.length === 0) return;
    revision += 1;
    const descriptor = {
      ...item,
      locators: item.locators.map((locator) => ({ ...locator })),
    };
    descriptors.set(item.itemId, descriptor);
    statuses.set(item.itemId, "restored");
    trackedTargets.set(item.itemId, target);
    pendingRebindItemIds.delete(item.itemId);
    scheduledRebindItemIds.delete(item.itemId);
    restoreRouteKey = currentRouteKey();
    updateRouteWatcher();
  }

  function trackCurrentRoute(): void {
    if (disposed) return;
    restoreRouteKey = currentRouteKey();
    updateRouteWatcher();
  }

  function applyState(message: OverlayStateMessage): void {
    revision += 1;
    const retained = new Map(message.items.map((item) => [item.itemId, item]));
    for (const itemId of descriptors.keys()) {
      if (!retained.has(itemId)) {
        descriptors.delete(itemId);
        statuses.delete(itemId);
        trackedTargets.delete(itemId);
        pendingRebindItemIds.delete(itemId);
        scheduledRebindItemIds.delete(itemId);
      }
    }
    for (const [itemId, descriptor] of descriptors) {
      const item = retained.get(itemId);
      if (item) descriptors.set(itemId, { ...descriptor, ...item });
    }
    if (descriptors.size === 0) restoreRouteKey = null;
    updateRouteWatcher();
  }

  function scheduleRebind(itemIds: Iterable<string>): void {
    if (disposed || descriptors.size === 0) return;
    for (const itemId of itemIds) {
      if (descriptors.has(itemId)) scheduledRebindItemIds.add(itemId);
    }
    if (scheduled || scheduledRebindItemIds.size === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const nextItemIds = [...scheduledRebindItemIds];
      scheduledRebindItemIds.clear();
      void requestRebind(nextItemIds);
    });
  }

  function handlePotentialRouteChange(): void {
    if (disposed) return;
    if (clearForRouteChange()) return;
    scheduleRebind(descriptors.keys());
  }

  function handleMutations(records: MutationRecord[]): void {
    if (disposed) return;
    if (clearForRouteChange()) return;
    const hasAddedNodes = records.some(
      (record) => record.type === "childList" && record.addedNodes.length > 0,
    );
    const affectedItemIds: string[] = [];
    for (const itemId of descriptors.keys()) {
      const status = statuses.get(itemId) ?? "checking";
      const target = trackedTargets.get(itemId);
      if (target?.isConnected) {
        if (!records.some((record) => mutationMayAffectConnectedTarget(record, target))) {
          continue;
        }
        if (isDomReplayTargetVisible(target)) {
          if (status !== "restored") {
            statuses.set(itemId, "restored");
            options.bindTarget(descriptors.get(itemId)!, target);
          }
        } else if (status !== "missing") {
          statuses.set(itemId, "missing");
          options.unbindTarget?.(itemId);
        }
        continue;
      }
      if (status === "restored" || hasAddedNodes) affectedItemIds.push(itemId);
    }
    scheduleRebind(affectedItemIds);
  }

  function clearForRouteChange(): boolean {
    const routeKey = currentRouteKey();
    if (routeKey === null) return false;
    if (
      restoreRouteKey !== null &&
      routeKey !== restoreRouteKey
    ) {
      revision += 1;
      restoreRouteKey = null;
      descriptors.clear();
      statuses.clear();
      trackedTargets.clear();
      pendingRebindItemIds.clear();
      scheduledRebindItemIds.clear();
      rebindRequested = false;
      updateRouteWatcher();
      options.onRouteChange?.();
      return true;
    }
    return false;
  }

  function updateRouteWatcher(): void {
    const shouldWatch = !disposed && view !== null && restoreRouteKey !== null;
    if (shouldWatch && routePollHandle === null) {
      routePollHandle = view.setInterval(
        () => clearForRouteChange(),
        options.routePollIntervalMs ?? 250,
      );
    } else if (!shouldWatch && routePollHandle !== null) {
      view?.clearInterval(routePollHandle);
      routePollHandle = null;
    }
  }

  function requestRebind(itemIds: Iterable<string>): Promise<void> {
    for (const itemId of itemIds) {
      if (descriptors.has(itemId)) pendingRebindItemIds.add(itemId);
    }
    if (pendingRebindItemIds.size === 0) return Promise.resolve();
    rebindRequested = true;
    return waitForRebindDrain();
  }

  function waitForRebindDrain(): Promise<void> {
    if (!rebindPromise) {
      rebindPromise = (async () => {
        while (
          rebindRequested && !disposed && descriptors.size > 0 &&
          pendingRebindItemIds.size > 0
        ) {
          rebindRequested = false;
          const itemIds = [...pendingRebindItemIds];
          pendingRebindItemIds.clear();
          await rebindItems(revision, itemIds);
        }
        if (disposed || descriptors.size === 0 || pendingRebindItemIds.size === 0) {
          rebindRequested = false;
        }
      })().finally(() => {
        rebindPromise = null;
      });
    }
    return rebindPromise.then(() => {
      if (
        rebindRequested && !disposed && descriptors.size > 0 &&
        pendingRebindItemIds.size > 0
      ) {
        return waitForRebindDrain();
      }
    });
  }

  async function rebindItems(expectedRevision: number, itemIds: string[]): Promise<void> {
    for (const itemId of itemIds) {
      const descriptor = descriptors.get(itemId);
      if (!descriptor) continue;
      const result = await (options.resolveTarget ?? resolveDomReplayTargetResult)(
        options.root,
        descriptor.locators,
      );
      if (disposed || revision !== expectedRevision) return;
      if (descriptors.get(itemId) !== descriptor) continue;
      statuses.set(itemId, result.status);
      if (result.status === "restored") {
        trackedTargets.set(itemId, result.target);
        options.bindTarget(descriptor, result.target);
      } else {
        options.unbindTarget?.(itemId);
      }
    }
  }

  function readStatus(): OverlayRebindStatusItem[] {
    return Array.from(descriptors.keys(), (itemId) => ({
      itemId,
      status: statuses.get(itemId) ?? "checking",
    }));
  }

  function readCurrentTarget(
    itemId: string,
    attachmentId: string,
  ): OverlayRebindTargetRead {
    const route = currentRouteLocation();
    const base = {
      itemId,
      attachmentId,
      target: null,
      revision,
      origin: route?.origin ?? "",
      pathname: route?.pathname ?? "",
    } as const;
    const descriptor = descriptors.get(itemId);
    if (!descriptor || descriptor.attachmentId !== attachmentId) {
      return { ...base, status: "unavailable" };
    }
    if (!route || restoreRouteKey === null || route.key !== restoreRouteKey) {
      return { ...base, status: "stale" };
    }
    const status = statuses.get(itemId) ?? "checking";
    if (status !== "restored") return { ...base, status };
    const target = trackedTargets.get(itemId);
    if (!target?.isConnected || !isDomReplayTargetVisible(target)) {
      return { ...base, status: "missing" };
    }
    return { ...base, status: "restored", target };
  }

  function isCurrentTarget(read: OverlayRebindTargetRead): boolean {
    if (disposed || read.status !== "restored" || !read.target) return false;
    const current = readCurrentTarget(read.itemId, read.attachmentId);
    return current.status === "restored" &&
      current.target === read.target &&
      current.revision === read.revision &&
      current.origin === read.origin &&
      current.pathname === read.pathname;
  }

  function dispose(): void {
    disposed = true;
    revision += 1;
    descriptors.clear();
    statuses.clear();
    trackedTargets.clear();
    pendingRebindItemIds.clear();
    scheduledRebindItemIds.clear();
    rebindRequested = false;
    observer?.disconnect();
    view?.removeEventListener("popstate", handlePotentialRouteChange);
    navigation?.removeEventListener("currententrychange", handlePotentialRouteChange);
    updateRouteWatcher();
  }

  function currentRouteKey(): string | null {
    return currentRouteLocation()?.key ?? null;
  }

  function currentRouteLocation(): {
    key: string;
    origin: string;
    pathname: string;
  } | null {
    if (!view) return null;
    try {
      const href = view.location?.href;
      if (!href) return null;
      const url = new URL(href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return {
        key: `${url.origin}${url.pathname}`,
        origin: url.origin,
        pathname: url.pathname,
      };
    } catch {
      return null;
    }
  }

  return {
    restore,
    applyState,
    trackCurrentRoute,
    commitCurrent,
    readStatus,
    readCurrentTarget,
    isCurrentTarget,
    dispose,
  };
}

function mutationMayAffectConnectedTarget(
  record: MutationRecord,
  target: HTMLElement,
): boolean {
  if (record.target === target || target.contains(record.target)) return true;
  return record.type === "attributes" &&
    record.target instanceof HTMLElement &&
    record.target.contains(target) &&
    (record.attributeName === "class" ||
      record.attributeName === "hidden" ||
      record.attributeName === "style");
}

function sameReplayDescriptor(
  left: OverlayRestoreItem | undefined,
  right: OverlayRestoreItem,
): boolean {
  return left?.attachmentId === right.attachmentId &&
    left.locators.length === right.locators.length &&
    left.locators.every((locator, index) => {
      const candidate = right.locators[index];
      return candidate?.strategy === locator.strategy &&
        candidate.value === locator.value &&
        candidate.confidence === locator.confidence;
    });
}
