import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import * as packagePackVerifier from "./verify-package-packs.mjs";
import {
  assertInstalledPackageIdentity,
  assertPublicPackageMetadata,
  assertInstalledPackageSourceMaps,
  assertSelfContainedSourceMap,
  toLocalPackageSpec,
} from "./package-pack-spec.mjs";
import {
  createConsumerInstallArguments,
  createIsolatedNpmEnvironment,
  createPackedCliOwnerConsumerManifest,
  createPackedCliOwnerInstallArguments,
  discoverPublicPackages,
  resolveExactNodeExecutable,
} from "./verify-package-packs.mjs";

test("keeps the root build bound to the exact Node 22.12 packed owner gate", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.scripts["verify:package-packs:node22"]).toBe(
    "npx --yes node@22.12.0 scripts/verify-package-packs.mjs --require-node-22.12",
  );
  expect(manifest.scripts.build).toMatch(/npm run verify:package-packs:node22$/u);
  expect(manifest.scripts["verify:packages"]).toMatch(/npm run verify:package-packs:node22$/u);
});

test("keeps the MCP transport helpers in the CLI package test suite", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../apps/cli/package.json", import.meta.url),
    "utf8",
  ));
  expect(manifest.scripts.test).toContain("src/local-bridge-mcp-stdio-broker.test.ts");
  expect(manifest.scripts.test).toContain("src/local-bridge-native-host.test.ts");
  expect(manifest.scripts.test).toContain("src/local-bridge-native-host-install.test.ts");
  expect(manifest.scripts.test).toContain("src/local-bridge-mcp-http-health-proof.test.ts");
  expect(manifest.scripts.test).toContain("src/annotation-lifecycle-control-state.test.ts");
});

describe("summarizeBoundedCommandOutput", () => {
  test("keeps short and exact-4096-byte output unchanged, then truncates 4097", () => {
    const output = "short diagnostic 🙂\n";
    const exactBoundary = "a".repeat(4 * 1024);
    const overBoundary = `${exactBoundary}b`;

    expect(packagePackVerifier.summarizeBoundedCommandOutput(output)).toBe(output);
    expect(packagePackVerifier.summarizeBoundedCommandOutput(exactBoundary))
      .toBe(exactBoundary);
    const overBoundarySummary = packagePackVerifier.summarizeBoundedCommandOutput(
      overBoundary,
    );
    expect(overBoundarySummary).not.toBe(overBoundary);
    expect(Buffer.byteLength(overBoundarySummary, "utf8"))
      .toBeLessThanOrEqual(4 * 1024);
    const overBoundaryParts = splitBoundedSummary(overBoundarySummary);
    expect(
      Buffer.byteLength(overBoundaryParts.prefix, "utf8") +
      overBoundaryParts.omittedBytes +
      Buffer.byteLength(overBoundaryParts.suffix, "utf8"),
    ).toBe(Buffer.byteLength(overBoundary, "utf8"));
  });

  test("does not overlap a unique nonrepeating head and tail", () => {
    const output = Array.from(
      { length: 1_600 },
      (_value, index) => String.fromCodePoint(0x3400 + index),
    ).join("");

    const summary = packagePackVerifier.summarizeBoundedCommandOutput(output);
    const parts = splitBoundedSummary(summary);
    const prefixCharacters = new Set(parts.prefix);

    expect(packagePackVerifier.summarizeBoundedCommandOutput(output)).toBe(summary);
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect([...parts.suffix].some((character) => prefixCharacters.has(character)))
      .toBe(false);
    expect(
      Buffer.byteLength(parts.prefix, "utf8") +
      parts.omittedBytes +
      Buffer.byteLength(parts.suffix, "utf8"),
    ).toBe(Buffer.byteLength(output, "utf8"));
  });

  test("keeps four-byte emoji boundaries intact in both head and tail", () => {
    const output = "🙂".repeat(1_500);

    const summary = packagePackVerifier.summarizeBoundedCommandOutput(output);
    const parts = splitBoundedSummary(summary);

    expect(summary).not.toContain("\uFFFD");
    expect([...parts.prefix].every((character) => character === "🙂")).toBe(true);
    expect([...parts.suffix].every((character) => character === "🙂")).toBe(true);
    const prefixLastCodeUnit = parts.prefix.charCodeAt(parts.prefix.length - 1);
    const suffixFirstCodeUnit = parts.suffix.charCodeAt(0);
    expect(prefixLastCodeUnit < 0xD800 || prefixLastCodeUnit > 0xDBFF).toBe(true);
    expect(suffixFirstCodeUnit < 0xDC00 || suffixFirstCodeUnit > 0xDFFF).toBe(true);
    expect(
      Buffer.byteLength(parts.prefix, "utf8") +
      parts.omittedBytes +
      Buffer.byteLength(parts.suffix, "utf8"),
    ).toBe(Buffer.byteLength(output, "utf8"));
  });
});

