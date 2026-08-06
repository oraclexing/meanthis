// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  applyPanelThemePreference,
  readPanelThemePreference,
  savePanelThemePreference,
  type PanelThemePreference,
} from "./panel-theme";

describe("extension panel theme preference", () => {
  test.each([
    [undefined, "system"],
    ["unexpected", "system"],
    ["system", "system"],
    ["light", "light"],
    ["dark", "dark"],
  ] as const)("reads %s as %s", async (stored, expected) => {
    const storage = {
      get: vi.fn(async () => ({ "ui-attach:panel-theme": stored })),
      set: vi.fn(async () => undefined),
    };

    await expect(readPanelThemePreference(storage)).resolves.toBe(expected);
  });

  test("persists one explicit preference without changing other settings", async () => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };

    await savePanelThemePreference(storage, "dark");

    expect(storage.set).toHaveBeenCalledWith({ "ui-attach:panel-theme": "dark" });
  });

  test.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", null],
  ] satisfies Array<[PanelThemePreference, string | null]>)
  ("applies %s as data-theme %s", (preference, expectedAttribute) => {
    document.documentElement.dataset.theme = "dark";

    applyPanelThemePreference(document.documentElement, preference);

    expect(document.documentElement.getAttribute("data-theme")).toBe(expectedAttribute);
  });
});
