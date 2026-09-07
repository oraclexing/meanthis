import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const CLI_PACKAGE_DIRECTORY = resolve(scriptsDirectory, "..");
const CLI_DIST_MODULES = [
  "bridge-cli",
  "capture-cli",
  "annotation-lifecycle-control-cli",
  "cli",
  "contracts",
  "index",
  "annotation-lifecycle-control-state",
  "local-bridge-agent-auth",
  "local-bridge-agent-token",
  "local-bridge-mcp",
  "local-bridge-mcp-http",
  "local-bridge-mcp-http-control",
  "local-bridge-mcp-http-health-proof",
  "local-bridge-mcp-http-owner",
  "local-bridge-mcp-http-token",
  "local-bridge-mcp-stdio-broker",
  "local-bridge-native-host",
  "local-bridge-native-host-contract",
  "local-bridge-native-host-install",
  "local-bridge-owner",
  "local-bridge",
  "mcp-host-config",
];

export const CLI_PUBLISHED_DIST_FILES = Object.freeze(CLI_DIST_MODULES.flatMap((name) => [
  `${name}.d.ts`,
  `${name}.js`,
  `${name}.js.map`,
]).sort());

export async function prepareCliPackage({
  packageDirectory = CLI_PACKAGE_DIRECTORY,
  runBuild,
} = {}) {
  if (typeof runBuild !== "function") {
    throw new Error("CLI package preparation requires an explicit build callback.");
  }
  await cleanCliDist(packageDirectory);
  await runBuild({ packageDirectory: resolve(packageDirectory) });
  await assertExactCliDist(packageDirectory);
}

export async function cleanCliDist(packageDirectory = CLI_PACKAGE_DIRECTORY) {
  const paths = await assertCliPackageBoundary(packageDirectory);
  await rm(paths.distDirectory, {
    force: true,
    maxRetries: 4,
    recursive: true,
    retryDelay: 100,
  });
  await mkdir(paths.distDirectory);
  await assertCliPackageBoundary(paths.packageDirectory);
}

export async function assertCliPackageBoundary(packageDirectory) {
  const resolvedPackageDirectory = resolve(packageDirectory);
  const distDirectory = resolve(resolvedPackageDirectory, "dist");
  if (
    basename(distDirectory) !== "dist" ||
    !samePath(dirname(distDirectory), resolvedPackageDirectory)
  ) {
    throw new Error("CLI package preparation refused an out-of-bound dist path.");
  }

  const packageStat = await lstat(resolvedPackageDirectory);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new Error("CLI package directory must be a real directory.");
  }
  const manifestPath = join(resolvedPackageDirectory, "package.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("CLI package manifest must be a regular file.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "@meanthis/cli") {
    throw new Error("CLI package preparation found an unexpected package identity.");
  }

  const realPackageDirectory = await realpath(resolvedPackageDirectory);
  let distStat;
  try {
    distStat = await lstat(distDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (distStat) {
    if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
      throw new Error("CLI dist path must be a real directory.");
    }
    const realDistDirectory = await realpath(distDirectory);
    if (!samePath(dirname(realDistDirectory), realPackageDirectory)) {
      throw new Error("CLI package preparation refused an out-of-bound dist path.");
    }
  }
  return {
    distDirectory,
    packageDirectory: resolvedPackageDirectory,
  };
}

export async function assertExactCliDist(packageDirectory) {
  const { distDirectory } = await assertCliPackageBoundary(packageDirectory);
  const entries = await readdir(distDirectory, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (nonFiles.length > 0) {
    throw new Error(`CLI dist contains non-regular entries: ${nonFiles.sort().join(", ")}.`);
  }
  const actual = entries.map((entry) => entry.name).sort();
  const allowed = new Set(CLI_PUBLISHED_DIST_FILES);
  const missing = CLI_PUBLISHED_DIST_FILES.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !allowed.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`CLI dist does not match the exact publish allowlist: ${details}.`);
  }
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(left) === normalize(right);
}

export function parseCliPackagePreparationArguments(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--clean") return "clean";
  if (argumentsList.length === 1 && argumentsList[0] === "--verify") return "verify";
  throw new Error("CLI package preparation requires exactly --clean or --verify.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = parseCliPackagePreparationArguments(process.argv.slice(2));
    if (action === "clean") await cleanCliDist();
    else await assertExactCliDist(CLI_PACKAGE_DIRECTORY);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
