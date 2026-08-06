import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@meanthis/hub-core": resolve(workspaceRoot, "packages/hub-core/src/index.ts"),
      "@meanthis/prompt": resolve(workspaceRoot, "packages/prompt/src/index.ts"),
      "@meanthis/replay": resolve(workspaceRoot, "packages/replay/src/index.ts"),
      "@meanthis/schema": resolve(workspaceRoot, "packages/schema/src/index.ts"),
      "@meanthis/web-extractor": resolve(workspaceRoot, "packages/web-extractor/src/index.ts"),
      "@meanthis/web-picker": resolve(workspaceRoot, "packages/web-picker/src/index.ts"),
    },
  },
  plugins: [
    {
      name: "ui-attach-demo-runtime-dev-entry",
      configureServer(server) {
        server.middlewares.use("/ui-attach-runtime.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end('export { createUiAttachInjectedRuntime } from "/src/ui-attach-runtime.ts";\n');
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      preserveEntrySignatures: "exports-only",
      input: {
        index: resolve(root, "index.html"),
        "ui-attach-runtime": resolve(root, "src/ui-attach-runtime.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "ui-attach-runtime" ? "ui-attach-runtime.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
