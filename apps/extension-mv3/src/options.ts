import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import { createAutomaticPageAccessController, type AutomaticPageAccessController } from "./automatic-page-access";
import { readDisclosureMode, saveDisclosureMode } from "./capture-store";
import { createUiAttachI18n, localizeDocument, type UiAttachI18n } from "./i18n";
import {
  applyPanelThemePreference,
  parsePanelThemePreference,
  readPanelThemePreference,
  savePanelThemePreference,
  type PanelThemePreference,
} from "./panel-theme";
import {
  MAX_RELATION_SHORTCUTS,
  normalizeRelationShortcut,
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
  UI_ATTACH_SETTINGS_UPDATED,
  type ContextMenuSelectionMode,
  type OverlayVisibilityPreference,
  type PreviewCopyPreference,
  type RelationShortcutPreference,
  type TimeDisplayPreference,
} from "./settings-preferences";

export interface OptionsDependencies {
  captureMode: {
    read(): Promise<UIAttachmentDisclosureMode>;
    save(mode: UIAttachmentDisclosureMode): Promise<void>;
  };
  previewCopy: {
    read(): Promise<PreviewCopyPreference>;
    save(preference: PreviewCopyPreference): Promise<void>;
  };
  themePreference: {
    read(): Promise<PanelThemePreference>;
    save(preference: PanelThemePreference): Promise<void>;
  };
  contextMenuSelection: {
    read(): Promise<ContextMenuSelectionMode>;
    save(mode: ContextMenuSelectionMode): Promise<void>;
  };
  frameScopeAutoStart: {
    read(): Promise<boolean>;
    save(enabled: boolean): Promise<void>;
  };
  timeDisplay: {
    read(): Promise<TimeDisplayPreference>;
    save(preference: TimeDisplayPreference): Promise<void>;
  };
  overlayVisibility: {
    read(): Promise<OverlayVisibilityPreference>;
    save(preference: OverlayVisibilityPreference): Promise<void>;
  };
  relationShortcuts: {
    read(): Promise<RelationShortcutPreference[]>;
    save(shortcuts: RelationShortcutPreference[]): Promise<void>;
  };
  automaticPageAccess: AutomaticPageAccessController;
  randomUUID(): string;
  stopSelection?(): Promise<void>;
  notifySettingsChanged(): Promise<void>;
  i18n?: UiAttachI18n;
}

export function createBrowserOptionsDependencies(): OptionsDependencies {
  return {
    captureMode: {
      read: () => readDisclosureMode(chrome.storage.local),
      save: (mode) => saveDisclosureMode(chrome.storage.local, mode),
    },
    previewCopy: {
      read: () => readPreviewCopyPreference(chrome.storage.local),
      save: (preference) => savePreviewCopyPreference(chrome.storage.local, preference),
    },
    themePreference: {
      read: () => readPanelThemePreference(chrome.storage.local),
      save: (preference) => savePanelThemePreference(chrome.storage.local, preference),
    },
    contextMenuSelection: {
      read: () => readContextMenuSelectionMode(chrome.storage.local),
      save: (mode) => saveContextMenuSelectionMode(chrome.storage.local, mode),
    },
    frameScopeAutoStart: {
      read: () => readFrameScopeAutoStart(chrome.storage.local),
      save: (enabled) => saveFrameScopeAutoStart(chrome.storage.local, enabled),
    },
    timeDisplay: {
      read: () => readTimeDisplayPreference(chrome.storage.local),
      save: (preference) => saveTimeDisplayPreference(chrome.storage.local, preference),
    },
    overlayVisibility: {
      read: () => readOverlayVisibilityPreference(chrome.storage.local),
      save: (preference) => saveOverlayVisibilityPreference(chrome.storage.local, preference),
    },
    relationShortcuts: {
      read: () => readRelationShortcuts(chrome.storage.local),
      save: (shortcuts) => saveRelationShortcuts(chrome.storage.local, shortcuts),
    },
    automaticPageAccess: createAutomaticPageAccessController(chrome),
    randomUUID: () => crypto.randomUUID(),
    async stopSelection() {
      await chrome.runtime.sendMessage({
        type: "ui-attach:element-selection-set",
        enabled: false,
      });
    },
    async notifySettingsChanged() {
      await chrome.runtime.sendMessage({ type: UI_ATTACH_SETTINGS_UPDATED }).catch(() => undefined);
    },
    i18n: createUiAttachI18n(chrome.i18n),
  };
}

