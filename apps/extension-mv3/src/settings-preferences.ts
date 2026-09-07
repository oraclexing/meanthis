import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { PersistentOverlayDisplayMode } from "@meanthis/web-picker";
import type { ExtensionStorageArea } from "./capture-store";

export const INDEPENDENT_VIEW_MODE_KEY = "ui-attach:independent-view-mode";
export const PREVIEW_COPY_MODE_KEY = "ui-attach:preview-copy-mode";
export const CONTEXT_MENU_SELECTION_MODE_KEY = "ui-attach:context-menu-selection-mode";
export const FRAME_SCOPE_AUTO_START_KEY = "ui-attach:frame-scope-auto-start";
export const TIME_DISPLAY_PREFERENCE_KEY = "ui-attach:time-display-preference";
export const OVERLAY_VISIBILITY_PREFERENCE_KEY = "ui-attach:overlay-visibility-preference";
export const OVERLAY_DISPLAY_MODE_PREFERENCE_KEY = "ui-attach:overlay-display-mode";
export const RELATION_SHORTCUTS_KEY = "ui-attach:relation-shortcuts";
export const UI_ATTACH_SETTINGS_UPDATED = "ui-attach:settings-updated";
export const MAX_RELATION_SHORTCUTS = 8;
export const MAX_RELATION_SHORTCUT_LABEL_LENGTH = 48;
export const MAX_RELATION_SHORTCUT_TEMPLATE_LENGTH = 280;

export type ContextMenuSelectionMode = "single" | "continuous";
export type TimeDisplayPreference = "local" | "utc";
export type OverlayVisibilityPreference = "panel" | "always";
export type OverlayDisplayModePreference = PersistentOverlayDisplayMode;

export interface DeferredPreferenceReadbackCoordinator<T> {
  request(value: T): void;
  externalChange(): void;
  drain(): Promise<void>;
}

/** Serializes local writes while preserving an external change observed mid-read. */
export function createDeferredPreferenceReadbackCoordinator<T>(options: {
  write(value: T): Promise<void>;
  read(): Promise<T>;
  onValue(value: T): void;
  onSettled?(): void;
}): DeferredPreferenceReadbackCoordinator<T> {
  let tail = Promise.resolve();
  let pending = 0;
  let deferredExternalRead = false;
  let revision = 0;
  const refresh = async (): Promise<void> => {
    const current = ++revision;
    const value = await options.read();
    if (current === revision) options.onValue(value);
  };
  const drainDeferred = (): void => {
    if (pending !== 0 || !deferredExternalRead) return;
    deferredExternalRead = false;
    tail = tail.then(refresh).catch(() => undefined).finally(options.onSettled);
  };
  return {
    request(value): void {
      pending += 1;
      tail = tail.then(async () => {
        const current = ++revision;
        await options.write(value);
        const readback = await options.read();
        if (current === revision) options.onValue(readback);
      }).catch(() => undefined).finally(() => {
        pending -= 1;
        if (pending === 0 && deferredExternalRead) {
          drainDeferred();
        } else if (pending === 0) {
          options.onSettled?.();
        }
      });
    },
    externalChange(): void {
      if (pending > 0) {
        deferredExternalRead = true;
        return;
      }
      tail = tail.then(refresh).catch(() => undefined).finally(options.onSettled);
    },
    async drain(): Promise<void> {
      let observed: Promise<void>;
      do {
        observed = tail;
        await observed;
      } while (observed !== tail);
    },
  };
}

export interface RelationShortcutPreference {
  id: string;
  label: string;
  template: string;
}

export interface PreviewCopyPreference {
  independent: boolean;
  mode: UIAttachmentDisclosureMode;
}

export async function readPreviewCopyPreference(
  storage: ExtensionStorageArea,
): Promise<PreviewCopyPreference> {
  const values = await storage.get([
    INDEPENDENT_VIEW_MODE_KEY,
    PREVIEW_COPY_MODE_KEY,
  ]);
  return {
    independent: values[INDEPENDENT_VIEW_MODE_KEY] === true,
    mode: parseDisclosureMode(values[PREVIEW_COPY_MODE_KEY]),
  };
}

export async function savePreviewCopyPreference(
  storage: ExtensionStorageArea,
  preference: PreviewCopyPreference,
): Promise<void> {
  await storage.set({
    [INDEPENDENT_VIEW_MODE_KEY]: preference.independent,
    [PREVIEW_COPY_MODE_KEY]: preference.mode,
  });
}

export async function readContextMenuSelectionMode(
  storage: ExtensionStorageArea,
): Promise<ContextMenuSelectionMode> {
  const values = await storage.get(CONTEXT_MENU_SELECTION_MODE_KEY);
  return values[CONTEXT_MENU_SELECTION_MODE_KEY] === "continuous"
    ? "continuous"
    : "single";
}

export async function saveContextMenuSelectionMode(
  storage: ExtensionStorageArea,
  mode: ContextMenuSelectionMode,
): Promise<void> {
  await storage.set({ [CONTEXT_MENU_SELECTION_MODE_KEY]: mode });
}

export async function readFrameScopeAutoStart(
  storage: ExtensionStorageArea,
): Promise<boolean> {
  const values = await storage.get(FRAME_SCOPE_AUTO_START_KEY);
  return values[FRAME_SCOPE_AUTO_START_KEY] === true;
}

