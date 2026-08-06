import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UI_ATTACH_SOURCE_MAP_DEFAULT_PATH,
  createSourceContentHash,
  createSourceMapSidecar,
  isUIAttachSourceMapSidecar,
  resolveUIAttachSource,
  resolveUIAttachSourceAcrossWorkspaces,
  type UIAttachSourceMapEntry,
} from "./index";

const BUILD_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SOURCE_ID = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (directory) => {
    const resolved = resolve(directory);
    const safePrefix = resolve(tmpdir());
    const child = relative(safePrefix, resolved);
    if (
      child === "" ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    ) {
      throw new Error("Refusing to remove a test directory outside the OS temp root.");
    }
    await rm(resolved, { recursive: true, force: true });
  }));
});

describe("source map sidecar contract", () => {
  it("creates and validates a canonical exact sidecar", () => {
    const entry = createEntry("export const value = 1;\n");

    const sidecar = createSourceMapSidecar(BUILD_ID, [entry]);

    expect(isUIAttachSourceMapSidecar(sidecar)).toBe(true);
    expect(sidecar).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-map-sidecar",
      buildId: BUILD_ID,
      entries: [entry],
    });
    expect(isUIAttachSourceMapSidecar({
      ...sidecar,
      entries: [{ ...entry, path: "C:/workspace/src/Panel.tsx" }],
    })).toBe(false);
    expect(isUIAttachSourceMapSidecar({
      ...sidecar,
      entries: [{ ...entry, path: "../outside.tsx" }],
    })).toBe(false);
  });
});

describe("resolveUIAttachSource", () => {
  it("verifies a matching sidecar entry against current workspace bytes", async () => {
    const workspaceRoot = await createWorkspace("export function Panel() {}\n");

    const result = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "verified",
      buildId: BUILD_ID,
      sourceId: SOURCE_ID,
      location: {
        path: "src/Panel.tsx",
        line: 4,
        column: 10,
        tagName: "button",
        componentName: "Panel",
      },
    });
    expect(JSON.stringify(result)).not.toContain(createSourceContentHash("export function Panel() {}\n"));
    expect(JSON.stringify(result)).not.toContain(resolve(workspaceRoot));
  });

  it.each([
    ["source_anchor_missing", undefined],
    ["source_anchor_invalid", { buildId: "short", sourceId: SOURCE_ID }],
  ])("returns unavailable for %s", async (reason, anchor) => {
    const workspaceRoot = await createWorkspace("export function Panel() {}\n");

    const result = await resolveUIAttachSource({ workspaceRoot, anchor });

    expect(result).toMatchObject({ status: "unavailable", reason });
  });

  it.each([
    ["build_mismatch", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", SOURCE_ID],
    ["source_id_not_found", BUILD_ID, "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"],
  ])("fails closed with %s", async (reason, buildId, sourceId) => {
    const workspaceRoot = await createWorkspace("export function Panel() {}\n");

    const result = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(buildId, sourceId),
    });

    expect(result).toMatchObject({ status: "unavailable", reason });
  });

  it("rejects a stale source hash", async () => {
    const workspaceRoot = await createWorkspace("export function Panel() {}\n");
    await writeFile(join(workspaceRoot, "src", "Panel.tsx"), "export function Changed() {}\n");

    const result = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "source_hash_mismatch" });
  });

  it("falls back to bounded candidates without upgrading them to verified", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-candidate-"));
    temporaryRoots.push(workspaceRoot);

    const result = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
      candidates: [
        { path: "src/Second.tsx", line: 20, column: 3, confidence: 0.7 },
        { path: "../outside.tsx", line: 1, column: 1, confidence: 1 },
        { path: "src/Panel.tsx", line: 4, column: 10, confidence: 0.9 },
      ],
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "candidate",
      exactFailureReason: "sidecar_missing",
      candidates: [
        { path: "src/Panel.tsx", line: 4, column: 10, confidence: 0.9 },
        { path: "src/Second.tsx", line: 20, column: 3, confidence: 0.7 },
      ],
    });
  });

  it("rejects malformed sidecars and source paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-invalid-"));
    temporaryRoots.push(workspaceRoot);
    const sidecarPath = join(workspaceRoot, ...UI_ATTACH_SOURCE_MAP_DEFAULT_PATH.split("/"));
    await mkdir(dirname(sidecarPath), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-map-sidecar",
      buildId: BUILD_ID,
      entries: [{ ...createEntry("source"), path: "../outside.tsx" }],
    }));

    const result = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "sidecar_invalid" });
  });
});

describe("resolveUIAttachSourceAcrossWorkspaces", () => {
  it("returns the only verified match across declared workspace roots", async () => {
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-unrelated-"));
    temporaryRoots.push(unrelatedRoot);
    const matchingRoot = await createWorkspace("export function Panel() {}\n");

    const result = await resolveUIAttachSourceAcrossWorkspaces({
      workspaceRoots: [unrelatedRoot, matchingRoot],
      anchor: createAnchor(),
    });

    expect(result).toMatchObject({ status: "verified", sourceId: SOURCE_ID });
  });

  it("fails closed when more than one workspace verifies the same anchor", async () => {
    const firstRoot = await createWorkspace("export function Panel() {}\n");
    const secondRoot = await createWorkspace("export function Panel() {}\n");

    const result = await resolveUIAttachSourceAcrossWorkspaces({
      workspaceRoots: [firstRoot, secondRoot],
      anchor: createAnchor(),
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "unavailable",
      reason: "workspace_ambiguous",
    });
  });

  it("keeps bounded candidates non-verified when no workspace matches", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-second-"));
    temporaryRoots.push(firstRoot, secondRoot);

    const result = await resolveUIAttachSourceAcrossWorkspaces({
      workspaceRoots: [firstRoot, secondRoot],
      anchor: createAnchor(),
      candidates: [{ path: "src/Panel.tsx", line: 4, column: 10, confidence: 0.8 }],
    });

    expect(result).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "candidate",
      exactFailureReason: "workspace_no_match",
      candidates: [{ path: "src/Panel.tsx", line: 4, column: 10, confidence: 0.8 }],
    });
  });

  it("rejects an unbounded workspace-root set before filesystem access", async () => {
    const result = await resolveUIAttachSourceAcrossWorkspaces({
      workspaceRoots: Array.from({ length: 33 }, (_, index) => `missing-${index}`),
      anchor: createAnchor(),
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "workspace_limit_exceeded",
    });
  });
});

function createAnchor(buildId = BUILD_ID, sourceId = SOURCE_ID) {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.opaque-source-anchor",
    buildId,
    sourceId,
  };
}

function createEntry(source: string): UIAttachSourceMapEntry {
  return {
    sourceId: SOURCE_ID,
    path: "src/Panel.tsx",
    line: 4,
    column: 10,
    tagName: "button",
    componentName: "Panel",
    contentHash: createSourceContentHash(source),
  };
}

async function createWorkspace(source: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-"));
  temporaryRoots.push(workspaceRoot);
  const sourcePath = join(workspaceRoot, "src", "Panel.tsx");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  const sidecar = createSourceMapSidecar(BUILD_ID, [createEntry(source)]);
  const sidecarPath = join(workspaceRoot, ...UI_ATTACH_SOURCE_MAP_DEFAULT_PATH.split("/"));
  await mkdir(dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toEqual(sidecar);
  return workspaceRoot;
}
