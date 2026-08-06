import { describe, expect, test } from "vitest";
import type { PanelSessionRow } from "./panel-session-model";
import {
  buildPanelRelationActionPresentation,
  buildPanelRelationIntent,
  buildPanelRelationModel,
} from "./panel-relation-task";

const ROWS: PanelSessionRow[] = [
  row("att_save", "A", "button - Save changes"),
  row("att_cancel", "B", "button - Cancel"),
  row("att_help", "C", "link - Help"),
];

describe("panel relation task", () => {
  test("defaults to the first two named captures without exposing item ids", () => {
    const model = buildPanelRelationModel(ROWS);

    expect(model).toEqual({
      targets: [
        { itemId: "att_save", label: "A", target: "button - Save changes" },
        { itemId: "att_cancel", label: "B", target: "button - Cancel" },
        { itemId: "att_help", label: "C", target: "link - Help" },
      ],
      defaultSourceItemId: "att_save",
      defaultReferenceItemId: "att_cancel",
    });
  });

  test("formats every low-cognition relationship action from stable labels", () => {
    const model = buildPanelRelationModel(ROWS);
    if (!model) throw new Error("relation model missing");

    expect([
      "below",
      "above",
      "left-of",
      "right-of",
      "align-left",
      "match-width",
    ].map((action) => buildPanelRelationIntent(
      model,
      "att_save",
      action,
      "att_cancel",
    ))).toEqual([
      { ok: true, intent: "Move A below B." },
      { ok: true, intent: "Move A above B." },
      { ok: true, intent: "Move A to the left of B." },
      { ok: true, intent: "Move A to the right of B." },
      { ok: true, intent: "Align A's left edge with B's left edge." },
      { ok: true, intent: "Match A's width to B's width." },
    ]);
  });

  test("pairs concise action labels with the complete deterministic intent", () => {
    const model = buildPanelRelationModel(ROWS);
    if (!model) throw new Error("relation model missing");

    expect([
      "below",
      "above",
      "left-of",
      "right-of",
      "align-left",
      "match-width",
    ].map((action) => buildPanelRelationActionPresentation(
      model,
      "att_save",
      action,
      "att_cancel",
    ))).toEqual([
      { ok: true, label: "A below B", ariaLabel: "Move A below B." },
      { ok: true, label: "A above B", ariaLabel: "Move A above B." },
      { ok: true, label: "A left of B", ariaLabel: "Move A to the left of B." },
      { ok: true, label: "A right of B", ariaLabel: "Move A to the right of B." },
      { ok: true, label: "Align A left to B", ariaLabel: "Align A's left edge with B's left edge." },
      { ok: true, label: "Match A width to B", ariaLabel: "Match A's width to B's width." },
    ]);
  });

  test("can localize relationship labels and generated intent without changing element references", () => {
    const model = buildPanelRelationModel(ROWS);
    if (!model) throw new Error("relation model missing");
    const translate = (key: string, values: Record<string, string | number> = {}) => {
      const messages: Record<string, string> = {
        relation_intent_below: "把 {source} 移到 {reference} 下方。",
        relation_label_below: "{source} 在 {reference} 下方",
      };
      return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => (
        String(values[name] ?? `{${name}}`)
      ));
    };

    expect(buildPanelRelationActionPresentation(
      model,
      "att_save",
      "below",
      "att_cancel",
      translate,
    )).toEqual({
      ok: true,
      label: "A 在 B 下方",
      ariaLabel: "把 A 移到 B 下方。",
    });
  });

  test("formats a user-defined shortcut from selected and reference placeholders", () => {
    const model = buildPanelRelationModel(ROWS);
    if (!model) throw new Error("relation model missing");

    expect(buildPanelRelationIntent(
      model,
      "att_save",
      {
        id: "shortcut-spacing",
        label: "Match spacing",
        template: "Adjust {selected} to keep the same spacing as {reference}.",
      },
      "att_cancel",
    )).toEqual({
      ok: true,
      intent: "Adjust A to keep the same spacing as B.",
    });
  });

  test("stays unavailable for one capture and rejects the same or unknown target", () => {
    expect(buildPanelRelationModel(ROWS.slice(0, 1))).toBeNull();
    const model = buildPanelRelationModel(ROWS);
    if (!model) throw new Error("relation model missing");

    expect(buildPanelRelationIntent(model, "att_save", "below", "att_save")).toEqual({
      ok: false,
      error: "Choose two different elements.",
    });
    expect(buildPanelRelationIntent(model, "att_unknown", "below", "att_cancel")).toEqual({
      ok: false,
      error: "Choose two captured elements.",
    });
    expect(buildPanelRelationActionPresentation(
      model,
      "att_save",
      "below",
      "att_save",
    )).toEqual({
      ok: false,
      error: "Choose two different elements.",
    });
  });
});

function row(id: string, label: string, target: string): PanelSessionRow {
  return {
    id,
    label,
    target,
    capturedAt: "2026-07-11T10:00:00.000Z",
    sourceDisclosureMode: "agent_safe",
    selected: false,
  };
}
