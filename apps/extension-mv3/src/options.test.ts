// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initializeOptions, type OptionsDependencies } from "./options";

const OPTIONS_HTML = readFileSync("apps/extension-mv3/options.html", "utf8");
const OPTIONS_CSS = readFileSync("apps/extension-mv3/src/options.css", "utf8");

describe("extension settings page", () => {
  beforeEach(() => {
    const parsed = new DOMParser().parseFromString(OPTIONS_HTML, "text/html");
    document.body.innerHTML = parsed.body.innerHTML;
    document.documentElement.removeAttribute("data-theme");
  });

  test("is registered as a full-tab options page and groups global settings", () => {
    const manifest = JSON.parse(readFileSync(
      "apps/extension-mv3/public/manifest.json",
      "utf8",
    ));
    expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });
    expect(document.querySelectorAll(".settings-section")).toHaveLength(5);
    expect(document.querySelector("#capture-privacy-heading")?.textContent).toBe(
      "Capture and privacy",
    );
    expect(document.querySelector("#page-access-heading")?.textContent).toBe("Page access");
    expect(document.querySelector("#relation-shortcuts-heading")?.textContent).toBe(
      "Task note shortcuts",
    );
    expect(document.querySelector("#appearance-heading")?.textContent).toBe("Appearance");
    expect(document.querySelector("#advanced-heading")?.textContent).toBe("Advanced");
    for (const section of document.querySelectorAll(".settings-section")) {
      expect(section.children).toHaveLength(2);
      expect(section.lastElementChild?.classList.contains("section-controls")).toBe(true);
    }
    expect(query("#context-menu-selection-mode").closest(".section-controls"))
      .toBe(query("#capture-mode").closest(".section-controls"));
    expect(query("#time-display-preference").closest(".section-controls"))
      .toBe(query("#theme-preference").closest(".section-controls"));
  });

  test("loads settings and saves each change immediately", async () => {
    const deps = createOptionsDependencies({
      captureMode: {
        read: async () => "full_debug",
        save: vi.fn(async () => undefined),
      },
      previewCopy: {
        read: async () => ({ independent: false, mode: "developer_diagnostic" }),
        save: vi.fn(async () => undefined),
      },
      themePreference: {
        read: async () => "dark",
        save: vi.fn(async () => undefined),
      },
      contextMenuSelection: {
        read: async () => "continuous",
        save: vi.fn(async () => undefined),
      },
      frameScopeAutoStart: {
        read: async () => true,
        save: vi.fn(async () => undefined),
      },
      timeDisplay: {
        read: async () => "utc",
        save: vi.fn(async () => undefined),
      },
      overlayVisibility: {
        read: async () => "always",
        save: vi.fn(async () => undefined),
      },
      relationShortcuts: {
        read: async () => [{
          id: "shortcut-spacing",
          label: "Match spacing",
          template: "Adjust {selected} to keep the same spacing as {reference}.",
        }],
        save: vi.fn(async () => undefined),
      },
    });

    await initializeOptions(deps);

    expect(query<HTMLSelectElement>("#capture-mode").value).toBe("full_debug");
    expect(query<HTMLElement>("#view-mode-field").hidden).toBe(true);
    expect(query<HTMLSelectElement>("#view-mode").value).toBe("full_debug");
    expect(query<HTMLSelectElement>("#context-menu-selection-mode").value).toBe("continuous");
    expect(query<HTMLInputElement>("#frame-scope-auto-start").checked).toBe(true);
    expect(query<HTMLSelectElement>("#time-display-preference").value).toBe("utc");
    expect(query<HTMLSelectElement>("#overlay-visibility-preference").value).toBe("always");
    expect(query<HTMLInputElement>("#relation-shortcut-label").value).toBe("Match spacing");
    expect(query<HTMLButtonElement>(
      '[data-relation-shortcut-id="shortcut-spacing"]',
    ).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");

    changeSelect("#capture-mode", "agent_safe");
    await flushMicrotasks();
    expect(deps.captureMode.save).toHaveBeenCalledWith("agent_safe");
    expect(query("#settings-status").textContent).toBe("Saved.");

    const independent = query<HTMLInputElement>("#independent-view-mode");
    independent.checked = true;
    independent.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(query<HTMLElement>("#view-mode-field").hidden).toBe(false);
    expect(deps.previewCopy.save).toHaveBeenLastCalledWith({
      independent: true,
      mode: "agent_safe",
    });
    changeSelect("#theme-preference", "light");
    await flushMicrotasks();
    expect(deps.themePreference.save).toHaveBeenCalledWith("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    changeSelect("#context-menu-selection-mode", "single");
    await flushMicrotasks();
    expect(deps.contextMenuSelection.save).toHaveBeenCalledWith("single");
    const frameScopeAutoStart = query<HTMLInputElement>("#frame-scope-auto-start");
    frameScopeAutoStart.checked = false;
    frameScopeAutoStart.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(deps.frameScopeAutoStart.save).toHaveBeenCalledWith(false);
    changeSelect("#time-display-preference", "local");
    await flushMicrotasks();
    expect(deps.timeDisplay.save).toHaveBeenCalledWith("local");
    changeSelect("#overlay-visibility-preference", "panel");
    await flushMicrotasks();
    expect(deps.overlayVisibility.save).toHaveBeenCalledWith("panel");
    expect(deps.notifySettingsChanged).toHaveBeenCalledTimes(7);
  });

  test("adds, edits, and removes a bounded custom task-note shortcut", async () => {
    const deps = createOptionsDependencies({
      randomUUID: () => "shortcut-new",
    });
    await initializeOptions(deps);

    inputText("#relation-shortcut-label", "Same spacing");
    inputText("#relation-shortcut-template",
      "Keep {selected} the same distance from {reference}.");
    query<HTMLButtonElement>("#save-relation-shortcut").click();
    await flushMicrotasks();

    expect(deps.relationShortcuts.save).toHaveBeenLastCalledWith([{
      id: "shortcut-new",
      label: "Same spacing",
      template: "Keep {selected} the same distance from {reference}.",
    }]);
    expect(query<HTMLButtonElement>(
      '[data-relation-shortcut-id="shortcut-new"]',
    ).getAttribute("aria-pressed")).toBe("true");
    expect(query("#relation-shortcut-editor-heading").textContent).toBe("Edit shortcut");
    inputText("#relation-shortcut-label", "Equal spacing");
    query<HTMLButtonElement>("#save-relation-shortcut").click();
    await flushMicrotasks();
    expect(deps.relationShortcuts.save).toHaveBeenLastCalledWith([{
      id: "shortcut-new",
      label: "Equal spacing",
      template: "Keep {selected} the same distance from {reference}.",
    }]);

    query<HTMLButtonElement>("#remove-relation-shortcut").click();
    await flushMicrotasks();
    expect(deps.relationShortcuts.save).toHaveBeenLastCalledWith([]);
    expect(query("#relation-shortcut-editor-heading").textContent).toBe("New shortcut");
  });

  test("prevents overlapping custom shortcut writes from dropping an edit", async () => {
    let resolveSave: (() => void) | undefined;
    const savePending = new Promise<void>((resolve) => { resolveSave = resolve; });
    const deps = createOptionsDependencies({
      randomUUID: () => "shortcut-new",
      relationShortcuts: {
        read: async () => [],
        save: vi.fn(() => savePending),
      },
    });
    await initializeOptions(deps);

    inputText("#relation-shortcut-label", "Same spacing");
    inputText("#relation-shortcut-template",
      "Keep {selected} the same distance from {reference}.");
    const save = query<HTMLButtonElement>("#save-relation-shortcut");
    save.click();

    expect(save.disabled).toBe(true);
    save.click();
    expect(deps.relationShortcuts.save).toHaveBeenCalledTimes(1);

    resolveSave?.();
    await flushMicrotasks();
    expect(save.disabled).toBe(true);
    expect(query<HTMLInputElement>("#relation-shortcut-label").value).toBe("Same spacing");
    expect(query<HTMLButtonElement>(
      '[data-relation-shortcut-id="shortcut-new"]',
    ).textContent).toBe("Same spacing");
  });

  test("does not discard an edited shortcut when another list item is selected", async () => {
    const shortcuts = [{
      id: "same-spacing",
      label: "Same spacing",
      template: "Keep {selected} the same distance from {reference}.",
    }, {
      id: "same-width",
      label: "Same width",
      template: "Keep {selected} the same width as {reference}.",
    }];
    const deps = createOptionsDependencies({
      relationShortcuts: {
        read: async () => shortcuts,
        save: vi.fn(async () => undefined),
      },
    });
    await initializeOptions(deps);

    inputText("#relation-shortcut-label", "Equal spacing");
    query<HTMLButtonElement>('[data-relation-shortcut-id="same-width"]').click();

    expect(query<HTMLInputElement>("#relation-shortcut-label").value).toBe("Equal spacing");
    expect(query<HTMLButtonElement>(
      '[data-relation-shortcut-id="same-spacing"]',
    ).getAttribute("aria-pressed")).toBe("true");
    expect(query("#relation-shortcut-editor-status").textContent).toBe(
      "Save or cancel your changes before choosing another shortcut.",
    );
    expect(document.activeElement).toBe(query("#save-relation-shortcut"));

    query<HTMLButtonElement>("#cancel-relation-shortcut").click();
    query<HTMLButtonElement>('[data-relation-shortcut-id="same-width"]').click();
    expect(query<HTMLInputElement>("#relation-shortcut-label").value).toBe("Same width");
  });

  test("keeps existing shortcuts editable at the eight-shortcut limit", async () => {
    const shortcuts = Array.from({ length: 8 }, (_, index) => ({
      id: `shortcut-${index}`,
      label: `Shortcut ${index + 1}`,
      template: "Keep {selected} aligned with {reference}.",
    }));
    const deps = createOptionsDependencies({
      relationShortcuts: {
        read: async () => shortcuts,
        save: vi.fn(async () => undefined),
      },
    });
    await initializeOptions(deps);

    expect(query<HTMLInputElement>("#relation-shortcut-label").disabled).toBe(false);
    expect(query<HTMLTextAreaElement>("#relation-shortcut-template").disabled).toBe(false);
    expect(query<HTMLButtonElement>("#new-relation-shortcut").disabled).toBe(true);

    query<HTMLButtonElement>("#remove-relation-shortcut").click();
    await flushMicrotasks();

    expect(query<HTMLButtonElement>("#new-relation-shortcut").disabled).toBe(false);
  });

  test("requests automatic page access only from the switch change", async () => {
    const setEnabled = vi.fn(async (enabled: boolean) => enabled);
    const stopSelection = vi.fn(async () => undefined);
    const deps = createOptionsDependencies({
      automaticPageAccess: { read: async () => false, setEnabled },
      stopSelection,
    });
    await initializeOptions(deps);

    expect(setEnabled).not.toHaveBeenCalled();
    const automaticAccess = query<HTMLInputElement>("#automatic-page-access");
    automaticAccess.checked = true;
    automaticAccess.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(stopSelection).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(automaticAccess.checked).toBe(true);
    expect(query("#automatic-page-access-status").textContent).toContain(
      "Automatic tab access is on",
    );

    automaticAccess.checked = false;
    automaticAccess.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(stopSelection).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    expect(automaticAccess.checked).toBe(false);
  });

  test("uses theme-aware hover, focus, and disabled states for every settings control", () => {
    expect(OPTIONS_CSS).toMatch(/:root\s*{[^}]*--color-control-hover-bg:\s*#e9eef6;[^}]*--color-control-hover-border:\s*#8090a8;/s);
    expect(OPTIONS_CSS).toMatch(/:root\[data-theme="dark"\]\s*{[^}]*--color-control-hover-bg:\s*#252d3a;[^}]*--color-control-hover-border:\s*#6a7890;/s);
    expect(OPTIONS_CSS).toMatch(/select:not\(:disabled\):hover\s*{[^}]*border-color:\s*var\(--color-control-hover-border\);[^}]*background:\s*var\(--color-control-hover-bg\);/s);
    expect(OPTIONS_CSS).toMatch(/\.switch-setting:hover\s+input:not\(:checked\):not\(:disabled\)\s*\+\s*\.switch-track\s*{[^}]*border-color:\s*var\(--color-control-hover-border\);[^}]*background:\s*var\(--color-control-hover-bg\);/s);
    expect(OPTIONS_CSS).toMatch(/select:disabled\s*{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.72;/s);
  });
});

function createOptionsDependencies(
  overrides: Partial<OptionsDependencies> = {},
): OptionsDependencies {
  return {
    captureMode: {
      read: async () => "agent_safe",
      save: vi.fn(async () => undefined),
    },
    previewCopy: {
      read: async () => ({ independent: false, mode: "agent_safe" }),
      save: vi.fn(async () => undefined),
    },
    themePreference: {
      read: async () => "system",
      save: vi.fn(async () => undefined),
    },
    contextMenuSelection: {
      read: async () => "single",
      save: vi.fn(async () => undefined),
    },
    frameScopeAutoStart: {
      read: async () => false,
      save: vi.fn(async () => undefined),
    },
    timeDisplay: {
      read: async () => "local",
      save: vi.fn(async () => undefined),
    },
    overlayVisibility: {
      read: async () => "panel",
      save: vi.fn(async () => undefined),
    },
    relationShortcuts: {
      read: async () => [],
      save: vi.fn(async () => undefined),
    },
    automaticPageAccess: {
      read: async () => false,
      setEnabled: vi.fn(async (enabled) => enabled),
    },
    notifySettingsChanged: vi.fn(async () => undefined),
    stopSelection: vi.fn(async () => undefined),
    randomUUID: () => "shortcut-default",
    ...overrides,
  };
}

function changeSelect(selector: string, value: string): void {
  const select = query<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputText(selector: string, value: string): void {
  const input = query<HTMLInputElement | HTMLTextAreaElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing test element: ${selector}`);
  return element as T;
}
