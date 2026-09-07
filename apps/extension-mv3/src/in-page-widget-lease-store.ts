import type { ExtensionStorageArea } from "./capture-store";
import { isCapability } from "./in-page-widget-contract";

export const IN_PAGE_WIDGET_LEASE_STORAGE_KEY = "ui-attach:in-page-widget-leases:v1";
export const IN_PAGE_WIDGET_LEASE_DEFAULT_TTL_MS = 5 * 60_000;
export const IN_PAGE_WIDGET_LEASE_DEFAULT_MAX_ENTRIES = 32;

const IN_PAGE_WIDGET_LEASE_MAX_TTL_MS = 60 * 60_000;
const IN_PAGE_WIDGET_LEASE_MAX_ENTRIES = 64;
const MAX_DOCUMENT_ID_LENGTH = 256;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_PATHNAME_LENGTH = 2_048;

export interface InPageWidgetLeaseSaveInput {
  surfaceId: string;
  capability: string;
  tabId: number;
  windowId: number;
  documentId: string;
  origin: string;
  pathname: string;
  actionContext?: PersistedInPageWidgetActionContext | null;
  frameContext?: PersistedInPageWidgetActionContext | null;
}

export interface PersistedInPageWidgetActionContext {
  frameId: number;
  documentId: string;
  origin: string;
  pathname: string;
}

export interface PersistedInPageWidgetLease {
  surfaceId: string;
  capabilityDigest: string;
  tabId: number;
  windowId: number;
  documentId: string;
  origin: string;
  pathname: string;
  expiresAt: number;
  actionContext: PersistedInPageWidgetActionContext | null;
  frameContext?: PersistedInPageWidgetActionContext | null;
}

export interface InPageWidgetLeaseStore {
  save(input: InPageWidgetLeaseSaveInput, now: number): Promise<PersistedInPageWidgetLease>;
  revoke(surfaceId: string): Promise<void>;
  revokeTab(tabId: number): Promise<void>;
  restore(
    surfaceId: string,
    rawCapability: string,
    now: number,
  ): Promise<PersistedInPageWidgetLease | null>;
}

export interface InPageWidgetLeaseStoreOptions {
  storage: ExtensionStorageArea;
  ttlMs?: number;
  maxEntries?: number;
  digest?(rawCapability: string): Promise<string>;
}

interface LeaseSnapshot {
  schemaVersion: "1";
  leases: PersistedInPageWidgetLease[];
}

interface ReadSnapshotResult {
  leases: PersistedInPageWidgetLease[];
  prunedExpired: boolean;
}

// chrome.storage.session is a single trusted store within one Service Worker.
// Share the read-modify-write tail across helper instances in that worker so a
// second integration owner cannot race a save/revoke against the first.
const storageMutationTails = new WeakMap<ExtensionStorageArea, Promise<void>>();

/**
 * Persists only a one-way binding for an in-page widget capability. The raw
 * capability remains in the caller's live worker state and must be supplied
 * again before a stored lease can be restored after a worker restart.
 */
