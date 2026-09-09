import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseHtml } from "parse5";
import { parseAst } from "rolldown/parseAst";
import { assertArtifactMetadataVersion } from "../../../scripts/version-alignment.mjs";
import { assertMeanThisExtensionIdentity } from "./extension-identity.mjs";
import { parseExtensionSurfaceProfile } from "./extension-surface-profile.mjs";

const EXTENSION_RUNTIME_STATIC_FILES = Object.freeze([
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
  "assets/automatic-page-access.js",
  "assets/background.js",
  "assets/capture-store.js",
  "assets/content.js",
  "assets/in-page-widget-contract.js",
  "assets/local-agent-bridge-runtime.js",
  "assets/messages.js",
  "assets/options.css",
  "assets/options.js",
  "assets/panel.css",
  "assets/panel.js",
  "assets/panel-session-controller.js",
  "assets/session-file.js",
  "assets/settings-preferences.js",
  "assets/src.js",
  "icons/document-duplicate.svg",
  "icons/meanthis-128.png",
  "icons/meanthis-16.png",
  "icons/meanthis-32.png",
  "icons/meanthis-48.png",
  "icons/pause.svg",
  "icons/play.svg",
  "icons/rectangle-group.svg",
  "icons/settings.svg",
  "icons/trash.svg",
  "icons/x-mark.svg",
  "manifest.json",
  "options.html",
  "panel.html",
  "widget.html",
]);
const CANONICAL_WIDGET_ENTRY_ASSET = "assets/widget.js";
const EXPECTED_WIDGET_MODULE_IMPORTS = Object.freeze({
  "assets/in-page-widget-contract.js": Object.freeze(["assets/session-file.js"]),
  "assets/messages.js": Object.freeze([]),
  "assets/panel-session-controller.js": Object.freeze([
    "assets/session-file.js",
    "assets/src.js",
  ]),
  "assets/session-file.js": Object.freeze([
    "assets/settings-preferences.js",
    "assets/src.js",
  ]),
  "assets/settings-preferences.js": Object.freeze([]),
  "assets/src.js": Object.freeze([]),
});
export const EXTENSION_RUNTIME_FILES = Object.freeze(
  runtimeFilesForWidgetEntry(CANONICAL_WIDGET_ENTRY_ASSET),
);
export const EXTENSION_RELEASE_FILES = Object.freeze([
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ...EXTENSION_RUNTIME_FILES,
]);

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE = 33;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0314;
const EXTERNAL_FILE_ATTRIBUTES = 0x81a40000;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ROOT_KEYS = [
  "schemaVersion", "kind", "package", "surfaceProfile", "version", "archive", "contents", "install", "cli",
];
const ARCHIVE_KEYS = ["filename", "bytes", "sha256", "format"];
const CONTENT_KEYS = ["path", "bytes", "sha256"];
const INSTALL_KEYS = ["mode", "entrypoint"];
const CLI_KEYS = ["package", "included", "status", "requiresCheckout"];
const SURFACE_CAPABILITIES = Object.freeze({
  consumer: Object.freeze({
    hostPermissions: [],
    permissions: ["activeTab", "alarms", "contextMenus", "nativeMessaging", "scripting", "sidePanel", "storage", "webNavigation"],
    optionalHostPermissions: ["http://127.0.0.1/*", "http://*/*", "https://*/*"],
  }),
  development: Object.freeze({
    hostPermissions: ["http://127.0.0.1/*"],
    permissions: ["activeTab", "alarms", "contextMenus", "nativeMessaging", "scripting", "sidePanel", "storage", "webNavigation"],
    optionalHostPermissions: ["http://*/*", "https://*/*"],
  }),
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const WIDGET_HTML_ELEMENTS = new Set([
  "body", "head", "html", "main", "meta", "script", "style", "title",
]);

function htmlAttributes(element) {
  return new Map(element.attrs.map(({ name, value }) => [name, value]));
}

function hasExactHtmlAttributes(element, expected) {
  return JSON.stringify([...htmlAttributes(element)]) === JSON.stringify(expected);
}

function collectWidgetDocumentFacts(html) {
  const parseErrors = [];
  const document = parseHtml(html, {
    onParseError: (error) => parseErrors.push(error.code),
    sourceCodeLocationInfo: true,
  });
  if (parseErrors.length !== 0
    || document.childNodes.length !== 2
    || document.childNodes[0]?.nodeName !== "#documentType"
    || document.childNodes[0]?.name !== "html"
    || document.childNodes[1]?.tagName !== "html") {
    throw new Error("Extension widget entry is invalid.");
  }
  const htmlElement = document.childNodes[1];
  const elements = [];
  const visit = (node) => {
    if (node.nodeName === "#comment") throw new Error("Extension widget entry is invalid.");
    if (node.nodeName === "#text") {
      if (!["style", "title"].includes(node.parentNode?.tagName)
        && node.value.trim().length !== 0) {
        throw new Error("Extension widget entry is invalid.");
      }
      return;
    }
    if (node.tagName) {
      if (!WIDGET_HTML_ELEMENTS.has(node.tagName) || !node.sourceCodeLocation) {
        throw new Error("Extension widget entry is invalid.");
      }
      elements.push(node);
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(htmlElement);
  const byTag = (name) => elements.filter((element) => element.tagName === name);
  const heads = byTag("head");
  const bodies = byTag("body");
  const scripts = byTag("script");
  const mounts = elements.filter(
    (element) => htmlAttributes(element).get("id") === "meanthis-widget-root",
  );
  if (byTag("html").length !== 1
    || heads.length !== 1
    || bodies.length !== 1
    || scripts.length !== 1
    || mounts.length !== 1
    || heads[0].parentNode !== htmlElement
    || bodies[0].parentNode !== htmlElement
    || scripts[0].parentNode !== heads[0]
    || mounts[0].tagName !== "main"
    || mounts[0].parentNode !== bodies[0]
    || [...byTag("meta"), ...byTag("title"), ...byTag("style")]
      .some((element) => element.parentNode !== heads[0])
    || ![0, 1].includes(htmlAttributes(htmlElement).size)
    || (htmlAttributes(htmlElement).size === 1
      && !hasExactHtmlAttributes(htmlElement, [["lang", "en"]]))
    || !hasExactHtmlAttributes(heads[0], [])
    || !hasExactHtmlAttributes(bodies[0], [])
    || !hasExactHtmlAttributes(mounts[0], [["id", "meanthis-widget-root"]])
    || mounts[0].childNodes.length !== 0
    || byTag("title").length > 1
    || byTag("style").length > 1
    || byTag("meta").some((element) => {
      const attributes = htmlAttributes(element);
      return !(attributes.size === 1 && attributes.get("charset")?.toLowerCase() === "utf-8")
        && !(attributes.size === 2 && attributes.get("name") === "viewport"
          && attributes.get("content") === "width=device-width, initial-scale=1.0");
    })) {
    throw new Error("Extension widget entry is invalid.");
  }
  const styles = byTag("style");
  const styleText = styles[0]?.childNodes.map((node) => node.value ?? "").join("") ?? "";
  const canonicalStyle =
    ":root { color-scheme: dark; } " +
    "html, body { margin: 0; min-width: 0; background: transparent; } " +
    "body { overflow: hidden; }";
  if (styles.length === 1 && styleText.replace(/\s+/g, " ").trim() !== canonicalStyle) {
    throw new Error("Extension widget entry is invalid.");
  }
  return { mounts, scripts };
}

function isSafeWidgetEntryAsset(path) {
  return typeof path === "string"
    && path.startsWith("assets/")
    && path.endsWith(".js")
    && !path.includes("\\")
    && !path.includes("%")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    && /^[A-Za-z0-9._/-]+$/.test(path);
}

export function parseExtensionWidgetEntryAsset(widgetHtml) {
  if (typeof widgetHtml !== "string" || widgetHtml.length === 0) {
    throw new Error("Extension widget entry is invalid.");
  }
  const { mounts, scripts: headScripts } = collectWidgetDocumentFacts(widgetHtml);
  const scriptAttributes = headScripts.length === 1
    ? htmlAttributes(headScripts[0])
    : null;
  const type = scriptAttributes?.get("type") ?? null;
  const source = scriptAttributes?.get("src") ?? null;
  if (
    type?.toLowerCase() !== "module"
    ||
    source === null
    || !source.startsWith("/assets/")
    || source.includes("?")
    || source.includes("#")
    || ![2, 3].includes(scriptAttributes.size)
    || (scriptAttributes.size === 2
      && !hasExactHtmlAttributes(headScripts[0], [["type", "module"], ["src", source]]))
    || (scriptAttributes.size === 3
      && !hasExactHtmlAttributes(
        headScripts[0],
        [["type", "module"], ["crossorigin", ""], ["src", source]],
      ))
    || headScripts[0].childNodes.length !== 0
    || mounts.length !== 1
  ) {
    throw new Error("Extension widget entry is invalid.");
  }
  let url;
  try {
    url = new URL(source, "https://extension.invalid/widget.html");
  } catch {
    throw new Error("Extension widget entry is invalid.");
  }
  const path = url.pathname.replace(/^\/+/, "");
  if (
    url.origin !== "https://extension.invalid"
    || url.search !== ""
    || url.hash !== ""
    || !isSafeWidgetEntryAsset(path)
  ) {
    throw new Error("Extension widget entry is invalid.");
  }
  return path;
}

function runtimeFilesForWidgetEntry(widgetEntryAsset) {
  return [...EXTENSION_RUNTIME_STATIC_FILES, widgetEntryAsset].sort(compareText);
}

export function deriveExtensionRuntimeFiles(widgetHtml) {
  return runtimeFilesForWidgetEntry(parseExtensionWidgetEntryAsset(widgetHtml));
}

function releaseFilesForWidgetEntry(widgetEntryAsset) {
  return [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    ...runtimeFilesForWidgetEntry(widgetEntryAsset),
  ];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key));
}

function isSamePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isWithin(parent, child) {
  const value = relative(parent, child);
  return value !== ""
    && value !== ".."
    && !value.startsWith(`..${sep}`)
    && !isAbsolute(value);
}

function pathsOverlap(left, right) {
  return isSamePath(left, right) || isWithin(left, right) || isWithin(right, left);
}

function forbiddenPathVariants(sourceDirectory, forbiddenPaths) {
  if (!Array.isArray(forbiddenPaths)
    || forbiddenPaths.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Extension release forbidden paths are invalid.");
  }
  const variants = new Set();
  for (const path of [sourceDirectory, ...forbiddenPaths].map((value) => resolve(value))) {
    variants.add(path);
    variants.add(path.replaceAll("\\", "/"));
    variants.add(JSON.stringify(path).slice(1, -1));
    variants.add(pathToFileURL(path).href);
  }
  return variants;
}

function embedsForbiddenPath(bytes, variants) {
  const direct = [...variants].some(
    (value) => value.length > 0 && bytes.includes(Buffer.from(value)),
  );
  if (direct || process.platform !== "win32") return direct;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return false;
  const lower = text.toLowerCase();
  return [...variants].some((value) => value.length > 0 && lower.includes(value.toLowerCase()));
}

function resolveWidgetModuleImport(modulePath, specifier) {
  if (!/^\.\/[A-Za-z0-9._-]+\.js$/.test(specifier)) {
    throw new Error("Extension widget module graph is invalid.");
  }
  return `${dirname(modulePath).replaceAll("\\", "/")}/${specifier.slice(2)}`;
}

function parseWidgetModuleFacts(modulePath, bytes) {
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error("Extension widget module graph is invalid.");
  }
  let ast;
  try {
    ast = parseAst(source);
  } catch {
    throw new Error("Extension widget module graph is invalid.");
  }
  const imports = [];
  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration"
      || statement.type === "ExportAllDeclaration"
      || (statement.type === "ExportNamedDeclaration" && statement.source !== null)) {
      if (typeof statement.source?.value !== "string") {
        throw new Error("Extension widget module graph is invalid.");
      }
      imports.push(resolveWidgetModuleImport(modulePath, statement.source.value));
    }
  }
  let dynamicImportFound = false;
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "ImportExpression") {
      dynamicImportFound = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "start" && key !== "end") visit(value);
    }
  };
  visit(ast);
  if (dynamicImportFound) {
    throw new Error("Extension widget module graph is invalid.");
  }
  return { imports: imports.sort(compareText) };
}