export async function initializeOptions(deps: OptionsDependencies): Promise<void> {
  const i18n = deps.i18n ?? createUiAttachI18n();
  const t = i18n.t;
  localizeDocument(document, i18n);
  const elements = queryOptionsElements();
  let relationShortcuts: RelationShortcutPreference[] = [];
  let selectedRelationShortcutId: string | null = null;
  let relationShortcutReturnId: string | null = null;
  let relationShortcutEditorBaseline = { label: "", template: "" };
  let relationShortcutWritePending = false;
  setControlsDisabled(elements, true);

  try {
    const [
      captureMode,
      previewCopy,
      themePreference,
      contextMenuSelection,
      frameScopeAutoStart,
      timeDisplay,
      overlayVisibility,
      savedRelationShortcuts,
      automaticPageAccess,
    ] = await Promise.all([
      deps.captureMode.read(),
      deps.previewCopy.read(),
      deps.themePreference.read(),
      deps.contextMenuSelection.read(),
      deps.frameScopeAutoStart.read(),
      deps.timeDisplay.read(),
      deps.overlayVisibility.read(),
      deps.relationShortcuts.read(),
      deps.automaticPageAccess.read(),
    ]);
    elements.captureMode.value = captureMode;
    elements.independentViewMode.checked = previewCopy.independent;
    elements.viewMode.value = previewCopy.independent ? previewCopy.mode : captureMode;
    elements.viewModeField.hidden = !previewCopy.independent;
    elements.themePreference.value = themePreference;
    elements.contextMenuSelectionMode.value = contextMenuSelection;
    elements.frameScopeAutoStart.checked = frameScopeAutoStart;
    elements.timeDisplayPreference.value = timeDisplay;
    elements.overlayVisibilityPreference.value = overlayVisibility;
    relationShortcuts = savedRelationShortcuts;
    selectedRelationShortcutId = relationShortcuts[0]?.id ?? null;
    elements.automaticPageAccess.checked = automaticPageAccess;
    applyPanelThemePreference(document.documentElement, themePreference);
    setControlsDisabled(elements, false);
    loadRelationShortcutEditor(selectedRelationShortcut());
  } catch {
    elements.status.textContent = t("settings_load_failed");
    return;
  }

  elements.captureMode.addEventListener("change", () => {
    const mode = parseDisclosureMode(elements.captureMode.value);
    if (!elements.independentViewMode.checked) elements.viewMode.value = mode;
    void saveSetting(elements, deps, async () => deps.captureMode.save(mode));
  });

  elements.independentViewMode.addEventListener("change", () => {
    const independent = elements.independentViewMode.checked;
    elements.viewModeField.hidden = !independent;
    if (independent) elements.viewMode.value = elements.captureMode.value;
    const preference = currentPreviewCopyPreference(elements);
    void saveSetting(elements, deps, async () => deps.previewCopy.save(preference));
  });

  elements.viewMode.addEventListener("change", () => {
    void saveSetting(elements, deps, async () => {
      await deps.previewCopy.save(currentPreviewCopyPreference(elements));
    });
  });

  elements.themePreference.addEventListener("change", () => {
    const previous = document.documentElement.dataset.theme;
    const preference = parsePanelThemePreference(elements.themePreference.value);
    applyPanelThemePreference(document.documentElement, preference);
    void saveSetting(elements, deps, async () => {
      try {
        await deps.themePreference.save(preference);
      } catch (error) {
        if (previous) document.documentElement.dataset.theme = previous;
        else delete document.documentElement.dataset.theme;
        throw error;
      }
    });
  });

  elements.contextMenuSelectionMode.addEventListener("change", () => {
    const mode = parseContextMenuSelectionMode(elements.contextMenuSelectionMode.value);
    void saveSetting(elements, deps, async () => deps.contextMenuSelection.save(mode));
  });

  elements.frameScopeAutoStart.addEventListener("change", () => {
    void saveSetting(
      elements,
      deps,
      async () => deps.frameScopeAutoStart.save(elements.frameScopeAutoStart.checked),
    );
  });

  elements.timeDisplayPreference.addEventListener("change", () => {
    const preference: TimeDisplayPreference =
      elements.timeDisplayPreference.value === "utc" ? "utc" : "local";
    void saveSetting(elements, deps, async () => deps.timeDisplay.save(preference));
  });

  elements.overlayVisibilityPreference.addEventListener("change", () => {
    const preference: OverlayVisibilityPreference =
      elements.overlayVisibilityPreference.value === "always" ? "always" : "panel";
    void saveSetting(elements, deps, async () => deps.overlayVisibility.save(preference));
  });

  elements.relationShortcutLabel.addEventListener("input", updateRelationShortcutEditorControls);
  elements.relationShortcutTemplate.addEventListener("input", updateRelationShortcutEditorControls);

  elements.relationShortcutEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveRelationShortcutEditor();
  });

  elements.relationShortcutsList.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("[data-relation-shortcut-id]");
    const id = button?.dataset.relationShortcutId;
    if (!id || id === selectedRelationShortcutId || !canLeaveRelationShortcutEditor()) return;
    const shortcut = relationShortcuts.find((current) => current.id === id);
    if (shortcut) loadRelationShortcutEditor(shortcut);
  });

  elements.newRelationShortcut.addEventListener("click", () => {
    if (relationShortcuts.length >= MAX_RELATION_SHORTCUTS) {
      elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_limit_reached");
      return;
    }
    if (selectedRelationShortcutId === null) {
      elements.relationShortcutLabel.focus();
      return;
    }
    if (!canLeaveRelationShortcutEditor()) return;
    relationShortcutReturnId = selectedRelationShortcutId;
    loadRelationShortcutEditor(null, true);
  });

  elements.cancelRelationShortcut.addEventListener("click", () => {
    const selected = selectedRelationShortcut();
    if (selected) {
      loadRelationShortcutEditor(selected, true);
      elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_changes_cancelled");
      return;
    }
    const returnShortcut = relationShortcuts.find(
      (shortcut) => shortcut.id === relationShortcutReturnId,
    ) ?? relationShortcuts[0] ?? null;
    relationShortcutReturnId = null;
    loadRelationShortcutEditor(returnShortcut, true);
    elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_changes_cancelled");
  });

  elements.removeRelationShortcut.addEventListener("click", () => {
    void removeSelectedRelationShortcut();
  });

  elements.automaticPageAccess.addEventListener("change", () => {
    const requested = elements.automaticPageAccess.checked;
    elements.automaticPageAccess.disabled = true;
    void (async () => {
      try {
        if (!requested) await deps.stopSelection?.().catch(() => undefined);
        const enabled = await deps.automaticPageAccess.setEnabled(requested);
        elements.automaticPageAccess.checked = enabled;
        elements.automaticPageAccessStatus.hidden = false;
        elements.automaticPageAccessStatus.textContent = enabled
          ? t("automatic_page_access_enabled")
          : requested
            ? t("automatic_page_access_denied")
            : t("automatic_page_access_disabled");
        elements.status.textContent = t("settings_saved");
        await deps.notifySettingsChanged();
      } catch {
        elements.automaticPageAccess.checked = !requested;
        elements.status.textContent = t("settings_save_failed");
      } finally {
        elements.automaticPageAccess.disabled = false;
      }
    })();
  });

  async function persistRelationShortcuts(
    next: RelationShortcutPreference[],
  ): Promise<boolean> {
    if (relationShortcutWritePending) return false;
    relationShortcutWritePending = true;
    updateRelationShortcutEditorControls();
    const saved = await saveSetting(elements, deps, async () => deps.relationShortcuts.save(next));
    if (saved) relationShortcuts = next;
    relationShortcutWritePending = false;
    renderRelationShortcutList();
    updateRelationShortcutEditorControls();
    return saved;
  }

  async function saveRelationShortcutEditor(): Promise<void> {
    if (relationShortcutWritePending || !relationShortcutEditorIsDirty()) return;
    if (selectedRelationShortcutId === null && relationShortcuts.length >= MAX_RELATION_SHORTCUTS) {
      elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_limit_reached");
      return;
    }
    const id = selectedRelationShortcutId ?? deps.randomUUID();
    const shortcut = normalizeRelationShortcut({
      id,
      label: elements.relationShortcutLabel.value,
      template: elements.relationShortcutTemplate.value,
    });
    if (shortcut === null) {
      elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_invalid");
      if (!elements.relationShortcutLabel.value.trim()) elements.relationShortcutLabel.focus();
      else elements.relationShortcutTemplate.focus();
      return;
    }
    const next = selectedRelationShortcutId === null
      ? [...relationShortcuts, shortcut]
      : relationShortcuts.map((current) => current.id === id ? shortcut : current);
    const saved = await persistRelationShortcuts(next);
    if (!saved) {
      elements.relationShortcutEditorStatus.textContent = t("settings_save_failed");
      return;
    }
    relationShortcutReturnId = null;
    loadRelationShortcutEditor(shortcut);
    elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_saved");
    elements.relationShortcutLabel.focus();
  }

  async function removeSelectedRelationShortcut(): Promise<void> {
    if (selectedRelationShortcutId === null || relationShortcutWritePending) return;
    if (!canLeaveRelationShortcutEditor()) return;
    const removedIndex = relationShortcuts.findIndex(
      (shortcut) => shortcut.id === selectedRelationShortcutId,
    );
    const next = relationShortcuts.filter(
      (shortcut) => shortcut.id !== selectedRelationShortcutId,
    );
    const saved = await persistRelationShortcuts(next);
    if (!saved) {
      elements.relationShortcutEditorStatus.textContent = t("settings_save_failed");
      return;
    }
    relationShortcutReturnId = null;
    const nextSelection = next[removedIndex] ?? next[removedIndex - 1] ?? null;
    loadRelationShortcutEditor(nextSelection);
    elements.relationShortcutEditorStatus.textContent = t("relation_shortcut_removed");
    const nextButton = nextSelection
      ? Array.from(elements.relationShortcutsList.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.dataset.relationShortcutId === nextSelection.id) ?? null
      : null;
    (nextButton ?? elements.relationShortcutLabel).focus();
  }

  function selectedRelationShortcut(): RelationShortcutPreference | null {
    if (selectedRelationShortcutId === null) return null;
    return relationShortcuts.find(
      (shortcut) => shortcut.id === selectedRelationShortcutId,
    ) ?? null;
  }

  function relationShortcutEditorIsDirty(): boolean {
    return elements.relationShortcutLabel.value !== relationShortcutEditorBaseline.label
      || elements.relationShortcutTemplate.value !== relationShortcutEditorBaseline.template;
  }

  function canLeaveRelationShortcutEditor(): boolean {
    if (relationShortcutWritePending) return false;
    if (!relationShortcutEditorIsDirty()) return true;
    elements.relationShortcutEditorStatus.textContent = t(
      "relation_shortcut_save_or_cancel_before_switching",
    );
    elements.saveRelationShortcut.focus();
    return false;
  }

  function loadRelationShortcutEditor(
    shortcut: RelationShortcutPreference | null,
    focusName = false,
  ): void {
    selectedRelationShortcutId = shortcut?.id ?? null;
    relationShortcutEditorBaseline = {
      label: shortcut?.label ?? "",
      template: shortcut?.template ?? "",
    };
    elements.relationShortcutLabel.value = relationShortcutEditorBaseline.label;
    elements.relationShortcutTemplate.value = relationShortcutEditorBaseline.template;
    elements.relationShortcutEditorHeading.textContent = t(
      shortcut ? "edit_shortcut" : "new_shortcut",
    );
    elements.saveRelationShortcut.textContent = t(
      shortcut ? "save_shortcut_changes" : "add_shortcut",
    );
    elements.removeRelationShortcut.hidden = shortcut === null;
    if (shortcut) {
      elements.removeRelationShortcut.setAttribute(
        "aria-label",
        t("remove_shortcut_named", { name: shortcut.label }),
      );
    } else {
      elements.removeRelationShortcut.removeAttribute("aria-label");
    }
    elements.relationShortcutEditorStatus.textContent = "";
    renderRelationShortcutList();
    updateRelationShortcutEditorControls();
    if (focusName) elements.relationShortcutLabel.focus();
  }

  function renderRelationShortcutList(): void {
    elements.relationShortcutsList.replaceChildren();
    elements.relationShortcutsEmpty.hidden = relationShortcuts.length > 0;
    for (const shortcut of relationShortcuts) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "relation-shortcut-list-button";
      button.dataset.relationShortcutId = shortcut.id;
      button.textContent = shortcut.label;
      button.setAttribute("aria-pressed", String(shortcut.id === selectedRelationShortcutId));
      button.disabled = relationShortcutWritePending;
      item.append(button);
      elements.relationShortcutsList.append(item);
    }
  }

  function updateRelationShortcutEditorControls(): void {
    const dirty = relationShortcutEditorIsDirty();
    const isNewShortcut = selectedRelationShortcutId === null;
    elements.relationShortcutLabel.disabled = relationShortcutWritePending;
    elements.relationShortcutTemplate.disabled = relationShortcutWritePending;
    elements.newRelationShortcut.disabled = relationShortcutWritePending
      || relationShortcuts.length >= MAX_RELATION_SHORTCUTS;
    elements.saveRelationShortcut.disabled = relationShortcutWritePending || !dirty;
    elements.cancelRelationShortcut.disabled = relationShortcutWritePending
      || (!dirty && !(isNewShortcut && relationShortcutReturnId !== null));
    elements.removeRelationShortcut.disabled = relationShortcutWritePending || dirty;
    elements.relationShortcutsList.querySelectorAll<HTMLButtonElement>("button").forEach(
      (button) => { button.disabled = relationShortcutWritePending; },
    );
  }
}

