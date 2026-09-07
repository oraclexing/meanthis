import type { ExtensionStorageArea } from "./capture-store";

export const SELECTION_INTENT_AUTHORITY_STORAGE_KEY = "ui-attach:selection-intent-authority:v1";
export const SELECTION_INTENT_POISON_STORAGE_KEY = "ui-attach:selection-intent-poison:v1";

const SELECTION_INTENT_LOCK_NAME = "meanthis:selection-intent-authority:v1";

export interface SelectionIntentAuthorityV1 {
  version: 1;
  authorityId: string;
  generation: number;
  desired: "enabled" | "stopped";
  clearOperationId: string | null;
  ownerTabId: number | null;
}

export interface SelectionIntentSnapshot {
  authorityId: string | null;
  generation: number;
  desired: "enabled" | "stopped";
  clearOperationId: string | null;
  ownerTabId: number | null;
}

export type SelectionIntentStoreResult =
  | { ok: true; value: SelectionIntentSnapshot }
  | {
      ok: false;
      code: "AUTHORITY_UNAVAILABLE" | "STALE_INTENT" | "RESUME_BLOCKED" |
        "STORAGE_ERROR" | "GENERATION_EXHAUSTED";
      error: string;
    };

export interface SelectionIntentStore {
  read(): Promise<SelectionIntentStoreResult>;
  startExplicit(ownerTabId: number, expectedGeneration?: number): Promise<SelectionIntentStoreResult>;
  stop(
    clearOperationId: string | null,
    expectedGeneration?: number,
  ): Promise<SelectionIntentStoreResult>;
  resume(ownerTabId: number, expectedGeneration: number): Promise<SelectionIntentStoreResult>;
}

let selectionIntentMutationTail: Promise<void> = Promise.resolve();

