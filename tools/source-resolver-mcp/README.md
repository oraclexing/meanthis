# @meanthis/source-resolver-mcp

English | [中文](./README_zh.md)

> Status: public-package candidate included in the nine-package release set. It is mechanically pack-verified but has not been published.

This package is the minimal read-only MCP adapter for MeanThis Source Mapping v1. Its stdio server exposes exactly one tool, `ui_attach_resolve_source`, and delegates verification to `@meanthis/source-map-core`.

It does not start or contact the MeanThis browser bridge, read a browser credential, create an approval request, own loopback state, or expose click, type, navigate, script, file-write, or other browser-control capabilities. Use it when a coding agent needs only to turn an opaque source anchor from **Copy for Agent** into a locally verified repository-relative source location.

## Tool contract

Pass the complete object from the handoff's `Source Anchor Tool Input` block as the entire `ui_attach_resolve_source` input. Do not add a `resolverInput` or other wrapper. The adapter accepts one opaque `sourceAnchor` and at most five bounded heuristic `candidates`.

The standalone server prefers `file://` workspace roots declared by the MCP client. If the client does not implement the roots capability, it may use only the MCP process launch directory inherited from that client. Declared roots always take precedence, and tool input cannot override a workspace path. Library hosts that call `createSourceResolverMcpServer()` may instead inject a trusted `listWorkspaceRoots` provider; that host-owned seam takes precedence over client roots and is not used by the standalone CLI.

Only `verified` proves a source location. Zero verified matches, multiple verified matches, stale source bytes, malformed or unknown anchors, malformed sidecars, traversal, symlink escape, and paths outside the declared workspace fail closed as a non-verified result. Output contains repository-relative locations rather than absolute paths.

## Local use before publication

Until the first registry publication, use this public-package candidate from the repository checkout. The recommended Codex setup is one command:

```powershell
npm run setup:codex-source-resolver
```

It builds the minimal resolver workspace, resolves the current Node executable and built entry to absolute paths, backs up the active Codex config before a real registration change, calls Codex's own `mcp add`, and verifies the resulting readback. Repeating it is a no-op when the exact registration already exists. A same-name registration with a different command, entry, environment, working directory, an allow-list that omits `ui_attach_resolve_source`, or a deny-list that includes it fails closed and is never overwritten.

Inspect the current state without changing config, or preview an install action:

```powershell
npm run doctor:codex-source-resolver
npm run setup:codex-source-resolver -- --dry-run
```

To remove only the exact registration owned by this checkout, run `npm run remove:codex-source-resolver`. A real add or remove first copies `$CODEX_HOME/config.toml`—or `~/.codex/config.toml` when `CODEX_HOME` is unset—to a timestamped sibling backup. A backup failure prevents the mutation.

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

The existing `npm run setup:codex-bridge` path registers the public companion's three-tool `ui-attach` product MCP server, including `ui_attach_resolve_source` alongside progressive shared-capture reads. Maintainers can opt into four additional legacy diagnostics with `meanthis mcp --compatibility`. Choose the standalone resolver when source verification is the only required capability; choose the full bridge only when the separate, explicitly approved browser-capture workflow is also needed.

Neither setup path publishes a package. The resolver and companion are already part of the nine-package public release candidate and remain unavailable from the registry until an explicit publication occurs.

## Verification

From the repository root:

```powershell
npm --workspace @meanthis/source-resolver-mcp test
npm --workspace @meanthis/source-resolver-mcp run build
npm run doctor:codex-source-resolver
npm run verify:source-mapping-package-packs
```

The focused tests exercise the MCP client/server exchange, roots precedence and fallback, exact unwrapped input schema, unique verified resolution, fail-closed states, and the injected no-mutation registration-manager contract without starting the browser bridge. The package-pack verifier additionally installs the bounded package tarball into an offline consumer and drives its standalone stdio entry through a real MCP initialize, `roots/list`, and tool call. Doctor reads only the built-entry and exact Codex registration state.

After the absolute-path registration above points to the current build, maintainers can run the authenticated fresh-Codex canary:

```powershell
npm run verify:codex-source-resolver-canary -- --model gpt-5.6-terra --codex codex.exe
```

`--codex` selects the exact CLI binary under test. Confirm the client version in the receipt and pass an absolute path when a desktop-bundled CLI differs from the `codex.exe` found on `PATH`. Codex CLI `0.146.0-alpha.3.1` cannot combine `--ignore-user-config` with an injected MCP registration. The harness therefore does not pass that flag: it reads back the installed selected registration and the installed MCP inventory, requires absolute command and entry paths, replaces and disables every ambient registration for the child process, and runs a no-model inventory preflight that requires exactly `meanthis-source-resolver` to remain enabled. The model-backed task is ephemeral and read-only, ignores repository rules, disables shell, plugins, apps, memories, multi-agent, browser, computer-use, in-app-browser, image-generation, and web-search surfaces, and leaves deferred MCP discovery available for the selected server. It must make exactly one resolver call, perform zero other command or tool actions, and return the exact verified result. The latest commit-bound `gpt-5.6-terra` cohort made zero resolver calls in `0/3` repetitions but reported the unattempted state honestly in `3/3`; the earlier Round 94 observations remain Terra `3/5` and mini `1/2`. That is surface-specific capability variance, not a resolver failure or general model ranking. This authenticated manual canary is outside deterministic release gates; see the sanitized [Round 95 report](../../docs/dogfood/2026-07-31-source-resolution-handoff-semantics-round-95.md).
