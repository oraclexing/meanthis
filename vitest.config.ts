import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@meanthis/hub-core": resolve(root, "packages/hub-core/src/index.ts"),
      "@meanthis/prompt": resolve(root, "packages/prompt/src/index.ts"),
      "@meanthis/replay": resolve(root, "packages/replay/src/index.ts"),
      "@meanthis/schema": resolve(root, "packages/schema/src/index.ts"),
      "@meanthis/web-extractor": resolve(root, "packages/web-extractor/src/index.ts"),
      "@meanthis/web-picker": resolve(root, "packages/web-picker/src/index.ts"),
    },
  },
  test: {
    globals: false,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.mjs",
      "examples/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
  },
});
