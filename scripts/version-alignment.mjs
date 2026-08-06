import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/u;
const PUBLIC_WORKSPACES = Object.freeze([
  ["packages/hub-core", "@meanthis/hub-core", false],
  ["packages/prompt", "@meanthis/prompt", false],
  ["packages/replay", "@meanthis/replay", false],
  ["packages/schema", "@meanthis/schema", false],
  ["packages/web-extractor", "@meanthis/web-extractor", false],
  ["packages/web-picker", "@meanthis/web-picker", false],
  ["tools/source-map-core", "@meanthis/source-map-core", false],
  ["tools/source-resolver-mcp", "@meanthis/source-resolver-mcp", false],
  ["apps/cli", "@meanthis/cli", false],
  ["apps/demo-web", "@meanthis/demo-web", true],
  ["apps/extension-mv3", "@meanthis/extension-mv3", true],
]);
const PUBLIC_PACKAGE_NAMES = new Set(
  PUBLIC_WORKSPACES.filter(([, , isPrivate]) => !isPrivate).map(([, name]) => name),
);

function fail(detail) {
  throw new Error(`Release version alignment failed: ${detail}.`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new TypeError("not an object");
    return value;
  } catch {
    fail(`cannot read ${path}`);
  }
}

export function assertArtifactMetadataVersion(metadata, expectedVersion) {
  if (!isRecord(metadata) || metadata.version !== expectedVersion) {
    fail(`artifact metadata version must equal ${expectedVersion}`);
  }
  if (
    metadata.kind !== "ui-attach.extension-release"
    || metadata.package !== "@meanthis/extension-mv3"
  ) {
    fail("extension release artifact identity is invalid");
  }
}

export async function verifyReleaseVersionAlignment(root) {
  const directory = root instanceof URL ? fileURLToPath(root) : root;
  const rootManifest = await readJson(join(directory, "package.json"));
  if (
    rootManifest.name !== "meanthis"
    || rootManifest.private !== true
    || !VERSION.test(rootManifest.version)
    || JSON.stringify(rootManifest.workspaces) !== JSON.stringify([
      "packages/schema",
      "packages/prompt",
      "packages/web-extractor",
      "packages/hub-core",
      "packages/web-picker",
      "packages/replay",
      "tools/source-map-core",
      "tools/source-resolver-mcp",
      "apps/cli",
      "apps/demo-web",
      "apps/extension-mv3",
    ])
  ) {
    fail("root workspace identity is invalid");
  }

  const knownNames = new Set(PUBLIC_WORKSPACES.map(([, name]) => name));
  for (const [path, expectedName, isPrivate] of PUBLIC_WORKSPACES) {
    const manifest = await readJson(join(directory, ...path.split("/"), "package.json"));
    if (
      manifest.name !== expectedName
      || manifest.version !== rootManifest.version
      || (isPrivate ? manifest.private !== true : manifest.private === true)
      || (!isPrivate && manifest.publishConfig?.access !== "public")
    ) {
      fail(`${path} workspace identity is invalid`);
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (!name.startsWith("@meanthis/")) continue;
        if (!knownNames.has(name) || value !== rootManifest.version) {
          fail(`${path} dependency ${name} is not aligned`);
        }
        if (!isPrivate && field !== "devDependencies" && !PUBLIC_PACKAGE_NAMES.has(name)) {
          fail(`${path} depends on a private workspace`);
        }
      }
    }
  }

  const browserManifest = await readJson(
    join(directory, "apps", "extension-mv3", "public", "manifest.json"),
  );
  if (
    browserManifest.manifest_version !== 3
    || browserManifest.name !== "MeanThis"
    || browserManifest.version !== rootManifest.version
  ) {
    fail("browser manifest identity is invalid");
  }
  return { publicPackages: PUBLIC_PACKAGE_NAMES.size, version: rootManifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyReleaseVersionAlignment(
      join(dirname(fileURLToPath(import.meta.url)), ".."),
    );
    process.stdout.write(
      `Release version alignment verified for ${result.version} (${result.publicPackages} public packages).\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
