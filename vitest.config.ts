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
      "@meanthis/source-map-core": resolve(root, "tools/source-map-core/src/index.ts"),
      "@meanthis/source-resolver-mcp": resolve(root, "tools/source-resolver-mcp/src/index.ts"),
      "@meanthis/web-extractor": resolve(root, "packages/web-extractor/src/index.ts"),
      "@meanthis/web-picker": resolve(root, "packages/web-picker/src/index.ts"),
    },
  },
  test: {
    globals: false,
    // npm test builds packages and the CLI before testing the released entry.
    env: { MEANTHIS_MCP_STDIO_BROKER_TEST_COMPILED: "1" },
    tags: [
      { name: "platform" },
      { name: "release" },
    ],
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.mjs",
      "examples/**/*.test.mjs",
      "scripts/**/*.test.mjs",
      "tools/**/*.test.ts",
      "tools/**/*.test.mjs",
    ],
  },
});