async function saveSetting(
  elements: ReturnType<typeof queryOptionsElements>,
  deps: OptionsDependencies,
  save: () => Promise<void>,
): Promise<boolean> {
  elements.status.textContent = "";
  try {
    await save();
    elements.status.textContent = (deps.i18n ?? createUiAttachI18n()).t("settings_saved");
    await deps.notifySettingsChanged();
    return true;
  } catch {
    elements.status.textContent = (deps.i18n ?? createUiAttachI18n()).t("settings_save_failed");
    return false;
  }
}

function currentPreviewCopyPreference(
  elements: ReturnType<typeof queryOptionsElements>,
): PreviewCopyPreference {
  return {
    independent: elements.independentViewMode.checked,
    mode: parseDisclosureMode(elements.viewMode.value),
  };
}

function parseDisclosureMode(value: string): UIAttachmentDisclosureMode {
  if (value === "developer_diagnostic" || value === "full_debug") return value;
  return "agent_safe";
}

function parseContextMenuSelectionMode(value: string): ContextMenuSelectionMode {
  return value === "continuous" ? "continuous" : "single";
}

function setControlsDisabled(
  elements: ReturnType<typeof queryOptionsElements>,
  disabled: boolean,
): void {
  elements.captureMode.disabled = disabled;
  elements.independentViewMode.disabled = disabled;
  elements.viewMode.disabled = disabled;
  elements.themePreference.disabled = disabled;
  elements.contextMenuSelectionMode.disabled = disabled;
  elements.frameScopeAutoStart.disabled = disabled;
  elements.timeDisplayPreference.disabled = disabled;
  elements.overlayVisibilityPreference.disabled = disabled;
  elements.newRelationShortcut.disabled = disabled;
  elements.relationShortcutLabel.disabled = disabled;
  elements.relationShortcutTemplate.disabled = disabled;
  elements.saveRelationShortcut.disabled = disabled;
  elements.cancelRelationShortcut.disabled = disabled;
  elements.removeRelationShortcut.disabled = disabled;
  elements.relationShortcutsList.querySelectorAll<HTMLButtonElement>("button").forEach(
    (element) => { element.disabled = disabled; },
  );
  elements.automaticPageAccess.disabled = disabled;
}

