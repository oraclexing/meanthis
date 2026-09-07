# MeanThis Companion

English | [中文](./README_zh.md)

`@meanthis/cli` is the optional local companion for the MeanThis browser extension. It exposes explicitly authorized, Agent-safe captures to local agents through four read-only MCP tools plus one narrow transient read-acknowledgement mutation. It does not control the browser, click, type, edit source files, or send captures to a hosted MeanThis service.

## Install

Requires Node.js `^22.12.0` or `^24.0.0`.

`0.1.0` is still unpublished. From this checkout:

```sh
npm ci
npm run build:bridge
npm link --workspace @meanthis/cli
```

After the package is published, the intended equivalent is:

```sh
npm install --global @meanthis/cli
```

## Thin stdio brokers, one shared HTTP owner

The default `meanthis` registration starts one thin stdio broker for each Agent task. The registration contains only an absolute Node executable and the built `local-bridge-mcp-stdio-broker.js` entry; it has no environment override, working directory, or token. At startup the broker reads and validates the protected profile credential, authenticates the detached HTTP owner at `127.0.0.1:38472` through fresh nonce/timestamp request-and-response HMAC proofs without sending the raw token, and only then holds the Bearer credential in memory for the fixed `/mcp` connection. The broker transparently forwards client capabilities, server requests such as `roots/list`, and all MCP traffic. Every broker receives an independent HTTP session and independent workspace roots; one task cannot borrow another task's roots. The daemon never falls back to its working directory, so source resolution without declared roots fails closed. Lower-level `ui-attach.*` schema kinds remain stable compatibility identifiers and do not make the server Codex-only.

Codex is the first automated adapter because its CLI supports structured registration readback and exact removal:

```sh
meanthis bridge install --host codex --json
meanthis bridge install-native-host --json
meanthis bridge doctor --json
meanthis bridge start --json
# Fully close and reopen the affected Codex task or host.
```

`install` registers the absolute Node-plus-broker stdio command, starts or reuses both detached owners, and verifies exact structured readback with empty `env`, `env_vars`, and `cwd`. It removes only exact managed legacy `ui-attach`, direct-HTTP `meanthis`, full-stdio `meanthis`, and standalone `meanthis-source-resolver` registrations from the same installation; it never overwrites a foreign or conflicting registration. `doctor` is read-only and includes `checks.agentCredential`. `start` creates missing credentials or validates secure credentials and starts or reuses both exact-build owners without changing host configuration; normal start and credential-load paths never reuse or repair an insecure `bridge-agent-key-v2`. After install, system restart, or credential rotation, fully restart the affected task or host so it starts a new broker. Do not use `bridge launch`: packaged Codex Desktop cannot reliably receive per-launch environment injection, and the command now fails safely with `HOST_LAUNCH_UNSUPPORTED`.

If `127.0.0.1:38472` is occupied by a listener that cannot complete the authenticated health proof, `doctor` reports `unverified_listener` and `start` or `install` fails with `MCP_HTTP_UNVERIFIED_LISTENER`. MeanThis does not identify that listener as its own process, send it a Bearer credential, or kill it automatically. Manually identify the process, confirm that it is safe to stop, stop it, and then run `meanthis bridge start --json`. An HMAC-valid listener from the older foreground lifecycle remains a separate `legacy_foreground` state.

`meanthis bridge install --host codex --dry-run --json` is the zero-mutation CLI preview: it creates no credential, starts no owner, and changes no configuration. That guarantee does not cover the checkout-level `npm run setup:bridge:codex` wrapper, which builds and links the CLI before it invokes the install command; those build/link side effects remain if the later registration preflight fails closed.

The checkout-level setup wrapper also runs `install-native-host`, installing the current-user Chrome/Edge Native Messaging registration used by **Create invitation**. The extension itself never writes the registry.

Use `rotate-agent-token` only when `doctor` reports `bridge-agent-key-v2` as `insecure` because of ACL drift, or when that Agent credential may have been exposed. Under the existing profile transition lock, it rotates the MCP HTTP bearer first and the Agent token second, ensuring turnover of both the HTTP owner and browser owner:

```sh
meanthis bridge rotate-agent-token --host codex --json
# Fully close and reopen the affected Agent task or host when directed.
```

