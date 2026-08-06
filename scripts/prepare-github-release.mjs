import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export async function prepareGithubRelease({ root, tag, outputDirectory }) {
  const repositoryRoot = resolve(root);
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw new Error("Release asset output directory must be absolute.");
  }
  const packageManifest = await readJson(join(repositoryRoot, "package.json"));
  const version = packageManifest.version;
  if (typeof version !== "string" || !VERSION.test(version) || tag !== `v${version}`) {
    throw new Error("Release tag must exactly match package version.");
  }

  const releaseDirectory = join(
    repositoryRoot,
    "output",
    "extension-mv3",
    "consumer",
    version,
  );
  const archiveFilename = `meanthis-extension-mv3-${version}.zip`;
  const manifestFilename = `meanthis-extension-mv3-${version}.manifest.json`;
  const archivePath = join(releaseDirectory, archiveFilename);
  const manifestPath = join(releaseDirectory, manifestFilename);
  const [archive, manifestBytes] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath),
  ]);
  const releaseManifest = JSON.parse(manifestBytes.toString("utf8"));
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  if (
    releaseManifest.schemaVersion !== "0.1.0"
    || releaseManifest.kind !== "ui-attach.extension-release"
    || releaseManifest.package !== "@meanthis/extension-mv3"
    || releaseManifest.surfaceProfile !== "consumer"
    || releaseManifest.version !== version
    || releaseManifest.archive?.filename !== archiveFilename
    || releaseManifest.archive?.bytes !== archive.length
    || typeof releaseManifest.archive?.sha256 !== "string"
    || !SHA256.test(releaseManifest.archive.sha256)
    || releaseManifest.archive.sha256 !== archiveSha256
    || releaseManifest.archive?.format !== "zip-store-v1"
  ) {
    throw new Error("Release archive does not match its manifest.");
  }

  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const checksumFilename = `meanthis-extension-mv3-${version}.sha256`;
  const stagingDirectory = resolve(outputDirectory);
  await mkdir(stagingDirectory);
  await Promise.all([
    writeFile(join(stagingDirectory, archiveFilename), archive, { flag: "wx" }),
    writeFile(join(stagingDirectory, manifestFilename), manifestBytes, { flag: "wx" }),
    writeFile(
      join(stagingDirectory, checksumFilename),
      `${archiveSha256}  ${archiveFilename}\n${manifestSha256}  ${manifestFilename}\n`,
      { flag: "wx" },
    ),
  ]);
  return {
    version,
    tag,
    assetNames: [archiveFilename, manifestFilename, checksumFilename],
  };
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release metadata is invalid.");
  }
  return value;
}

function parseOptions(args) {
  if (
    args.length !== 4
    || args[0] !== "--tag"
    || args[1].length === 0
    || args[2] !== "--output"
    || args[3].length === 0
  ) {
    throw new Error(
      "Usage: node scripts/prepare-github-release.mjs --tag <vX.Y.Z> --output <absolute-directory>",
    );
  }
  return { tag: args[1], outputDirectory: args[3] };
}

if (process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const result = await prepareGithubRelease({ root, ...parseOptions(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
