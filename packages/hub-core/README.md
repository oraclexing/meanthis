# @meanthis/hub-core

English | [中文](./README_zh.md)

> Release status: `0.1.0` is an unpublished candidate. Until the [project changelog](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG.md) records publication, use this workspace or a verified package tarball; the install command below describes intended registry usage.

Transport-agnostic capture sessions and Agent handoff assembly for MeanThis. The package owns the in-memory session model, summary-first reads, disclosure-specific views, prompt bundles, and canonical capture-session validation.

Source-patch materialization and repair orchestration are deliberately absent from the `hub-core` API and dependencies. Historical repair benchmarks keep their fixture and prompt-building code outside this public package. A downstream host owns all source access, candidate generation, review, application, and verification.

It is intentionally not an MCP server, HTTP service, browser extension, or CLI.

## Install

```bash
npm install @meanthis/hub-core
```

## Example

```ts
import { createCaptureHub } from "@meanthis/hub-core";

const hub = createCaptureHub();
const session = hub.createSession({ origin: "https://example.com" });
console.log(hub.summarizeSession(session.id));
```

## Capture session files

`validateCaptureSessionFile` and `hydrateCaptureSessionFile` accept an already-parsed capture-session value. Callers own file I/O and JSON parsing; Hub validates the value and hydrates its in-memory model.

Validation is fail closed. Undeclared fields on the root, session, attachment item, source record, and declared `UIAttachment` records are rejected before hydration. The validator also rejects cyclic values, accessor properties, and non-JSON container shapes without invoking page-controlled getters.

Validation is bounded by exported constants:

- `CAPTURE_SESSION_FILE_MAX_BYTES`: 1,048,576 bytes for the compact JSON representation. Raw JSON readers must enforce the same byte limit before parsing; the MeanThis CLI does so.
- `CAPTURE_SESSION_FILE_MAX_ATTACHMENTS`: 26 attachments per session.
- `CAPTURE_SESSION_FILE_MAX_COLLECTION_ITEMS`: 256 items in any array.
- `CAPTURE_SESSION_FILE_MAX_STRING_BYTES`: 1,048,576 UTF-8 bytes for any string or object key; the total compact JSON budget remains the effective aggregate bound.
- `CAPTURE_SESSION_FILE_MAX_OBJECT_KEYS`: 64 own enumerable string keys per object.
- `CAPTURE_SESSION_FILE_MAX_NESTING_DEPTH`: 32 nested levels.
- `CAPTURE_SESSION_FILE_MAX_VALUE_NODES`: 65,536 visited values.
- `CAPTURE_SESSION_FILE_MAX_VALIDATION_ISSUES`: 100 returned validation issues.

## Local page routing

`deriveCapturePageRoutingHint` derives an optional, ephemeral Chromium tab/frame candidate from a capture record. `buildCapturePageRoutingRefs` and `serializeCapturePageRoutingSection` expose the same contract for JSON and Markdown handoffs. Query strings and fragments are omitted, encoded paths are decoded only for bounded sensitive-data detection, and invalid or recognized-sensitive routes produce no hint. Consumers must require exactly one live tab-and-frame-route match and user confirmation before browser control.

These helpers do not connect to a browser, authenticate a profile, open a port, or implement an MCP transport. A coincidental match in another Chromium profile remains possible until a profile-scoped live bridge exists.
