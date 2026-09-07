import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("demo Vite config", () => {
  it("resolves the demo through the shared web-picker package", () => {
    expect(config.resolve?.alias).toMatchObject({
      "@meanthis/web-picker": expect.stringMatching(/packages[\\/]web-picker[\\/]src[\\/]index\.ts$/u),
    });
    expect(config.build?.rollupOptions).toBeUndefined();
  });
});
