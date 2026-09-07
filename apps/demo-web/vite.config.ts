import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@meanthis/prompt": resolve(workspaceRoot, "packages/prompt/src/index.ts"),
      "@meanthis/schema": resolve(workspaceRoot, "packages/schema/src/index.ts"),
      "@meanthis/web-extractor": resolve(workspaceRoot, "packages/web-extractor/src/index.ts"),
      "@meanthis/web-picker": resolve(workspaceRoot, "packages/web-picker/src/index.ts"),
    },
  },
  root,
});
