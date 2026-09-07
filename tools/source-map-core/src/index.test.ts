import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UI_ATTACH_SOURCE_MAP_DEFAULT_PATH,
  createSourceContentHash,
  createSourceMapSidecar,
  isUIAttachSourceMapSidecar,
  normalizeUIAttachSourceResolutionV1,
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
  it("accepts a valid lexical component breadcrumb on an entry", () => {
    const source = "export function Panel() {}\n";
    const entry = {
      ...createEntry(source),
      componentBreadcrumb: [
        { path: "src/Panel.tsx", line: 1, column: 1, componentName: "Outer" },
        { path: "src/Panel.tsx", line: 2, column: 3, componentName: "Panel" },
      ],
    } as unknown as UIAttachSourceMapEntry;

    expect(createSourceMapSidecar(BUILD_ID, [entry])).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-map-sidecar",
      buildId: BUILD_ID,
      entries: [entry],
    });
  });

  it("snapshots breadcrumb frames instead of retaining caller-owned references", () => {
    const source = "export function Panel() {}\n";
    const componentBreadcrumb = [
      { path: "src/Panel.tsx", line: 1, column: 1, componentName: "Panel" },
    ];
    const entry = {
      ...createEntry(source),
      componentBreadcrumb,
    } as UIAttachSourceMapEntry;

    const sidecar = createSourceMapSidecar(BUILD_ID, [entry]);
    componentBreadcrumb[0]!.componentName = "Mutated";

    expect(sidecar.entries[0]?.componentBreadcrumb).toEqual([
      { path: "src/Panel.tsx", line: 1, column: 1, componentName: "Panel" },
    ]);
  });

  it.each([
    ["a breadcrumb frame with an unsafe path", [
      { path: "../outside.tsx", line: 1, column: 1, componentName: "Panel" },
    ]],
    ["a breadcrumb frame from a different source file", [
      { path: "src/Other.tsx", line: 1, column: 1, componentName: "Panel" },
    ]],
    ["a breadcrumb frame with an invalid component name", [
      { path: "src/Panel.tsx", line: 1, column: 1, componentName: "panel" },
    ]],
    ["a breadcrumb with more than three frames", Array.from({ length: 4 }, (_, index) => ({
      path: "src/Panel.tsx",
      line: index + 1,
      column: 1,
      componentName: `Panel${index}`,
    }))],
  ])("rejects %s", (_name, componentBreadcrumb) => {
    expect(isUIAttachSourceMapSidecar({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-map-sidecar",
      buildId: BUILD_ID,
      entries: [{
        ...createEntry("source"),
        componentBreadcrumb,
      } as unknown as UIAttachSourceMapEntry],
    })).toBe(false);
  });

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

  it("accepts an exact configured JSX component callsite alongside unchanged intrinsic entries", () => {
    const source = "export const value = 1;\n";
    const intrinsic = createEntry(source);
    const component = createComponentEntry(source, "C".repeat(43));

    const sidecar = createSourceMapSidecar(BUILD_ID, [intrinsic, component]);

    expect(isUIAttachSourceMapSidecar(sidecar)).toBe(true);
    expect(sidecar.entries).toEqual([intrinsic, component]);
    expect(intrinsic).toEqual({
      sourceId: SOURCE_ID,
      path: "src/Panel.tsx",
      line: 4,
      column: 10,
      tagName: "button",
      componentName: "Panel",
      contentHash: createSourceContentHash(source),
    });
  });

  it.each([
    ["an uppercase intrinsic tag", { ...createEntry("source"), tagName: "Button" }],
    ["a component callsite with an intrinsic tag", {
      ...createComponentEntry("source"),
      tagName: "button",
    }],
    ["an unknown callsite kind", {
      ...createComponentEntry("source"),
      callsiteKind: "jsx_component",
    }],
    ["an invalid callsite name", {
      ...createComponentEntry("source"),
      callsiteName: "button",
    }],
    ["a component callsite without a callsite name", (() => {
      const { callsiteName: _callsiteName, ...entry } = createComponentEntry("source");
      return entry;
    })()],
    ["a component callsite carrying private import configuration", {
      ...createComponentEntry("source"),
      importSource: "@/components/ui/button",
    }],
    ["an intrinsic entry carrying component-only fields", {
      ...createEntry("source"),
      callsiteKind: "configured_jsx_component",
      callsiteName: "Button",
    }],
  ])("rejects %s", (_name, entry) => {
    expect(isUIAttachSourceMapSidecar({
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-map-sidecar",
      buildId: BUILD_ID,
      entries: [entry],
    })).toBe(false);
  });
});

