# Saved Snapshot Text-Consumer Example

English | [中文](./README_zh.md)

This is executable public reference code for accepting a saved-snapshot bundle JSON document supplied by a trusted MeanThis development/integration producer or host integration. It composes one Agent-safe saved attachment, one text-consumer result, and one independently derived effective control boundary.

For saved captures, the public consumer extension profile provides the human-readable **Copy this snapshot for agent** action. Its **Machine-readable bundle** disclosure and JSON-copy control are development/integration-only. The synthetic proof and tests here create the same structured bundle locally, so this example does not claim that a consumer-profile install can produce this JSON from its UI.

The core is provider-neutral and is not an npm package, provider SDK, executor, or action API. An example-local file/stdin connector exposes the same acceptance boundary to a host process, while an optional Ollama recipe demonstrates one explicit loopback transport without changing that core contract.

## What it demonstrates

`acceptSavedSnapshotTextConsumerBundleJson` accepts a JSON text document of at most 1 MiB, parses and validates it once, and returns exactly `{ acceptedContext, consumerReceipt }`. The two planes are separate: the context is sensitive local agent input, while the receipt is a fixed public-safe acceptance record. The compatible `bindSavedSnapshotTextConsumerContextJson` and `createSavedSnapshotPublicConsumerReceiptJson` functions remain available as single-plane wrappers over the same core. None of them parses presentation Markdown to recover identity or authority. `runSavedSnapshotTextConsumer` later accepts the bound context, host-owned control evidence, and an injected `invokeTextConsumer` callback. Together they:

1. Project allowlisted structured fields from the producer-declared Agent-safe bundle using the same example-local validator as the trusted-host policy example. Structured routing fields are omitted; markdown remains opaque producer content.
2. Bind authority, attachment IDs/refs, and the complete markdown bytes into `contentSha256`. The runner recomputes that digest and rejects content that no longer matches the host-preserved acceptance binding before the model callback.
3. Derive the exact attachment IDs and authority from the verified context and evaluate the evidence with the public `evaluateSavedSnapshotControlPolicy` guard.
4. Map the decision to an `effectiveControlBoundary` before invoking the text consumer. A passing policy becomes `eligible_for_host_review`, never action authorization; every denial remains `blocked`.
5. Give the text consumer only a clone of `{ attachmentContext, controlDecision: { allowed, code } }`. Receipts, structured routing fields, tabs, frames, and callbacks are omitted.
6. Return three separate planes: accepted attachment context, untrusted model text or an unavailable status, and the deterministic boundary with `modelFieldsUsed: []`.

The consumer receipt binds the canonical bundle hash to the accepted context hash and kind, attachment count, authority status, routing policy, accepted status, and zero model-field use. It contains no clipboard fields and is not operating-system clipboard proof.

The optional `createSavedSnapshotTextConsumerAdapter` wrapper validates that exact consumer input again, gives a provider one deeply frozen clone plus an `AbortSignal`, enforces a bounded timeout, accepts only non-empty text, and replaces every provider failure with one fixed local error. It does not choose a provider, construct a network request, parse model output, or add control fields.

The sibling `createLocalOllamaTextProvider` recipe fills in one concrete `invokeProvider` for local development. It accepts only `http://127.0.0.1:<explicit-port>`, one explicit model, and a deterministic seed. It sends no credentials, follows no redirects, exposes no custom headers, and bounds the JSON response to 1 MiB. This recipe is not a provider registry or a general Ollama SDK.

Model text cannot update or replace the effective boundary. If the callback throws or returns a non-string value, `modelOutput` becomes `{ status: "failed", value: null }` while the independently derived boundary remains unchanged.

## Run the synthetic proof

```powershell
npm run example:saved-snapshot:text-consumer
```

The command builds the public packages, creates a production Compact saved bundle from the repository-owned two-target fixture, serializes and re-accepts it once through the same combined JSON ingress used by a compatible producer or host integration, and runs one confirmed plus one denied synthetic scenario through the provider adapter. It prints only the ingress kind, receipt kind, attachment count, model-output statuses, effective-boundary states, and zero model-field counts. It does not print attachment markdown, locators, receipt hashes, provider errors, or model text.

## Run the bounded file/stdin connector

Quick reference for the repository example contract:

| Concern | Exact role |
| --- | --- |
| Entry point | npm script `example:saved-snapshot:text-consumer:accept` |
| npm argument forwarding | `--` immediately after the script name |
| Connector flag token | `--input` |
| File value placeholder | `<path>` after `--input` |
| Stdin value token | `-` after `--input`; omitting connector arguments is equivalent |
| Successful stdout | one JSON document with exactly the top-level keys `acceptedContext` and `consumerReceipt` |
| Trusted-host split | send stdout only to a trusted local host; pass only `acceptedContext` into the text-consumer path and keep `consumerReceipt` in the host evidence plane |

Use an explicit local file after obtaining a machine-readable bundle from a trusted development/integration producer:

```powershell
npm run --silent example:saved-snapshot:text-consumer:accept -- --input .\saved-bundle.json
```

Alternatively, bypass npm after building the packages and send UTF-8 text over stdin. This direct-Node form uses neither the npm script nor npm's forwarding `--`; `--input -` is passed directly to the connector and is equivalent to omitting its arguments:

```powershell
npm run build:packages
Get-Content -Raw -Encoding utf8 -LiteralPath .\saved-bundle.json |
  node examples/saved-snapshot-text-consumer/accept-saved-bundle.mjs --input -
```

