import { BRIDGE_MESSAGE_KEYS } from "./extension-surface-profile.mjs";

const BRIDGE_RUNTIME_MARKER = "ui-attach:local-agent-bridge";
const BRIDGE_ALARM_MARKER = "ui-attach.local-agent-bridge.refresh.v1";
const BRIDGE_LOCALE_KEYS = BRIDGE_MESSAGE_KEYS;

export function assertBridgeSurface(
  profile,
  { backgroundScript, localeCatalogs, panelHtml, javascriptSources },
) {
  const localeValues = [...localeCatalogs.values()];
  const hasLocaleKey = (catalog, key) => (
    catalog !== null
    && typeof catalog === "object"
    && Object.hasOwn(catalog, key)
  );
  const hasBridgeHeading = panelHtml.includes("local-bridge-heading");
  const hasBridgeAlarm = backgroundScript.includes(BRIDGE_ALARM_MARKER);
  const hasBridgeRuntime = [...javascriptSources.values()].some((source) => (
    source.includes(BRIDGE_RUNTIME_MARKER)
  ));
  const anyBridgeLocale = localeValues.some((catalog) => (
    BRIDGE_LOCALE_KEYS.some((key) => hasLocaleKey(catalog, key))
  ));
  const completeBridgeLocales = localeValues.length > 0
    && localeValues.every((catalog) => (
      BRIDGE_LOCALE_KEYS.every((key) => hasLocaleKey(catalog, key))
    ));
  const completeBridgeSurface = hasBridgeAlarm
    && hasBridgeHeading
    && completeBridgeLocales
    && hasBridgeRuntime;

  if (!completeBridgeSurface) {
    const label = profile === "consumer" ? "Consumer" : "Development";
    throw new Error(`${label} extension artifact must preserve the local bridge surface`);
  }
}
