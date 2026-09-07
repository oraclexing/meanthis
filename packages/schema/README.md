# @meanthis/schema

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Shared UI attachment schema and validators for MeanThis integrations. The contract covers selected-element facts, locator candidates and stability, replay metadata, disclosure policy, artifacts, and the bounded local-bridge wire format.

Pointer-based selections may include an optional `selectionPoint` with bounded element-relative `xRatio` and `yRatio` values. It records where the user selected the element without retaining mutable viewport coordinates. Keyboard or programmatic selections omit this field instead of inventing a pointer position.

An attachment that selects an `iframe` host can include an optional `boundary` object. `innerDom: "not_captured"` makes the limitation machine-readable; `frameOrigin` is either a canonical HTTP(S) origin with no path, query, fragment, or credentials, or `null`; optional `framePathname` is a canonical pathname with query and fragment removed; and `dominantViewport` reports whether the visible frame covers most of the viewport. This describes only the frame host and never claims that the embedded document was inspected. Legacy boundaries without `framePathname` remain valid, but exact frame selection requires a newly captured route.

## Private troubleshooting summary

`projectPrivateDebugSummaryV1` converts one valid, explicit capture-time `MetadataDiagnosticsV1` sidecar into a `PrivateDebugSummaryV1` allowlist projection. The projection retains only bounded replay-result counts, coarse device/viewport/touch classes, one-shot consent, and an all-false execution-authority record. It deliberately omits capture identity, timestamps, page identity or content, locators, network/console fields, exact dimensions, and user agent. Collected network or console diagnostics and non-capture-time authority fail closed.

`validatePrivateDebugSummaryV1`, `serializePrivateDebugSummaryV1`, and `parsePrivateDebugSummaryV1` enforce exact keys, descriptor-only data properties, bounded canonical JSON, and the same replay/device invariants as the source sidecar. The schema does not copy, upload, download, or grant browser control; a host must expose any clipboard action as a separate explicit user gesture.

## Experimental opaque source anchors

An attachment may contain `sourceAnchor`, whose `buildId` and `sourceId` are exact 43-character base64url identifiers. The anchor is untrusted page data: it contains no repository path or line number and does not claim that a source location has been verified. A local source-map resolver must match it against a trusted sidecar before exposing workspace files.

## Saved snapshot control policy

`evaluateSavedSnapshotControlPolicy` is a pure, fail-closed consumer guard for the `ui-attach.saved-snapshot-authority` contract. The trusted host supplies an explicit `controlAttemptId`, the exact attachment IDs derived from the same accepted saved bundle as `authority`, an externally produced live-recheck receipt, an explicit human-confirmation receipt, and the current `evaluatedAt` from its own trusted clock. The guard requires exact origin, attempt, receipt, target-set, ordering, and freshness bindings; every target must be a unique live match, and a recheck validity window cannot exceed 60 seconds.

```ts
import { evaluateSavedSnapshotControlPolicy } from "@meanthis/schema";

const decision = evaluateSavedSnapshotControlPolicy({
  authority: savedBundle.authority,
  expectedAttachmentIds: ["att_save"],
  controlAttemptId,
  liveRecheck,
  userConfirmation,
  evaluatedAt,
});
```

An `allowed: true` decision means only that the supplied objects structurally satisfy this bounded policy. The guard does not inspect a DOM, select a tab, replay a locator, perform browser control, authenticate the receipt issuer, prove that a recheck really occurred, or verify that a caller supplied the real current time. The host remains responsible for deriving attachment IDs from that same bundle, supplying its trusted current time, trusting the receipt producer, and constraining any later action. Model prose, a generic boolean, prior chat history, another artifact's target IDs, and local-bridge state are not confirmation or live-recheck authority.

See the runnable, non-controlling [saved-snapshot trusted-host example](../../examples/saved-snapshot-trusted-host/README.md) for same-bundle derivation, monotonic host-clock injection, and fail-closed external issuer sequencing.

## Local bridge MCP read receipt

`parseLocalBridgeMcpReadReceipt` and `isLocalBridgeMcpReadReceipt` validate the optional, response-only receipt returned by an explicit canonical-handoff MCP read. The receipt binds the exact UTF-8 handoff bytes plus the exact instance, capture, snapshot sequence, and `handoff` detail through a lowercase SHA-256 digest. Its `returned_to_mcp_client` status describes only the response containing the receipt; the fixed limitations state that it does not prove model attention, task creation, or downstream execution. It is not persisted and grants no browser-control or live-DOM authority.

## Install

```bash
npm install @meanthis/schema
```

## Example

```ts
import { createAttachmentId, isUIAttachment } from "@meanthis/schema";

const id = createAttachmentId("checkout-submit");
if (isUIAttachment(value)) {
  console.log(id, value.locatorBundle.primary);
}
```
