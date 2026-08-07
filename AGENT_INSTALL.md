# Install MeanThis With an Agent

This file is the deterministic setup contract for coding agents. MeanThis does not require a separate skill: install the browser extension, install the host-neutral CLI/MCP companion, register it with the user's MCP host, and verify the local bridge before asking the user to connect.

## Safety boundary

- The default MCP surface is read-only: `meanthis_list_captures`, `meanthis_read_capture`, and `meanthis_resolve_source`.
- Never paste a MeanThis connection request into a website, issue, log, or tracked file. It is a short-lived local capability.
- Do not approve a connection until the user has created the request on this device and explicitly asked you to connect.
- Browser extension installation or permission prompts require a visible user confirmation. Do not claim that they were completed silently.

## Install from this repository

Use this path until the first npm and Chrome Web Store releases are public:

```powershell
git clone https://github.com/oraclexing/meanthis.git
Set-Location meanthis
npm ci
```

For Codex, run:

```powershell
npm run setup:bridge:codex
meanthis bridge doctor --json
```

The setup command builds and links the CLI, backs up the Codex configuration before a real change, registers the MCP server as `meanthis`, safely removes an exact legacy `ui-attach` registration from the same installation, and starts and verifies the local bridge owner. A conflicting registration is never overwritten. While the MCP host process is active, an authenticated lease keeps the owner available and automatically recreates it after a loss; after all hosts exit, the owner still closes after 30 minutes without authenticated activity.

For Claude Code, VS Code, or Cursor, first build and link the companion, then generate the host-specific artifact:

```powershell
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

Apply only the artifact for the user's actual host, verify that the host lists a `meanthis` MCP server with the three default tools, and then run:

```powershell
meanthis bridge start --json
```

## Browser extension

Before the Chrome Web Store listing is public, use the reviewed extension artifact named by the project release instructions. Loading an unpacked build requires Chrome developer mode and a user confirmation. Once the store listing is public, open that listing and let the user confirm **Add to Chrome**. Agents must not substitute an unrelated unpacked or development build.

## Connect

1. Ask the user to open the MeanThis side panel and choose **Create & copy request**.
2. The user sends the complete `MeanThis Connection Request` to the agent on the same device.
3. Run the exact `meanthis bridge approve ... --json` command contained in that request only after the user explicitly asks to connect.
4. Confirm the result without repeating the approval key.
5. Discover captures with `meanthis_list_captures`, then request only the necessary detail with `meanthis_read_capture`. Use `meanthis_resolve_source` only when a capture contains a source anchor.

If the side panel reports that the local Agent connection failed, run `meanthis bridge doctor --json`. An active MCP host normally repairs the owner within 15 seconds; if the host has not started its MCP process, run `meanthis bridge start --json`, verify a successful result, and let the user retry. Do not ask the user to click repeatedly to bootstrap the runtime.

If `npm link` reports `EEXIST` for an old `ui-attach` shim, do not use `--force`. Inspect the shim and the package under `npm root --global`; only when both resolve to this exact checkout and the linked package now identifies itself as `@meanthis/cli`, run `npm unlink --global` with the exact legacy package name read from that package's metadata, then rerun setup. Leave any foreign installation untouched.

## After public package release

The repository installation can be replaced by the pinned public package version:

```powershell
npm install --global @meanthis/cli@0.1.0
meanthis bridge install --host codex --json
```

Pin an exact released version in automated setup. Do not infer package availability from this document; verify the release and package registry first.
