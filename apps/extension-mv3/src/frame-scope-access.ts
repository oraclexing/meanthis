import type { UiAttachChromePermissions } from "./extension-api";
import type {
  FrameScopeListData,
  SessionCommand,
  SessionCommandResponse,
} from "./messages";

const MAX_FRAME_SCOPES = 256;
const MAX_FRAME_DEPTH = 32;

export interface FrameScopeSelectionTarget {
  tabId: number;
  frameId: number;
  documentId: string | null;
  origin: string;
  pathname: string;
  requiresHostPermission: boolean;
}

export class FrameScopeAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FrameScopeAccessError";
  }
}

export interface FrameScopePermissionLease {
  release(): Promise<void>;
}

export interface FrameScopePermissionTarget {
  origin: string;
  requiresHostPermission: boolean;
}

export interface FrameScopeSelectionController<
  TTarget extends FrameScopePermissionTarget = FrameScopeSelectionTarget,
  TOperation = void,
> {
  select(target: TTarget, startSelection: boolean, operation?: TOperation): Promise<boolean>;
  stop(operation?: TOperation): Promise<boolean>;
  releasePermission(): Promise<void>;
}

export function createFrameScopeSelectionController<
  TTarget extends FrameScopePermissionTarget = FrameScopeSelectionTarget,
  TOperation = void,
>(options: {
  permissions: UiAttachChromePermissions;
  selectTarget(
    target: TTarget,
    startSelection: boolean,
    operation?: TOperation,
  ): Promise<boolean>;
  stopSelection(operation?: TOperation): Promise<boolean>;
  isOperationCurrent?(operation?: TOperation): boolean;
}): FrameScopeSelectionController<TTarget, TOperation> {
  let retainedPermission: {
    origin: string;
    lease: FrameScopePermissionLease;
  } | null = null;
  let operationTail = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function releasePermissionNow(): Promise<void> {
    const current = retainedPermission;
    if (!current) return;
    try {
      await current.lease.release();
      if (retainedPermission === current) retainedPermission = null;
    } catch (error) {
      throw normalizeFrameScopeError(error, "FRAME_PERMISSION_CLEANUP_FAILED");
    }
  }

  async function releasePreparedPermission(
    prepared: { origin: string; lease: FrameScopePermissionLease } | null,
  ): Promise<void> {
    if (!prepared || prepared === retainedPermission) return;
    try {
      await prepared.lease.release();
    } catch (error) {
      throw normalizeFrameScopeError(error, "FRAME_PERMISSION_CLEANUP_FAILED");
    }
  }

  async function selectNow(
    target: TTarget,
    startSelection: boolean,
    operation?: TOperation,
  ): Promise<boolean> {
    assertOperationCurrent(operation);
    let prepared = target.requiresHostPermission
      ? retainedPermission?.origin === target.origin
        ? retainedPermission
        : {
            origin: target.origin,
            lease: await acquireFrameScopePermission(options.permissions, target.origin),
          }
      : null;
    let enabled: boolean;
    try {
      assertOperationCurrent(operation);
      enabled = await options.selectTarget(target, startSelection, operation);
      assertOperationCurrent(operation);
      if (enabled !== startSelection) {
        throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
      }
    } catch (error) {
      try {
        await releasePreparedPermission(prepared);
      } catch (cleanupError) {
        throw cleanupError;
      }
      throw normalizeFrameScopeError(error, "FRAME_SCOPE_UNAVAILABLE");
    }

    if (!enabled) {
      await releasePreparedPermission(prepared);
      prepared = null;
      await releasePermissionNow();
      return false;
    }

    const previous = retainedPermission;
    retainedPermission = prepared;
    prepared = null;
    if (previous && previous !== retainedPermission) {
      try {
        await previous.lease.release();
      } catch (error) {
        try {
          await options.stopSelection(operation);
        } catch {
          // Permission cleanup remains the authoritative failure.
        }
        throw normalizeFrameScopeError(error, "FRAME_PERMISSION_CLEANUP_FAILED");
      }
    }
    return true;
  }

  async function stopNow(operation?: TOperation): Promise<boolean> {
    let enabled: boolean;
    try {
      assertOperationCurrent(operation);
      enabled = await options.stopSelection(operation);
      assertOperationCurrent(operation);
    } catch (error) {
      throw normalizeFrameScopeError(error, "FRAME_SCOPE_UNAVAILABLE");
    }
    if (enabled) throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    await releasePermissionNow();
    return false;
  }

  function assertOperationCurrent(operation?: TOperation): void {
    if (options.isOperationCurrent && !options.isOperationCurrent(operation)) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
  }

  return {
    select: (target, startSelection, operation) =>
      enqueue(() => selectNow(target, startSelection, operation)),
    stop: (operation) => enqueue(() => stopNow(operation)),
    releasePermission: () => enqueue(releasePermissionNow),
  };
}

export async function readFrameScopes(
  sendCommand: (command: SessionCommand) => Promise<SessionCommandResponse<unknown>>,
): Promise<FrameScopeListData> {
  let response: SessionCommandResponse<unknown>;
  try {
    response = await sendCommand({ type: "ui-attach:frame-scope-list" });
  } catch {
    throw new FrameScopeAccessError("FRAME_SCOPE_UNAVAILABLE");
  }
  if (!response.ok) throw new FrameScopeAccessError(response.code);
  if (!isFrameScopeListData(response.data)) {
    throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
  }
  return response.data;
}