export function createInPageWidgetLeaseStore(
  options: InPageWidgetLeaseStoreOptions,
): InPageWidgetLeaseStore {
  const ttlMs = validateIntegerOption(
    "ttlMs",
    options.ttlMs ?? IN_PAGE_WIDGET_LEASE_DEFAULT_TTL_MS,
    1,
    IN_PAGE_WIDGET_LEASE_MAX_TTL_MS,
  );
  const maxEntries = validateIntegerOption(
    "maxEntries",
    options.maxEntries ?? IN_PAGE_WIDGET_LEASE_DEFAULT_MAX_ENTRIES,
    1,
    IN_PAGE_WIDGET_LEASE_MAX_ENTRIES,
  );
  const digest = options.digest ?? digestCapability;
  return { save, revoke, revokeTab, restore };

  function save(
    input: InPageWidgetLeaseSaveInput,
    now: number,
  ): Promise<PersistedInPageWidgetLease> {
    if (!isValidSaveInput(input) || !isTimestamp(now) || !Number.isSafeInteger(now + ttlMs)) {
      return Promise.reject(new Error("Invalid MeanThis in-page widget lease."));
    }
    const clonedInput = { ...input };
    return runExclusive(async () => {
      const capabilityDigest = await digest(clonedInput.capability);
      if (!isCapabilityDigest(capabilityDigest)) {
        throw new Error("Invalid MeanThis in-page widget capability digest.");
      }
      const record: PersistedInPageWidgetLease = {
        surfaceId: clonedInput.surfaceId,
        capabilityDigest,
        tabId: clonedInput.tabId,
        windowId: clonedInput.windowId,
        documentId: clonedInput.documentId,
        origin: clonedInput.origin,
        pathname: clonedInput.pathname,
        expiresAt: now + ttlMs,
        actionContext: clonedInput.actionContext ? { ...clonedInput.actionContext } : null,
        ...(Object.hasOwn(clonedInput, "frameContext") ? {
          frameContext: clonedInput.frameContext ? { ...clonedInput.frameContext } : null,
        } : {}),
      };
      const current = await readSnapshot(now);
      const retained = current?.leases.filter((lease) =>
        lease.surfaceId !== record.surfaceId && lease.tabId !== record.tabId
      ) ?? [];
      retained.push(record);
      retained.sort(compareLeaseExpiry);
      while (retained.length > maxEntries) retained.shift();
      await writeSnapshot(retained);
      return cloneLease(record);
    });
  }

  function revoke(surfaceId: string): Promise<void> {
    if (!isUuid(surfaceId)) {
      return Promise.reject(new Error("Invalid MeanThis in-page widget surface id."));
    }
    return runExclusive(async () => {
      const values = await options.storage.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      const rawSnapshot = values[IN_PAGE_WIDGET_LEASE_STORAGE_KEY];
      if (rawSnapshot === undefined) return;
      const snapshot = parseSnapshot(rawSnapshot, maxEntries);
      if (!snapshot) {
        await options.storage.remove(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
        return;
      }
      await writeSnapshot(snapshot.leases.filter((lease) => lease.surfaceId !== surfaceId));
    });
  }

  function revokeTab(tabId: number): Promise<void> {
    if (!isChromeId(tabId)) {
      return Promise.reject(new Error("Invalid MeanThis in-page widget tab id."));
    }
    return runExclusive(async () => {
      const values = await options.storage.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      const rawSnapshot = values[IN_PAGE_WIDGET_LEASE_STORAGE_KEY];
      if (rawSnapshot === undefined) return;
      const snapshot = parseSnapshot(rawSnapshot, maxEntries);
      if (!snapshot) {
        await options.storage.remove(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
        return;
      }
      await writeSnapshot(snapshot.leases.filter((lease) => lease.tabId !== tabId));
    });
  }

  function restore(
    surfaceId: string,
    rawCapability: string,
    now: number,
  ): Promise<PersistedInPageWidgetLease | null> {
    if (!isUuid(surfaceId) || !isCapability(rawCapability) || !isTimestamp(now) ||
        !Number.isSafeInteger(now + ttlMs)) {
      return Promise.resolve(null);
    }
    return runExclusive(async () => {
      const current = await readSnapshot(now);
      if (!current) return null;
      const candidate = current.leases.find((lease) => lease.surfaceId === surfaceId);
      if (!candidate) {
        if (current.prunedExpired) await writeSnapshot(current.leases);
        return null;
      }

      let actualDigest: string | null = null;
      try {
        const value = await digest(rawCapability);
        if (isCapabilityDigest(value)) actualDigest = value;
      } catch {
        // Without a valid digest, the persisted binding cannot authenticate.
      }
      if (!actualDigest || !constantTimeEqual(actualDigest, candidate.capabilityDigest)) {
        if (current.prunedExpired) await writeSnapshot(current.leases);
        return null;
      }
      const renewed: PersistedInPageWidgetLease = {
        ...candidate,
        expiresAt: now + ttlMs,
      };
      const renewedLeases = current.leases.map((lease) =>
        lease.surfaceId === renewed.surfaceId ? renewed : lease
      ).sort(compareLeaseExpiry);
      await writeSnapshot(renewedLeases);
      return cloneLease(renewed);
    }).catch(() => null);
  }

  async function readSnapshot(now: number): Promise<ReadSnapshotResult | null> {
    const values = await options.storage.get(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
    const rawSnapshot = values[IN_PAGE_WIDGET_LEASE_STORAGE_KEY];
    if (rawSnapshot === undefined) return { leases: [], prunedExpired: false };
    const snapshot = parseSnapshot(rawSnapshot, maxEntries);
    if (!snapshot || snapshot.leases.some((lease) => lease.expiresAt > now + ttlMs)) {
      await options.storage.remove(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      return null;
    }
    const leases = snapshot.leases.filter((lease) => lease.expiresAt > now);
    return {
      leases,
      prunedExpired: leases.length !== snapshot.leases.length,
    };
  }

  async function writeSnapshot(leases: PersistedInPageWidgetLease[]): Promise<void> {
    if (leases.length === 0) {
      await options.storage.remove(IN_PAGE_WIDGET_LEASE_STORAGE_KEY);
      return;
    }
    const snapshot: LeaseSnapshot = {
      schemaVersion: "1",
      leases: leases.map(cloneLease),
    };
    await options.storage.set({ [IN_PAGE_WIDGET_LEASE_STORAGE_KEY]: snapshot });
  }

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storageMutationTails.get(options.storage) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    storageMutationTails.set(options.storage, result.then(() => undefined, () => undefined));
    return result;
  }
}

function parseSnapshot(value: unknown, maxEntries: number): LeaseSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "leases"]) ||
      value.schemaVersion !== "1" || !Array.isArray(value.leases) ||
      value.leases.length === 0 || value.leases.length > maxEntries) return null;
  const leases: PersistedInPageWidgetLease[] = [];
  const surfaceIds = new Set<string>();
  const tabIds = new Set<number>();
  for (const item of value.leases) {
    const lease = parseLease(item);
    if (!lease || surfaceIds.has(lease.surfaceId) || tabIds.has(lease.tabId)) return null;
    surfaceIds.add(lease.surfaceId);
    tabIds.add(lease.tabId);
    leases.push(lease);
  }
  return { schemaVersion: "1", leases };
}