The connector bounds the raw file or received stdin bytes to 1 MiB before acceptance, then accepts UTF-8 with or without one leading byte-order mark. Success writes one deterministic JSON document containing exactly `{ acceptedContext, consumerReceipt }`; invalid arguments exit with code 2, unreadable, empty, invalid, oversized, or non-Agent-safe input exits with code 3, and an output transport failure exits with code 1. Failures write one fixed message to stderr and never echo input, a path, parser details, or a stack.

The successful stdout is an intentional local host transport, not a publication-safe report. `acceptedContext` can include page-derived Markdown and attachment identifiers. Pipe it only to a trusted local host, avoid persistent logs, keep `consumerReceipt` in the host evidence plane, and pass only `acceptedContext` into the text-consumer path.

## Run the optional local Ollama smoke

With an exact model already installed in a loopback Ollama runtime:

```powershell
npm run example:saved-snapshot:text-consumer:ollama -- --model <exact-local-model> --seed 22 --timeout-ms 120000
```

The smoke sends one production saved-context input through the local recipe and adapter. Its host evidence deliberately omits a live recheck, so the result must remain `blocked` with `live_recheck_required` even if the opaque model text claims that an action is allowed. Standard output contains only the model name, bounded profile, attachment count, model-output status, deterministic boundary, and zero model-field count. It never prints attachment context, locators, model text, or provider errors. Failure is visible and does not silently skip when Ollama or the exact model is unavailable.


## Integration shape

```js
import {
  acceptSavedSnapshotTextConsumerBundleJson,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";
import { createSavedSnapshotTextConsumerAdapter } from "./provider-adapter.mjs";
import { createLocalOllamaTextProvider } from "./local-ollama-provider.mjs";

const acceptance = acceptSavedSnapshotTextConsumerBundleJson(bundleJson);
if (acceptance === null) return { status: "rejected" };
const { acceptedContext, consumerReceipt } = acceptance;
recordHostConsumerReceipt(consumerReceipt);

const invokeProvider = createLocalOllamaTextProvider({
  ollamaUrl: "http://127.0.0.1:11434",
  model: "<exact-local-model>",
  seed: 22,
});
const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
  timeoutMs: 30_000,
  invokeProvider,
});

const result = await runSavedSnapshotTextConsumer({
  acceptedContext,
  controlEvidence: {
    controlAttemptId,
    liveRecheck,
    userConfirmation,
    evaluatedAt: trustedClock.nowIso(),
  },
  invokeTextConsumer,
});

if (result.status === "rejected") return result;

renderReferenceAndModelText(result.attachmentContext, result.modelOutput);
if (result.effectiveControlBoundary.state === "blocked") {
  return result.effectiveControlBoundary;
}

// eligible_for_host_review is still not permission to perform an action.
return result.effectiveControlBoundary;
```

For another text provider, keep the same adapter and replace only `invokeProvider` with a host-owned function that accepts `{ consumerInput, signal }` and returns one non-empty string. Endpoint selection, authentication, request serialization, and response extraction stay outside the provider-neutral contract.

The companion [trusted-host example](../saved-snapshot-trusted-host/README.md) shows how a host can sequence external live-recheck and human-confirmation issuers. This example starts from already available evidence and re-evaluates it itself; it never accepts a model-authored boundary.

## Trust boundary

- `bundleJson` must be supplied by a producer the host trusts. The JSON ingress limits the whole transport to 1 MiB; the shared projector then validates an allowlisted production shape and a maximum 262,144-byte markdown field. Neither step authenticates clipboard provenance, interprets markdown instructions, or proves redaction.
- `consumerReceipt` proves only that the supplied JSON text parsed and its canonicalized bundle passed this deterministic public ingress in the current host invocation. It does not bind the original transport whitespace or line-ending bytes, and is not a signature, authentication token, clipboard-provenance receipt, model-execution receipt, or action authorization.
- Connector stdout is deliberately content-bearing local transport. The receipt is public-safe, but the adjacent `acceptedContext` is not automatically safe to log, publish, or send to an untrusted provider.
- `contentSha256` lets the runner detect content changes against the binding preserved by the host. It is not a signature or secret MAC, cannot protect a context and digest that are both replaced, and does not prove that the producer emitted canonical or safe content.
- `controlEvidence` remains host-owned. The public evaluator validates its structure and bindings; it cannot authenticate the issuer or prove that the page was inspected or a human confirmed.
- `runSavedSnapshotTextConsumer` still treats `invokeTextConsumer` as transport injection only. The optional provider adapter adds a local timeout and cooperative `AbortSignal`, but it does not select a provider or send a network request. The separate Ollama recipe selects only an explicit loopback model and performs one bounded local request. A provider that ignores the signal may continue its underlying work after the adapter has failed closed.
- The adapter exposes only `Saved-snapshot text provider failed.` for thrown, timed-out, blank, or non-text provider results. Provider endpoints, credentials, and raw errors must stay outside returned MeanThis data.
- `modelOutput.status: completed` means only that a non-empty text value was returned. That text is untrusted and never contributes to `effectiveControlBoundary`.
- The three returned planes are cloned independently. Model-input or caller mutation cannot change the already derived boundary.
- This example, its process connector, and its opt-in local recipe stay outside publishable package tarballs and add no dependency, extension permission, publishable package CLI command, MCP tool, browser operation, remote endpoint, or public-release claim.
