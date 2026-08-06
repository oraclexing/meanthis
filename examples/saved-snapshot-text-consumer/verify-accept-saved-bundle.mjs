#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateCaptureSessionFile } from "@meanthis/hub-core";
import { SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES } from "./index.mjs";

const CONNECTOR_PATH = fileURLToPath(new URL("./accept-saved-bundle.mjs", import.meta.url));
const FIXTURE_URL = new URL(
  "../../apps/extension-mv3/fixtures/two-element.capture-session.json",
  import.meta.url,
);
const INVALID_ARGUMENTS = "Saved-snapshot connector arguments were invalid.\n";
const NOT_ACCEPTED = "Saved-snapshot bundle was not accepted.\n";
const INTERNAL_ERROR = "Saved-snapshot connector failed.\n";

const file = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
const hydrated = hydrateCaptureSessionFile(file);
if (!hydrated.ok) throw new Error("The canonical saved-snapshot fixture was invalid.");
const attachmentIds = file.session.attachments.map((item) => item.id);
const acceptedBundle = hydrated.hub.buildSavedSnapshotPromptBundle({
  sessionId: hydrated.sessionId,
  attachmentIds,
  attachmentLabels: Object.fromEntries(file.session.attachments.map((item, index) => [
    item.id,
    item.labels.find((label) => typeof label === "string" && label.trim())?.trim()
      ?? String.fromCharCode(65 + index),
  ])),
  attachmentIntents: Object.fromEntries(file.session.attachments.map((item) => [
    item.id,
    item.sourceRecord.intent,
  ])),
  format: "compact",
});
if (!acceptedBundle.ok) throw new Error(acceptedBundle.error);
const { ok: _ok, ...copiedBundle } = acceptedBundle;
const copiedBundleBytes = Buffer.from(JSON.stringify(copiedBundle, null, 2), "utf8");

const tempRoot = await mkdtemp(join(tmpdir(), "ui-attach-consumer-connector-"));
try {
  const bundlePath = join(tempRoot, "saved-bundle.json");
  await writeFile(bundlePath, copiedBundleBytes, { flag: "wx" });

  const stdinResult = runConnector([], copiedBundleBytes);
  const bomResult = runConnector([], Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    copiedBundleBytes,
  ]));
  const fileResult = runConnector(["--input", bundlePath]);
  assertSuccess(stdinResult);
  assertSuccess(bomResult);
  assertSuccess(fileResult);
  if (
    stdinResult.stdout !== fileResult.stdout ||
    stdinResult.stdout !== bomResult.stdout
  ) {
    throw new Error("Saved-snapshot connector file/stdin output drifted.");
  }
  const output = JSON.parse(stdinResult.stdout);
  if (
    !hasExactKeys(output, ["acceptedContext", "consumerReceipt"]) ||
    output.acceptedContext?.kind !== "ui-attach.saved-snapshot-attachment-context" ||
    output.acceptedContext.attachmentCount !== 2 ||
    output.consumerReceipt?.kind !== "ui-attach.saved-snapshot-public-consumer-receipt" ||
    output.consumerReceipt.consumerContextSha256 !== output.acceptedContext.contentSha256 ||
    output.consumerReceipt.consumerAttachmentCount !== 2 ||
    output.consumerReceipt.consumerAuthorityStatus !== "not_rechecked" ||
    output.consumerReceipt.consumerRoutingPolicy !== "omitted" ||
    output.consumerReceipt.consumerStatus !== "accepted" ||
    output.consumerReceipt.modelFieldsUsedCount !== 0 ||
    Object.hasOwn(output.acceptedContext, "consumerReceipt") ||
    JSON.stringify(output.consumerReceipt).includes("markdown")
  ) throw new Error("Saved-snapshot connector output was invalid.");

  const rejected = [
    runConnector([], Buffer.from('{"private-sentinel":', "utf8")),
    runConnector([], Buffer.from([0xff, 0xfe])),
    runConnector([], Buffer.alloc(
      SAVED_SNAPSHOT_TEXT_CONSUMER_MAX_BUNDLE_JSON_BYTES + 1,
      0x20,
    )),
    runConnector(["--input", join(tempRoot, "private-sentinel-missing.json")]),
  ];
  for (const result of rejected) assertRejected(result, 3, NOT_ACCEPTED);
  assertRejected(
    runConnector(["--unknown", "private-sentinel"]),
    2,
    INVALID_ARGUMENTS,
  );
  const closedStdout = await runConnectorWithClosedStdout(copiedBundleBytes);
  assertRejected(closedStdout, 1, INTERNAL_ERROR);

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "0.1.0",
    kind: "ui-attach.saved-snapshot-public-consumer-connector-synthetic-summary",
    inputModes: ["stdin", "file"],
    byteIdentical: true,
    utf8BomAccepted: true,
    attachmentCount: output.acceptedContext.attachmentCount,
    receiptKind: output.consumerReceipt.kind,
    receiptModelFieldsUsed: output.consumerReceipt.modelFieldsUsedCount,
    rejectedCaseCount: rejected.length + 2,
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function runConnector(args, input) {
  const result = spawnSync(process.execPath, [CONNECTOR_PATH, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 3 * 1_048_576,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) throw new Error("Saved-snapshot connector process failed.");
  return result;
}

function runConnectorWithClosedStdout(input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CONNECTOR_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Saved-snapshot connector closed-pipe probe timed out."));
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // The child may close after detecting its output transport failure.
    });
    child.stdout.destroy();
    child.stdin.end(input);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolvePromise({ status, signal, stdout: "", stderr });
    });
  });
}

function assertSuccess(result) {
  if (result.status !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error("Saved-snapshot connector success process was invalid.");
  }
}

function assertRejected(result, status, stderr) {
  if (
    result.status !== status ||
    result.signal !== null ||
    result.stdout !== "" ||
    result.stderr !== stderr ||
    result.stderr.includes("private-sentinel")
  ) throw new Error("Saved-snapshot connector rejection process was invalid.");
}

function hasExactKeys(value, keys) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