function assertWidgetModuleGraph(entries, widgetEntryAsset) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const expectedEntryImports = Object.keys(EXPECTED_WIDGET_MODULE_IMPORTS).sort(compareText);
  const expectedGraph = new Map([
    [widgetEntryAsset, expectedEntryImports],
    ...Object.entries(EXPECTED_WIDGET_MODULE_IMPORTS),
  ]);
  for (const [modulePath, expectedImports] of expectedGraph) {
    const entry = entryByPath.get(modulePath);
    if (!entry) throw new Error("Extension widget module graph is invalid.");
    const { imports: actualImports } = parseWidgetModuleFacts(modulePath, entry.bytes);
    if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) {
      throw new Error("Extension widget module graph is invalid.");
    }
  }
}

export function assertExtensionWidgetRuntime(entries) {
  if (!Array.isArray(entries)) throw new Error("Extension widget runtime is invalid.");
  const widgetHtml = entries.find((entry) => entry?.path === "widget.html")?.bytes;
  let widgetEntryAsset;
  try {
    widgetEntryAsset = parseExtensionWidgetEntryAsset(widgetHtml?.toString("utf8"));
  } catch {
    throw new Error("Extension widget runtime is invalid.");
  }
  assertWidgetModuleGraph(entries, widgetEntryAsset);
  return widgetEntryAsset;
}