With a current registration, it restarts and verifies both owners, then requires affected tasks or hosts to restart. With a missing or managed legacy registration, secure readback is followed by publishing the A2-bound desired marker and starting or turning over and verifying the browser owner. It does not start the MCP HTTP owner or claim the complete MCP runtime; it reports `runtimeActive:false`, `browserOwnerActive:true`, and install as the next step. Marker-aware builds turn over automatically from their first supported build. A much older browser owner that does not recognize the desired-marker protocol may not exit; the CLI then fails closed and directs the user to stop the old process occupying `127.0.0.1:38471` before retrying. A drifted registration fails closed. Partial or committed-but-unverified results are reported honestly without tokens, credential paths, or underlying error causes.

If the separate MCP HTTP credential inspection reports `rotation_required`, this narrower command rotates only that bearer. Before the current broker registration exists it does not start owners or claim runtime readiness, and directs you to install next. After any successful rotation, fully restart affected tasks or hosts so their brokers reread the credentials:

```sh
meanthis bridge rotate-mcp-token --host codex --json
# Fully close and reopen the affected Agent task or host.
```

The older `meanthis bridge install --codex --json` command remains compatible. For other hosts, MeanThis returns the manual stdio command and argument without modifying the host:

```sh
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

Run `meanthis bridge start --json`, configure the returned absolute Node command with its single broker-entry argument, then fully restart that host. Generated metadata contains no environment, working directory, or token.

| Host | Generated setup | Automatic verification |
| --- | --- | --- |
| Codex | Stdio `codex mcp add` with absolute Node plus broker entry | Yes: structured exact readback |
| Claude Code | Manual stdio command and argument | No: configure and verify in Claude Code |
| VS Code | Manual stdio command and argument | No: configure and verify in VS Code |
| Cursor | Manual stdio command and argument | No: configure and verify in Cursor |

The JSON output contains the stdio-broker descriptor and host-specific setup metadata. Codex commands are returned as executable-plus-argv data rather than a shell-quoted string. The other adapters are metadata-only and do not claim that the host has been configured.

After the fresh agent host starts, open MeanThis, choose the access scope, and select **Create & copy invitation**. Paste the copied one-line `meanthis bridge accept <connection-code> --json` command only into the intended local agent conversation. The 68-character versioned alphanumeric connection code packages the request ID, selected mode, and 32-byte approval key without Markdown-sensitive punctuation; treat the entire code as the short-lived local capability. A successful acceptance returns an exact machine-readable next action for capture discovery. No expanded or legacy acceptance syntax is supported.

## Default MCP surface

The default broker-backed `meanthis` registration exposes four read-only tools plus one narrow transient acknowledgement mutation:

- `meanthis_list_captures` lists bounded page identity and capture metadata for the MeanThis-selected scope explicitly shared after connection. A `focusedContexts` entry carries `focusKind: "meanthis_shared_scope"`; it is not an operating-system foreground-tab signal. It can identify the exact sanitized scope before any targets are selected, without enumerating unrelated browser tabs or disclosing element text, task-note text, locators, or handoff content. `captureTitle` and `captureUpdatedAt` describe only the optional capture. There is no additional Capture or Share action. Structured state and `nextAction` fields distinguish no connection, a shared page with no selected targets, multiple captures, and a directly readable capture. Capture metadata includes only the task-note count, not the note text; for one capture, `nextAction` recommends `detail: "agent_context"` when at least one task note exists and otherwise recommends `summary`.
- `meanthis_wait_capture_change` accepts one exact `instanceId`, `captureId`, and `afterSequence`, plus an optional `timeoutMs` that defaults to `20,000` and cannot exceed `25,000` milliseconds, leaving headroom under the 30-second HTTP request timeout. It performs only bounded polling through the existing `LocalBridgeReader`. Its result contains capture identity, `previousSequence`, `currentSequence`, `changed`, `timedOut`, `state`, and an all-false `executionAuthority`; after a change, its exact `nextAction` is `meanthis_read_capture` with `detail: "summary"`. It never returns task, element, locator, context, or handoff content and grants no browser control. A stale or replaced capture, or any sequence regression, fails closed and requires `meanthis_list_captures` again.
- `meanthis_read_capture` reads one exact capture revision as `summary`, `content`, `task`, `agent_context`, `locator`, `visual`, capture-level `diagnostics`, legacy `context`, or canonical `handoff`. `agent_context` is the fast path for requested work: after validating the exact snapshot sequence, it returns each task note with minimal element identity, `grounding.recommendedLocator`, frame boundary, bounded visual facts, and `grounding.sourceResolution` resolved read-only against that client's declared workspace roots. Resolution failure stays explicit and fail-closed inside that target instead of discarding the capture read. It omits raw content, screenshot artifacts, source bytes, hashes, and absolute workspace paths. Standalone `task`, `locator`, `visual`, and `meanthis_resolve_source` reads remain available for progressive inspection or retry. `diagnostics` is whole-capture only: it currently returns bounded replay attempt/verified/ambiguous/missing counts derived from replay facts already present in the explicit capture. A legacy capture with no diagnostics projection returns `null`; unavailable, malformed, or overbound replay facts remain a non-null sidecar with the corresponding `replay.status`. It never returns raw locator or failure strings; device, network, and console remain `not_requested`, and all execution-authority fields remain false. Discovery exposes only `metadataDiagnosticsVersion: "v1"`, not the counters. A task read pairs each note with minimal element identity, `grounding.recommendedLocator`, the opaque source anchor, and frame boundary; it does not include raw content or style. A content read returns `partsSource: "captured"` whenever the page capture recorded the `contentParts` field, including an intentionally empty array, or `"legacy_fallback"` only when that field is absent and the reader synthesized one compatibility part. Prefer capture-scoped `targetIds` such as `target_C` when selecting A-Z targets; `attachmentIds` remain compatible. Every read states `targetIdScope: "capture"` and the no-execution-authority boundary. A task note is requested work, but the capture grants no browser-control or live-DOM execution authority.
- Every successful `meanthis_read_capture` response returns an exact `nextAction` for `meanthis_ack_capture_read` plus the equivalent `meanthis capture ack ... --json` argv. The acknowledgement binds the exact `instanceId`, `captureId`, snapshot sequence, and read detail. It records only that the Agent client confirmed retrieval of that version; it does not prove model attention, understanding, task creation, or downstream execution. Repeating the same exact input is idempotent. A new sequence, clear, disconnect, or owner restart removes it. The acknowledgement is transient owner memory and grants no browser, DOM, source, cloud, reply, thread, or task authority.
- A canonical whole-capture `handoff` read may explicitly set `includeReadReceipt: true`. The inline `ui-attach.mcp-read-receipt` binds the exact returned UTF-8 handoff bytes and exact instance/capture/sequence/detail with SHA-256. It is response-only and not persisted. `returned_to_mcp_client` means only that the MCP response contains the receipt; the fixed limitations state that this does not prove model attention, task creation, or downstream execution.
- Every target in the canonical read views also carries `annotationIdentity`. Current extension sessions expose an opaque `annotationId` with `annotationIdScope: "capture_session"` and its creation/update timestamps; exact legacy sessions and old cached bridge snapshots normalize to explicit `null`/`unknown` fields. The annotation ID is a read-only correlation handle, not a selector or capability. It does not replace `targetId`, bypass `expectedSequence`, or authorize reply, resolve, edit, delete, browser control, or source writes.
- `meanthis_resolve_source` resolves an opaque source anchor against trusted local sidecars under that client's MCP workspace roots. The shared HTTP owner has no daemon working-directory fallback.

Repeated bounded waits can form a low-privilege change-watch, but this is not an Agentation-style thread/reply/resolve workflow or an event stream.

## User-approved annotation lifecycle proposals

The four discovery/read/wait/source tools remain read-only; `meanthis_ack_capture_read` is limited to transient read-confirmation state. A local Agent may separately submit one exact `open -> resolved` or `resolved -> open` proposal through the control CLI:

```text
meanthis control submit --instance <instance-id> --capture <capture-id> --sequence <n> --annotation <annotation-id> --expected <open|resolved> --next <open|resolved> [--operation <uuid>] --json
meanthis control status --operation <uuid> --fingerprint <sha256> --owner-generation <n> --connection-generation <n> --json
```

`submit` only creates a proposal bound to the exact instance, capture, sequence, annotation, expected state, next state, operation ID, fingerprint, Owner generation, and connection generation returned by the control owner. It does not mutate the annotation. MeanThis must show that exact proposal in the browser widget, and only a trusted user click on its exact **Approve** action may claim it. Missing, stale, mismatched, expired, replaced, or already-claimed authority fails closed.

After approval, the extension persists and reads back the canonical lifecycle state and durable operation ledger, then publishes a new Bridge snapshot. The Owner accepts terminal success only when the durable receipt and the current snapshot agree on the exact annotation, next state, sequence advance, and observed time. The Agent must then run `meanthis capture list --json` (or `meanthis_list_captures`) and read the returned new exact sequence. The control path grants no browser control, DOM mutation, source-write, cloud-send, reply, thread, or general edit/delete authority; every later lifecycle transition requires another exact visible approval.

The former direct-HTTP registration, `meanthis mcp` full stdio entry, and standalone `meanthis-source-resolver` registration remain compatibility or migration paths. Maintainer-only legacy diagnostics require the explicit `meanthis mcp --compatibility` flag. None is part of the recommended default architecture, and current install removes the exact managed standalone resolver.

One direct-HTTP compatibility limitation remains in `@modelcontextprotocol/sdk` 1.29: cancelling the first nested server request, whose numeric request ID is `0`, can leave its client-side handler retained until the client or session closes. The default thin broker avoids that ID-specific SDK behavior with bidirectional truthy request-ID aliases. Meanwhile, the HTTP daemon's corresponding POST and session-accounting slots already reach terminal cleanup; the retained object is limited to the direct client's handler.

Raw direct-HTTP clients also have a cancellation boundary: after cancelling an outer JSON-RPC request whose ID is `0` or `""`, they must not reuse that same ID in the same authenticated session. A direct client must likewise never construct an unknown or already-completed cancellation carrying MeanThis's internal control header; otherwise its cancellation intent can consume a later request that reuses the same ID in that session. The control header is an internal thin-broker contract, not a direct-client API. The recommended default broker avoids both cases through its truthy ID aliases and internal control-lane lifecycle.

If the current agent task cannot call the registered MCP tools directly, use the host-neutral fallback. It uses the same discovery and progressive-read implementation rather than a second protocol:

```text
meanthis capture list --json
meanthis capture read --instance <instance-id> --capture <capture-id> --sequence <n> --detail content --target target_C --json
meanthis capture read --instance <instance-id> --capture <capture-id> --sequence <n> --detail agent_context --target target_C --json
meanthis capture ack --instance <instance-id> --capture <capture-id> --sequence <n> --detail agent_context --json
```

The acceptance result and every directly readable capture-list result provide the exact executable-plus-argv continuation, so an Agent does not need to construct raw MCP JSON-RPC.

For `agent_context` through this CLI fallback, the invocation working directory is the only trusted source-resolution root. Run the returned command from the intended project root; a missing, unrelated, ambiguous, or stale sidecar remains an explicit unavailable result.

Capture-session file and stdin inputs are limited to 1 MiB before JSON parsing. A `bundle --intent-file` input is limited to 256 KiB.

## Trust and privacy

Both detached owners bind only to `127.0.0.1`: the browser owner on `38471` and MCP HTTP owner on `38472`. The broker validates the protected credential on every start, probes `/health` with fresh nonce/timestamp request-and-response HMAC proofs that disclose no raw token, and sends the Bearer credential to fixed `/mcp` only after that owner check. The host never receives the token, but the broker necessarily holds it in process memory. It persists no capture, MCP session, or token; stdio EOF or termination first requests immediate HTTP-session deletion and ends the broker; if that DELETE or the daemon is unavailable, the daemon's bounded disconnected-grace/idle cleanup reclaims the retained session. If the verified owner later dies and another local process takes the fixed port before an existing broker reconnects, that process could receive the Bearer credential; v1 has no TLS or channel binding. The credential remains a same-user, local-process capability for Agent-safe read-only context and grants no click, type, navigation, script execution, source editing, or browser control. The browser bridge is disconnected by default and requires an explicit browser gesture plus a short-lived local invitation accepted by the intended agent. Its default public path accepts only Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`; no runtime or environment override is exposed. The browser extension requests its optional loopback host permission only when the user creates a connection invitation. Credentials and invitation material must stay on the same device and must not be pasted into a webpage, public issue, log, or committed file.

See the repository [Privacy Notice](../../PRIVACY.md) and [Security Policy](../../SECURITY.md) for the complete boundary.

## Status

`0.1.0` is an unpublished candidate. The package metadata and local/cache-preferred pack checks prepare a public install path but do not publish the package; because they use `--prefer-offline` rather than `--offline`, npm may still access the configured registry when required.
