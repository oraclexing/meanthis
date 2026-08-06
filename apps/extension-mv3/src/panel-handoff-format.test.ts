import { describe, expect, test, vi } from "vitest";
import {
  readPanelHandoffFormatPreferences,
  savePanelHandoffFormatPreference,
} from "./panel-handoff-format";

describe("extension panel handoff format preferences", () => {
  test.each([
    [{}, { singleTarget: "exact", multiTarget: "compact" }],
    [{
      "ui-attach:handoff-format:single-target": "compact",
      "ui-attach:handoff-format:multi-target": "exact",
    }, { singleTarget: "compact", multiTarget: "exact" }],
    [{
      "ui-attach:handoff-format:single-target": "unexpected",
      "ui-attach:handoff-format:multi-target": null,
    }, { singleTarget: "exact", multiTarget: "compact" }],
  ] as const)("reads bounded preferences from %j", async (stored, expected) => {
    const storage = {
      get: vi.fn(async () => stored),
      set: vi.fn(async () => undefined),
    };

    await expect(readPanelHandoffFormatPreferences(storage)).resolves.toEqual(expected);
    expect(storage.get).toHaveBeenCalledWith([
      "ui-attach:handoff-format:single-target",
      "ui-attach:handoff-format:multi-target",
    ]);
  });

  test.each([
    ["single", "compact", { "ui-attach:handoff-format:single-target": "compact" }],
    ["multi", "exact", { "ui-attach:handoff-format:multi-target": "exact" }],
  ] as const)("persists only the %s-target preference", async (scope, format, expected) => {
    const storage = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };

    await savePanelHandoffFormatPreference(storage, scope, format);

    expect(storage.set).toHaveBeenCalledWith(expected);
  });
});
