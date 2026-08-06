import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertInstalledPackageIdentity,
  assertInstalledPackageSourceMaps,
  assertPublicPackageMetadata,
  toLocalPackageSpec,
} from "./package-pack-spec.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath =
  process.env.npm_execpath ??
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const requiredFiles = [
  "LICENSE",
  "README.md",
  "README_zh.md",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "package.json",
];
const packageSpecificFiles = {
  "@meanthis/replay": [
    "dist/locator-expression.d.ts",
    "dist/locator-expression.js",
    "dist/locator-expression.js.map",
    "dist/types.d.ts",
  ],
};
const smokeExports = {
  "@meanthis/cli": "createLocalBridgeMcpServer",
  "@meanthis/hub-core": "createCaptureHub",
  "@meanthis/prompt": "serializeAttachmentSummary",
  "@meanthis/replay": "applyReplayResult",
  "@meanthis/schema": "createAttachmentId",
  "@meanthis/source-map-core": "createSourceContentHash",
  "@meanthis/source-resolver-mcp": "createSourceResolverMcpServer",
  "@meanthis/web-extractor": "extractElementAttachment",
  "@meanthis/web-picker": "createUiAttachPicker",
};
const publicWorkspacePaths = {
  "@meanthis/cli": "apps/cli",
  "@meanthis/hub-core": "packages/hub-core",
  "@meanthis/prompt": "packages/prompt",
  "@meanthis/replay": "packages/replay",
  "@meanthis/schema": "packages/schema",
  "@meanthis/source-map-core": "tools/source-map-core",
  "@meanthis/source-resolver-mcp": "tools/source-resolver-mcp",
  "@meanthis/web-extractor": "packages/web-extractor",
  "@meanthis/web-picker": "packages/web-picker",
};
const companionFiles = [
  "LICENSE",
  "README.md",
  "README_zh.md",
  "package.json",
  ...[
    "bridge-cli",
    "cli",
    "contracts",
    "index",
    "local-bridge-agent-auth",
    "local-bridge-agent-token",
    "local-bridge-mcp",
    "local-bridge-owner",
    "local-bridge",
    "mcp-host-config",
  ].flatMap((name) => [
    `dist/${name}.d.ts`,
    `dist/${name}.js`,
    `dist/${name}.js.map`,
  ]),
];
const sourceResolverFiles = [
  ...requiredFiles,
  "dist/cli.js",
  "dist/cli.js.map",
  "dist/cli.d.ts",
];

export async function verifyPackagePacks() {
  const tempDir = await mkdtemp(join(tmpdir(), "meanthis-package-packs-"));
  const tarballsDir = join(tempDir, "tarballs");
  const consumerDir = join(tempDir, "consumer");

  try {
    await mkdir(tarballsDir);
    const { artifacts, packages } = await packPublicPackages(tarballsDir);
    const tarballs = artifacts.map((artifact) => artifact.path);

    await verifyInstalledConsumer(consumerDir, packages, tarballs);
    console.log(`Verified ${packages.length} publishable package tarballs.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function discoverPublicPackages() {
  const rootLicense = await readFile(join(rootDir, "LICENSE"), "utf8");
  const packages = [];
  for (const [name, packageDirectory] of Object.entries(publicWorkspacePaths)) {
    const directory = join(rootDir, ...packageDirectory.split("/"));
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const packageLicense = await readFile(join(directory, "LICENSE"), "utf8");
    if (packageLicense !== rootLicense) {
      throw new Error(`${manifest.name}: package LICENSE differs from the root LICENSE.`);
    }
    if (manifest.name !== name) {
      throw new Error(`${packageDirectory}: public package identity is invalid.`);
    }
    const expectedExport = smokeExports[name];
    const allowedFiles = name === "@meanthis/cli"
      ? companionFiles
      : name === "@meanthis/source-resolver-mcp"
        ? sourceResolverFiles
        : [
            ...requiredFiles,
            ...(packageSpecificFiles[name] ?? []),
          ];
    assertPublicPackageMetadata(manifest, packageDirectory);
    packages.push({
      allowedFiles,
      directory,
      expectedExport,
      name,
      packageDirectory,
      sourceMapPaths: allowedFiles.filter((path) => path.endsWith(".map")),
      version: manifest.version,
    });
  }
  const sortedPackages = packages.sort((left, right) => left.name.localeCompare(right.name));
  const expectedNames = Object.keys(smokeExports).sort();
  const actualNames = sortedPackages.map((packageInfo) => packageInfo.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Public package set mismatch. Expected ${expectedNames.length}, found ${actualNames.length}.`,
    );
  }
  return sortedPackages;
}

export function packWorkspacePackage(packageInfo, tarballsDir) {
  const packagePath = toLocalPackageSpec(rootDir, packageInfo.directory);
  const stdout = run(process.execPath, [
    npmCliPath,
    "pack",
    packagePath,
    "--json",
    "--pack-destination",
    tarballsDir,
  ]);
  const results = JSON.parse(stdout);
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(`${packageInfo.name}: npm pack returned an unexpected result.`);
  }
  if (results[0].name !== packageInfo.name || results[0].version !== packageInfo.version) {
    throw new Error(`${packageInfo.name}: npm pack returned an unexpected package identity.`);
  }
  return results[0];
}

export function verifyTarballFiles(packageName, files, allowedFiles) {
  const paths = new Set(files.map((file) => file.path.replaceAll("\\", "/")));
  const missing = allowedFiles.filter((requiredFile) => !paths.has(requiredFile));
  if (missing.length > 0) {
    throw new Error(`${packageName}: tarball is missing ${missing.join(", ")}.`);
  }

  const forbidden = [...paths].filter(isForbiddenFile);
  if (forbidden.length > 0) {
    throw new Error(`${packageName}: tarball contains forbidden files: ${forbidden.join(", ")}.`);
  }
  const unexpected = [...paths].filter((path) => !allowedFiles.includes(path));
  if (unexpected.length > 0) {
    throw new Error(`${packageName}: tarball contains unexpected files: ${unexpected.join(", ")}.`);
  }
}