describe("source resolution output normalization", () => {
  it("copies each exact public variant without retaining caller-owned objects", () => {
    const componentBreadcrumb = [{
      path: "src/Panel.tsx",
      line: 1,
      column: 1,
      componentName: "Panel",
    }];
    const verified = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "verified",
      buildId: BUILD_ID,
      sourceId: SOURCE_ID,
      location: {
        path: "src/Panel.tsx",
        line: 2,
        column: 3,
        tagName: "button",
        componentName: "Panel",
        componentBreadcrumb,
      },
    };
    const candidate = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "candidate",
      exactFailureReason: "source_hash_mismatch",
      candidates: [{ path: "src/Panel.tsx", line: 2, column: 3, confidence: 0.75 }],
    };
    const unavailable = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "unavailable",
      reason: "workspace_unavailable",
    };
    const configuredVerified = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "verified",
      buildId: BUILD_ID,
      sourceId: SOURCE_ID,
      location: {
        path: "src/Button.tsx",
        line: 8,
        column: 6,
        callsiteKind: "configured_jsx_component",
        callsiteName: "Button",
        componentName: "Panel",
      },
    };

    const normalizedVerified = normalizeUIAttachSourceResolutionV1(verified);
    const normalizedCandidate = normalizeUIAttachSourceResolutionV1(candidate);
    expect(normalizedVerified).toEqual(verified);
    expect(normalizedCandidate).toEqual(candidate);
    expect(normalizeUIAttachSourceResolutionV1(unavailable)).toEqual(unavailable);
    expect(normalizeUIAttachSourceResolutionV1(configuredVerified)).toEqual(configuredVerified);
    expect(normalizedVerified).not.toBe(verified);
    expect(normalizedVerified?.status === "verified" && normalizedVerified.location)
      .not.toBe(verified.location);
    expect(
      normalizedVerified?.status === "verified" &&
      normalizedVerified.location.componentBreadcrumb,
    ).not.toBe(componentBreadcrumb);
    expect(normalizedCandidate?.status === "candidate" && normalizedCandidate.candidates)
      .not.toBe(candidate.candidates);
  });

  it.each([
    ["an extra private path", {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "unavailable",
      reason: "workspace_unavailable",
      workspaceRoot: "C:/private/workspace",
    }],
    ["an extra hash and raw error", {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "candidate",
      exactFailureReason: "source_hash_mismatch",
      candidates: [{ path: "src/Panel.tsx", line: 2, column: 3, confidence: 0.75 }],
      contentHash: "secret",
      rawError: "private failure",
    }],
    ["an absolute verified path", {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "verified",
      buildId: BUILD_ID,
      sourceId: SOURCE_ID,
      location: {
        path: "C:/private/Panel.tsx",
        line: 2,
        column: 3,
        tagName: "button",
        componentName: "Panel",
      },
    }],
    ["an empty candidate list", {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "candidate",
      exactFailureReason: "source_hash_mismatch",
      candidates: [],
    }],
    ["an own undefined optional field", {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      status: "verified",
      buildId: BUILD_ID,
      sourceId: SOURCE_ID,
      location: {
        path: "src/Panel.tsx",
        line: 2,
        column: 3,
        tagName: "button",
        componentName: "Panel",
        componentBreadcrumb: undefined,
      },
    }],
  ])("rejects %s", (_name, value) => {
    expect(normalizeUIAttachSourceResolutionV1(value)).toBeNull();
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const value = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.source-resolution",
      reason: "workspace_unavailable",
    } as Record<string, unknown>;
    Object.defineProperty(value, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unavailable";
      },
    });

    expect(normalizeUIAttachSourceResolutionV1(value)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});