export function createSelectionIntentStore(options: {
  authorityStorage: ExtensionStorageArea;
  poisonStorage: ExtensionStorageArea;
  randomUUID?: () => string;
}): SelectionIntentStore {
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  let loaded = false;
  let unavailable = false;
  let authority: SelectionIntentAuthorityV1 | null = null;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = selectionIntentMutationTail.then(
      () => withSelectionIntentLock(operation),
      () => withSelectionIntentLock(operation),
    );
    selectionIntentMutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function ensureLoaded(): Promise<boolean> {
    if (loaded) return !unavailable;
    loaded = true;
    let poisonValues: Record<string, unknown>;
    let authorityValues: Record<string, unknown>;
    try {
      [poisonValues, authorityValues] = await Promise.all([
        options.poisonStorage.get(SELECTION_INTENT_POISON_STORAGE_KEY),
        options.authorityStorage.get(SELECTION_INTENT_AUTHORITY_STORAGE_KEY),
      ]);
    } catch {
      unavailable = true;
      return false;
    }
    if (Object.hasOwn(poisonValues, SELECTION_INTENT_POISON_STORAGE_KEY)) {
      unavailable = true;
      return false;
    }
    const hasAuthority = Object.hasOwn(
      authorityValues,
      SELECTION_INTENT_AUTHORITY_STORAGE_KEY,
    );
    const rawAuthority = authorityValues[SELECTION_INTENT_AUTHORITY_STORAGE_KEY];
    if (!hasAuthority) return true;
    const parsed = parseSelectionIntentAuthority(rawAuthority);
    if (!parsed) {
      unavailable = true;
      return false;
    }
    authority = parsed;
    return true;
  }

  function snapshot(): SelectionIntentSnapshot {
    return authority
      ? { ...authority }
      : {
          authorityId: null,
          generation: 0,
          desired: "stopped",
          clearOperationId: null,
          ownerTabId: null,
        };
  }

  async function persist(next: SelectionIntentAuthorityV1): Promise<SelectionIntentStoreResult> {
    try {
      await options.authorityStorage.set({
        [SELECTION_INTENT_AUTHORITY_STORAGE_KEY]: next,
      });
      authority = next;
      return { ok: true, value: snapshot() };
    } catch (error) {
      unavailable = true;
      try {
        await options.poisonStorage.set({ [SELECTION_INTENT_POISON_STORAGE_KEY]: true });
      } catch {
        // Current worker remains fail-closed. Dual-storage failure is an explicit residual.
      }
      return failure("STORAGE_ERROR", error);
    }
  }

  async function poisonFailure(
    code: Exclude<SelectionIntentStoreResult, { ok: true }>["code"],
    error: unknown,
  ): Promise<SelectionIntentStoreResult> {
    unavailable = true;
    try {
      await options.poisonStorage.set({ [SELECTION_INTENT_POISON_STORAGE_KEY]: true });
    } catch {
      // Current worker remains fail-closed. Dual-storage failure is an explicit residual.
    }
    return failure(code, error);
  }

  async function transition(
    desired: SelectionIntentAuthorityV1["desired"],
    clearOperationId: string | null,
    ownerTabId: number | null,
    expectedGeneration?: number,
    terminal = false,
  ): Promise<SelectionIntentStoreResult> {
    if (!await ensureLoaded()) {
      return terminal
        ? await poisonFailure("AUTHORITY_UNAVAILABLE", "Selection intent authority is unavailable.")
        : unavailableFailure();
    }
    const current = snapshot();
    if (expectedGeneration !== undefined && expectedGeneration !== current.generation) {
      return failure("STALE_INTENT", "Selection intent generation changed.");
    }
    if (current.generation === Number.MAX_SAFE_INTEGER) {
      return terminal
        ? await poisonFailure("GENERATION_EXHAUSTED", "Selection intent generation is exhausted.")
        : failure("GENERATION_EXHAUSTED", "Selection intent generation is exhausted.");
    }
    const authorityId = current.authorityId ?? randomUUID();
    if (!isBoundedId(authorityId) ||
        (ownerTabId !== null && !isNonNegativeSafeInteger(ownerTabId)) ||
        (desired === "enabled" && ownerTabId === null) ||
        (desired === "stopped" && ownerTabId !== null) ||
        (clearOperationId !== null && !isBoundedId(clearOperationId))) {
      return terminal
        ? await poisonFailure("AUTHORITY_UNAVAILABLE", "Selection intent authority is unavailable.")
        : unavailableFailure();
    }
    return persist({
      version: 1,
      authorityId,
      generation: current.generation + 1,
      desired,
      clearOperationId,
      ownerTabId,
    });
  }

  return {
    read: () => enqueue(async () => await ensureLoaded()
      ? { ok: true, value: snapshot() }
      : unavailableFailure()),
    startExplicit: (ownerTabId, expectedGeneration) => enqueue(() =>
      transition("enabled", null, ownerTabId, expectedGeneration)),
    stop: (clearOperationId, expectedGeneration) => enqueue(() =>
      transition("stopped", clearOperationId, null, expectedGeneration, true)),
    resume: (ownerTabId, expectedGeneration) => enqueue(async () => {
      if (!await ensureLoaded()) return unavailableFailure();
      const current = snapshot();
      if (expectedGeneration !== current.generation) {
        return failure("STALE_INTENT", "Selection intent generation changed.");
      }
      if (current.desired !== "enabled" || current.clearOperationId !== null ||
          current.ownerTabId !== ownerTabId) {
        return failure("RESUME_BLOCKED", "Selection resume was stopped by a terminal intent.");
      }
      return { ok: true, value: current };
    }),
  };
}

export function parseSelectionIntentAuthority(value: unknown): SelectionIntentAuthorityV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "authorityId",
    "generation",
    "desired",
    "clearOperationId",
    "ownerTabId",
  ]) || value.version !== 1 || !isBoundedId(value.authorityId) ||
      !Number.isSafeInteger(value.generation) || typeof value.generation !== "number" ||
      value.generation <= 0 || (value.desired !== "enabled" && value.desired !== "stopped") ||
      (value.clearOperationId !== null && !isBoundedId(value.clearOperationId)) ||
      !(value.ownerTabId === null || isNonNegativeSafeInteger(value.ownerTabId)) ||
      (value.desired === "enabled" &&
        (value.clearOperationId !== null || value.ownerTabId === null)) ||
      (value.desired === "stopped" && value.ownerTabId !== null)) {
    return null;
  }
  return value as unknown as SelectionIntentAuthorityV1;
}

async function withSelectionIntentLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks
    ? await locks.request(SELECTION_INTENT_LOCK_NAME, { mode: "exclusive" }, operation)
    : await operation();
}

function unavailableFailure(): SelectionIntentStoreResult {
  return failure("AUTHORITY_UNAVAILABLE", "Selection intent authority is unavailable.");
}

function failure(
  code: Exclude<SelectionIntentStoreResult, { ok: true }>["code"],
  error: unknown,
): SelectionIntentStoreResult {
  return {
    ok: false,
    code,
    error: error instanceof Error ? error.message : String(error),
  };
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}