describe("formatBoundedCommandFailure", () => {
  test("keeps two independent npm process lanes ordered and isolated", () => {
    const message = packagePackVerifier.formatBoundedCommandFailure({
      args: ["npm-cli.js", "pack", ".", "--json"],
      command: "node",
      status: 23,
      stderr: `STDERR_HEAD\n${"e".repeat(16 * 1024)}\nSTDERR_TAIL`,
      stdout: `STDOUT_HEAD\n${"o".repeat(16 * 1024)}\nSTDOUT_TAIL`,
    });
    const lanes = readNpmProcessLanes(message);

    expect(message).toMatch(/^Command failed with exit code 23:/u);
    expect(message.indexOf("npm process stdout:\n"))
      .toBeLessThan(message.indexOf("npm process stderr:\n"));
    for (const [lane, ownMarkers, foreignMarkers] of [
      [lanes.stdout, ["STDOUT_HEAD", "STDOUT_TAIL"], ["STDERR_HEAD", "STDERR_TAIL"]],
      [lanes.stderr, ["STDERR_HEAD", "STDERR_TAIL"], ["STDOUT_HEAD", "STDOUT_TAIL"]],
    ]) {
      expect(Buffer.byteLength(lane, "utf8")).toBeLessThanOrEqual(4 * 1024);
      for (const marker of ownMarkers) {
        expect(lane.split(marker)).toHaveLength(2);
        expect(message.split(marker)).toHaveLength(2);
      }
      for (const marker of foreignMarkers) expect(lane).not.toContain(marker);
      expect([
        ...lane.matchAll(/\.\.\.\[\d+ UTF-8 bytes omitted\]\.\.\./gu),
      ]).toHaveLength(1);
    }
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(9 * 1024);
  });

  test("omits an empty npm process lane", () => {
    const message = packagePackVerifier.formatBoundedCommandFailure({
      args: ["npm-cli.js", "pack"],
      command: "node",
      status: 1,
      stderr: "stderr only",
      stdout: "",
    });

    expect(message).not.toContain("npm process stdout:");
    expect(message).toContain("npm process stderr:\nstderr only");
  });
});

function splitBoundedSummary(summary) {
  const match = /\n\.\.\.\[(\d+) UTF-8 bytes omitted\]\.\.\.\n/u.exec(summary);
  if (!match) throw new Error("Expected one bounded-output omission marker.");
  return {
    omittedBytes: Number(match[1]),
    prefix: summary.slice(0, match.index),
    suffix: summary.slice(match.index + match[0].length),
  };
}

function readNpmProcessLanes(message) {
  const stdoutLabel = "npm process stdout:\n";
  const stderrLabel = "\nnpm process stderr:\n";
  const stdoutStart = message.indexOf(stdoutLabel);
  const stderrStart = message.indexOf(stderrLabel, stdoutStart);
  if (stdoutStart < 0 || stderrStart <= stdoutStart) {
    throw new Error("Expected ordered npm process diagnostics.");
  }
  return {
    stderr: message.slice(stderrStart + stderrLabel.length),
    stdout: message.slice(stdoutStart + stdoutLabel.length, stderrStart),
  };
}

