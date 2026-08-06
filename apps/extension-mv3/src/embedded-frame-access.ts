import type { UiAttachChromePermissions } from "./extension-api";
import type { SessionCommand, SessionCommandResponse } from "./messages";

export interface EmbeddedFrameSelectionTarget {
  itemId: string;
  tabId: number;
  pageOrigin: string;
  pagePathname: string;
  parentFrameId: number;
  frameOrigin: string;
  framePathname: string;
}

type ResolvedEmbeddedFrameSelectionTarget = Omit<EmbeddedFrameSelectionTarget, "itemId"> & {
  requiresHostPermission: boolean;
};

export class EmbeddedFrameAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmbeddedFrameAccessError";
  }
}

export async function startEmbeddedFrameSelection(options: {
  permissions: UiAttachChromePermissions;
  sendCommand(command: SessionCommand): Promise<SessionCommandResponse<unknown>>;
  target: EmbeddedFrameSelectionTarget;
}): Promise<void> {
  const resolved = await resolveEmbeddedFrameSelectionTarget(options);
  let pattern: string | null = null;
  let alreadyGranted = true;
  if (resolved.requiresHostPermission) {
    pattern = permissionPatternForOrigin(resolved.frameOrigin);
    let existingPermission: Promise<boolean>;
    let requestedPermission: Promise<boolean>;
    try {
      existingPermission = options.permissions.contains({ origins: [pattern] });
      requestedPermission = options.permissions.request({ origins: [pattern] }).catch(() => false);
    } catch {
      throw new EmbeddedFrameAccessError("FRAME_PERMISSION_UNAVAILABLE");
    }

    const [existingResult, requestedResult] = await Promise.allSettled([
      existingPermission,
      requestedPermission,
    ]);
    const permissionStateKnown = existingResult.status === "fulfilled";
    alreadyGranted = permissionStateKnown && existingResult.value;
    const granted = requestedResult.status === "fulfilled" && requestedResult.value;

    if (!permissionStateKnown) {
      if (granted && !(await removePermission(options.permissions, pattern))) {
        throw new EmbeddedFrameAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
      }
      throw new EmbeddedFrameAccessError("FRAME_PERMISSION_UNAVAILABLE");
    }
    if (!alreadyGranted && !granted) throw new EmbeddedFrameAccessError("FRAME_PERMISSION_DENIED");
  }

  let activationError: EmbeddedFrameAccessError | null = null;
  try {
    const result = await options.sendCommand({
      type: "ui-attach:embedded-frame-selection-activate",
      itemId: options.target.itemId,
      sourceFrameOrigin: options.target.frameOrigin,
      sourceFramePathname: options.target.framePathname,
      tabId: resolved.tabId,
      pageOrigin: resolved.pageOrigin,
      pagePathname: resolved.pagePathname,
      parentFrameId: resolved.parentFrameId,
      frameOrigin: resolved.frameOrigin,
      framePathname: resolved.framePathname,
    });
    if (!result.ok) {
      activationError = new EmbeddedFrameAccessError(result.code);
    } else if (!isEnabledSelectionData(result.data)) {
      activationError = new EmbeddedFrameAccessError("INVALID_SESSION_RESPONSE");
    }
  } catch {
    activationError = new EmbeddedFrameAccessError("FRAME_UNAVAILABLE");
  }

  if (pattern !== null && !alreadyGranted) {
    const removed = await removePermission(options.permissions, pattern);
    if (!removed) {
      try {
        await options.sendCommand({ type: "ui-attach:element-selection-set", enabled: false });
      } catch {
        // The permission cleanup failure remains the authoritative safe error.
      }
      throw new EmbeddedFrameAccessError("FRAME_PERMISSION_CLEANUP_FAILED");
    }
  }

  if (activationError) throw activationError;
}

async function resolveEmbeddedFrameSelectionTarget(options: {
  sendCommand(command: SessionCommand): Promise<SessionCommandResponse<unknown>>;
  target: EmbeddedFrameSelectionTarget;
}): Promise<ResolvedEmbeddedFrameSelectionTarget> {
  let response: SessionCommandResponse<unknown>;
  try {
    response = await options.sendCommand({
      type: "ui-attach:embedded-frame-selection-resolve",
      ...options.target,
    });
  } catch {
    throw new EmbeddedFrameAccessError("FRAME_UNAVAILABLE");
  }
  if (!response.ok) throw new EmbeddedFrameAccessError(response.code);
  if (!isResolvedEmbeddedFrameSelectionTarget(response.data)) {
    throw new EmbeddedFrameAccessError("INVALID_SESSION_RESPONSE");
  }
  return response.data;
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

function permissionPatternForOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
      throw new Error("unsupported origin");
    }
    return `${origin}/*`;
  } catch {
    throw new EmbeddedFrameAccessError("FRAME_UNAVAILABLE");
  }
}

function isEnabledSelectionData(value: unknown): value is { enabled: true } {
  return typeof value === "object" && value !== null &&
    Object.keys(value).length === 1 &&
    (value as { enabled?: unknown }).enabled === true;
}

function isResolvedEmbeddedFrameSelectionTarget(
  value: unknown,
): value is ResolvedEmbeddedFrameSelectionTarget {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 7 ||
    typeof record.tabId !== "number" ||
    !Number.isInteger(record.tabId) ||
    record.tabId < 0 ||
    typeof record.parentFrameId !== "number" ||
    !Number.isInteger(record.parentFrameId) ||
    record.parentFrameId < 0 ||
    !isCanonicalOrigin(record.pageOrigin) ||
    !isCanonicalOrigin(record.frameOrigin) ||
    typeof record.requiresHostPermission !== "boolean"
  ) return false;
  return isCanonicalPathname(record.pagePathname, record.pageOrigin) &&
    isCanonicalPathname(record.framePathname, record.frameOrigin);
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