async function readJson(path, errorMessage) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new TypeError(errorMessage);
    return value;
  } catch {
    throw new Error(errorMessage);
  }
}

function assertExactFileSet(entries) {
  const paths = entries.map((entry) => entry.path);
  let widgetEntryAsset;
  let expectedPaths;
  try {
    widgetEntryAsset = assertExtensionWidgetRuntime(entries);
    expectedPaths = releaseFilesForWidgetEntry(widgetEntryAsset);
  } catch {
    throw new Error("Extension release file set is invalid.");
  }
  if (paths.length !== expectedPaths.length
    || paths.some((path, index) => path !== expectedPaths[index])
    || entries.some((entry) => !Buffer.isBuffer(entry.bytes)
      || entry.bytes.length === 0
      || entry.bytes.length > MAX_FILE_BYTES)) {
    throw new Error("Extension release file set is invalid.");
  }
  return expectedPaths;
}

async function collectReleaseEntries(sourceDirectory, forbiddenPaths, noticeRoot) {
  const variants = forbiddenPathVariants(sourceDirectory, forbiddenPaths);
  const entries = [];

  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const sourcePath = join(directory, child.name);
      const artifactPath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        throw new Error("Extension release file set is invalid.");
      }
      if (child.isDirectory()) {
        await visit(sourcePath, artifactPath);
        continue;
      }
      const bytes = await readFile(sourcePath);
      if (embedsForbiddenPath(bytes, variants)) {
        throw new Error("Extension release contains a forbidden local path.");
      }
      entries.push({ path: artifactPath, bytes });
    }
  }

  await visit(sourceDirectory);
  for (const artifactPath of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const sourcePath = join(noticeRoot, artifactPath);
    let metadata;
    try {
      metadata = await lstat(sourcePath);
    } catch {
      throw new Error("Extension release notice file set is invalid.");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("Extension release notice file set is invalid.");
    }
    const bytes = await readFile(sourcePath);
    if (
      bytes.length === 0
      || bytes.length > MAX_FILE_BYTES
      || embedsForbiddenPath(bytes, variants)
    ) {
      throw new Error("Extension release notice file set is invalid.");
    }
    entries.push({ path: artifactPath, bytes });
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  assertExactFileSet(entries);
  return entries;
}

