import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  MEANTHIS_CHROME_WEB_STORE_ID,
  MEANTHIS_CHROME_WEB_STORE_PUBLIC_KEY,
  extensionIdFromManifestKey,
} from "./scripts/extension-identity.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

async function readPackageJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    packageManager?: string;
    devDependencies?: Record<string, string>;
  };
}

async function readManifest(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    action?: {
      default_icon?: Record<string, string>;
      default_title?: string;
    };
    content_scripts?: unknown[];
    description?: string;
    default_locale?: string;
    host_permissions?: string[];
    key?: string;
    optional_host_permissions?: string[];
    icons?: Record<string, string>;
    minimum_chrome_version?: string;
    name?: string;
    permissions?: string[];
  };
}

function pngAlphaBounds(bytes: Buffer) {
  const idatChunks: Buffer[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    if (raw[row] !== 0) throw new Error("Expected unfiltered generated PNG scanlines.");
    for (let x = 0; x < width; x += 1) {
      if (raw[row + 1 + x * 4 + 3] <= 16) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

describe("extension package policy", () => {
  test("uses user-invoked active-tab access instead of unconditional host access", async () => {
    const manifest = await readManifest(
      resolve(workspaceRoot, "apps/extension-mv3/public/manifest.json"),
    );

    expect(manifest.permissions?.toSorted()).toEqual([
      "activeTab",
      "alarms",
      "contextMenus",
      "scripting",
      "sidePanel",
      "storage",
      "webNavigation",
    ]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual([
      "http://127.0.0.1/*",
      "http://*/*",
      "https://*/*",
    ]);
    expect(manifest.minimum_chrome_version).toBe("120");
    expect(manifest.content_scripts).toBeUndefined();
  });

  test("ships the product identity and complete Chromium icon set", async () => {
    const manifest = await readManifest(
      resolve(workspaceRoot, "apps/extension-mv3/public/manifest.json"),
    );
    const icons = {
      "16": "icons/meanthis-16.png",
      "32": "icons/meanthis-32.png",
      "48": "icons/meanthis-48.png",
      "128": "icons/meanthis-128.png",
    };

    expect(manifest.name).toBe("MeanThis");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.description).toBe("__MSG_extension_description__");
    expect(manifest.icons).toEqual(icons);
    expect(manifest.action).toEqual({
      default_icon: icons,
      default_title: "__MSG_open_ui_attach__",
    });

    for (const [size, path] of Object.entries(icons)) {
      const bytes = await readFile(resolve(workspaceRoot, "apps/extension-mv3/public", path));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(Number(size));
      expect(bytes.readUInt32BE(20)).toBe(Number(size));
    }
  });

  test("pins unpacked and store builds to the Chrome Web Store item identity", async () => {
    const manifest = await readManifest(
      resolve(workspaceRoot, "apps/extension-mv3/public/manifest.json"),
    );

    expect(manifest.key).toBe(MEANTHIS_CHROME_WEB_STORE_PUBLIC_KEY);
    expect(extensionIdFromManifestKey(manifest.key)).toBe(MEANTHIS_CHROME_WEB_STORE_ID);
  });

  test("uses the refined store icon with optical toolbar masters", async () => {
    const [source128, source32, source16, icon] = await Promise.all([
      readFile(resolve(workspaceRoot, "apps/extension-mv3/assets/meanthis-icon-128.png")),
      readFile(resolve(workspaceRoot, "apps/extension-mv3/assets/meanthis-icon-32.svg"), "utf8"),
      readFile(resolve(workspaceRoot, "apps/extension-mv3/assets/meanthis-icon-16.svg"), "utf8"),
      readFile(resolve(workspaceRoot, "apps/extension-mv3/public/icons/meanthis-16.png")),
    ]);

    expect(source128.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(source128.readUInt32BE(16)).toBe(128);
    expect(source128.readUInt32BE(20)).toBe(128);
    expect(pngAlphaBounds(source128)).toEqual({ minX: 16, minY: 16, maxX: 111, maxY: 111 });
    expect(source32).toContain("redrawn for 32 pixels");
    expect(source16).toContain("drawn directly on a 16 pixel grid");
    for (const opticalMaster of [source32, source16]) {
      expect(opticalMaster).not.toContain("ui-attach");
      expect(opticalMaster).not.toContain("scale(-1 1)");
    }
    expect(pngAlphaBounds(icon)).toEqual({ minX: 0, minY: 0, maxX: 15, maxY: 15 });
  });

  test("keeps toolbar icons full-canvas and the 128px store icon in its 96px safe area", async () => {
    const [icon32, icon48, icon128] = await Promise.all([32, 48, 128].map((size) => readFile(
      resolve(workspaceRoot, `apps/extension-mv3/public/icons/meanthis-${size}.png`),
    )));

    expect(pngAlphaBounds(icon32)).toEqual({ minX: 0, minY: 0, maxX: 31, maxY: 31 });
    expect(pngAlphaBounds(icon48)).toEqual({ minX: 0, minY: 0, maxX: 47, maxY: 47 });
    expect(pngAlphaBounds(icon128)).toEqual({ minX: 16, minY: 16, maxX: 111, maxY: 111 });
  });

  test("restricts local storage before controller registration and keeps content storage-free", async () => {
    const background = await readFile(resolve(workspaceRoot, "apps/extension-mv3/src/background.ts"), "utf8");
    const content = await readFile(resolve(workspaceRoot, "apps/extension-mv3/src/content.ts"), "utf8");

    const accessBoundary = background.indexOf('setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })');
    const rejectionHandled = background.indexOf(".then(", accessBoundary);
    const controllerRegistration = background.indexOf("controller.register()");
    expect(accessBoundary).toBeGreaterThan(-1);
    expect(rejectionHandled).toBeGreaterThan(accessBoundary);
    expect(controllerRegistration).toBeGreaterThan(rejectionHandled);
    expect(controllerRegistration).toBeGreaterThan(accessBoundary);
    expect(background).not.toContain("void initializeBackground()");
    expect(content).not.toContain("chrome.storage.local");
    expect(content).not.toContain("chrome.storage.onChanged");
    expect(content).toContain('type: "ui-attach:content-settings-get"');
  });

  test("keeps bilingual privacy claims linked and verifiable against extension code", async () => {
    const [privacy, privacyZh, extractor, captureStore, sessionStore] = await Promise.all([
      readFile(resolve(workspaceRoot, "PRIVACY.md"), "utf8"),
      readFile(resolve(workspaceRoot, "PRIVACY_zh.md"), "utf8"),
      readFile(resolve(workspaceRoot, "packages/web-extractor/src/index.ts"), "utf8"),
      readFile(resolve(workspaceRoot, "apps/extension-mv3/src/capture-store.ts"), "utf8"),
      readFile(resolve(workspaceRoot, "apps/extension-mv3/src/session-store.ts"), "utf8"),
    ]);
    const linkedDocs = [
      ["README.md", "(./PRIVACY.md)"],
      ["README_zh.md", "(./PRIVACY_zh.md)"],
      ["SECURITY.md", "(./PRIVACY.md)"],
      ["SECURITY_zh.md", "(./PRIVACY_zh.md)"],
      ["RELEASING.md", "(./PRIVACY.md)"],
      ["RELEASING_zh.md", "(./PRIVACY_zh.md)"],
      ["apps/extension-mv3/README.md", "(../../PRIVACY.md)"],
      ["apps/extension-mv3/README_zh.md", "(../../PRIVACY_zh.md)"],
    ] as const;

    for (const [path, link] of linkedDocs) {
      await expect(readFile(resolve(workspaceRoot, path), "utf8"))
        .resolves.toContain(link);
    }
    for (const permission of [
      "activeTab",
      "alarms",
      "contextMenus",
      "scripting",
      "sidePanel",
      "storage",
      "webNavigation",
    ]) {
      expect(privacy).toContain(`\`${permission}\``);
      expect(privacyZh).toContain(`\`${permission}\``);
    }
    expect(privacy.match(/^## /gm)).toHaveLength(9);
    expect(privacyZh.match(/^## /gm)).toHaveLength(9);
    expect(privacy).toContain("## Chrome Web Store Limited Use");
    expect(privacyZh).toContain("## Chrome Web Store Limited Use");
    expect(privacy).toContain("complies with the [Chrome Web Store User Data Policy]");
    expect(privacyZh).toContain("符合 [Chrome Web Store User Data Policy]");
    expect(privacy).toContain("`allowNetworkSend: false`");
    expect(privacyZh).toContain("`allowNetworkSend: false`");
    expect(extractor).toContain("allowScreenshot: false");
    expect(extractor).toContain("allowDomSnippet: false");
    expect(extractor).toContain("allowNetworkSend: false");
    expect(captureStore).toContain("ui-attach extension storage requires allowNetworkSend=false");
    expect(sessionStore).toContain("await storage.remove(keys)");
  });

  test("pins the package manager used for reproducible extension builds", async () => {
    const packageJson = await readPackageJson(resolve(workspaceRoot, "package.json"));

    expect(packageJson.packageManager).toBe("npm@11.16.0");
  });

  test("pins Vite exactly where the MV3 build relies on bundler output shape", async () => {
    const rootPackageJson = await readPackageJson(resolve(workspaceRoot, "package.json"));
    const extensionPackageJson = await readPackageJson(
      resolve(workspaceRoot, "apps/extension-mv3/package.json"),
    );

    expect(rootPackageJson.devDependencies?.vite).toBe("8.1.2");
    expect(extensionPackageJson.devDependencies?.vite).toBe("8.1.2");
  });
});
