import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import {
  extensionProfileOutDir,
  parseExtensionSurfaceProfile,
  projectExtensionLocaleMessages,
  projectExtensionManifest,
} from "./scripts/extension-surface-profile.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(async ({ mode }) => {
  const surfaceProfile = parseExtensionSurfaceProfile(mode);
  const outDir = extensionProfileOutDir(surfaceProfile);
  const developmentBuildId = surfaceProfile === "development"
    ? process.env.MEANTHIS_EXTENSION_DEV_BUILD_ID ?? ""
    : "";
  const developmentReloadToken = surfaceProfile === "development"
    ? process.env.MEANTHIS_EXTENSION_DEV_RELOAD_TOKEN ?? ""
    : "";
  const baseManifest = JSON.parse(await readFile(resolve(root, "public/manifest.json"), "utf8"));

  return {
  define: {
    __MEANTHIS_EXTENSION_DEV_BUILD_ID__: JSON.stringify(developmentBuildId),
    __MEANTHIS_EXTENSION_DEV_RELOAD_TOKEN__: JSON.stringify(developmentReloadToken),
  },
  resolve: {
    alias: {
      "./development-runtime-control": resolve(
        root,
        "src",
        `development-runtime-control.${surfaceProfile}.ts`,
      ),
      "./surface-panel.development": resolve(
        root,
        "src",
        `surface-panel.${surfaceProfile}.ts`,
      ),
      "@meanthis/hub-core": resolve(workspaceRoot, "packages/hub-core/src/index.ts"),
      "@meanthis/prompt": resolve(workspaceRoot, "packages/prompt/src/index.ts"),
      "@meanthis/replay": resolve(workspaceRoot, "packages/replay/src/index.ts"),
      "@meanthis/schema": resolve(workspaceRoot, "packages/schema/src/index.ts"),
      "@meanthis/web-picker": resolve(workspaceRoot, "packages/web-picker/src/index.ts"),
      "@meanthis/web-extractor": resolve(workspaceRoot, "packages/web-extractor/src/index.ts"),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(root, "src/background.ts"),
        options: resolve(root, "options.html"),
        panel: resolve(root, "panel.html"),
        widget: resolve(root, "widget.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (normalizedId.endsWith("/apps/extension-mv3/src/messages.ts")) {
            // This module is shared by the background, panel, and widget graphs.
            // Pin the chunk name instead of letting Rollup choose a name from
            // whichever importer happens to win after an unrelated graph change.
            return "messages";
          }
          if (
            normalizedId.endsWith("/src/i18n.ts") ||
            normalizedId.endsWith("/src/panel-theme.ts") ||
            normalizedId.endsWith("/src/settings-preferences.ts")
          ) {
            return "settings-preferences";
          }
          if (/\/packages\/[^/]+\/src\//u.test(normalizedId)) {
            // The extension consumes workspace packages from source. Keep that
            // shared public contract graph in one stable release-artifact chunk
            // instead of accepting importer-dependent src/src2 renames.
            return "src";
          }
          return undefined;
        },
        chunkFileNames: (chunkInfo) =>
          chunkInfo.moduleIds.some((id) =>
            id.replaceAll("\\", "/").endsWith("/src/session-file.ts"),
          )
            ? "assets/session-file.js"
            : "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [{
    name: "ui-attach-extension-surface-profile",
    async closeBundle() {
      await writeFile(
        join(root, outDir, "manifest.json"),
        `${JSON.stringify(projectExtensionManifest(baseManifest, surfaceProfile), null, 2)}\n`,
      );
      for (const locale of ["en", "zh_CN"]) {
        const messages = JSON.parse(await readFile(
          join(root, "public", "_locales", locale, "messages.json"),
          "utf8",
        ));
        await writeFile(
          join(root, outDir, "_locales", locale, "messages.json"),
          `${JSON.stringify(projectExtensionLocaleMessages(messages, surfaceProfile), null, 2)}\n`,
        );
      }
    },
  }],
  };
});
