# @meanthis/source-resolver-mcp

English | [中文](./README_zh.md)

> Status: public-package candidate included in the nine-package release set. It is mechanically pack-verified but has not been published.

This package is the minimal read-only MCP adapter for MeanThis Source Mapping v1. Its stdio server exposes exactly one tool, `meanthis_resolve_source`, and delegates verification to `@meanthis/source-map-core`.

It does not start or contact the MeanThis browser bridge, read a browser credential, create an approval request, own loopback state, or expose click, type, navigate, script, file-write, or other browser-control capabilities. Use it when a coding agent needs only to turn an opaque source anchor from **Copy for Agent** into a locally verified repository-relative source location.

## Tool contract

Pass the complete object from the handoff's `Source Anchor Tool Input` block as the entire `meanthis_resolve_source` input. Do not add a `resolverInput` or other wrapper. The adapter accepts one opaque `sourceAnchor` and at most five bounded heuristic `candidates`.

The standalone server prefers `file://` workspace roots declared by the MCP client. If the client does not implement the roots capability, it may use only the MCP process launch directory inherited from that client. Declared roots always take precedence, and tool input cannot override a workspace path. Library hosts that call `createSourceResolverMcpServer()` may instead inject a trusted `listWorkspaceRoots` provider; that host-owned seam takes precedence over client roots and is not used by the standalone CLI.

Only `verified` proves a source location. Zero verified matches, multiple verified matches, stale source bytes, malformed or unknown anchors, malformed sidecars, traversal, symlink escape, and paths outside the declared workspace fail closed as a non-verified result. Output contains repository-relative locations rather than absolute paths.

When a verified location includes `componentBreadcrumb`, it is same-file lexical evidence with `{ path, line, column, componentName }` frames ordered outer-to-inner and capped at the three most recent frames. It is returned only after current source bytes match the recorded hash; `candidate` and `unavailable` results omit it. It is not a React Fiber/runtime stack or cross-file inference, and the adapter never returns source text, `contentHash`, `workspaceRoot`, absolute paths, or browser/source write authority.

## Local use before publication

Until the first registry publication, use this public-package candidate from a checkout of this repository. Run the commands below from the repository root. The package is not available from the npm registry yet.

The package workspace provides the exact registration manager. After installing the checkout dependencies, build and install the standalone resolver for Codex with:

```powershell
npm ci
npm --workspace @meanthis/source-resolver-mcp run setup:codex
```

The command builds the resolver, resolves the current Node executable and built entry to absolute paths, backs up the active Codex config before a real registration change, calls Codex's own `mcp add`, and verifies the resulting readback. Repeating it is a no-op when the exact registration already exists. A same-name registration with a different command, entry, environment, working directory, an allow-list that omits `meanthis_resolve_source`, or a deny-list that includes it fails closed and is never overwritten.

Inspect the current state without changing config, or preview an install action:

```powershell
npm --workspace @meanthis/source-resolver-mcp run doctor:codex
npm --workspace @meanthis/source-resolver-mcp run setup:codex -- --dry-run
```

To remove only the exact registration owned by this checkout, run:

```powershell
npm --workspace @meanthis/source-resolver-mcp run remove:codex
```

A real add or remove first copies `$CODEX_HOME/config.toml`—or `~/.codex/config.toml` when `CODEX_HOME` is unset—to a timestamped sibling backup. A backup failure prevents the mutation.

The package binary is `meanthis-source-resolver`, and the recommended MCP registration name is also `meanthis-source-resolver`. For transparency, the manual equivalent of the install command is:

```powershell
npm ci
npm --workspace @meanthis/source-resolver-mcp run build
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$entry = (Resolve-Path ".\tools\source-resolver-mcp\dist\cli.js").Path
codex mcp add meanthis-source-resolver -- "$node" "$entry"
codex mcp get meanthis-source-resolver --json
```

Both the Node command and built entry are absolute in this registration. Start a fresh Codex task after changing registration because MCP discovery happens when the task starts. The manual removal equivalent is `codex mcp remove meanthis-source-resolver`.

The command runs a stdio server and intentionally has no interactive browser setup. Opening it directly in a terminal will wait for an MCP client on stdin/stdout.

## Full bridge compatibility

The public companion's `setup:bridge:codex` path registers the `meanthis` product MCP server with four read-only tools—`meanthis_list_captures`, metadata-only bounded `meanthis_wait_capture_change`, `meanthis_read_capture`, and `meanthis_resolve_source`—plus the narrow transient `meanthis_ack_capture_read` acknowledgement mutation. Choose the standalone resolver when source verification is the only required capability; choose the full bridge only when the separate, explicitly approved browser-capture workflow is also needed.

Neither setup path publishes a package. The resolver and companion are already part of the nine-package public release candidate and remain unavailable from the registry until an explicit publication occurs.

## Verification

From the repository root, run the focused workspace checks and then the public package verification:

```powershell
npm --workspace @meanthis/source-resolver-mcp test
npm --workspace @meanthis/source-resolver-mcp run build
npm run verify:packages
```

The focused tests exercise the MCP client/server exchange, roots precedence and fallback, exact unwrapped input schema, unique verified resolution, fail-closed states, and the injected no-mutation registration-manager contract without starting the browser bridge. The root package verification builds and pack-verifies the nine public workspaces in an isolated consumer. It does not publish a package, run an authenticated model canary, or prove a live Codex registration.
