import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("demo Vite config", () => {
  it("preserves the runtime module export for bookmarklet imports", () => {
    expect(config.build?.rollupOptions?.preserveEntrySignatures).toBe("exports-only");
  });
});