describe("resolveUIAttachSource", () => {
  it("returns a verified lexical breadcrumb only after the source hash matches", async () => {
    const source = "export function Panel() {}\n";
    const breadcrumb = [
      { path: "src/Panel.tsx", line: 1, column: 1, componentName: "Outer" },
      { path: "src/Panel.tsx", line: 2, column: 3, componentName: "Panel" },
    ];
    const entry = {
      ...createEntry(source),
      componentBreadcrumb: breadcrumb,
    } as unknown as UIAttachSourceMapEntry;
    const workspaceRoot = await createWorkspace(source, entry);

    const verified = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
    });

    expect(verified).toMatchObject({
      status: "verified",
      location: { componentBreadcrumb: breadcrumb },
    });
    expect(JSON.stringify(verified)).not.toContain(createSourceContentHash(source));
    expect(JSON.stringify(verified)).not.toContain(resolve(workspaceRoot));

    await writeFile(join(workspaceRoot, "src", "Panel.tsx"), "export function Changed() {}\n");
    const mismatch = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
    });

    expect(mismatch).toMatchObject({ status: "unavailable", reason: "source_hash_mismatch" });
    expect(JSON.stringify(mismatch)).not.toContain("componentBreadcrumb");
  });

  it("does not expose breadcrumb data through candidate or unavailable fallbacks", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-fallback-"));
    temporaryRoots.push(workspaceRoot);
    const candidates = [{
      path: "src/Panel.tsx",
      line: 4,
      column: 10,
      confidence: 0.8,
      componentBreadcrumb: [{
        path: "src/Panel.tsx",
        line: 1,
        column: 1,
        componentName: "Panel",
      }],
    }];

    const candidate = await resolveUIAttachSource({
      workspaceRoot,
      anchor: createAnchor(),
      candidates,
    });
    expect(candidate.status).toBe("candidate");
    expect(JSON.stringify(candidate)).not.toContain("componentBreadcrumb");

    const unavailable = await resolveUIAttachSource({
      workspaceRoot,
      anchor: { buildId: "short", sourceId: SOURCE_ID },
    });
    expect(unavailable.status).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("componentBreadcrumb");
  });

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

  it("verifies a configured JSX component callsite without inventing a DOM tag", async () => {
    const source = "export function Panel() {}\n";
    const entry = createComponentEntry(source);
    const workspaceRoot = await createWorkspace(source, entry);

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
        callsiteKind: "configured_jsx_component",
        callsiteName: "Button",
        componentName: "Panel",
      },
    });
    expect(JSON.stringify(result)).not.toContain("tagName");
    expect(JSON.stringify(result)).not.toContain(createSourceContentHash(source));
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

function createComponentEntry(
  source: string,
  sourceId = SOURCE_ID,
): UIAttachSourceMapEntry {
  return {
    sourceId,
    path: "src/Panel.tsx",
    line: 4,
    column: 10,
    callsiteKind: "configured_jsx_component",
    callsiteName: "Button",
    componentName: "Panel",
    contentHash: createSourceContentHash(source),
  };
}

async function createWorkspace(
  source: string,
  entry: UIAttachSourceMapEntry = createEntry(source),
): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ui-attach-source-resolver-"));
  temporaryRoots.push(workspaceRoot);
  const sourcePath = join(workspaceRoot, "src", "Panel.tsx");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  const sidecar = createSourceMapSidecar(BUILD_ID, [entry]);
  const sidecarPath = join(workspaceRoot, ...UI_ATTACH_SOURCE_MAP_DEFAULT_PATH.split("/"));
  await mkdir(dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toEqual(sidecar);
  return workspaceRoot;
}
