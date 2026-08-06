import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertInstalledPackageIdentity,
  assertPublicPackageMetadata,
  assertInstalledPackageSourceMaps,
  assertSelfContainedSourceMap,
  toLocalPackageSpec,
} from "./package-pack-spec.mjs";
import { discoverPublicPackages } from "./verify-package-packs.mjs";

describe("toLocalPackageSpec", () => {
  test("marks workspace package directories as local npm specs", () => {
    const root = join("repo-root");
    const packageDirectory = join(root, "packages", "html-ops");

    expect(toLocalPackageSpec(root, packageDirectory)).toBe("./packages/html-ops");
  });
});

describe("discoverPublicPackages", () => {
  test("discovers the six libraries plus the installable companion chain", async () => {
    const packages = await discoverPublicPackages();
    expect(packages.map((packageInfo) => packageInfo.name)).toEqual([
      "@meanthis/cli",
      "@meanthis/hub-core",
      "@meanthis/prompt",
      "@meanthis/replay",
      "@meanthis/schema",
      "@meanthis/source-map-core",
      "@meanthis/source-resolver-mcp",
      "@meanthis/web-extractor",
      "@meanthis/web-picker",
    ]);
    const cli = packages.find((packageInfo) => packageInfo.name === "@meanthis/cli");
    expect(cli?.allowedFiles).toEqual(expect.arrayContaining([
      "dist/mcp-host-config.d.ts",
      "dist/mcp-host-config.js",
      "dist/mcp-host-config.js.map",
    ]));
  });
});

describe("assertSelfContainedSourceMap", () => {
  test("rejects a published map without embedded source content", () => {
    expect(() => assertSelfContainedSourceMap(JSON.stringify({
      version: 3,
      sources: ["../src/index.ts"],
    }))).toThrow("Published source map is not self-contained.");
  });

  test("accepts relative sources with matching embedded content", () => {
    expect(() => assertSelfContainedSourceMap(JSON.stringify({
      version: 3,
      sources: ["../src/index.ts"],
      sourcesContent: ["export const value = 1;\n"],
    }))).not.toThrow();
  });

  test("rejects invalid map bytes from the installed tarball consumer", async () => {
    const consumerDirectory = await mkdtemp(join(tmpdir(), "ui-attach-map-consumer-"));
    try {
      const mapDirectory = join(
        consumerDirectory,
        "node_modules",
        "@meanthis",
        "schema",
        "dist",
      );
      await mkdir(mapDirectory, { recursive: true });
      await writeFile(
        join(mapDirectory, "index.js.map"),
        JSON.stringify({ version: 3, sources: ["../src/index.ts"] }),
      );

      await expect(assertInstalledPackageSourceMaps(
        consumerDirectory,
        "@meanthis/schema",
        ["dist/index.js.map"],
      )).rejects.toThrow("Published source map is not self-contained.");
    } finally {
      await rm(consumerDirectory, { recursive: true, force: true });
    }
  });
});

describe("assertPublicPackageMetadata", () => {
  const validManifest = {
    name: "@meanthis/schema",
    description: "Shared UI attachment schema.",
    license: "MIT",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/oraclexing/meanthis.git",
      directory: "packages/schema",
    },
    homepage: "https://github.com/oraclexing/meanthis/tree/main/packages/schema#readme",
    bugs: { url: "https://github.com/oraclexing/meanthis/issues" },
  };

  test("rejects metadata without the package repository directory", () => {
    const manifest = structuredClone(validManifest);
    delete manifest.repository.directory;
    expect(() => assertPublicPackageMetadata(manifest, "packages/schema"))
      .toThrow("Public package metadata is incomplete.");
  });

  test("accepts complete public package metadata", () => {
    expect(() => assertPublicPackageMetadata(validManifest, "packages/schema")).not.toThrow();
  });
});

describe("assertInstalledPackageIdentity", () => {
  test("rejects a tarball manifest version that differs from the bound evidence record", () => {
    expect(() => assertInstalledPackageIdentity(
      { name: "@meanthis/web-picker", version: "9.9.9" },
      { name: "@meanthis/web-picker", version: "0.1.0" },
    )).toThrow("Installed package identity does not match its evidence record.");
  });

  test("accepts the exact bound package name and version", () => {
    expect(() => assertInstalledPackageIdentity(
      { name: "@meanthis/web-picker", version: "0.1.0" },
      { name: "@meanthis/web-picker", version: "0.1.0" },
    )).not.toThrow();
  });
});
