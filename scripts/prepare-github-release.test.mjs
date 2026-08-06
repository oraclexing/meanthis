import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { prepareGithubRelease } from "./prepare-github-release.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("GitHub release preparation", () => {
  test("binds the tag to the package and consumer archive before writing a checksum", async () => {
    const fixture = await createFixture();
    const outputDirectory = join(fixture.root, "release-assets");

    const result = await prepareGithubRelease({
      root: fixture.root,
      tag: "v0.1.0",
      outputDirectory,
    });

    expect(result).toEqual({
      version: "0.1.0",
      tag: "v0.1.0",
      assetNames: [
        "meanthis-extension-mv3-0.1.0.zip",
        "meanthis-extension-mv3-0.1.0.manifest.json",
        "meanthis-extension-mv3-0.1.0.sha256",
      ],
    });
    const manifestFilename = "meanthis-extension-mv3-0.1.0.manifest.json";
    const manifest = await readFile(join(fixture.releaseDirectory, manifestFilename));
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    expect(await readFile(join(outputDirectory, "meanthis-extension-mv3-0.1.0.sha256"), "utf8"))
      .toBe(
        `${fixture.archiveSha256}  ${fixture.archiveFilename}\n`
        + `${manifestSha256}  ${manifestFilename}\n`,
      );
    await expect(readFile(join(fixture.releaseDirectory, "meanthis-extension-mv3-0.1.0.sha256")))
      .rejects.toThrow();
  });

  test("fails before writing when the tag or manifest is not exact", async () => {
    const wrongTag = await createFixture();
    await expect(prepareGithubRelease({
      root: wrongTag.root,
      tag: "v0.1.1",
      outputDirectory: join(wrongTag.root, "release-assets"),
    }))
      .rejects.toThrow("Release tag must exactly match package version.");

    const wrongManifest = await createFixture({ manifestSha256: "0".repeat(64) });
    await expect(prepareGithubRelease({
      root: wrongManifest.root,
      tag: "v0.1.0",
      outputDirectory: join(wrongManifest.root, "release-assets"),
    }))
      .rejects.toThrow("Release archive does not match its manifest.");
  });
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "meanthis-github-release-"));
  temporaryDirectories.push(root);
  const version = "0.1.0";
  const archiveFilename = `meanthis-extension-mv3-${version}.zip`;
  const manifestFilename = `meanthis-extension-mv3-${version}.manifest.json`;
  const releaseDirectory = join(root, "output", "extension-mv3", "consumer", version);
  const archive = Buffer.from("deterministic extension bytes");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "meanthis", version })}\n`);
  await writeFile(join(releaseDirectory, archiveFilename), archive);
  await writeFile(join(releaseDirectory, manifestFilename), `${JSON.stringify({
    schemaVersion: "0.1.0",
    kind: "ui-attach.extension-release",
    package: "@meanthis/extension-mv3",
    surfaceProfile: "consumer",
    version,
    archive: {
      filename: archiveFilename,
      bytes: archive.length,
      sha256: options.manifestSha256 ?? archiveSha256,
      format: "zip-store-v1",
    },
  })}\n`);
  return { archiveFilename, archiveSha256, releaseDirectory, root };
}
