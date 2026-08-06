import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXTENSION_RUNTIME_FILES } from "./extension-release-artifact.mjs";
import {
  extensionProfileOutDir,
  parseExtensionSurfaceProfile,
} from "./extension-surface-profile.mjs";
import { assertBridgeSurface } from "./extension-bridge-surface.mjs";
import { assertMeanThisExtensionIdentity } from "./extension-identity.mjs";

const surfaceProfile = parseExtensionSurfaceProfile(process.argv[2] ?? "development");
const dist = new URL(`../${extensionProfileOutDir(surfaceProfile)}/`, import.meta.url);
const distPath = fileURLToPath(dist);

const artifactFiles = [];

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error("Extension artifact contains an unsupported filesystem entry");
    }
    if (entry.isDirectory()) {
      await collectFiles(new URL(`${path}/`, dist), path);
      continue;
    }
    artifactFiles.push(path);
  }
}

await collectFiles(distPath);
artifactFiles.sort();
if (JSON.stringify(artifactFiles) !== JSON.stringify(EXTENSION_RUNTIME_FILES)) {
  throw new Error("Extension artifact file set is not stable");
}

for (const file of EXTENSION_RUNTIME_FILES) {
  const bytes = await readFile(new URL(file, dist));
  if (bytes.length === 0) {
    throw new Error(`Extension artifact must be non-empty: ${file}`);
  }
}

const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
const javascriptSources = new Map(await Promise.all(
  EXTENSION_RUNTIME_FILES.filter((file) => file.endsWith(".js")).map(async (file) => [
    file,
    await readFile(new URL(file, dist), "utf8"),
  ]),
));
const backgroundScript = javascriptSources.get("assets/background.js");
if (typeof backgroundScript !== "string") {
  throw new Error("Extension artifact is missing its background script");
}
const contentScript = await readFile(new URL("assets/content.js", dist), "utf8");
const optionsHtml = await readFile(new URL("options.html", dist), "utf8");
const panelHtml = await readFile(new URL("panel.html", dist), "utf8");
const englishMessages = JSON.parse(
  await readFile(new URL("_locales/en/messages.json", dist), "utf8"),
);
const simplifiedChineseMessages = JSON.parse(
  await readFile(new URL("_locales/zh_CN/messages.json", dist), "utf8"),
);

if (manifest.manifest_version !== 3) {
  throw new Error("Extension manifest must use MV3");
}
assertMeanThisExtensionIdentity(manifest);

const expectedIcons = {
  "16": "icons/meanthis-16.png",
  "32": "icons/meanthis-32.png",
  "48": "icons/meanthis-48.png",
  "128": "icons/meanthis-128.png",
};
if (manifest.name !== "MeanThis"
  || manifest.default_locale !== "en"
  || manifest.minimum_chrome_version !== "120"
  || manifest.description !== "__MSG_extension_description__"
  || JSON.stringify(manifest.icons) !== JSON.stringify(expectedIcons)
  || JSON.stringify(manifest.action) !== JSON.stringify({
    default_icon: expectedIcons,
    default_title: "__MSG_open_ui_attach__",
  })) {
  throw new Error("Extension manifest product identity is not stable");
}

if (englishMessages.extension_description?.message !==
    "Select UI elements and provide precise, local context for an agent."
  || englishMessages.open_ui_attach?.message !== "Open MeanThis"
  || simplifiedChineseMessages.extension_description?.message !==
    "选择 UI 元素，并为 Agent 提供精确的本地上下文。"
  || simplifiedChineseMessages.add_elements?.message !== "添加元素"
  || JSON.stringify(Object.keys(englishMessages).sort()) !==
    JSON.stringify(Object.keys(simplifiedChineseMessages).sort())) {
  throw new Error("Extension locale catalogs are incomplete or misaligned");
}

if (manifest.background?.service_worker !== "assets/background.js") {
  throw new Error("Extension manifest background path is not stable");
}

const expectedPermissions = [
  "activeTab",
  "alarms",
  "contextMenus",
  "scripting",
  "sidePanel",
  "storage",
  "webNavigation",
];
if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify(expectedPermissions)) {
  throw new Error("Extension manifest permissions are not minimal and stable");
}

if ("host_permissions" in manifest || "content_scripts" in manifest) {
  throw new Error("Extension manifest must not request unconditional host access");
}

const expectedOptionalHostPermissions = [
  "http://127.0.0.1/*",
  "http://*/*",
  "https://*/*",
];
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOptionalHostPermissions)) {
  throw new Error("Extension optional host access must remain explicit and user-scoped");
}

if (!backgroundScript.includes("assets/content.js")) {
  throw new Error("Extension background must reference the packaged content script");
}

if (manifest.side_panel?.default_path !== "panel.html") {
  throw new Error("Extension manifest side panel path is not stable");
}

if (JSON.stringify(manifest.options_ui) !== JSON.stringify({
  page: "options.html",
  open_in_tab: true,
})) {
  throw new Error("Extension manifest settings page is not stable");
}

if (manifest.permissions?.includes("downloads")) {
  throw new Error("Extension manifest must not request downloads permission");
}

assertBridgeSurface(surfaceProfile, {
  backgroundScript,
  javascriptSources,
  localeCatalogs: new Map([
    ["en", englishMessages],
    ["zh_CN", simplifiedChineseMessages],
  ]),
  panelHtml,
});

for (const marker of [
  "open-settings",
  "current-content-mode",
  "session-list",
  "clear-session",
  "export-session",
  'data-i18n="add_elements"',
  'data-i18n="copy_for_agent"',
]) {
  if (!panelHtml.includes(marker)) {
    throw new Error(`Extension panel artifact is missing ${marker}`);
  }
}


for (const marker of [
  "capture-mode",
  "view-mode",
  "theme-preference",
  "automatic-page-access",
  'data-i18n="settings_capture_privacy"',
  'data-i18n="settings_page_access"',
  'data-i18n="settings_appearance"',
  'data-i18n="settings_advanced"',
]) {
  if (!optionsHtml.includes(marker)) {
    throw new Error(`Extension settings artifact is missing ${marker}`);
  }
}

if (/^\s*import(?:\s|\{)/m.test(contentScript)) {
  throw new Error("Extension content script must be bundled without module imports");
}

console.log("Extension artifact verified");
