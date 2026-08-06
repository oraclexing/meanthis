import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import config from "./vite.config";
import contentConfig from "./vite.content.config";

const execFileAsync = promisify(execFile);

async function resolveConfig(viteConfig: typeof config, mode = "development") {
  if (typeof viteConfig !== "function") return viteConfig;
  return viteConfig({
    command: "build",
    isPreview: false,
    isSsrBuild: false,
    mode,
  });
}

async function resolveSurfaceProfilePlugin(mode: "consumer" | "development") {
  const resolved = await resolveConfig(config, mode);
  const plugin = resolved.plugins?.find((candidate) => (
    typeof candidate === "object" && candidate !== null &&
    "name" in candidate && candidate.name === "ui-attach-extension-surface-profile"
  ));
  if (!plugin) throw new Error("Expected the extension surface-profile plugin");
  return plugin;
}

describe("extension Vite config", () => {
  test("preserves the optional local bridge panel in both build profiles", async () => {
    const panelHtml = await readFile(new URL("./panel.html", import.meta.url), "utf8");
    const consumer = await resolveSurfaceProfilePlugin("consumer");
    const development = await resolveSurfaceProfilePlugin("development");

    expect(consumer).not.toHaveProperty("transformIndexHtml");
    expect(development).not.toHaveProperty("transformIndexHtml");
    expect(panelHtml).toContain("local-bridge-heading");
    expect(panelHtml).not.toContain("data-development-only");
  });

  test("ignores the generated consumer extension output", async () => {
    await expect(execFileAsync("git", [
      "check-ignore",
      "-q",
      "apps/extension-mv3/dist-consumer/manifest.json",
    ])).resolves.toBeDefined();
  });

  test("projects a consumer manifest with optional loopback bridge capabilities", async () => {
    const baseManifest = JSON.parse(
      await readFile(new URL("./public/manifest.json", import.meta.url), "utf8"),
    );
    const { projectExtensionManifest } = await import("./scripts/extension-surface-profile.mjs");
    const projected = projectExtensionManifest(baseManifest, "consumer");

    expect(projected.permissions).toContain("alarms");
    expect(projected.optional_host_permissions).toContain("http://127.0.0.1/*");
    expect(projected.optional_host_permissions).toEqual(
      expect.arrayContaining(["http://*/*", "https://*/*"]),
    );
  });

  test("projects consumer locale catalogs with optional bridge copy", async () => {
    const messages = JSON.parse(
      await readFile(new URL("./public/_locales/en/messages.json", import.meta.url), "utf8"),
    );
    const { projectExtensionLocaleMessages } = await import(
      "./scripts/extension-surface-profile.mjs"
    );
    const projected = projectExtensionLocaleMessages(messages, "consumer");

    expect(projected.first_capture_disclosure_local.message).toMatch(/bridge/i);
    expect(projected.first_capture_disclosure_receiver.message).toMatch(/bridge/i);
    expect(projected).toHaveProperty("local_agent_bridge");
    expect(projected).toHaveProperty("ready_to_connect");
  });

  test("builds panel and background separately from the classic content script", async () => {
    const resolved = await resolveConfig(config);
    const input = resolved.build?.rollupOptions?.input;
    expect(input).toMatchObject({
      background: expect.stringContaining("background.ts"),
      options: expect.stringContaining("options.html"),
      panel: expect.stringContaining("panel.html"),
    });
    expect(input).not.toHaveProperty("content");
  });

  test("uses stable page entry filenames required by the MV3 manifest", async () => {
    const resolved = await resolveConfig(config);
    const output = resolved.build?.rollupOptions?.output;
    expect(output).toMatchObject({ entryFileNames: "assets/[name].js" });
    if (!output || Array.isArray(output) || typeof output.chunkFileNames !== "function") {
      throw new Error("Expected a stable extension chunk filename function");
    }
    type ChunkInfo = Parameters<typeof output.chunkFileNames>[0];
    expect(
      output.chunkFileNames({
        moduleIds: ["D:/checkout/apps/extension-mv3/src/session-file.ts"],
      } as ChunkInfo),
    ).toBe("assets/session-file.js");
    expect(
      output.chunkFileNames({
        moduleIds: ["D:/checkout/apps/extension-mv3/src/other-shared.ts"],
      } as ChunkInfo),
    ).toBe("assets/[name].js");
  });

  test("disables modulepreload links for extension pages", async () => {
    expect((await resolveConfig(config)).build?.modulePreload).toBe(false);
  });

  test("builds the content script as a single non-emptying bundle", async () => {
    const resolved = await resolveConfig(contentConfig);
    expect(resolved.build?.emptyOutDir).toBe(false);
    expect(resolved.build?.copyPublicDir).toBe(false);
    expect(resolved.build?.rollupOptions?.input).toEqual(
      expect.stringContaining("content.ts"),
    );
    expect(resolved.build?.rollupOptions?.output).toMatchObject({
      entryFileNames: "assets/content.js",
      codeSplitting: false,
    });
  });
});