function assertReleaseVersions(rootManifest, extensionManifest, cliManifest, browserManifest) {
  const versions = [
    rootManifest.version,
    extensionManifest.version,
    cliManifest.version,
    browserManifest.version,
  ];
  if (rootManifest.name !== "meanthis"
    || rootManifest.private !== true
    || extensionManifest.name !== "@meanthis/extension-mv3"
    || extensionManifest.private !== true
    || cliManifest.name !== "@meanthis/cli"
    || cliManifest.private === true
    || cliManifest.publishConfig?.access !== "public"
    || browserManifest.manifest_version !== 3
    || browserManifest.name !== "MeanThis"
    || browserManifest.default_locale !== "en"
    || browserManifest.description !== "__MSG_extension_description__"
    || browserManifest.action?.default_title !== "__MSG_open_ui_attach__") {
    throw new Error("Extension release workspace boundary is invalid.");
  }
  assertMeanThisExtensionIdentity(browserManifest);
  if (!versions.every((version) => typeof version === "string" && VERSION.test(version))
    || new Set(versions).size !== 1) {
    throw new Error("Extension release versions must match.");
  }
  return versions[0];
}

function assertBrowserManifestSurface(browserManifest, surfaceProfile) {
  const expected = SURFACE_CAPABILITIES[surfaceProfile];
  const widgetResources = browserManifest.web_accessible_resources;
  if (!expected
    || JSON.stringify(browserManifest.permissions) !== JSON.stringify(expected.permissions)
    || JSON.stringify(browserManifest.host_permissions ?? [])
      !== JSON.stringify(expected.hostPermissions)
    || JSON.stringify(browserManifest.optional_host_permissions)
      !== JSON.stringify(expected.optionalHostPermissions)
    || !Array.isArray(widgetResources)
    || widgetResources.length !== 1
    || JSON.stringify(widgetResources[0]?.resources) !== JSON.stringify(["widget.html"])
    || JSON.stringify(widgetResources[0]?.matches)
      !== JSON.stringify(["http://*/*", "https://*/*"])
    || widgetResources[0]?.use_dynamic_url !== false) {
    throw new Error("Extension release manifest surface profile is invalid.");
  }
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(STORE_METHOD, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(STORE_METHOD, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(EXTERNAL_FILE_ATTRIBUTES, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.bytes.length;
  }

  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

function invalidArchive() {
  throw new Error("Extension release archive is invalid.");
}

function parseStoredZip(bytes, expectedFiles) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) {
    return invalidArchive();
  }
  const endOffset = bytes.length - 22;
  if (bytes.readUInt32LE(endOffset) !== END_SIGNATURE
    || bytes.readUInt16LE(endOffset + 4) !== 0
    || bytes.readUInt16LE(endOffset + 6) !== 0
    || bytes.readUInt16LE(endOffset + 8) !== bytes.readUInt16LE(endOffset + 10)
    || bytes.readUInt16LE(endOffset + 20) !== 0) {
    return invalidArchive();
  }
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (count !== expectedFiles.length
    || centralOffset + centralSize !== endOffset
    || centralOffset > endOffset) {
    return invalidArchive();
  }

  const entries = [];
  let centralCursor = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < count; index += 1) {
    if (centralCursor + 46 > endOffset
      || bytes.readUInt32LE(centralCursor) !== CENTRAL_SIGNATURE
      || bytes.readUInt16LE(centralCursor + 4) !== VERSION_MADE_BY
      || bytes.readUInt16LE(centralCursor + 6) !== VERSION_NEEDED
      || bytes.readUInt16LE(centralCursor + 8) !== UTF8_FLAG
      || bytes.readUInt16LE(centralCursor + 10) !== STORE_METHOD
      || bytes.readUInt16LE(centralCursor + 12) !== DOS_TIME
      || bytes.readUInt16LE(centralCursor + 14) !== DOS_DATE
      || bytes.readUInt16LE(centralCursor + 30) !== 0
      || bytes.readUInt16LE(centralCursor + 32) !== 0
      || bytes.readUInt16LE(centralCursor + 34) !== 0
      || bytes.readUInt16LE(centralCursor + 36) !== 0
      || bytes.readUInt32LE(centralCursor + 38) !== EXTERNAL_FILE_ATTRIBUTES
      || bytes.readUInt32LE(centralCursor + 42) !== expectedLocalOffset) {
      return invalidArchive();
    }
    const checksum = bytes.readUInt32LE(centralCursor + 16);
    const compressedSize = bytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = bytes.readUInt32LE(centralCursor + 24);
    const nameLength = bytes.readUInt16LE(centralCursor + 28);
    if (compressedSize !== uncompressedSize || uncompressedSize === 0) return invalidArchive();
    const centralNameStart = centralCursor + 46;
    const centralNameEnd = centralNameStart + nameLength;
    if (centralNameEnd > endOffset || expectedLocalOffset + 30 > centralOffset) {
      return invalidArchive();
    }
    const nameBytes = bytes.subarray(centralNameStart, centralNameEnd);
    const path = nameBytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(nameBytes)
      || path !== expectedFiles[index]
      || bytes.readUInt32LE(expectedLocalOffset) !== LOCAL_SIGNATURE
      || bytes.readUInt16LE(expectedLocalOffset + 4) !== VERSION_NEEDED
      || bytes.readUInt16LE(expectedLocalOffset + 6) !== UTF8_FLAG
      || bytes.readUInt16LE(expectedLocalOffset + 8) !== STORE_METHOD
      || bytes.readUInt16LE(expectedLocalOffset + 10) !== DOS_TIME
      || bytes.readUInt16LE(expectedLocalOffset + 12) !== DOS_DATE
      || bytes.readUInt32LE(expectedLocalOffset + 14) !== checksum
      || bytes.readUInt32LE(expectedLocalOffset + 18) !== compressedSize
      || bytes.readUInt32LE(expectedLocalOffset + 22) !== uncompressedSize
      || bytes.readUInt16LE(expectedLocalOffset + 26) !== nameLength
      || bytes.readUInt16LE(expectedLocalOffset + 28) !== 0) {
      return invalidArchive();
    }
    const localNameStart = expectedLocalOffset + 30;
    const localNameEnd = localNameStart + nameLength;
    const dataEnd = localNameEnd + uncompressedSize;
    if (dataEnd > centralOffset
      || !bytes.subarray(localNameStart, localNameEnd).equals(nameBytes)) {
      return invalidArchive();
    }
    const entryBytes = Buffer.from(bytes.subarray(localNameEnd, dataEnd));
    if (crc32(entryBytes) !== checksum) return invalidArchive();
    entries.push({ path, bytes: entryBytes });
    expectedLocalOffset = dataEnd;
    centralCursor = centralNameEnd;
  }
  if (centralCursor !== endOffset || expectedLocalOffset !== centralOffset) return invalidArchive();
  return entries;
}