function queryOptionsElements() {
  return {
    captureMode: query<HTMLSelectElement>("#capture-mode"),
    independentViewMode: query<HTMLInputElement>("#independent-view-mode"),
    viewModeField: query<HTMLElement>("#view-mode-field"),
    viewMode: query<HTMLSelectElement>("#view-mode"),
    themePreference: query<HTMLSelectElement>("#theme-preference"),
    contextMenuSelectionMode: query<HTMLSelectElement>("#context-menu-selection-mode"),
    frameScopeAutoStart: query<HTMLInputElement>("#frame-scope-auto-start"),
    timeDisplayPreference: query<HTMLSelectElement>("#time-display-preference"),
    overlayVisibilityPreference: query<HTMLSelectElement>("#overlay-visibility-preference"),
    relationShortcutsList: query<HTMLElement>("#relation-shortcuts-list"),
    relationShortcutsEmpty: query<HTMLElement>("#relation-shortcuts-empty"),
    newRelationShortcut: query<HTMLButtonElement>("#new-relation-shortcut"),
    relationShortcutEditor: query<HTMLFormElement>("#relation-shortcut-editor"),
    relationShortcutEditorHeading: query<HTMLElement>("#relation-shortcut-editor-heading"),
    relationShortcutEditorStatus: query<HTMLElement>("#relation-shortcut-editor-status"),
    relationShortcutLabel: query<HTMLInputElement>("#relation-shortcut-label"),
    relationShortcutTemplate: query<HTMLTextAreaElement>("#relation-shortcut-template"),
    saveRelationShortcut: query<HTMLButtonElement>("#save-relation-shortcut"),
    cancelRelationShortcut: query<HTMLButtonElement>("#cancel-relation-shortcut"),
    removeRelationShortcut: query<HTMLButtonElement>("#remove-relation-shortcut"),
    automaticPageAccess: query<HTMLInputElement>("#automatic-page-access"),
    automaticPageAccessStatus: query<HTMLElement>("#automatic-page-access-status"),
    status: query<HTMLElement>("#settings-status"),
  };
}

function query<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`Missing settings element: ${selector}`);
  return found as T;
}
