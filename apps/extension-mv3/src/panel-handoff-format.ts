import type { CapturePromptBundleFormat } from "@meanthis/hub-core";

const SINGLE_TARGET_HANDOFF_FORMAT_KEY = "ui-attach:handoff-format:single-target";
const MULTI_TARGET_HANDOFF_FORMAT_KEY = "ui-attach:handoff-format:multi-target";

export type PanelHandoffFormatScope = "single" | "multi";

export interface PanelHandoffFormatPreferences {
  singleTarget: CapturePromptBundleFormat;
  multiTarget: CapturePromptBundleFormat;
}

export interface PanelHandoffFormatStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readPanelHandoffFormatPreferences(
  storage: PanelHandoffFormatStorageArea,
): Promise<PanelHandoffFormatPreferences> {
  const values = await storage.get([
    SINGLE_TARGET_HANDOFF_FORMAT_KEY,
    MULTI_TARGET_HANDOFF_FORMAT_KEY,
  ]);
  return {
    singleTarget: parseHandoffFormat(values[SINGLE_TARGET_HANDOFF_FORMAT_KEY], "exact"),
    multiTarget: parseHandoffFormat(values[MULTI_TARGET_HANDOFF_FORMAT_KEY], "compact"),
  };
}

export async function savePanelHandoffFormatPreference(
  storage: PanelHandoffFormatStorageArea,
  scope: PanelHandoffFormatScope,
  format: CapturePromptBundleFormat,
): Promise<void> {
  const key = scope === "single"
    ? SINGLE_TARGET_HANDOFF_FORMAT_KEY
    : MULTI_TARGET_HANDOFF_FORMAT_KEY;
  await storage.set({ [key]: format });
}

function parseHandoffFormat(
  value: unknown,
  fallback: CapturePromptBundleFormat,
): CapturePromptBundleFormat {
  return value === "exact" || value === "compact" ? value : fallback;
}