export function parseExtensionReleaseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Extension release manifest is invalid.");
  }
  const contentPaths = Array.isArray(manifest?.contents)
    ? manifest.contents.map((entry) => entry?.path)
    : [];
  const widgetEntryCandidates = contentPaths.filter(
    (path) => !["LICENSE", "THIRD_PARTY_NOTICES.md", ...EXTENSION_RUNTIME_STATIC_FILES]
      .includes(path),
  );
  const expectedFiles = widgetEntryCandidates.length === 1
    && isSafeWidgetEntryAsset(widgetEntryCandidates[0])
    ? releaseFilesForWidgetEntry(widgetEntryCandidates[0])
    : null;
  if (!Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8").equals(bytes)
    || !hasExactKeys(manifest, ROOT_KEYS)
    || manifest.schemaVersion !== "0.1.0"
    || manifest.kind !== "ui-attach.extension-release"
    || manifest.package !== "@meanthis/extension-mv3"
    || !["consumer", "development"].includes(manifest.surfaceProfile)
    || typeof manifest.version !== "string"
    || !VERSION.test(manifest.version)
    || !hasExactKeys(manifest.archive, ARCHIVE_KEYS)
    || manifest.archive.filename !== `meanthis-extension-mv3-${manifest.version}.zip`
    || !Number.isSafeInteger(manifest.archive.bytes)
    || manifest.archive.bytes <= 0
    || typeof manifest.archive.sha256 !== "string"
    || !SHA256.test(manifest.archive.sha256)
    || manifest.archive.format !== "zip-store-v1"
    || expectedFiles === null
    || !Array.isArray(manifest.contents)
    || manifest.contents.length !== expectedFiles.length
    || !manifest.contents.every((entry, index) => hasExactKeys(entry, CONTENT_KEYS)
      && entry.path === expectedFiles[index]
      && Number.isSafeInteger(entry.bytes)
      && entry.bytes > 0
      && typeof entry.sha256 === "string"
      && SHA256.test(entry.sha256))
    || !hasExactKeys(manifest.install, INSTALL_KEYS)
    || manifest.install.mode !== "extract_then_load_unpacked"
    || manifest.install.entrypoint !== "manifest.json"
    || !hasExactKeys(manifest.cli, CLI_KEYS)
    || manifest.cli.package !== "@meanthis/cli"
    || manifest.cli.included !== false
    || manifest.cli.status !== "separate-public-package"
    || manifest.cli.requiresCheckout !== false) {
    throw new Error("Extension release manifest is invalid.");
  }
  return manifest;
}

