# @meanthis/schema

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Shared UI attachment schema and validators for MeanThis integrations. The contract covers selected-element facts, locator candidates and stability, replay metadata, disclosure policy, artifacts, and the bounded local-bridge wire format.

An attachment that selects an `iframe` host can include an optional `boundary` object. `innerDom: "not_captured"` makes the limitation machine-readable; `frameOrigin` is either a canonical HTTP(S) origin with no path, query, fragment, or credentials, or `null`; optional `framePathname` is a canonical pathname with query and fragment removed; and `dominantViewport` reports whether the visible frame covers most of the viewport. This describes only the frame host and never claims that the embedded document was inspected. Legacy boundaries without `framePathname` remain valid, but exact frame selection requires a newly captured route.

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
