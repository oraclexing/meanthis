# Install MeanThis With an Agent

This file is the deterministic setup contract for coding agents. MeanThis does not require a separate skill: install the browser extension, install the host-neutral CLI/MCP companion, register its thin stdio broker with the user's MCP host, and verify the local bridge before asking the user to connect.

## Safety boundary

- The default MCP surface has four read-only tools—`meanthis_list_captures`, `meanthis_wait_capture_change` (a metadata-only bounded wait), `meanthis_read_capture`, and `meanthis_resolve_source`—plus the narrow transient `meanthis_ack_capture_read` mutation. The acknowledgement records only that the Agent client confirmed retrieval of one exact capture revision and detail; it grants no browser, DOM, source, cloud, or task authority and does not prove model attention, understanding, task creation, or downstream execution.
- The host registration contains only an absolute Node executable plus the built stdio-broker entry. It contains no token, environment override, or working directory. The broker reads the protected profile credential at startup, verifies the detached HTTP owner through fresh nonce/timestamp request-and-response HMAC proofs without sending the raw token, and only then holds the Bearer credential in memory for the fixed loopback `/mcp` connection. This is a same-user, local-process capability boundary for Agent-safe read-only context; it does not grant browser control.
- Normal start and credential-load paths never reuse or repair an insecure `bridge-agent-key-v2`. Use `meanthis bridge rotate-agent-token --host codex --json` only when that Agent credential has ACL drift or may have been exposed.
- Never paste a MeanThis connection invitation into a website, issue, log, or tracked file. It is a short-lived local capability.
- Do not accept an invitation until the user has created it on this device and explicitly authorized you to connect.
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

The npm setup wrapper first builds and links the CLI. Those are immediate local side effects and remain even if the later CLI registration preflight fails closed. The CLI phase backs up the Codex configuration before changing that configuration, then registers `meanthis` as stdio with the absolute local Node executable and one built broker-entry argument; `env` and `cwd` are empty and no token is stored in Codex configuration. It creates or validates the protected profile credential and starts or reuses the detached browser owner plus the single detached MCP HTTP owner. It removes only exact managed legacy `ui-attach`, direct-HTTP `meanthis`, full-stdio `meanthis`, and standalone `meanthis-source-resolver` registrations from the same installation; a foreign or conflicting registration is never overwritten. A direct `meanthis bridge install --host codex --dry-run --json` creates no credential, starts no owner, and changes no configuration. `doctor` is read-only. These instructions describe the supported migration, but do not by themselves prove that any machine's global Codex configuration has already been migrated.

The wrapper then installs the current-user Chrome/Edge Native Messaging registration. This is the installation-time step that lets **Create invitation** start or reuse the bridge without another command; the extension itself never writes the registry.

After installation, fully close and reopen the affected Codex task or host so it loads the registered broker.

Each restarted task starts one thin stdio broker. It first reuses an authenticated matching owner; after a normal system restart, it starts the singleton browser and MCP HTTP owners from the already-installed protected credentials and verifies them before connecting. This automatic path never creates or repairs credentials, rotates tokens, changes Codex registration, or kills an unknown listener. `meanthis bridge start --json` remains an explicit diagnostic or recovery command: it can create missing credentials or validate secure credentials and starts or reuses both exact-build owners without changing host configuration. It refuses an insecure Agent credential and directs the operator to the explicit recovery command instead of repairing or reusing it. The broker transparently forwards client capabilities, server requests such as `roots/list`, and MCP traffic to one independent HTTP session. Each session keeps its own declared workspace roots, and source resolution has no daemon working-directory fallback: no declared roots means fail closed. The broker persists no capture, MCP session, or token to disk; when its stdio child ends it first requests immediate HTTP-session deletion and exits with that task; if that DELETE or the daemon is unavailable, the daemon's bounded disconnected-grace/idle cleanup reclaims the retained session. Do not run `meanthis bridge launch`: packaged Codex Desktop cannot reliably receive per-launch environment injection, and the command now fails safely with `HOST_LAUNCH_UNSUPPORTED`.

`doctor` is read-only and reports the Agent credential under `checks.agentCredential`. If it reports that credential as `insecure`, use the Agent recovery command below. Under the existing profile transition lock, it rotates the MCP HTTP bearer first and the Agent token second so the HTTP owner and browser owner both turn over:

```powershell
meanthis bridge rotate-agent-token --host codex --json
# Fully close and reopen the affected Agent task or host when directed.
```