function verifyReleasePayload(archiveBytes, manifestBytes, archiveFilename) {
  const manifest = parseExtensionReleaseManifest(manifestBytes);
  const expectedFiles = manifest.contents.map((entry) => entry.path);
  if (manifest.archive.filename !== archiveFilename
    || manifest.archive.bytes !== archiveBytes.length
    || manifest.archive.sha256 !== sha256(archiveBytes)) {
    throw new Error("Extension release archive does not match its manifest.");
  }
  let entries;
  try {
    entries = parseStoredZip(archiveBytes, expectedFiles);
  } catch {
    throw new Error("Extension release archive does not match its manifest.");
  }
  try {
    const browserManifest = JSON.parse(
      entries.find((entry) => entry.path === "manifest.json").bytes.toString("utf8"),
    );
    assertBrowserManifestSurface(browserManifest, manifest.surfaceProfile);
    assertExactFileSet(entries);
  } catch {
    throw new Error("Extension release archive does not match its manifest.");
  }
  if (entries.some((entry, index) => {
    const content = manifest.contents[index];
    return entry.path !== content.path
      || entry.bytes.length !== content.bytes
      || sha256(entry.bytes) !== content.sha256;
  })) {
    throw new Error("Extension release archive does not match its manifest.");
  }
  return { manifest, entries };
}