describe("workspace npm pack lifecycle isolation", () => {
  const payload = [{
    filename: "meanthis-cli-0.1.0.tgz",
    name: "@meanthis/cli",
    version: "0.1.0",
  }];
  const cliDirectory = fileURLToPath(new URL("../apps/cli", import.meta.url));

  test("rejects an unclosed JSON-like prefix instead of extracting a JSON suffix", () => {
    const runCommand = vi.fn(() =>
      `{"truncated":\n${JSON.stringify(payload)}`);

    expect(() => packagePackVerifier.packWorkspacePackage({
      directory: cliDirectory,
      name: "@meanthis/cli",
      version: "0.1.0",
    }, "tarballs", { runCommand })).toThrow(
      "@meanthis/cli: npm pack returned invalid JSON.",
    );
  });

  test("forces background lifecycle IO without disabling workspace scripts", () => {
    const runCommand = vi.fn(() => JSON.stringify(payload));

    expect(packagePackVerifier.packWorkspacePackage({
      directory: cliDirectory,
      name: "@meanthis/cli",
      version: "0.1.0",
    }, "tarballs", { runCommand })).toEqual(payload[0]);
    const npmArguments = runCommand.mock.calls[0][1];
    expect(npmArguments.slice(1)).toEqual([
      "pack",
      "./apps/cli",
      "--json",
      "--foreground-scripts=false",
      "--pack-destination",
      "tarballs",
    ]);
    expect(npmArguments).not.toContain("--ignore-scripts");
  });

  test("runs a real npm 11 prepack side effect without contaminating strict JSON", async () => {
    const fixture = await createWorkspacePackFixture("success");
    try {
      expect(packagePackVerifier.assertExactNpmCliVersion({
        environment: fixture.environment,
        nodeExecutable: process.execPath,
      })).toBe("11.16.0");
      const packed = packagePackVerifier.packWorkspacePackage({
        directory: fixture.directory,
        name: fixture.name,
        version: "1.0.0",
      }, fixture.tarballsDirectory, {
        environment: fixture.environment,
        nodeExecutable: process.execPath,
      });

      expect(packed).toMatchObject({ name: fixture.name, version: "1.0.0" });
      expect(await readFile(join(fixture.directory, "prepack-marker.txt"), "utf8"))
        .toBe("prepack ran\n");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("keeps real npm 11 prepack failure diagnostics recognizable and bounded", async () => {
    const fixture = await createWorkspacePackFixture("failure", { fail: true });
    try {
      expect(packagePackVerifier.assertExactNpmCliVersion({
        environment: fixture.environment,
        nodeExecutable: process.execPath,
      })).toBe("11.16.0");
      let failure;
      try {
        packagePackVerifier.packWorkspacePackage({
          directory: fixture.directory,
          name: fixture.name,
          version: "1.0.0",
        }, fixture.tarballsDirectory, {
          environment: fixture.environment,
          nodeExecutable: process.execPath,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("Command failed with exit code 23:");
      const lanes = readNpmProcessLanes(failure.message);
      for (const lane of [lanes.stdout, lanes.stderr]) {
        expect(Buffer.byteLength(lane, "utf8")).toBeLessThanOrEqual(4 * 1024);
        expect([
          ...lane.matchAll(/\.\.\.\[\d+ UTF-8 bytes omitted\]\.\.\./gu),
        ]).toHaveLength(1);
      }
      // npm may duplicate and reorder one failing lifecycle detail across its
      // own process streams, so this fixture does not map child markers back to
      // the lifecycle script's original stdout and stderr lanes.
      expect(Buffer.byteLength(failure.message, "utf8"))
        .toBeLessThanOrEqual(9 * 1024);
      expect(await readFile(join(fixture.directory, "prepack-marker.txt"), "utf8"))
        .toBe("prepack ran\n");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

async function createWorkspacePackFixture(label, { fail = false } = {}) {
  const fixtureParent = fileURLToPath(new URL(
    "../.ui-attach-local/package-pack-spec/",
    import.meta.url,
  ));
  await mkdir(fixtureParent, { recursive: true });
  const directory = await mkdtemp(join(fixtureParent, `${label}-`));
  const npmStateDirectory = join(directory, "npm-state");
  const tarballsDirectory = join(directory, "tarballs");
  await Promise.all([
    mkdir(join(npmStateDirectory, "cache"), { recursive: true }),
    mkdir(join(npmStateDirectory, "prefix"), { recursive: true }),
    mkdir(tarballsDirectory),
  ]);
  await Promise.all([
    writeFile(join(npmStateDirectory, "global.npmrc"), ""),
    writeFile(join(npmStateDirectory, "user.npmrc"), ""),
    writeFile(join(directory, "index.js"), "export const fixture = true;\n"),
    writeFile(join(directory, "package.json"), `${JSON.stringify({
      files: ["index.js"],
      name: `meanthis-prepack-${label}`,
      scripts: { prepack: "node prepack.mjs" },
      type: "module",
      version: "1.0.0",
    }, null, 2)}\n`),
    writeFile(join(directory, "prepack.mjs"), [
      'import { writeFile } from "node:fs/promises";',
      'await writeFile(new URL("./prepack-marker.txt", import.meta.url), "prepack ran\\n");',
      `process.stdout.write(${JSON.stringify(
        fail ? "PREPACK_FAILURE_STDOUT_HEAD\n" : "PREPACK_SUCCESS_STDOUT_MARKER\n",
      )});`,
      `process.stderr.write(${JSON.stringify(
        fail ? "PREPACK_FAILURE_STDERR_HEAD\n" : "PREPACK_SUCCESS_STDERR_MARKER\n",
      )});`,
      ...(fail ? [
        'process.stdout.write("x".repeat(16 * 1024));',
        'process.stdout.write("\\nPREPACK_FAILURE_STDOUT_TAIL\\n");',
        'process.stderr.write("y".repeat(16 * 1024));',
        'process.stderr.write("\\nPREPACK_FAILURE_STDERR_TAIL\\n");',
        "process.exitCode = 23;",
      ] : []),
      "",
    ].join("\n")),
  ]);
  const environment = packagePackVerifier.createIsolatedNpmEnvironment(
    npmStateDirectory,
    process.env,
    { nodeExecutable: process.execPath },
  );
  environment.NPM_CONFIG_FOREGROUND_SCRIPTS = "true";
  return {
    directory,
    environment,
    name: `meanthis-prepack-${label}`,
    tarballsDirectory,
  };
}

describe("toLocalPackageSpec", () => {
  test("marks workspace package directories as local npm specs", () => {
    const root = join("repo-root");
    const packageDirectory = join(root, "apps", "demo-web");

    expect(toLocalPackageSpec(root, packageDirectory)).toBe("./apps/demo-web");
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
      "dist/annotation-lifecycle-control-state.d.ts",
      "dist/annotation-lifecycle-control-state.js",
      "dist/annotation-lifecycle-control-state.js.map",
      "dist/local-bridge-mcp-http.d.ts",
      "dist/local-bridge-mcp-http.js",
      "dist/local-bridge-mcp-http.js.map",
      "dist/local-bridge-mcp-http-control.d.ts",
      "dist/local-bridge-mcp-http-control.js",
      "dist/local-bridge-mcp-http-control.js.map",
      "dist/local-bridge-mcp-http-health-proof.d.ts",
      "dist/local-bridge-mcp-http-health-proof.js",
      "dist/local-bridge-mcp-http-health-proof.js.map",
      "dist/local-bridge-mcp-http-owner.d.ts",
      "dist/local-bridge-mcp-http-owner.js",
      "dist/local-bridge-mcp-http-owner.js.map",
      "dist/local-bridge-mcp-http-token.d.ts",
      "dist/local-bridge-mcp-http-token.js",
      "dist/local-bridge-mcp-http-token.js.map",
      "dist/local-bridge-mcp-stdio-broker.d.ts",
      "dist/local-bridge-mcp-stdio-broker.js",
      "dist/local-bridge-mcp-stdio-broker.js.map",
      "dist/local-bridge-native-host.d.ts",
      "dist/local-bridge-native-host.js",
      "dist/local-bridge-native-host.js.map",
      "dist/local-bridge-native-host-contract.d.ts",
      "dist/local-bridge-native-host-contract.js",
      "dist/local-bridge-native-host-contract.js.map",
      "dist/local-bridge-native-host-install.d.ts",
      "dist/local-bridge-native-host-install.js",
      "dist/local-bridge-native-host-install.js.map",
      "dist/mcp-host-config.d.ts",
      "dist/mcp-host-config.js",
      "dist/mcp-host-config.js.map",
    ]));
  });
});

describe("createConsumerInstallArguments", () => {
  test("allows a clean consumer to resolve uncached external dependencies", () => {
    const argumentsList = createConsumerInstallArguments(["meanthis-schema-0.1.0.tgz"]);

    expect(argumentsList).toContain("--prefer-offline");
    expect(argumentsList).not.toContain("--offline");
    expect(argumentsList.at(-1)).toBe("meanthis-schema-0.1.0.tgz");
  });
});

describe("packed CLI owner consumer", () => {
  const resolverSdkTarball = join(
    process.cwd(),
    "pack fixtures",
    "modelcontextprotocol-sdk-resolver-1.29.0.tgz",
  );
  const artifacts = [
    {
      name: "@meanthis/cli",
      path: join(process.cwd(), "pack fixtures", "meanthis-cli-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/hub-core",
      path: join(process.cwd(), "pack fixtures", "meanthis-hub-core-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/prompt",
      path: join(process.cwd(), "pack fixtures", "meanthis-prompt-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/schema",
      path: join(process.cwd(), "pack fixtures", "meanthis-schema-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/source-map-core",
      path: join(process.cwd(), "pack fixtures", "meanthis-source-map-core-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/source-resolver-mcp",
      path: join(process.cwd(), "pack fixtures", "meanthis-source-resolver-mcp-0.1.0.tgz"),
      version: "0.1.0",
    },
    {
      name: "@meanthis/web-extractor",
      path: join(process.cwd(), "pack fixtures", "meanthis-web-extractor-0.1.0.tgz"),
      version: "0.1.0",
    },
  ];

  test("installs only the CLI directly and binds first-party transitives to packed tarballs", () => {
    const manifest = createPackedCliOwnerConsumerManifest(artifacts, {
      resolverSdkTarball,
    });

    expect(manifest).toMatchObject({
      name: "meanthis-packed-cli-owner-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@meanthis/cli": pathToFileURL(artifacts[0].path).href,
      },
      overrides: {
        "@meanthis/hub-core": pathToFileURL(artifacts[1].path).href,
        "@meanthis/prompt": pathToFileURL(artifacts[2].path).href,
        "@meanthis/schema": pathToFileURL(artifacts[3].path).href,
        "@meanthis/source-map-core": pathToFileURL(artifacts[4].path).href,
        "@meanthis/source-resolver-mcp": {
          ".": pathToFileURL(artifacts[5].path).href,
          "@modelcontextprotocol/sdk": pathToFileURL(resolverSdkTarball).href,
        },
        "@meanthis/web-extractor": pathToFileURL(artifacts[6].path).href,
      },
    });
    expect(Object.keys(manifest.dependencies)).toEqual(["@meanthis/cli"]);
    expect(manifest.overrides).not.toHaveProperty("@meanthis/cli");
  });

  test("fails closed when any first-party CLI runtime tarball is missing", () => {
    const incompleteArtifacts = artifacts.filter(
      (artifact) => artifact.name !== "@meanthis/prompt",
    );

    expect(() => createPackedCliOwnerConsumerManifest(incompleteArtifacts, {
      resolverSdkTarball,
    }))
      .toThrow("missing first-party runtime tarballs: @meanthis/prompt");
  });

  test("requires an isolated file tarball for the resolver-specific SDK root", () => {
    expect(() => createPackedCliOwnerConsumerManifest(artifacts))
      .toThrow("requires a resolver-specific SDK tarball");
  });

  test("forces a nested install without accepting package specs on the command line", () => {
    const argumentsList = createPackedCliOwnerInstallArguments();

    expect(argumentsList).toEqual([
      "install",
      "--install-strategy=nested",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--registry=https://registry.npmjs.org/",
    ]);
  });

  test("isolates npm state and removes inherited npm credentials and Node injection", () => {
    const npmStateDirectory = join(process.cwd(), "isolated npm state");
    const environment = createIsolatedNpmEnvironment(npmStateDirectory, {
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      GITHUB_TOKEN: "github-secret",
      NODE_AUTH_TOKEN: "node-secret",
      NODE_OPTIONS: "--require malicious.cjs",
      Node_Path: "C:\\global-modules",
      NPM_CONFIG_REGISTRY: "https://private.invalid/",
      npm_config_userconfig: "ignored-user-config",
      NPM_TOKEN: "npm-secret",
      Path: "C:\\Windows\\System32",
      RANDOM_INHERITED_VALUE: "must-not-pass",
      SystemRoot: "C:\\Windows",
    }, {
      nodeExecutable: process.execPath,
    });

    expect(environment).toMatchObject({
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      NPM_CONFIG_CACHE: join(npmStateDirectory, "cache"),
      NPM_CONFIG_GLOBALCONFIG: join(npmStateDirectory, "global.npmrc"),
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_USERCONFIG: join(npmStateDirectory, "user.npmrc"),
      PATH: `${dirname(process.execPath)}${delimiter}C:\\Windows\\System32`,
      SYSTEMROOT: "C:\\Windows",
    });
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("Node_Path");
    expect(environment).not.toHaveProperty("npm_config_userconfig");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("RANDOM_INHERITED_VALUE");
  });

  test("deduplicates nested npm search paths while preserving the chosen Node and lookup order", () => {
    const nodeDirectory = dirname(process.execPath);
    const workspaceBin = join(process.cwd(), "node_modules", ".bin");
    const alternateCase = workspaceBin.toUpperCase();
    const environment = createIsolatedNpmEnvironment(join(process.cwd(), "isolated npm state"), {
      PATH: [workspaceBin, nodeDirectory, workspaceBin, alternateCase, nodeDirectory].join(delimiter),
    }, { nodeExecutable: process.execPath });

    expect(environment.PATH.split(delimiter)).toEqual(process.platform === "win32"
      ? [nodeDirectory, workspaceBin]
      : [nodeDirectory, workspaceBin, alternateCase]);
  });

  test("accepts only a runner that reports the required Node version", () => {
    expect(resolveExactNodeExecutable({
      environment: { MEANTHIS_NODE_22_12: process.execPath },
      expectedNodeVersion: process.versions.node,
    })).toBe(process.execPath);

    expect(() => resolveExactNodeExecutable({
      environment: { MEANTHIS_NODE_22_12: process.execPath },
      expectedNodeVersion: "0.0.0",
    })).toThrow("the configured runner reported");
  });

  test("parses the strict exact-Node package verification flag", () => {
    expect(packagePackVerifier.parsePackagePackArguments([
      "--require-node-22.12",
    ])).toEqual({ requireExactNode: true });
    expect(packagePackVerifier.parsePackagePackArguments([]))
      .toEqual({ requireExactNode: false });
    expect(() => packagePackVerifier.parsePackagePackArguments(["--unknown"]))
      .toThrow("Unknown package pack verification argument: --unknown");
  });

  test("requires the packageManager npm version for the exact toolchain", () => {
    const npmCliExecutable = process.env.npm_execpath ?? join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );

    expect(packagePackVerifier.assertExactNpmCliVersion({
      nodeExecutable: process.execPath,
      npmCliExecutable,
    })).toBe("11.16.0");
    expect(() => packagePackVerifier.assertExactNpmCliVersion({
      expectedNpmVersion: "0.0.0",
      nodeExecutable: process.execPath,
      npmCliExecutable,
    })).toThrow("requires npm 0.0.0");
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
