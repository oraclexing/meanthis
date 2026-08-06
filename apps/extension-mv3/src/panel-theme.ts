export const PANEL_THEME_KEY = "ui-attach:panel-theme";

export type PanelThemePreference = "system" | "light" | "dark";

export interface PanelThemeStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readPanelThemePreference(
  storage: PanelThemeStorageArea,
): Promise<PanelThemePreference> {
  const values = await storage.get(PANEL_THEME_KEY);
  return parsePanelThemePreference(values[PANEL_THEME_KEY]);
}

export async function savePanelThemePreference(
  storage: PanelThemeStorageArea,
  preference: PanelThemePreference,
): Promise<void> {
  await storage.set({ [PANEL_THEME_KEY]: preference });
}

export function parsePanelThemePreference(value: unknown): PanelThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function applyPanelThemePreference(
  root: HTMLElement,
  preference: PanelThemePreference,
): void {
  if (preference === "system") {
    delete root.dataset.theme;
    return;
  }
  root.dataset.theme = preference;
}
