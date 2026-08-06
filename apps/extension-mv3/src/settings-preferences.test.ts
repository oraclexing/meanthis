import { describe, expect, test, vi } from "vitest";
import {
  CONTEXT_MENU_SELECTION_MODE_KEY,
  FRAME_SCOPE_AUTO_START_KEY,
  INDEPENDENT_VIEW_MODE_KEY,
  OVERLAY_VISIBILITY_PREFERENCE_KEY,
  PREVIEW_COPY_MODE_KEY,
  RELATION_SHORTCUTS_KEY,
  TIME_DISPLAY_PREFERENCE_KEY,
  formatDisplayTime,
  readContextMenuSelectionMode,
  readFrameScopeAutoStart,
  readOverlayVisibilityPreference,
  readPreviewCopyPreference,
  readRelationShortcuts,
  readTimeDisplayPreference,
  saveContextMenuSelectionMode,
  saveFrameScopeAutoStart,
  saveOverlayVisibilityPreference,
  savePreviewCopyPreference,
  saveRelationShortcuts,
  saveTimeDisplayPreference,
} from "./settings-preferences";

describe("extension settings preferences", () => {
  test("defaults to a linked Agent-safe preview and copy mode", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readPreviewCopyPreference(storage)).resolves.toEqual({
      independent: false,
      mode: "agent_safe",
    });
  });

  test("persists the independent preview and copy mode as one preference", async () => {
    const storage = {
      get: vi.fn(async () => ({
        [INDEPENDENT_VIEW_MODE_KEY]: true,
        [PREVIEW_COPY_MODE_KEY]: "developer_diagnostic",
      })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readPreviewCopyPreference(storage)).resolves.toEqual({
      independent: true,
      mode: "developer_diagnostic",
    });
    await savePreviewCopyPreference(storage, {
      independent: true,
      mode: "full_debug",
    });
    expect(storage.set).toHaveBeenCalledWith({
      [INDEPENDENT_VIEW_MODE_KEY]: true,
      [PREVIEW_COPY_MODE_KEY]: "full_debug",
    });
  });

  test("defaults a context-menu picker to one confirmation and persists continuous selection", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readContextMenuSelectionMode(storage)).resolves.toBe("single");
    storage.get.mockResolvedValue({
      [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous",
    });
    await expect(readContextMenuSelectionMode(storage)).resolves.toBe("continuous");

    await saveContextMenuSelectionMode(storage, "continuous");
    expect(storage.set).toHaveBeenCalledWith({
      [CONTEXT_MENU_SELECTION_MODE_KEY]: "continuous",
    });
  });

  test("defaults frame scope changes to manual start and persists explicit auto-start", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readFrameScopeAutoStart(storage)).resolves.toBe(false);
    storage.get.mockResolvedValue({ [FRAME_SCOPE_AUTO_START_KEY]: true });
    await expect(readFrameScopeAutoStart(storage)).resolves.toBe(true);

    await saveFrameScopeAutoStart(storage, true);
    expect(storage.set).toHaveBeenCalledWith({ [FRAME_SCOPE_AUTO_START_KEY]: true });
  });

  test("shows page markers only with the panel by default and persists explicit always-on visibility", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readOverlayVisibilityPreference(storage)).resolves.toBe("panel");
    storage.get.mockResolvedValue({ [OVERLAY_VISIBILITY_PREFERENCE_KEY]: "always" });
    await expect(readOverlayVisibilityPreference(storage)).resolves.toBe("always");

    await saveOverlayVisibilityPreference(storage, "always");
    expect(storage.set).toHaveBeenCalledWith({
      [OVERLAY_VISIBILITY_PREFERENCE_KEY]: "always",
    });
  });

  test("defaults human-facing timestamps to local time while preserving an explicit UTC preference", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readTimeDisplayPreference(storage)).resolves.toBe("local");
    storage.get.mockResolvedValue({ [TIME_DISPLAY_PREFERENCE_KEY]: "utc" });
    await expect(readTimeDisplayPreference(storage)).resolves.toBe("utc");
    await saveTimeDisplayPreference(storage, "utc");
    expect(storage.set).toHaveBeenCalledWith({ [TIME_DISPLAY_PREFERENCE_KEY]: "utc" });
  });

  test("formats local display time without changing the canonical UTC value", () => {
    const capturedAt = "2026-08-02T09:34:00.000Z";

    expect(formatDisplayTime(capturedAt, "utc")).toBe("2026-08-02 09:34 UTC");
    expect(formatDisplayTime(capturedAt, "local", () => -480)).toBe(
      "2026-08-02 17:34 GMT+8",
    );
    expect(capturedAt).toBe("2026-08-02T09:34:00.000Z");
  });

  test("persists only bounded custom relation shortcuts with both placeholders", async () => {
    const shortcut = {
      id: "shortcut-spacing",
      label: "Match spacing",
      template: "Adjust {selected} to keep the same spacing as {reference}.",
    };
    const storage = {
      get: vi.fn(async () => ({ [RELATION_SHORTCUTS_KEY]: [shortcut] })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    await expect(readRelationShortcuts(storage)).resolves.toEqual([shortcut]);
    await saveRelationShortcuts(storage, [shortcut]);
    expect(storage.set).toHaveBeenCalledWith({ [RELATION_SHORTCUTS_KEY]: [shortcut] });

    storage.get.mockResolvedValue({
      [RELATION_SHORTCUTS_KEY]: [{ ...shortcut, template: "Missing placeholders" }],
    });
    await expect(readRelationShortcuts(storage)).resolves.toEqual([]);

    await expect(saveRelationShortcuts(storage, Array.from({ length: 9 }, (_, index) => ({
      ...shortcut,
      id: `shortcut-${index}`,
    })))).rejects.toThrow("Invalid relation shortcuts preference.");
    await expect(saveRelationShortcuts(storage, [shortcut, shortcut])).rejects.toThrow(
      "Invalid relation shortcuts preference.",
    );
  });
});