function isForbiddenFile(path) {
  return (
    path.startsWith("src/") ||
    path.includes(".test.") ||
    path === "tsconfig.json" ||
    path.endsWith(".tsbuildinfo")
  );
}

export async function verifyInstalledConsumer(consumerDir, packages, tarballs) {
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "ui-attach-package-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    process.execPath,
    [
      npmCliPath,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballs,
    ],
    consumerDir,
  );

  for (const packageInfo of packages) {
    const installedManifest = JSON.parse(
      await readFile(
        join(consumerDir, "node_modules", ...packageInfo.name.split("/"), "package.json"),
        "utf8",
      ),
    );
    try {
      assertInstalledPackageIdentity(installedManifest, packageInfo);
      assertPublicPackageMetadata(installedManifest, packageInfo.packageDirectory);
      await assertInstalledPackageSourceMaps(
        consumerDir,
        packageInfo.name,
        packageInfo.sourceMapPaths,
      );
    } catch {
      throw new Error(`${packageInfo.name}: installed package metadata or source maps are invalid.`);
    }
  }

  const runtimeExpectations = Object.fromEntries(
    packages.map((packageInfo) => [packageInfo.name, packageInfo.expectedExport]),
  );
  await writeFile(
    join(consumerDir, "runtime-smoke.mjs"),
    [
      `const runtimeExpectations = ${JSON.stringify(runtimeExpectations)};`,
      "for (const [packageName, expectedExport] of Object.entries(runtimeExpectations)) {",
      "  const packageExports = await import(packageName);",
      "  if (typeof packageExports[expectedExport] !== \"function\") {",
      "    throw new Error(`${packageName} does not export ${expectedExport}.`);",
      "  }",
      "}",
      'const replayExports = await import("@meanthis/replay");',
      'if ("resolveReplayLocatorExpression" in replayExports) {',
      '  throw new Error("@meanthis/replay exposes parser internals from its root.");',
      "}",
      'const hubCoreExports = await import("@meanthis/hub-core");',
      'if ("buildAgentRepairPacket" in hubCoreExports) {',
      '  throw new Error("@meanthis/hub-core exposes repair orchestration from its root.");',
      "}",
      "const captureHub = hubCoreExports.createCaptureHub();",
      'if ("buildRepairPacket" in captureHub) {',
      '  throw new Error("@meanthis/hub-core capture hub exposes repair orchestration.");',
      "}",
      'if ("materializeHtmlBlockMove" in captureHub) {',
      '  throw new Error("@meanthis/hub-core capture hub exposes source materialization.");',
      "}",
      'const schemaExports = await import("@meanthis/schema");',
      'if (typeof schemaExports.evaluateSavedSnapshotControlPolicy !== "function") {',
      '  throw new Error("@meanthis/schema does not export the saved-snapshot policy guard.");',
      "}",
      "const invalidPolicyDecision = schemaExports.evaluateSavedSnapshotControlPolicy(null);",
      'if (invalidPolicyDecision.allowed || invalidPolicyDecision.code !== "invalid_request") {',
      '  throw new Error("@meanthis/schema saved-snapshot policy guard smoke failed.");',
      "}",
      "",
    ].join("\n"),
  );
  run(process.execPath, [join(consumerDir, "runtime-smoke.mjs")], consumerDir);
  const cliHelp = run(process.execPath, [
    join(consumerDir, "node_modules", "@meanthis", "cli", "dist", "index.js"),
    "--help",
  ], consumerDir);
  if (!cliHelp.includes("MeanThis CLI") || !cliHelp.includes("meanthis mcp")) {
    throw new Error("@meanthis/cli: installed binary smoke failed.");
  }

  await writeFile(
    join(consumerDir, "index.ts"),
    `${packages
      .map(
        (packageInfo, index) =>
          `import { ${packageInfo.expectedExport} as smokeExport${index} } from ${JSON.stringify(packageInfo.name)};\nvoid smokeExport${index};`,
      )
      .join("\n")}
import type {
  ReplayLocatorLike,
  ReplayPageLike,
  ReplayQueryScopeLike,
} from "@meanthis/replay";
import {
  evaluateSavedSnapshotControlPolicy,
  type SavedSnapshotControlPolicyDecisionV1,
} from "@meanthis/schema";
declare const replayTypes: [ReplayLocatorLike, ReplayPageLike, ReplayQueryScopeLike];
void replayTypes;
const policyDecision: SavedSnapshotControlPolicyDecisionV1 =
  evaluateSavedSnapshotControlPolicy(null);
void policyDecision;
`,
  );
  await writeFile(
    join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        files: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [join(rootDir, "node_modules", "typescript", "bin", "tsc"), "--project", consumerDir],
    consumerDir,
  );
}

export async function packPublicPackages(outputDirectory) {
  const packages = await discoverPublicPackages();
  const artifacts = [];
  for (const packageInfo of packages) {
    const pack = packWorkspacePackage(packageInfo, outputDirectory);
    verifyTarballFiles(packageInfo.name, pack.files, packageInfo.allowedFiles);
    artifacts.push({
      filename: pack.filename,
      name: packageInfo.name,
      path: join(outputDirectory, pack.filename),
      version: packageInfo.version,
    });
  }
  return { artifacts, packages };
}

function run(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyPackagePacks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
