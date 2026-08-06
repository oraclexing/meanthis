import type { PanelSessionRow } from "./panel-session-model";
import { translateEnglish, type UiAttachTranslate } from "./i18n";
import type { RelationShortcutPreference } from "./settings-preferences";

export const PANEL_RELATION_ACTIONS = [
  "below",
  "above",
  "left-of",
  "right-of",
  "align-left",
  "match-width",
] as const;

export type PanelRelationAction = (typeof PANEL_RELATION_ACTIONS)[number];
export type PanelRelationShortcut = PanelRelationAction | RelationShortcutPreference;

export interface PanelRelationTarget {
  itemId: string;
  label: string;
  target: string;
}

export interface PanelRelationModel {
  targets: PanelRelationTarget[];
  defaultSourceItemId: string;
  defaultReferenceItemId: string;
}

export type PanelRelationIntentResult =
  | { ok: true; intent: string }
  | { ok: false; error: string };

export type PanelRelationActionPresentationResult =
  | { ok: true; label: string; ariaLabel: string }
  | { ok: false; error: string };

export function buildPanelRelationModel(rows: PanelSessionRow[]): PanelRelationModel | null {
  if (rows.length < 2) return null;
  const targets = rows.map((row) => ({
    itemId: row.id,
    label: row.label,
    target: row.target,
  }));
  return {
    targets,
    defaultSourceItemId: targets[0]!.itemId,
    defaultReferenceItemId: targets[1]!.itemId,
  };
}

export function buildPanelRelationIntent(
  model: PanelRelationModel,
  sourceItemId: string,
  action: PanelRelationShortcut,
  referenceItemId: string,
  translate: UiAttachTranslate = translateEnglish,
): PanelRelationIntentResult {
  const source = model.targets.find((target) => target.itemId === sourceItemId);
  const reference = model.targets.find((target) => target.itemId === referenceItemId);
  if (!source || !reference) {
    return { ok: false, error: translate("choose_two_elements") };
  }
  if (source.itemId === reference.itemId) {
    return { ok: false, error: translate("choose_different_elements") };
  }
  return {
    ok: true,
    intent: formatRelationIntent(action, source.label, reference.label, translate),
  };
}

export function buildPanelRelationActionPresentation(
  model: PanelRelationModel,
  sourceItemId: string,
  action: PanelRelationAction,
  referenceItemId: string,
  translate: UiAttachTranslate = translateEnglish,
): PanelRelationActionPresentationResult {
  const intentResult = buildPanelRelationIntent(
    model,
    sourceItemId,
    action,
    referenceItemId,
    translate,
  );
  if (!intentResult.ok) return intentResult;

  const source = model.targets.find((target) => target.itemId === sourceItemId)!;
  const reference = model.targets.find((target) => target.itemId === referenceItemId)!;
  return {
    ok: true,
    label: formatRelationActionLabel(action, source.label, reference.label, translate),
    ariaLabel: intentResult.intent,
  };
}

export function isPanelRelationAction(value: string): value is PanelRelationAction {
  return (PANEL_RELATION_ACTIONS as readonly string[]).includes(value);
}

function formatRelationIntent(
  action: PanelRelationShortcut,
  sourceLabel: string,
  referenceLabel: string,
  translate: UiAttachTranslate,
): string {
  if (typeof action !== "string") {
    return action.template
      .replaceAll("{selected}", sourceLabel)
      .replaceAll("{reference}", referenceLabel);
  }
  return translate(`relation_intent_${action.replaceAll("-", "_")}`, {
    source: sourceLabel,
    reference: referenceLabel,
  });
}

function formatRelationActionLabel(
  action: PanelRelationAction,
  sourceLabel: string,
  referenceLabel: string,
  translate: UiAttachTranslate,
): string {
  return translate(`relation_label_${action.replaceAll("-", "_")}`, {
    source: sourceLabel,
    reference: referenceLabel,
  });
}
