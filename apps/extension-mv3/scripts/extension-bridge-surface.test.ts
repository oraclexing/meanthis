import { describe, expect, test } from "vitest";
import { assertBridgeSurface } from "./extension-bridge-surface.mjs";
import { BRIDGE_MESSAGE_KEYS } from "./extension-surface-profile.mjs";

const runtimeOnlyInPanel = new Map([
  ["assets/background.js", ""],
  ["assets/content.js", ""],
  ["assets/panel.js", "ui-attach:local-agent-bridge"],
  ["assets/session-file.js", ""],
]);
const bridgeLocale = Object.fromEntries(BRIDGE_MESSAGE_KEYS.map((key) => [
  key,
  { message: key },
]));
const bridgeLocales = new Map([["en", bridgeLocale]]);

function assertProfileRejected(profile: "consumer" | "development", overrides = {}) {
  expect(() => assertBridgeSurface(profile, {
    backgroundScript: "ui-attach.local-agent-bridge.refresh.v1",
    localeCatalogs: bridgeLocales,
    panelHtml: '<details id="local-bridge-settings"><summary id="local-bridge-heading"></summary></details>',
    javascriptSources: runtimeOnlyInPanel,
    ...overrides,
  })).toThrow(`${profile === "consumer" ? "Consumer" : "Development"} extension artifact must preserve the local bridge surface`);
}

describe("extension bridge artifact surface", () => {
  test("scans every published JavaScript asset for the canonical bridge runtime marker", () => {
    expect(() => assertBridgeSurface("consumer", {
      backgroundScript: "ui-attach.local-agent-bridge.refresh.v1",
      localeCatalogs: bridgeLocales,
      panelHtml: '<details id="local-bridge-settings"><summary id="local-bridge-heading"></summary></details>',
      javascriptSources: runtimeOnlyInPanel,
    })).not.toThrow();

    expect(() => assertBridgeSurface("development", {
      backgroundScript: "ui-attach.local-agent-bridge.refresh.v1",
      localeCatalogs: bridgeLocales,
      panelHtml: '<details id="local-bridge-settings"><summary id="local-bridge-heading"></summary></details>',
      javascriptSources: runtimeOnlyInPanel,
    })).not.toThrow();
  });

  test("requires every bridge locale key in both profiles", () => {
    for (const key of BRIDGE_MESSAGE_KEYS) {
      const missing = structuredClone(bridgeLocale);
      delete missing[key];
      assertProfileRejected("consumer", { localeCatalogs: new Map([["en", missing]]) });
    }
    assertProfileRejected("development", {
      localeCatalogs: new Map([
        ["en", bridgeLocale],
        ["zh_CN", { local_agent_bridge: { message: "Local bridge" } }],
      ]),
    });
  });

  test("requires bridge DOM, alarm, and runtime in both profiles", () => {
    for (const profile of ["consumer", "development"] as const) {
      assertProfileRejected(profile, { panelHtml: "" });
      assertProfileRejected(profile, { backgroundScript: "" });
      assertProfileRejected(profile, { javascriptSources: new Map() });
    }
  });
});