function resultFor(outputRoot, version) {
  const releaseDirectory = join(outputRoot, version);
  const archiveFilename = `meanthis-extension-mv3-${version}.zip`;
  const manifestFilename = `meanthis-extension-mv3-${version}.manifest.json`;
  return {
    version,
    releaseDirectory,
    archiveFilename,
    archivePath: join(releaseDirectory, archiveFilename),
    manifestFilename,
    manifestPath: join(releaseDirectory, manifestFilename),
  };
}

async function assertExistingRelease(result, archiveBytes, manifestBytes) {
  try {
    const directory = await lstat(result.releaseDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new TypeError("Invalid release directory.");
    }
    const entries = await readdir(result.releaseDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    const expectedNames = [result.archiveFilename, result.manifestFilename].sort(compareText);
    if (entries.length !== expectedNames.length
      || entries.some((entry, index) => entry.name !== expectedNames[index]
        || !entry.isFile()
        || entry.isSymbolicLink())) {
      throw new TypeError("Invalid release directory.");
    }
    const memberStats = await Promise.all(expectedNames.map(
      (name) => lstat(join(result.releaseDirectory, name)),
    ));
    if (memberStats.some((member) => !member.isFile() || member.isSymbolicLink())) {
      throw new TypeError("Invalid release directory.");
    }
    const [existingArchive, existingManifest] = await Promise.all([
      readFile(result.archivePath),
      readFile(result.manifestPath),
    ]);
    if (existingArchive.equals(archiveBytes) && existingManifest.equals(manifestBytes)) return true;
  } catch {
    // A missing or unreadable member is still a version collision.
  }
  throw new Error("Extension release version already exists with different bytes.");
}

export async function createExtensionReleaseArtifact(options) {
  const surfaceProfile = parseExtensionSurfaceProfile(options.surfaceProfile);
  const sourceDirectory = resolve(options.sourceDirectory);
  const outputRoot = resolve(options.outputRoot);
  if (pathsOverlap(sourceDirectory, outputRoot)) {
    throw new Error("Extension release source and output paths must not overlap.");
  }
  const entries = await collectReleaseEntries(
    sourceDirectory,
    options.forbiddenPaths ?? [],
    dirname(resolve(options.rootManifestPath)),
  );
  const [rootManifest, extensionManifest, cliManifest] = await Promise.all([
    readJson(options.rootManifestPath, "Extension release workspace manifests are invalid."),
    readJson(options.extensionManifestPath, "Extension release workspace manifests are invalid."),
    readJson(options.cliManifestPath, "Extension release workspace manifests are invalid."),
  ]);
  let browserManifest;
  try {
    browserManifest = JSON.parse(
      entries.find((entry) => entry.path === "manifest.json").bytes.toString("utf8"),
    );
  } catch {
    throw new Error("Extension release versions must match.");
  }
  const version = assertReleaseVersions(
    rootManifest,
    extensionManifest,
    cliManifest,
    browserManifest,
  );
  assertBrowserManifestSurface(browserManifest, surfaceProfile);
  const archiveBytes = createStoredZip(entries);
  const archiveFilename = `meanthis-extension-mv3-${version}.zip`;
  const manifest = {
    schemaVersion: "0.1.0",
    kind: "ui-attach.extension-release",
    package: "@meanthis/extension-mv3",
    surfaceProfile,
    version,
    archive: {
      filename: archiveFilename,
      bytes: archiveBytes.length,
      sha256: sha256(archiveBytes),
      format: "zip-store-v1",
    },
    contents: entries.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes.length,
      sha256: sha256(entry.bytes),
    })),
    install: {
      mode: "extract_then_load_unpacked",
      entrypoint: "manifest.json",
    },
    cli: {
      package: "@meanthis/cli",
      included: false,
      status: "separate-public-package",
      requiresCheckout: false,
    },
  };
  assertArtifactMetadataVersion(manifest, version);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  verifyReleasePayload(archiveBytes, manifestBytes, archiveFilename);
  await mkdir(outputRoot, { recursive: true });
  const result = resultFor(outputRoot, version);
  result.surfaceProfile = surfaceProfile;
  try {
    await access(result.releaseDirectory);
    await assertExistingRelease(result, archiveBytes, manifestBytes);
    return result;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error?.message === "Extension release version already exists with different bytes.") {
        throw error;
      }
      throw error;
    }
  }

  const temporaryDirectory = await mkdtemp(join(outputRoot, `.tmp-${version}-`));
  let moved = false;
  try {
    await Promise.all([
      writeFile(join(temporaryDirectory, archiveFilename), archiveBytes, { flag: "wx" }),
      writeFile(
        join(temporaryDirectory, `meanthis-extension-mv3-${version}.manifest.json`),
        manifestBytes,
        { flag: "wx" },
      ),
    ]);
    try {
      await rename(temporaryDirectory, result.releaseDirectory);
      moved = true;
      return result;
    } catch {
      await assertExistingRelease(result, archiveBytes, manifestBytes);
      return result;
    }
  } finally {
    if (!moved) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function extractExtensionReleaseArtifact(options) {
  const archivePath = resolve(options.archivePath);
  const manifestPath = resolve(options.manifestPath);
  const targetDirectory = resolve(options.targetDirectory);
  const [archiveBytes, manifestBytes] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath),
  ]);
  const { manifest, entries } = verifyReleasePayload(
    archiveBytes,
    manifestBytes,
    basename(archivePath),
  );
  let created = false;
  try {
    await mkdir(dirname(targetDirectory), { recursive: true });
    await mkdir(targetDirectory);
    created = true;
    for (const entry of entries) {
      const outputPath = join(targetDirectory, ...entry.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, entry.bytes, { flag: "wx" });
    }
    return {
      extensionDir: targetDirectory,
      files: entries.map((entry) => entry.path),
      surfaceProfile: manifest.surfaceProfile,
      version: manifest.version,
    };
  } catch (error) {
    if (created) await rm(targetDirectory, { recursive: true, force: true });
    throw error;
  }
}
