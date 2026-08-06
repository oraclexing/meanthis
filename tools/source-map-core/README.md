# @meanthis/source-map-core

[English](./README.md) | [中文](./README_zh.md)

Trusted local validation and resolution for MeanThis Source Mapping v1.

> Status: public-package candidate included in the nine-package release set. It is mechanically pack-verified but has not been published.

The resolver treats every page-provided anchor as untrusted routing data. It reads only the canonical `.ui-attach/source-map.json` sidecar beneath a declared local workspace, rejects traversal and symlink escapes, bounds file sizes, and verifies the current source bytes against the recorded SHA-256 hash. Successful output contains only a repository-relative location; the verification hash remains internal.

`resolveUIAttachSourceAcrossWorkspaces` requires one unique verified match across the supplied workspace roots. Zero matches, multiple matches, stale source bytes, malformed sidecars, unknown IDs, and out-of-workspace paths return an explicit non-verified result. Bounded heuristic candidates remain `candidate`; confidence alone never upgrades them to `verified`.

The separate public-package candidate `@meanthis/source-resolver-mcp` exposes this core as the read-only `ui_attach_resolve_source` tool. It obtains roots from the MCP client's `roots/list` response. If the client does not implement roots, it may use only the launch directory inherited by the MCP process; explicit roots always take precedence. Tool input does not accept a workspace-path override. The public `@meanthis/cli` companion composes the same adapter into its three-tool product surface; maintainer-only legacy diagnostics require explicit compatibility mode.

From the repository root, `npm run verify:source-mapping-package-packs` packs this core, the minimal MCP adapter, the private Vite producer, and their public schema dependency; installs those exact tarballs into an isolated offline consumer; and verifies the standalone MCP exchange, source maps, types, runtime imports, a real Vite build, and the opaque-output boundary. The check establishes package readiness only: it publishes nothing, and the Vite producer remains outside the public release set.
