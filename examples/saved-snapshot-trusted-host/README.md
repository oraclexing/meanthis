# Saved Snapshot Trusted-Host Example

English | [中文](./README_zh.md)

This is executable public reference code for integrating `@meanthis/schema` without turning MeanThis into a browser-control executor. It is not an npm package, connector, or action API.

## What it demonstrates

`evaluateAcceptedSavedSnapshotWithTrustedHost` accepts one production `ui-attach.saved-snapshot-prompt-bundle` object. It copies the `agent_safe` authority, attachment IDs, and attachment refs from that same accepted object before any asynchronous adapter call, rejects routing fields or inconsistent ID/ref sets, and then sequences the public policy guard:

1. The host generates one opaque control-attempt ID and supplies a canonical current time.
2. A no-receipt preflight must return `live_recheck_required`.
3. The external live-recheck issuer receives the frozen saved reference. User confirmation is requested only if that receipt is structurally valid, fresh, origin-bound, attempt-bound, and uniquely matches every target.
4. The external human-confirmation issuer binds its receipt to that exact attempt and recheck receipt.
5. A fresh, monotonic host time is used for the final policy evaluation.

The function returns only `SavedSnapshotControlPolicyDecisionV1`. There is no action payload, success callback, DOM query, locator replay, tab selection, local-bridge call, or browser-control operation.

## Run the synthetic proof

```powershell
npm run example:saved-snapshot:trusted-host
```

The command builds the public packages, creates a production Compact saved bundle from the repository-owned two-target capture fixture, injects deterministic synthetic issuers, and prints only the decision:

```json
{
  "allowed": true,
  "code": "requirements_satisfied",
  "liveRecheckReceiptId": "receipt_0123456789abcdef"
}
```

## Integration shape

```js
import { evaluateAcceptedSavedSnapshotWithTrustedHost } from "./index.mjs";

const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
  acceptedBundle,
  createControlAttemptId: hostAttemptIds.create,
  nowIso: trustedClock.nowIso,
  issueLiveRecheck: livePageAdapter.issueRecheckReceipt,
  issueUserConfirmation: humanUi.issueConfirmationReceipt,
});

if (!decision.allowed) {
  // Stop. The denial code is safe to log or present for review.
  return decision;
}

// MeanThis does not perform the later action. The host still owns action scope,
// receipt-issuer trust, and the decision about whether any action is permitted.
```

## Trust boundary

- `acceptedBundle` must come from a producer the host trusts. This example validates its bounded shape but cannot authenticate its provenance.
- The synthetic runner does not inspect a live page or prove that a human interacted with a confirmation UI. Real issuers remain host-owned adapters.
- Real issuer adapters must enforce their own bounded timeout and cancellation policy. This transport-free example awaits each adapter and cannot cancel underlying work that never settles.
- `nowIso` must use the host's trusted current clock. The example rejects invalid or backward timestamps, but cannot prove the clock itself is honest.
- An `allowed: true` decision is structural policy evidence, not an authorization token and not proof that a later action is safe.
- This example stays outside publishable package tarballs and does not add extension permissions, a CLI command, connector transport, or control capability.