function parseLease(value: unknown): PersistedInPageWidgetLease | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "surfaceId",
    "capabilityDigest",
    "tabId",
    "windowId",
    "documentId",
    "origin",
    "pathname",
    "expiresAt",
    ...(Object.hasOwn(value, "actionContext") ? ["actionContext"] : []),
    ...(Object.hasOwn(value, "frameContext") ? ["frameContext"] : []),
  ]) || !isUuid(value.surfaceId) || !isCapabilityDigest(value.capabilityDigest) ||
      !isChromeId(value.tabId) || !isChromeId(value.windowId) ||
      !isOpaqueId(value.documentId, MAX_DOCUMENT_ID_LENGTH) ||
      !isWebOrigin(value.origin) || !isPathname(value.pathname, value.origin) ||
      !isTimestamp(value.expiresAt)) return null;
  const actionContext = Object.hasOwn(value, "actionContext")
    ? parseActionContext(value.actionContext)
    : null;
  if (Object.hasOwn(value, "actionContext") && value.actionContext !== null && !actionContext) {
    return null;
  }
  const frameContext = Object.hasOwn(value, "frameContext")
    ? parseActionContext(value.frameContext)
    : null;
  if (Object.hasOwn(value, "frameContext") && value.frameContext !== null && !frameContext) {
    return null;
  }
  return {
    surfaceId: value.surfaceId,
    capabilityDigest: value.capabilityDigest,
    tabId: value.tabId,
    windowId: value.windowId,
    documentId: value.documentId,
    origin: value.origin,
    pathname: value.pathname,
    expiresAt: value.expiresAt,
    actionContext,
    ...(Object.hasOwn(value, "frameContext") ? { frameContext } : {}),
  };
}

function isValidSaveInput(value: unknown): value is InPageWidgetLeaseSaveInput {
  return isRecord(value) && hasExactKeys(value, [
    "surfaceId",
    "capability",
    "tabId",
    "windowId",
    "documentId",
    "origin",
    "pathname",
    ...(Object.hasOwn(value, "actionContext") ? ["actionContext"] : []),
    ...(Object.hasOwn(value, "frameContext") ? ["frameContext"] : []),
  ]) && isUuid(value.surfaceId) && isCapability(value.capability) &&
    isChromeId(value.tabId) && isChromeId(value.windowId) &&
    isOpaqueId(value.documentId, MAX_DOCUMENT_ID_LENGTH) &&
    isWebOrigin(value.origin) && isPathname(value.pathname, value.origin) &&
    (!Object.hasOwn(value, "actionContext") || value.actionContext === null ||
      parseActionContext(value.actionContext) !== null) &&
    (!Object.hasOwn(value, "frameContext") || value.frameContext === null ||
      parseActionContext(value.frameContext) !== null);
}

function parseActionContext(value: unknown): PersistedInPageWidgetActionContext | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "frameId",
    "documentId",
    "origin",
    "pathname",
  ]) || !isChromeId(value.frameId) ||
      !isOpaqueId(value.documentId, MAX_DOCUMENT_ID_LENGTH) ||
      !isWebOrigin(value.origin) || !isPathname(value.pathname, value.origin)) return null;
  return {
    frameId: value.frameId,
    documentId: value.documentId,
    origin: value.origin,
    pathname: value.pathname,
  };
}

async function digestCapability(rawCapability: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable for the MeanThis widget lease.");
  }
  const bytes = new TextEncoder().encode(rawCapability);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isWebOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value && parsed.pathname === "/" && parsed.search === "" &&
      parsed.hash === "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function isPathname(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATHNAME_LENGTH ||
      !value.startsWith("/") || /[?#\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value, origin);
    return parsed.origin === origin && parsed.pathname === value &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function isOpaqueId(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCapabilityDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isChromeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function constantTimeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

function compareLeaseExpiry(
  first: PersistedInPageWidgetLease,
  second: PersistedInPageWidgetLease,
): number {
  return first.expiresAt - second.expiresAt || first.surfaceId.localeCompare(second.surfaceId);
}

function cloneLease(lease: PersistedInPageWidgetLease): PersistedInPageWidgetLease {
  return {
    ...lease,
    actionContext: lease.actionContext ? { ...lease.actionContext } : null,
    ...(Object.hasOwn(lease, "frameContext") ? {
      frameContext: lease.frameContext ? { ...lease.frameContext } : null,
    } : {}),
  };
}

function validateIntegerOption(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