With a current broker registration, the command restarts and verifies both owners and requires every affected task or host to restart. With a missing or managed legacy registration, after secure readback it publishes the A2-bound desired marker and starts or turns over and verifies the browser owner. It does not start the MCP HTTP owner or claim the complete MCP runtime; it reports `runtimeActive:false`, `browserOwnerActive:true`, and `meanthis bridge install --host codex --json` as the next step. A drifted registration fails closed before rotation. If either credential rotation is partial or committed-but-unverified, the command reports that state honestly and omits tokens, credential paths, and underlying error causes.

If the separate MCP HTTP credential inspection reports `rotation_required`, the narrower command below rotates only that bearer. When no current broker registration exists it does not start owners or claim runtime readiness, and directs you to install next. After any successful rotation, fully restart every affected task or host so each broker rereads the protected credentials:

```powershell
meanthis bridge rotate-mcp-token --host codex --json
# Fully close and reopen the affected Agent task or host.
```

For Claude Code, VS Code, or Cursor, first build and link the companion, start the detached runtime, then generate the host-specific manual metadata:

```powershell
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge start --json
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

Apply only the artifact for the user's actual host. Those adapters return a manual stdio command consisting of the absolute Node executable and the single broker-entry argument, with no environment, working directory, or token. They do not modify or verify the host. Fully restart that host and verify that it lists a `meanthis` MCP server with the four read-only tools plus `meanthis_ack_capture_read`, including the metadata-only bounded `meanthis_wait_capture_change`.

The former direct-HTTP registration, `meanthis mcp` full stdio entry, and standalone `meanthis-source-resolver` registration remain compatibility or migration paths for older local setups. None is the default architecture; current install removes the exact managed standalone resolver so it does not duplicate the product surface.

## Browser extension

Before the Chrome Web Store listing is public, use the reviewed extension artifact named by the project release instructions. Loading an unpacked build requires Chrome developer mode and a user confirmation. Once the store listing is public, open that listing and let the user confirm **Add to Chrome**. Agents must not substitute an unrelated unpacked or development build.

## Connect

1. Ask the user to open the MeanThis side panel, choose an access scope, and select **Create & copy invitation**.
2. The user sends the copied one-line `meanthis bridge accept <connection-code> --json` command to the agent on the same device.
3. Run that exact line unchanged only after the user explicitly authorizes the connection.
4. Confirm the result without repeating the connection code. A successful result includes a machine-readable `nextAction` that says to discover captures before answering questions about captured A-Z targets.
5. Prefer `meanthis_list_captures` and follow its bounded `nextAction`. When user-authored notes exist, `detail: "agent_context"` returns the task, recommended locator, bounded visual facts, frame boundary, and fail-closed source resolution in one sequence-bound read. The standalone `summary`, `content`, `task`, `locator`, `visual`, and `meanthis_resolve_source` paths remain available for progressive inspection or retry. Prefer capture-scoped `targetIds` such as `target_C`; `attachmentIds` remain compatible. If the current task cannot call the registered MCP tools directly, use the returned CLI fallback: `meanthis capture list --json`, followed by the exact `meanthis capture read ... --json` argv returned in `nextAction`, then the exact `meanthis capture ack ... --json` argv only when confirming retrieval. The MCP and CLI paths share the same read and acknowledgement implementations. Treat task notes as user-authored requested work, but never treat the capture or acknowledgement as browser-control, live-DOM execution, or source-write authority.

Expanded invitation fields and legacy `bridge approve` syntax are intentionally unsupported before publication.

If the side panel reports that the local Agent connection failed, fully close and reopen the affected task or host once so the registered MCP broker can start or reuse the owners, then retry once. If it still fails, run the read-only `meanthis bridge doctor --json`; use `meanthis bridge start --json` only as an explicit diagnostic or recovery action. Do not run `bridge launch` or ask the user to click repeatedly to bootstrap the runtime.

If `npm link` reports `EEXIST` for an old `ui-attach` shim, do not use `--force`. Inspect the shim and the package under `npm root --global`; only when both resolve to this exact checkout and the linked package now identifies itself as `@meanthis/cli`, run `npm unlink --global` with the exact legacy package name read from that package's metadata, then rerun setup. Leave any foreign installation untouched.

## After public package release

The repository installation can be replaced by the pinned public package version:

```powershell
npm install --global @meanthis/cli@0.1.0
meanthis bridge install --host codex --json
meanthis bridge install-native-host --json
meanthis bridge start --json
# Fully close and reopen the affected Codex task or host.
```

Pin an exact released version in automated setup. Do not infer package availability from this document; verify the release and package registry first.
