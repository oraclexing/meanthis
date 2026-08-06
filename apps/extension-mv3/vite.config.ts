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
  const baseManifest = JSON.parse(await readFile(resolve(root, "public/manifest.json"), "utf8"));

  return {
  define: {
    __UI_ATTACH_SURFACE_PROFILE__: JSON.stringify(surfaceProfile),
  },
  resolve: {
    alias: {
      "./surface-background.development": resolve(
        root,
        "src",
        `surface-background.${surfaceProfile}.ts`,
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
      },
      output: {
        entryFileNames: "assets/[name].js",
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (
            normalizedId.endsWith("/src/i18n.ts") ||
            normalizedId.endsWith("/src/panel-theme.ts") ||
            normalizedId.endsWith("/src/settings-preferences.ts")
          ) {
            return "settings-preferences";
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
