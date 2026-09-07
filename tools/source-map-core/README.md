# @meanthis/source-map-core

[English](./README.md) | [中文](./README_zh.md)

Trusted local validation and resolution for MeanThis Source Mapping v1.

> Status: public-package candidate included in the nine-package release set. It is mechanically pack-verified but has not been published.

The resolver treats every page-provided anchor as untrusted routing data. It reads only the canonical `.ui-attach/source-map.json` sidecar beneath a declared local workspace, rejects traversal and symlink escapes, bounds file sizes, and verifies the current source bytes against the recorded SHA-256 hash. Successful output contains only a repository-relative location; the verification hash remains internal.

Verified locations preserve the sidecar entry kind. An intrinsic location contains `tagName`; an explicitly configured JSX host-component callsite instead contains `callsiteKind: "configured_jsx_component"` and its local JSX `callsiteName`, with no invented DOM tag. The latter proves the recorded source callsite and current source bytes only. It does not prove that the component forwarded the separate opaque callsite attributes at runtime, and it does not expose the producer's configured module specifier or export identity.

## Verified lexical component breadcrumbs

A verified location may also contain `componentBreadcrumb`, a same-file lexical breadcrumb of `{ path, line, column, componentName }` frames ordered outer-to-inner and retaining at most the three most recent frames. It is emitted only after the current source bytes match the entry's recorded hash. This is lexical source evidence, not a React Fiber or runtime stack and never an inference across files. `candidate` and `unavailable` results omit the breadcrumb. The response never includes source text, `contentHash`, `workspaceRoot`, absolute paths, or browser/source write authority.

`resolveUIAttachSourceAcrossWorkspaces` requires one unique verified match across the supplied workspace roots. Zero matches, multiple matches, stale source bytes, malformed sidecars, unknown IDs, and out-of-workspace paths return an explicit non-verified result. Bounded heuristic candidates remain `candidate`; confidence alone never upgrades them to `verified`.

The separate public-package candidate `@meanthis/source-resolver-mcp` exposes this core as the read-only `meanthis_resolve_source` tool. It obtains roots from the MCP client's `roots/list` response. If the client does not implement roots, it may use only the launch directory inherited by the MCP process; explicit roots always take precedence. Tool input does not accept a workspace-path override. The public `@meanthis/cli` companion composes the same adapter into a product surface with four read-only tools—`meanthis_list_captures`, metadata-only bounded `meanthis_wait_capture_change`, `meanthis_read_capture`, and `meanthis_resolve_source`—plus the narrow transient `meanthis_ack_capture_read` acknowledgement mutation; maintainer-only legacy diagnostics require explicit compatibility mode.

## Verification

From the repository root, run the focused workspace checks and then the public package verification:

```powershell
npm --workspace @meanthis/source-map-core test
npm --workspace @meanthis/source-map-core run build
npm run verify:packages
```

The focused tests exercise source-map sidecar validation, traversal and symlink boundaries, stale-byte rejection, unique verified resolution, and the opaque-output boundary. The root package verification builds and pack-verifies the nine public workspaces in an isolated consumer. It does not execute the excluded private Vite producer, publish anything, or prove a live source-map integration.
