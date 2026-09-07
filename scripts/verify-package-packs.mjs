import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
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
const rootManifest = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const cliWorkspaceManifest = JSON.parse(
  await readFile(join(rootDir, "apps", "cli", "package.json"), "utf8"),
);
const resolverWorkspaceManifest = JSON.parse(
  await readFile(join(rootDir, "tools", "source-resolver-mcp", "package.json"), "utf8"),
);
const packedOwnerNpmVersion = readNpmPackageManagerVersion(rootManifest.packageManager);
const packedOwnerNodeVersion = "22.12.0";
const packedOwnerRuntimeSdkName = "@modelcontextprotocol/sdk";
const packedOwnerRuntimeSdkVersion = readSharedRuntimeDependencyVersion(
  cliWorkspaceManifest,
  resolverWorkspaceManifest,
  packedOwnerRuntimeSdkName,
);
const packedOwnerNodeEnvironmentVariable = "MEANTHIS_NODE_22_12";
const packedOwnerFirstPartyRuntimePackages = [
  "@meanthis/hub-core",
  "@meanthis/prompt",
  "@meanthis/schema",
  "@meanthis/source-map-core",
  "@meanthis/source-resolver-mcp",
  "@meanthis/web-extractor",
];
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
  "@meanthis/schema": [
    "dist/annotation-lifecycle-control.d.ts",
    "dist/annotation-lifecycle-control.js",
    "dist/annotation-lifecycle-control.js.map",
    "dist/metadata-diagnostics.d.ts",
    "dist/metadata-diagnostics.js",
    "dist/metadata-diagnostics.js.map",
  ],
  "@meanthis/replay": [
    "dist/locator-expression.d.ts",
    "dist/locator-expression.js",
    "dist/locator-expression.js.map",
    "dist/types.d.ts",
  ],
  "@meanthis/web-picker": [
    "dist/annotation-surface-controller.d.ts",
    "dist/annotation-surface-controller.js",
    "dist/annotation-surface-controller.js.map",
    "dist/element-selection-controller.d.ts",
    "dist/element-selection-controller.js",
    "dist/element-selection-controller.js.map",
    "dist/in-page-widget-view.d.ts",
    "dist/in-page-widget-view.js",
    "dist/in-page-widget-view.js.map",
    "dist/persistent-overlays.d.ts",
    "dist/persistent-overlays.js",
    "dist/persistent-overlays.js.map",
    "dist/surface-claim.d.ts",
    "dist/surface-claim.js",
    "dist/surface-claim.js.map",
    "dist/web-widget.d.ts",
    "dist/web-widget.js",
    "dist/web-widget.js.map",
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
  "@meanthis/web-picker": "createMeanThisWebWidget",
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
    "capture-cli",
    "cli",
    "contracts",
    "index",
    "annotation-lifecycle-control-cli",
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

export function parsePackagePackArguments(argumentsList) {
  let requireExactNode = false;
  for (const argument of argumentsList) {
    if (argument === "--require-node-22.12") {
      requireExactNode = true;
      continue;
    }
    throw new Error(`Unknown package pack verification argument: ${argument}`);
  }
  return { requireExactNode };
}

export async function verifyPackagePacks({ requireExactNode = false } = {}) {
  const exactNodeExecutable = resolveExactNodeExecutable();
  if (requireExactNode && !exactNodeExecutable) {
    throw new Error(
      `Package pack verification requires exact Node ${packedOwnerNodeVersion}; ` +
      `run the strict command with that runtime or set ${packedOwnerNodeEnvironmentVariable}.`,
    );
  }
  const tempDir = await mkdtemp(join(tmpdir(), "meanthis-package-packs-"));
  const tarballsDir = join(tempDir, "tarballs");
  const consumerDir = join(tempDir, "consumer");
  let primaryError;

  try {
    let executionOptions = {};
    if (exactNodeExecutable) {
      const npmStateDirectory = join(tempDir, "npm");
      await prepareIsolatedNpmState(npmStateDirectory);
      const environment = createIsolatedNpmEnvironment(
        npmStateDirectory,
        process.env,
        { nodeExecutable: exactNodeExecutable },
      );
      assertExactNpmCliVersion({
        environment,
        nodeExecutable: exactNodeExecutable,
      });
      executionOptions = {
        environment,
        nodeExecutable: exactNodeExecutable,
      };
    }

    await mkdir(tarballsDir);
    const { artifacts, packages } = await packPublicPackages(
      tarballsDir,
      executionOptions,
    );
    const tarballs = artifacts.map((artifact) => artifact.path);

    await verifyInstalledConsumer(consumerDir, packages, tarballs, executionOptions);
    if (exactNodeExecutable) {
      await verifyPackedCliOwnerIdentity({
        artifacts,
        nodeExecutable: exactNodeExecutable,
      });
    } else {
      console.log(
        `Skipped packed CLI owner identity smoke: exact Node ${packedOwnerNodeVersion} runner is unavailable.`,
      );
    }
    console.log(
      exactNodeExecutable
        ? `Verified ${packages.length} publishable package tarballs and the packed CLI owner identity on exact Node ${packedOwnerNodeVersion}.`
        : `Verified ${packages.length} publishable package tarballs; the packed CLI owner identity was skipped and is not verified.`,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupTemporaryDirectory(tempDir, primaryError);
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

export function packWorkspacePackage(
  packageInfo,
  tarballsDir,
  { environment, nodeExecutable = process.execPath, runCommand = run } = {},
) {
  const packagePath = toLocalPackageSpec(rootDir, packageInfo.directory);
  const stdout = runCommand(nodeExecutable, [
    npmCliPath,
    "pack",
    packagePath,
    "--json",
    "--foreground-scripts=false",
    "--pack-destination",
    tarballsDir,
  ], rootDir, { environment });
  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    throw new Error(`${packageInfo.name}: npm pack returned invalid JSON.`);
  }
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

export async function verifyInstalledConsumer(
  consumerDir,
  packages,
  tarballs,
  { environment, nodeExecutable = process.execPath } = {},
) {
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "ui-attach-package-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    nodeExecutable,
    [npmCliPath, ...createConsumerInstallArguments(tarballs)],
    consumerDir,
    { environment },
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
      'const schemaExports = await import("@meanthis/schema");',
      'if (typeof schemaExports.evaluateSavedSnapshotControlPolicy !== "function") {',
      '  throw new Error("@meanthis/schema does not export the saved-snapshot policy guard.");',
      "}",
      'const webPickerExports = await import("@meanthis/web-picker");',
      'if (typeof webPickerExports.createMeanThisWebWidget !== "function" ||',
      '    typeof webPickerExports.claimMeanThisSurface !== "function") {',
      '  throw new Error("@meanthis/web-picker does not expose the shared widget SDK contract.");',
      "}",
      "const invalidPolicyDecision = schemaExports.evaluateSavedSnapshotControlPolicy(null);",
      'if (invalidPolicyDecision.allowed || invalidPolicyDecision.code !== "invalid_request") {',
      '  throw new Error("@meanthis/schema saved-snapshot policy guard smoke failed.");',
      "}",
      "",
    ].join("\n"),
  );
  run(
    nodeExecutable,
    [join(consumerDir, "runtime-smoke.mjs")],
    consumerDir,
    { environment },
  );
  const cliHelp = run(nodeExecutable, [
    join(consumerDir, "node_modules", "@meanthis", "cli", "dist", "index.js"),
    "--help",
  ], consumerDir, { environment });
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
import {
  claimMeanThisSurface,
  createMeanThisWebWidget,
} from "@meanthis/web-picker";
declare const replayTypes: [ReplayLocatorLike, ReplayPageLike, ReplayQueryScopeLike];
void replayTypes;
const policyDecision: SavedSnapshotControlPolicyDecisionV1 =
  evaluateSavedSnapshotControlPolicy(null);
void policyDecision;
void claimMeanThisSurface;
void createMeanThisWebWidget;
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
    nodeExecutable,
    [join(rootDir, "node_modules", "typescript", "bin", "tsc"), "--project", consumerDir],
    consumerDir,
    { environment },
  );
}

export function createConsumerInstallArguments(tarballs) {
  return [
    "install",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    ...tarballs,
  ];
}

export function createPackedCliOwnerConsumerManifest(
  artifacts,
  { resolverSdkTarball } = {},
) {
  const artifactsByName = new Map();
  for (const artifact of artifacts) {
    if (
      typeof artifact?.name !== "string" ||
      typeof artifact?.path !== "string" ||
      !isAbsolute(artifact.path) ||
      artifactsByName.has(artifact.name)
    ) {
      throw new Error("Packed CLI owner smoke received invalid package artifacts.");
    }
    artifactsByName.set(artifact.name, artifact);
  }
  const cliArtifact = artifactsByName.get("@meanthis/cli");
  if (!cliArtifact) {
    throw new Error("Packed CLI owner smoke requires the @meanthis/cli tarball.");
  }
  const missingRuntimeArtifacts = packedOwnerFirstPartyRuntimePackages.filter(
    (name) => !artifactsByName.has(name),
  );
  if (missingRuntimeArtifacts.length > 0) {
    throw new Error(
      `Packed CLI owner smoke is missing first-party runtime tarballs: ${missingRuntimeArtifacts.join(", ")}.`,
    );
  }
  if (typeof resolverSdkTarball !== "string" || !isAbsolute(resolverSdkTarball)) {
    throw new Error(
      "Packed CLI owner smoke requires a resolver-specific SDK tarball.",
    );
  }

  const overrides = Object.fromEntries(
    packedOwnerFirstPartyRuntimePackages.map((name) => [
      name,
      pathToFileURL(artifactsByName.get(name).path).href,
    ]),
  );
  overrides["@meanthis/source-resolver-mcp"] = {
    ".": pathToFileURL(
      artifactsByName.get("@meanthis/source-resolver-mcp").path,
    ).href,
    [packedOwnerRuntimeSdkName]: pathToFileURL(resolverSdkTarball).href,
  };

  return {
    name: "meanthis-packed-cli-owner-smoke",
    private: true,
    type: "module",
    dependencies: {
      "@meanthis/cli": pathToFileURL(cliArtifact.path).href,
    },
    overrides,
  };
}

export function createPackedCliOwnerInstallArguments() {
  return [
    "install",
    "--install-strategy=nested",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--registry=https://registry.npmjs.org/",
  ];
}

export function createIsolatedNpmEnvironment(
  npmStateDirectory,
  inheritedEnvironment = process.env,
  { nodeExecutable } = {},
) {
  const environment = createMinimalRuntimeEnvironment(inheritedEnvironment);
  if (nodeExecutable) {
    environment.PATH = [dirname(nodeExecutable), environment.PATH]
      .filter(Boolean)
      .join(delimiter);
  }
  if (typeof environment.PATH === "string") {
    // Nested npm lifecycles append the same ancestor bins repeatedly. Keep
    // their first lookup positions so Windows cmd retains a usable PATH.
    const seen = new Set();
    environment.PATH = environment.PATH.split(delimiter).filter((entry) => {
      const key = process.platform === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join(delimiter);
  }
  return {
    ...environment,
    NPM_CONFIG_CACHE: join(npmStateDirectory, "cache"),
    NPM_CONFIG_GLOBALCONFIG: join(npmStateDirectory, "global.npmrc"),
    NPM_CONFIG_PREFIX: join(npmStateDirectory, "prefix"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: join(npmStateDirectory, "user.npmrc"),
  };
}

export function resolveExactNodeExecutable({
  environment = process.env,
  expectedNodeVersion = packedOwnerNodeVersion,
} = {}) {
  const configuredExecutable = environment[packedOwnerNodeEnvironmentVariable];
  if (configuredExecutable) {
    assertExactNodeExecutable(configuredExecutable, expectedNodeVersion, environment);
    return configuredExecutable;
  }
  if (process.versions.node === expectedNodeVersion) {
    return process.execPath;
  }
  return undefined;
}

export function assertExactNpmCliVersion({
  environment,
  expectedNpmVersion = packedOwnerNpmVersion,
  nodeExecutable = process.execPath,
  npmCliExecutable = npmCliPath,
} = {}) {
  const actualNpmVersion = run(
    nodeExecutable,
    [npmCliExecutable, "--version"],
    rootDir,
    { environment },
  );
  if (actualNpmVersion !== expectedNpmVersion) {
    throw new Error(
      `Packed CLI owner identity smoke requires npm ${expectedNpmVersion}; ` +
      `the configured npm CLI reported ${actualNpmVersion}.`,
    );
  }
  return actualNpmVersion;
}

export async function verifyPackedCliOwnerIdentity({
  artifacts: providedArtifacts,
  expectedNodeVersion = packedOwnerNodeVersion,
  nodeExecutable: providedNodeExecutable,
} = {}) {
  const nodeExecutable = providedNodeExecutable ?? resolveExactNodeExecutable({
    expectedNodeVersion,
  });
  if (!nodeExecutable) {
    throw new Error(
      `Packed CLI owner identity smoke requires exact Node ${expectedNodeVersion}. ` +
      `Run it with that Node version or set ${packedOwnerNodeEnvironmentVariable} to its absolute executable path.`,
    );
  }
  assertExactNodeExecutable(nodeExecutable, expectedNodeVersion);

  const tempDirectory = await mkdtemp(join(tmpdir(), "mt-p22-"));
  const tarballsDirectory = join(tempDirectory, "packs");
  const consumerDirectory = join(tempDirectory, "consumer");
  const npmStateDirectory = join(tempDirectory, "npm");
  let primaryError;

  try {
    await prepareIsolatedNpmState(npmStateDirectory);
    const isolatedEnvironment = createIsolatedNpmEnvironment(
      npmStateDirectory,
      process.env,
      { nodeExecutable },
    );
    assertExactNpmCliVersion({
      environment: isolatedEnvironment,
      nodeExecutable,
    });

    let artifacts = providedArtifacts;
    await mkdir(tarballsDirectory);
    if (!artifacts) {
      ({ artifacts } = await packPublicPackages(tarballsDirectory, {
        environment: isolatedEnvironment,
        nodeExecutable,
      }));
    }
    const resolverSdkTarball = await packResolverRuntimeSdk(
      tarballsDirectory,
      join(tempDirectory, "resolver-sdk-staging"),
      {
        environment: isolatedEnvironment,
        nodeExecutable,
      },
    );
    const manifest = createPackedCliOwnerConsumerManifest(artifacts, {
      resolverSdkTarball,
    });
    const cliArtifact = artifacts.find((artifact) => artifact.name === "@meanthis/cli");
    if (!cliArtifact) {
      throw new Error("Packed CLI owner smoke requires the @meanthis/cli tarball.");
    }

    await mkdir(consumerDirectory);
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    run(
      nodeExecutable,
      [npmCliPath, ...createPackedCliOwnerInstallArguments()],
      consumerDirectory,
      { environment: isolatedEnvironment },
    );

    const cliRoot = join(consumerDirectory, "node_modules", "@meanthis", "cli");
    const ownerModulePath = join(cliRoot, "dist", "local-bridge-mcp-http-owner.js");
    const runtimeSmokePath = join(consumerDirectory, "owner-identity-smoke.mjs");
    await writeFile(
      runtimeSmokePath,
      createPackedCliOwnerRuntimeSmoke({
        cliName: cliArtifact.name,
        cliRoot,
        cliVersion: cliArtifact.version,
        consumerRoot: consumerDirectory,
        expectedNodeVersion,
        ownerModulePath,
        repositoryRoot: rootDir,
      }),
    );
    const output = run(
      nodeExecutable,
      [runtimeSmokePath],
      consumerDirectory,
      { environment: isolatedEnvironment },
    );
    const receipt = JSON.parse(output);
    if (
      receipt.nodeVersion !== expectedNodeVersion ||
      receipt.buildHashChanged !== true ||
      receipt.restoredIdentity !== true
    ) {
      throw new Error("Packed CLI owner identity smoke returned an invalid receipt.");
    }
    console.log(`Verified packed CLI owner identity with Node ${expectedNodeVersion}.`);
    return receipt;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupTemporaryDirectory(tempDirectory, primaryError);
  }
}

function createPackedCliOwnerRuntimeSmoke({
  cliName,
  cliRoot,
  cliVersion,
  consumerRoot,
  expectedNodeVersion,
  ownerModulePath,
  repositoryRoot,
}) {
  return `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const expectedNodeVersion = ${JSON.stringify(expectedNodeVersion)};
const cliName = ${JSON.stringify(cliName)};
const cliVersion = ${JSON.stringify(cliVersion)};
const cliRoot = ${JSON.stringify(cliRoot)};
const consumerRoot = ${JSON.stringify(consumerRoot)};
const repositoryRoot = ${JSON.stringify(repositoryRoot)};

function canonical(path) {
  return realpathSync.native(path);
}

function comparable(path) {
  const resolved = canonical(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(path, parent) {
  const relativePath = relative(comparable(parent), comparable(path));
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(\`..\${sep}\`) &&
    !isAbsolute(relativePath);
}

function findPackageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) return canonical(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(\`Could not find package root for \${expectedName}.\`);
    }
    current = parent;
  }
}

assert.equal(process.versions.node, expectedNodeVersion);
assert.equal(lstatSync(cliRoot).isSymbolicLink(), false);
const cliManifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
assert.equal(cliManifest.name, cliName);
assert.equal(cliManifest.version, cliVersion);
assert.equal(cliManifest.bin.meanthis, "./dist/index.js");
assert.equal(cliManifest.bin["ui-attach"], "./dist/index.js");

const cliEntryPath = join(cliRoot, "dist", "index.js");
assert.equal(lstatSync(cliEntryPath).isFile(), true);
const cliRequire = createRequire(pathToFileURL(cliEntryPath));
const cliSdkEntry = cliRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const resolverEntry = cliRequire.resolve("@meanthis/source-resolver-mcp");
const resolverRequire = createRequire(pathToFileURL(resolverEntry));
const resolverSdkEntry = resolverRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const cliSdkRoot = findPackageRoot(cliSdkEntry, "@modelcontextprotocol/sdk");
const resolverRoot = findPackageRoot(resolverEntry, "@meanthis/source-resolver-mcp");
const resolverSdkRoot = findPackageRoot(resolverSdkEntry, "@modelcontextprotocol/sdk");
const expectedCliSdkRoot = join(cliRoot, "node_modules", "@modelcontextprotocol", "sdk");
const expectedResolverRoot = join(
  cliRoot,
  "node_modules",
  "@meanthis",
  "source-resolver-mcp",
);
const expectedResolverSdkRoot = join(
  expectedResolverRoot,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
);
assert.equal(comparable(cliSdkRoot), comparable(expectedCliSdkRoot));
assert.equal(comparable(resolverRoot), comparable(expectedResolverRoot));
assert.equal(comparable(resolverSdkRoot), comparable(expectedResolverSdkRoot));
assert.notEqual(comparable(cliSdkRoot), comparable(resolverSdkRoot));
assert.equal(isWithin(cliSdkRoot, consumerRoot), true);
assert.equal(isWithin(resolverSdkRoot, consumerRoot), true);
for (const [label, root] of [
  ["packed CLI", cliRoot],
  ["CLI SDK", cliSdkRoot],
  ["source resolver", resolverRoot],
  ["source resolver SDK", resolverSdkRoot],
]) {
  assert.equal(isWithin(root, repositoryRoot), false, \`\${label} fell back to the repository.\`);
}

const ownerModule = await import(${JSON.stringify(pathToFileURL(ownerModulePath).href)});
assert.equal(typeof ownerModule.loadLocalBridgeMcpHttpOwnerIdentity, "function");
const loadIdentity = ownerModule.loadLocalBridgeMcpHttpOwnerIdentity;
const firstIdentity = loadIdentity();
assert.deepEqual(
  Object.keys(firstIdentity).sort(),
  ["buildHash", "entryPath", "executablePath"],
);
assert.equal(firstIdentity.executablePath, process.execPath);
assert.equal(comparable(firstIdentity.entryPath), comparable(cliEntryPath));
assert.match(firstIdentity.buildHash, /^[0-9a-f]{64}$/);
assert.deepEqual(loadIdentity(), firstIdentity);

const resolverSdkRequire = createRequire(pathToFileURL(resolverSdkEntry));
const contentTypeEntry = resolverSdkRequire.resolve("content-type");
const contentTypeRoot = findPackageRoot(contentTypeEntry, "content-type");
assert.equal(
  isWithin(contentTypeRoot, join(resolverSdkRoot, "node_modules")),
  true,
  "content-type did not resolve from the resolver-specific SDK closure.",
);
const contentTypeManifestPath = join(contentTypeRoot, "package.json");
const originalManifestBytes = readFileSync(contentTypeManifestPath);
let changedIdentity;
try {
  writeFileSync(
    contentTypeManifestPath,
    Buffer.concat([originalManifestBytes, Buffer.from("\\n", "utf8")]),
  );
  changedIdentity = loadIdentity();
  assert.notEqual(changedIdentity.buildHash, firstIdentity.buildHash);
} finally {
  writeFileSync(contentTypeManifestPath, originalManifestBytes);
}
const restoredIdentity = loadIdentity();
assert.deepEqual(restoredIdentity, firstIdentity);

process.stdout.write(JSON.stringify({
  buildHashChanged: changedIdentity.buildHash !== firstIdentity.buildHash,
  nodeVersion: process.versions.node,
  restoredIdentity: true,
}));
`;
}

function createMinimalRuntimeEnvironment(inheritedEnvironment) {
  const allowedKeys = new Set([
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "OS",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    const normalizedKey = key.toUpperCase();
    if (allowedKeys.has(normalizedKey) && typeof value === "string") {
      environment[normalizedKey] = value;
    }
  }
  return environment;
}

function assertExactNodeExecutable(
  nodeExecutable,
  expectedNodeVersion,
  inheritedEnvironment = process.env,
) {
  if (typeof nodeExecutable !== "string" || !isAbsolute(nodeExecutable)) {
    throw new Error(
      `Exact Node ${expectedNodeVersion} runner must be an absolute executable path.`,
    );
  }
  const result = spawnSync(nodeExecutable, ["-p", "process.versions.node"], {
    cwd: rootDir,
    encoding: "utf8",
    env: createMinimalRuntimeEnvironment(inheritedEnvironment),
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  const actualNodeVersion = result.status === 0 ? result.stdout.trim() : "unavailable";
  if (actualNodeVersion !== expectedNodeVersion) {
    throw new Error(
      `Packed CLI owner identity smoke requires exact Node ${expectedNodeVersion}; ` +
      `the configured runner reported ${actualNodeVersion}.`,
    );
  }
}

async function prepareIsolatedNpmState(npmStateDirectory) {
  await mkdir(join(npmStateDirectory, "cache"), { recursive: true });
  await mkdir(join(npmStateDirectory, "prefix"), { recursive: true });
  await writeFile(join(npmStateDirectory, "user.npmrc"), "");
  await writeFile(join(npmStateDirectory, "global.npmrc"), "");
}

async function cleanupTemporaryDirectory(tempDirectory, primaryError) {
  try {
    await rm(tempDirectory, {
      force: true,
      maxRetries: 4,
      recursive: true,
      retryDelay: 100,
    });
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    console.error(
      `Temporary cleanup also failed after the primary error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}

function readNpmPackageManagerVersion(packageManager) {
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "");
  if (!match) {
    throw new Error("Root packageManager must pin an exact npm version.");
  }
  return match[1];
}

function readSharedRuntimeDependencyVersion(
  firstManifest,
  secondManifest,
  dependencyName,
) {
  const firstVersion = firstManifest.dependencies?.[dependencyName];
  const secondVersion = secondManifest.dependencies?.[dependencyName];
  if (
    typeof firstVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(firstVersion) ||
    secondVersion !== firstVersion
  ) {
    throw new Error(
      `${dependencyName} must use one exact shared runtime version in CLI and resolver packages.`,
    );
  }
  return firstVersion;
}

async function readBoundedPackageFiles(packageDirectory) {
  const files = new Map();
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(packageDirectory, path).replaceAll("\\", "/");
      if (relativePath === "node_modules" || relativePath.startsWith("node_modules/")) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Resolver-specific SDK staging contains a non-regular file.");
      }
      const bytes = await readFile(path);
      totalBytes += bytes.byteLength;
      if (files.size >= 4096 || totalBytes > 64 * 1024 * 1024) {
        throw new Error("Resolver-specific SDK staging exceeds its file bounds.");
      }
      files.set(relativePath, bytes);
    }
  }

  await visit(packageDirectory);
  return files;
}

function assertPackageFileMapsEqual(expected, actual, message) {
  if (expected.size !== actual.size) throw new Error(message);
  for (const [path, expectedBytes] of expected) {
    const actualBytes = actual.get(path);
    if (!actualBytes || !expectedBytes.equals(actualBytes)) {
      throw new Error(message);
    }
  }
}

function replacePackageManifestVersion(bytes, fromVersion, toVersion) {
  const text = bytes.toString("utf8");
  const versionKeyIndex = text.indexOf('"version"');
  const colonIndex = text.indexOf(":", versionKeyIndex);
  const encodedFromVersion = JSON.stringify(fromVersion);
  const versionValueIndex = text.indexOf(encodedFromVersion, colonIndex + 1);
  if (
    versionKeyIndex < 0 ||
    colonIndex < 0 ||
    versionValueIndex < 0 ||
    !/^\s*$/.test(text.slice(colonIndex + 1, versionValueIndex))
  ) {
    throw new Error("Resolver-specific SDK manifest version is not replaceable.");
  }
  return Buffer.from(
    text.slice(0, versionValueIndex) +
      JSON.stringify(toVersion) +
      text.slice(versionValueIndex + encodedFromVersion.length),
    "utf8",
  );
}

async function assertStagedSdkDiffersOnlyByVersion(
  sourceFiles,
  stagedPackageDirectory,
  sourceVersion,
  stagedVersion,
) {
  const stagedFiles = await readBoundedPackageFiles(stagedPackageDirectory);
  const stagedManifest = stagedFiles.get("package.json");
  if (!stagedManifest) {
    throw new Error("Resolver-specific SDK staging package has no package.json.");
  }
  stagedFiles.set(
    "package.json",
    replacePackageManifestVersion(stagedManifest, stagedVersion, sourceVersion),
  );
  assertPackageFileMapsEqual(
    sourceFiles,
    stagedFiles,
    "Resolver-specific SDK staging differs from its source beyond package version.",
  );
}

async function packResolverRuntimeSdk(
  outputDirectory,
  stagingDirectory,
  { environment, nodeExecutable = process.execPath } = {},
) {
  const sourceConsumerDirectory = join(stagingDirectory, "source-consumer");
  const stagedPackageDirectory = join(stagingDirectory, "resolver-sdk-package");
  const smokeVersion = `${packedOwnerRuntimeSdkVersion}-meanthis-resolver-smoke.0`;
  await mkdir(sourceConsumerDirectory, { recursive: true });
  await writeFile(
    join(sourceConsumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "meanthis-resolver-sdk-source",
      private: true,
      dependencies: {
        [packedOwnerRuntimeSdkName]: packedOwnerRuntimeSdkVersion,
      },
    }, null, 2)}\n`,
  );
  run(
    nodeExecutable,
    [npmCliPath, ...createPackedCliOwnerInstallArguments()],
    sourceConsumerDirectory,
    { environment },
  );

  const sourcePackageDirectory = join(
    sourceConsumerDirectory,
    "node_modules",
    ...packedOwnerRuntimeSdkName.split("/"),
  );
  const sourceFilesBefore = await readBoundedPackageFiles(sourcePackageDirectory);
  const sourceManifestBytes = sourceFilesBefore.get("package.json");
  if (!sourceManifestBytes) {
    throw new Error("Resolver-specific SDK source package has no package.json.");
  }
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (
    sourceManifest.name !== packedOwnerRuntimeSdkName ||
    sourceManifest.version !== packedOwnerRuntimeSdkVersion
  ) {
    throw new Error("Resolver-specific SDK source package identity is invalid.");
  }

  await cp(sourcePackageDirectory, stagedPackageDirectory, {
    filter: (source) => {
      const relativePath = relative(sourcePackageDirectory, source);
      return relativePath !== "node_modules" &&
        !relativePath.startsWith(`node_modules${sep}`);
    },
    recursive: true,
  });
  assertPackageFileMapsEqual(
    sourceFilesBefore,
    await readBoundedPackageFiles(stagedPackageDirectory),
    "Resolver-specific SDK staging copy differs from its registry source.",
  );

  const stagedManifestPath = join(stagedPackageDirectory, "package.json");
  const stagedManifestBytes = replacePackageManifestVersion(
    sourceManifestBytes,
    packedOwnerRuntimeSdkVersion,
    smokeVersion,
  );
  let stdout;
  let packError;
  try {
    await writeFile(stagedManifestPath, stagedManifestBytes);
    await assertStagedSdkDiffersOnlyByVersion(
      sourceFilesBefore,
      stagedPackageDirectory,
      packedOwnerRuntimeSdkVersion,
      smokeVersion,
    );
    stdout = run(nodeExecutable, [
      npmCliPath,
      "pack",
      stagedPackageDirectory,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDirectory,
    ], rootDir, { environment });
  } catch (error) {
    packError = error;
    throw error;
  } finally {
    try {
      await writeFile(stagedManifestPath, sourceManifestBytes);
    } catch (restoreError) {
      if (!packError) throw restoreError;
      console.error(
        `SDK staging restore also failed after the pack error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
  }
  assertPackageFileMapsEqual(
    sourceFilesBefore,
    await readBoundedPackageFiles(stagedPackageDirectory),
    "Resolver-specific SDK staging bytes were not restored after packing.",
  );
  assertPackageFileMapsEqual(
    sourceFilesBefore,
    await readBoundedPackageFiles(sourcePackageDirectory),
    "Resolver-specific SDK registry source bytes changed during staging.",
  );

  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    throw new Error("Resolver-specific SDK pack returned invalid JSON.");
  }
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    results[0].name !== packedOwnerRuntimeSdkName ||
    results[0].version !== smokeVersion
  ) {
    throw new Error("Resolver-specific SDK pack returned an unexpected package identity.");
  }
  return join(outputDirectory, results[0].filename);
}

export async function packPublicPackages(outputDirectory, executionOptions = {}) {
  const packages = await discoverPublicPackages();
  const artifacts = [];
  for (const packageInfo of packages) {
    const pack = packWorkspacePackage(packageInfo, outputDirectory, executionOptions);
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

function run(command, args, cwd = rootDir, { environment } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatBoundedCommandFailure({
      args,
      command,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }));
  }
  return result.stdout.trim();
}

export function formatBoundedCommandFailure({ args, command, status, stderr, stdout }) {
  const summarizedStdout = summarizeBoundedCommandOutput(stdout);
  const summarizedStderr = summarizeBoundedCommandOutput(stderr);
  return [
    `Command failed with exit code ${status}: ${command} ${args.join(" ")}`,
    summarizedStdout.length > 0
      ? `npm process stdout:\n${summarizedStdout}`
      : undefined,
    summarizedStderr.length > 0
      ? `npm process stderr:\n${summarizedStderr}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeBoundedCommandOutput(output) {
  const maximumBytes = 4 * 1024;
  const value = typeof output === "string" ? output : "";
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maximumBytes) return value;

  const maximumMarker = createOmittedBytesMarker(totalBytes);
  const contentBudget = maximumBytes - Buffer.byteLength(maximumMarker, "utf8");
  const prefixBudget = Math.ceil(contentBudget / 2);
  const suffixBudget = contentBudget - prefixBudget;
  const prefix = takeUtf8Prefix(value, prefixBudget);
  const suffix = takeUtf8Suffix(value, suffixBudget, prefix.end);
  const omittedBytes = totalBytes - prefix.bytes - suffix.bytes;
  return prefix.text + createOmittedBytesMarker(omittedBytes) + suffix.text;
}

function createOmittedBytesMarker(omittedBytes) {
  return `\n...[${omittedBytes} UTF-8 bytes omitted]...\n`;
}

function takeUtf8Prefix(value, maximumBytes) {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return { bytes, end, text: value.slice(0, end) };
}

function takeUtf8Suffix(value, maximumBytes, minimumIndex) {
  let bytes = 0;
  let start = value.length;
  while (start > minimumIndex) {
    let characterStart = start - 1;
    const trailingCodeUnit = value.charCodeAt(characterStart);
    if (
      trailingCodeUnit >= 0xDC00 &&
      trailingCodeUnit <= 0xDFFF &&
      characterStart > minimumIndex
    ) {
      const leadingCodeUnit = value.charCodeAt(characterStart - 1);
      if (leadingCodeUnit >= 0xD800 && leadingCodeUnit <= 0xDBFF) {
        characterStart -= 1;
      }
    }
    const characterBytes = Buffer.byteLength(
      value.slice(characterStart, start),
      "utf8",
    );
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    start = characterStart;
  }
  return { bytes, start, text: value.slice(start) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyPackagePacks(parsePackagePackArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
