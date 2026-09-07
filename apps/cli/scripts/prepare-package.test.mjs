import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CLI_PUBLISHED_DIST_FILES,
  parseCliPackagePreparationArguments,
  prepareCliPackage,
} from "./prepare-package.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe("CLI package preparation", () => {
  test("keeps one exact publishable dist allowlist", () => {
    expect(CLI_PUBLISHED_DIST_FILES).toHaveLength(66);
    expect(new Set(CLI_PUBLISHED_DIST_FILES).size).toBe(CLI_PUBLISHED_DIST_FILES.length);
    expect(CLI_PUBLISHED_DIST_FILES).toContain("annotation-lifecycle-control-state.js");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("annotation-lifecycle-control-cli.js");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("local-bridge-mcp-http-control.js");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("local-bridge-mcp-stdio-broker.d.ts");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("local-bridge-native-host.d.ts");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("local-bridge-native-host-contract.d.ts");
    expect(CLI_PUBLISHED_DIST_FILES).toContain("local-bridge-native-host-install.d.ts");
    expect(CLI_PUBLISHED_DIST_FILES.every((name) =>
      name.endsWith(".d.ts") || name.endsWith(".js") || name.endsWith(".js.map")))
      .toBe(true);
  });

  test("removes stale dist before a forced build and accepts only exact outputs", async () => {
    const packageDirectory = await createTemporaryCliPackage();
    const distDirectory = join(packageDirectory, "dist");
    const stalePath = join(distDirectory, "stale-launcher.js");
    await mkdir(distDirectory);
    await writeFile(stalePath, "stale");
    let buildCalls = 0;

    await prepareCliPackage({
      packageDirectory,
      runBuild: async () => {
        buildCalls += 1;
        await expect(lstat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
        await writeExactDist(distDirectory);
      },
    });

    expect(buildCalls).toBe(1);
    expect((await readdir(distDirectory)).sort()).toEqual(CLI_PUBLISHED_DIST_FILES);
  });

  test("fails closed before cleanup when the package identity is wrong", async () => {
    const packageDirectory = await createTemporaryCliPackage("@foreign/cli");
    const distDirectory = join(packageDirectory, "dist");
    const sentinelPath = join(distDirectory, "keep.txt");
    await mkdir(distDirectory);
    await writeFile(sentinelPath, "keep");
    let buildCalled = false;

    await expect(prepareCliPackage({
      packageDirectory,
      runBuild: async () => { buildCalled = true; },
    })).rejects.toThrow("unexpected package identity");

    expect(buildCalled).toBe(false);
    expect(await readFile(sentinelPath, "utf8")).toBe("keep");
  });

  test("refuses a non-directory dist target before recursive cleanup", async () => {
    const packageDirectory = await createTemporaryCliPackage();
    const distPath = join(packageDirectory, "dist");
    await writeFile(distPath, "do not remove");

    await expect(prepareCliPackage({
      packageDirectory,
      runBuild: async () => {},
    })).rejects.toThrow("dist path must be a real directory");

    expect(await readFile(distPath, "utf8")).toBe("do not remove");
  });

  test("rejects stale or missing outputs after the forced build", async () => {
    const stalePackage = await createTemporaryCliPackage();
    await expect(prepareCliPackage({
      packageDirectory: stalePackage,
      runBuild: async () => {
        const distDirectory = join(stalePackage, "dist");
        await writeExactDist(distDirectory);
        await writeFile(join(distDirectory, "old-launcher.js"), "stale");
      },
    })).rejects.toThrow("unexpected old-launcher.js");

    const incompletePackage = await createTemporaryCliPackage();
    await expect(prepareCliPackage({
      packageDirectory: incompletePackage,
      runBuild: async () => {
        const distDirectory = join(incompletePackage, "dist");
        await writeExactDist(distDirectory, { omit: CLI_PUBLISHED_DIST_FILES[0] });
      },
    })).rejects.toThrow(`missing ${CLI_PUBLISHED_DIST_FILES[0]}`);
  });

  test("accepts only the two fixed no-path helper actions", () => {
    expect(parseCliPackagePreparationArguments(["--clean"])).toBe("clean");
    expect(parseCliPackagePreparationArguments(["--verify"])).toBe("verify");
    expect(() => parseCliPackagePreparationArguments([])).toThrow("exactly --clean or --verify");
    expect(() => parseCliPackagePreparationArguments(["--clean", "outside-dist"]))
      .toThrow("exactly --clean or --verify");
  });

  test("wires direct pack lifecycle without publishing the helper", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest.scripts.prepack).toBe(
      "node scripts/prepare-package.mjs --clean && tsc -b --force && " +
      "node scripts/verify-cli.mjs && node scripts/prepare-package.mjs --verify",
    );
    expect(manifest.scripts.test).toContain("src/local-bridge-mcp-http-control.test.ts");
    expect(manifest.scripts.test).toContain("scripts/prepare-package.test.mjs");
    expect(manifest.files[0]).toBe("README_zh.md");
    expect(manifest.files.slice(1).sort()).toEqual(
      CLI_PUBLISHED_DIST_FILES.map((name) => `dist/${name}`).sort(),
    );
  });
});

async function createTemporaryCliPackage(name = "@meanthis/cli") {
  const packageDirectory = await mkdtemp(join(tmpdir(), "meanthis-cli-prepack-test-"));
  temporaryDirectories.push(packageDirectory);
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name })}\n`,
  );
  return packageDirectory;
}

async function writeExactDist(distDirectory, { omit } = {}) {
  await mkdir(distDirectory, { recursive: true });
  await Promise.all(CLI_PUBLISHED_DIST_FILES
    .filter((name) => name !== omit)
    .map((name) => writeFile(join(distDirectory, name), name)));
}
