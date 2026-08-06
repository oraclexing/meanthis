import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import {
  extensionProfileOutDir,
  parseExtensionSurfaceProfile,
} from "./scripts/extension-surface-profile.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const surfaceProfile = parseExtensionSurfaceProfile(mode);
  return {
  define: {
    __UI_ATTACH_SURFACE_PROFILE__: JSON.stringify(surfaceProfile),
  },
  resolve: {
    alias: {
      "@meanthis/prompt": resolve(workspaceRoot, "packages/prompt/src/index.ts"),
      "@meanthis/replay": resolve(workspaceRoot, "packages/replay/src/index.ts"),
      "@meanthis/schema": resolve(workspaceRoot, "packages/schema/src/index.ts"),
      "@meanthis/web-extractor": resolve(workspaceRoot, "packages/web-extractor/src/index.ts"),
    },
  },
  build: {
    outDir: extensionProfileOutDir(surfaceProfile),
    emptyOutDir: false,
    copyPublicDir: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(root, "src/content.ts"),
      output: {
        entryFileNames: "assets/content.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
        // Keep the MV3 content script classic and single-file; verify-extension rejects import-bearing output.
        codeSplitting: false,
      },
    },
  },
  };
});