export async function saveFrameScopeAutoStart(
  storage: ExtensionStorageArea,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [FRAME_SCOPE_AUTO_START_KEY]: enabled === true });
}

export async function readTimeDisplayPreference(
  storage: ExtensionStorageArea,
): Promise<TimeDisplayPreference> {
  const values = await storage.get(TIME_DISPLAY_PREFERENCE_KEY);
  return values[TIME_DISPLAY_PREFERENCE_KEY] === "utc" ? "utc" : "local";
}

export async function saveTimeDisplayPreference(
  storage: ExtensionStorageArea,
  preference: TimeDisplayPreference,
): Promise<void> {
  await storage.set({
    [TIME_DISPLAY_PREFERENCE_KEY]: preference === "utc" ? "utc" : "local",
  });
}

export async function readOverlayVisibilityPreference(
  storage: ExtensionStorageArea,
): Promise<OverlayVisibilityPreference> {
  const values = await storage.get(OVERLAY_VISIBILITY_PREFERENCE_KEY);
  return values[OVERLAY_VISIBILITY_PREFERENCE_KEY] === "always" ? "always" : "panel";
}

export async function saveOverlayVisibilityPreference(
  storage: ExtensionStorageArea,
  preference: OverlayVisibilityPreference,
): Promise<void> {
  await storage.set({
    [OVERLAY_VISIBILITY_PREFERENCE_KEY]: preference === "always" ? "always" : "panel",
  });
}

export async function readOverlayDisplayModePreference(
  storage: ExtensionStorageArea,
): Promise<OverlayDisplayModePreference> {
  const values = await storage.get(OVERLAY_DISPLAY_MODE_PREFERENCE_KEY);
  return parseOverlayDisplayModePreference(values[OVERLAY_DISPLAY_MODE_PREFERENCE_KEY]);
}

export async function saveOverlayDisplayModePreference(
  storage: ExtensionStorageArea,
  preference: OverlayDisplayModePreference,
): Promise<void> {
  await storage.set({
    [OVERLAY_DISPLAY_MODE_PREFERENCE_KEY]: parseOverlayDisplayModePreference(preference),
  });
}

export async function readRelationShortcuts(
  storage: ExtensionStorageArea,
): Promise<RelationShortcutPreference[]> {
  const values = await storage.get(RELATION_SHORTCUTS_KEY);
  return parseRelationShortcuts(values[RELATION_SHORTCUTS_KEY]);
}

export async function saveRelationShortcuts(
  storage: ExtensionStorageArea,
  shortcuts: RelationShortcutPreference[],
): Promise<void> {
  const normalized = normalizeRelationShortcuts(shortcuts);
  if (normalized === null) throw new TypeError("Invalid relation shortcuts preference.");
  await storage.set({ [RELATION_SHORTCUTS_KEY]: normalized });
}

export function normalizeRelationShortcut(
  value: unknown,
): RelationShortcutPreference | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => (
    key === "id" || key === "label" || key === "template"
  ))) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.template !== "string"
  ) return null;
  const id = value.id.trim();
  const label = value.label.trim();
  const template = value.template.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) return null;
  if (label.length === 0 || label.length > MAX_RELATION_SHORTCUT_LABEL_LENGTH) return null;
  if (
    template.length === 0 ||
    template.length > MAX_RELATION_SHORTCUT_TEMPLATE_LENGTH ||
    !template.includes("{selected}") ||
    !template.includes("{reference}")
  ) return null;
  return { id, label, template };
}

export function formatDisplayTime(
  value: string,
  preference: TimeDisplayPreference,
  getTimezoneOffset: (date: Date) => number = (date) => date.getTimezoneOffset(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (preference === "utc") return `${formatDateParts(date)} UTC`;

  const timezoneOffset = getTimezoneOffset(date);
  if (!Number.isFinite(timezoneOffset)) return value;
  const localDate = new Date(date.getTime() - timezoneOffset * 60_000);
  return `${formatDateParts(localDate)} ${formatTimezoneOffset(timezoneOffset)}`;
}

function parseDisclosureMode(value: unknown): UIAttachmentDisclosureMode {
  if (value === "developer_diagnostic" || value === "full_debug") return value;
  return "agent_safe";
}

function parseOverlayDisplayModePreference(value: unknown): OverlayDisplayModePreference {
  return value === "full" || value === "markers" || value === "hidden" || value === "hover"
    ? value
    : "hover";
}

function parseRelationShortcuts(value: unknown): RelationShortcutPreference[] {
  return normalizeRelationShortcuts(value) ?? [];
}

function normalizeRelationShortcuts(value: unknown): RelationShortcutPreference[] | null {
  if (!Array.isArray(value) || value.length > MAX_RELATION_SHORTCUTS) return null;
  const normalized: RelationShortcutPreference[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const shortcut = normalizeRelationShortcut(candidate);
    if (shortcut === null || ids.has(shortcut.id)) return null;
    ids.add(shortcut.id);
    normalized.push(shortcut);
  }
  return normalized;
}

function formatDateParts(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatTimezoneOffset(timezoneOffset: number): string {
  const offsetFromUtc = -timezoneOffset;
  if (offsetFromUtc === 0) return "UTC";
  const sign = offsetFromUtc > 0 ? "+" : "-";
  const absolute = Math.abs(offsetFromUtc);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return minutes === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
