import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const REPOSITORY_URL = "git+https://github.com/oraclexing/meanthis.git";
const ISSUES_URL = "https://github.com/oraclexing/meanthis/issues";

export function toLocalPackageSpec(rootDirectory, packageDirectory) {
  const relativePath = relative(rootDirectory, packageDirectory).replaceAll("\\", "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export function assertSelfContainedSourceMap(value) {
  let sourceMap;
  try {
    sourceMap = JSON.parse(value);
  } catch {
    throw new Error("Published source map is not self-contained.");
  }
  const sources = sourceMap?.sources;
  const sourcesContent = sourceMap?.sourcesContent;
  if (!Array.isArray(sources)
    || sources.length === 0
    || !Array.isArray(sourcesContent)
    || sourcesContent.length !== sources.length
    || sources.some((source) => typeof source !== "string"
      || source.length === 0
      || source.startsWith("/")
      || WINDOWS_ABSOLUTE_PATH.test(source))
    || sourcesContent.some((content) => typeof content !== "string")) {
    throw new Error("Published source map is not self-contained.");
  }
}

export async function assertInstalledPackageSourceMaps(
  consumerDirectory,
  packageName,
  sourceMapPaths,
) {
  const packageSegments = packageName.split("/");
  if (packageSegments.length !== 2
    || packageSegments.some((segment) => !/^[@a-z0-9][a-z0-9._-]*$/.test(segment))
    || !Array.isArray(sourceMapPaths)
    || sourceMapPaths.length === 0) {
    throw new Error("Published source map is not self-contained.");
  }
  for (const path of sourceMapPaths) {
    const pathSegments = typeof path === "string" ? path.split("/") : [];
    if (pathSegments.length === 0
      || pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("Published source map is not self-contained.");
    }
    const bytes = await readFile(
      join(consumerDirectory, "node_modules", ...packageSegments, ...pathSegments),
      "utf8",
    );
    assertSelfContainedSourceMap(bytes);
  }
}

export function assertInstalledPackageIdentity(manifest, expected) {
  if (typeof expected?.name !== "string"
    || typeof expected?.version !== "string"
    || manifest?.name !== expected.name
    || manifest?.version !== expected.version) {
    throw new Error("Installed package identity does not match its evidence record.");
  }
}

export function assertPublicPackageMetadata(manifest, packageDirectory) {
  const expectedHomepage = `https://github.com/oraclexing/meanthis/tree/main/${packageDirectory}#readme`;
  if (typeof manifest?.name !== "string"
    || !manifest.name.startsWith("@meanthis/")
    || typeof manifest.description !== "string"
    || manifest.description.trim().length === 0
    || manifest.private === true
    || manifest.license !== "MIT"
    || manifest.publishConfig?.access !== "public"
    || manifest.repository?.type !== "git"
    || manifest.repository?.url !== REPOSITORY_URL
    || manifest.repository?.directory !== packageDirectory
    || manifest.homepage !== expectedHomepage
    || manifest.bugs?.url !== ISSUES_URL) {
    throw new Error("Public package metadata is incomplete.");
  }
}