export async function selectFrameScope(options: {
  permissions: UiAttachChromePermissions;
  sendCommand(command: SessionCommand): Promise<SessionCommandResponse<unknown>>;
  target: FrameScopeSelectionTarget;
  startSelection: boolean;
}): Promise<boolean> {
  const permissionLease = options.startSelection && options.target.requiresHostPermission
    ? await acquireFrameScopePermission(options.permissions, options.target.origin)
    : null;

  let activationError: FrameScopeAccessError | null = null;
  let enabled = false;
  try {
    const response = await options.sendCommand({
      type: "ui-attach:frame-scope-select",
      tabId: options.target.tabId,
      frameId: options.target.frameId,
      documentId: options.target.documentId,
      origin: options.target.origin,
      pathname: options.target.pathname,
      startSelection: options.startSelection,
    });
    if (!response.ok) {
      activationError = new FrameScopeAccessError(response.code);
    } else if (!isSelectionState(response.data)) {
      activationError = new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    } else {
      enabled = response.data.enabled;
    }
  } catch {
    activationError = new FrameScopeAccessError("FRAME_SCOPE_UNAVAILABLE");
  }

  if (permissionLease) {
    try {
      await permissionLease.release();
    } catch {
      try {
        await options.sendCommand({ type: "ui-attach:element-selection-set", enabled: false });
      } catch {
        // Permission cleanup remains the authoritative fail-closed error.
      }
      throw new FrameScopeAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
    }
  }
  if (activationError) throw activationError;
  if (enabled !== options.startSelection) {
    throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
  }
  return enabled;
}

export async function acquireFrameScopePermission(
  permissions: UiAttachChromePermissions,
  origin: string,
): Promise<FrameScopePermissionLease> {
  const permissionPattern = patternForOrigin(origin);
  let existingPermission: Promise<boolean>;
  let requestedPermission: Promise<boolean>;
  try {
    existingPermission = permissions.contains({ origins: [permissionPattern] });
    requestedPermission = permissions.request({ origins: [permissionPattern] }).catch(() => false);
  } catch {
    throw new FrameScopeAccessError("FRAME_PERMISSION_UNAVAILABLE");
  }

  const [existingResult, requestedResult] = await Promise.allSettled([
    existingPermission,
    requestedPermission,
  ]);
  const permissionStateKnown = existingResult.status === "fulfilled";
  const alreadyGranted = permissionStateKnown && existingResult.value;
  const granted = requestedResult.status === "fulfilled" && requestedResult.value;
  if (!permissionStateKnown) {
    if (granted && !(await removePermission(permissions, permissionPattern))) {
      throw new FrameScopeAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
    }
    throw new FrameScopeAccessError("FRAME_PERMISSION_UNAVAILABLE");
  }
  if (!alreadyGranted && !granted) {
    throw new FrameScopeAccessError("FRAME_PERMISSION_DENIED");
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released || alreadyGranted) return;
      if (!(await removePermission(permissions, permissionPattern))) {
        throw new FrameScopeAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
      }
      released = true;
    },
  };
}

function normalizeFrameScopeError(error: unknown, fallbackCode: string): FrameScopeAccessError {
  return error instanceof FrameScopeAccessError
    ? error
    : new FrameScopeAccessError(fallbackCode);
}

function isFrameScopeListData(value: unknown): value is FrameScopeListData {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tabId", "currentFrameId", "scopes"])) {
    return false;
  }
  if (!isNonNegativeInteger(value.tabId) || !isNonNegativeInteger(value.currentFrameId)) {
    return false;
  }
  if (!Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > MAX_FRAME_SCOPES) {
    return false;
  }
  const scopes = value.scopes;
  if (!scopes.every(isFrameScopeDescriptor)) return false;
  const byId = new Map(scopes.map((scope) => [scope.frameId, scope]));
  if (byId.size !== scopes.length) return false;
  const root = byId.get(0);
  const current = byId.get(value.currentFrameId);
  if (!root || root.parentFrameId !== null || root.depth !== 0 || !root.selectable || !current) {
    return false;
  }
  return scopes.every((scope) => {
    if (scope.frameId === 0) return true;
    const parent = scope.parentFrameId === null ? undefined : byId.get(scope.parentFrameId);
    return parent !== undefined && scope.depth === parent.depth + 1;
  });
}

function isFrameScopeDescriptor(value: unknown): value is FrameScopeListData["scopes"][number] {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "frameId",
    "parentFrameId",
    "documentId",
    "origin",
    "pathname",
    "depth",
    "requiresHostPermission",
    "selectable",
  ])) return false;
  if (
    !isNonNegativeInteger(value.frameId) ||
    !(value.parentFrameId === null || isNonNegativeInteger(value.parentFrameId)) ||
    !(value.documentId === null || isBoundedNonEmptyString(value.documentId, 256)) ||
    !isCanonicalOrigin(value.origin) ||
    !isCanonicalPathname(value.pathname, value.origin) ||
    !isNonNegativeInteger(value.depth) ||
    value.depth > MAX_FRAME_DEPTH ||
    typeof value.requiresHostPermission !== "boolean" ||
    typeof value.selectable !== "boolean"
  ) return false;
  return value.frameId === 0 || !value.selectable || value.documentId !== null;
}

function isSelectionState(value: unknown): value is { enabled: boolean } {
  return isRecord(value) && hasOnlyKeys(value, ["enabled"]) && typeof value.enabled === "boolean";
}

function patternForOrigin(origin: string): string {
  if (!isCanonicalOrigin(origin)) throw new FrameScopeAccessError("FRAME_SCOPE_UNAVAILABLE");
  return `${origin}/*`;
}

async function removePermission(
  permissions: UiAttachChromePermissions,
  pattern: string,
): Promise<boolean> {
  try {
    return await permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isCanonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    const url = new URL(value, `${origin}/`);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}
