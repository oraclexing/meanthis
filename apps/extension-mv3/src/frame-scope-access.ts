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
      released = true;
      if (!(await removePermission(permissions, permissionPattern))) {
        throw new FrameScopeAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
      }
    },
  };
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
