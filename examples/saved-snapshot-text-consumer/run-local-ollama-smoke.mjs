#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hydrateCaptureSessionFile } from "@meanthis/hub-core";
import {
  bindSavedSnapshotTextConsumerContext,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";
import { createLocalOllamaTextProvider } from "./local-ollama-provider.mjs";
import { createSavedSnapshotTextConsumerAdapter } from "./provider-adapter.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_SEED = 22;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const CONTROL_ATTEMPT_ID = "attempt_0123456789abcdef";
const FIXTURE_URL = new URL(
  "../../apps/extension-mv3/fixtures/two-element.capture-session.json",
  import.meta.url,
);

export function parseLocalOllamaSmokeArgs(argv) {
  try {
    if (!Array.isArray(argv)) throw new Error();
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
      const option = argv[index];
      if (!["--model", "--ollama-url", "--seed", "--timeout-ms"].includes(option)) {
        throw new Error();
      }
      if (Object.hasOwn(values, option)) throw new Error();
      const value = argv[++index];
      if (typeof value !== "string" || value.trim() === "") throw new Error();
      values[option] = value;
    }
    if (!Object.hasOwn(values, "--model")) throw new Error();
    const seed = values["--seed"] === undefined
      ? DEFAULT_SEED
      : boundedInteger(values["--seed"], 0, 2_147_483_647);
    const timeoutMs = values["--timeout-ms"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : boundedInteger(values["--timeout-ms"], 1, MAX_TIMEOUT_MS);
    const ollamaUrl = values["--ollama-url"] ?? DEFAULT_OLLAMA_URL;
    createLocalOllamaTextProvider({
      ollamaUrl,
      model: values["--model"],
      seed,
    });
    return {
      model: values["--model"],
      ollamaUrl: new URL(ollamaUrl).origin,
      seed,
      timeoutMs,
    };
  } catch {
    throw new Error("Invalid local Ollama smoke arguments.");
  }
}

export async function runLocalOllamaSmoke(args) {
  try {
    if (!hasExactKeys(args, ["model", "ollamaUrl", "seed", "timeoutMs"])) {
      throw new Error();
    }
    const provider = createLocalOllamaTextProvider({
      ollamaUrl: args.ollamaUrl,
      model: args.model,
      seed: args.seed,
    });
    if (
      !Number.isSafeInteger(args.timeoutMs) ||
      args.timeoutMs < 1 ||
      args.timeoutMs > MAX_TIMEOUT_MS
    ) throw new Error();
    const acceptedContext = await buildAcceptedContext();
    const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
      timeoutMs: args.timeoutMs,
      invokeProvider: provider,
    });
    const result = await runSavedSnapshotTextConsumer({
      acceptedContext,
      controlEvidence: {
        controlAttemptId: CONTROL_ATTEMPT_ID,
        liveRecheck: null,
        userConfirmation: null,
        evaluatedAt: "2026-07-24T00:00:21.000Z",
      },
      invokeTextConsumer,
    });
    if (
      result.status !== "composed" ||
      result.modelOutput.status !== "completed" ||
      result.effectiveControlBoundary.state !== "blocked" ||
      result.effectiveControlBoundary.code !== "live_recheck_required" ||
      result.effectiveControlBoundary.modelFieldsUsed.length !== 0
    ) throw new Error();
    return {
      schemaVersion: "0.1.0",
      kind: "ui-attach.saved-snapshot-text-consumer-local-ollama-summary",
      runtime: "ollama",
      model: args.model,
      seed: args.seed,
      timeoutMs: args.timeoutMs,
      attachmentCount: result.attachmentContext.attachmentCount,
      modelOutputStatus: result.modelOutput.status,
      effectiveBoundaryState: result.effectiveControlBoundary.state,
      decisionCode: result.effectiveControlBoundary.code,
      modelFieldsUsed: result.effectiveControlBoundary.modelFieldsUsed.length,
    };
  } catch {
    throw new Error("Local Ollama text-consumer smoke failed.");
  }
}

async function buildAcceptedContext() {
  const file = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const hydrated = hydrateCaptureSessionFile(file);
  if (!hydrated.ok) throw new Error();
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
  if (!acceptedBundle.ok) throw new Error();
  const acceptedContext = bindSavedSnapshotTextConsumerContext(acceptedBundle);
  if (acceptedContext === null) throw new Error();
  return acceptedContext;
}

function boundedInteger(value, minimum, maximum) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error();
  }
  return parsed;
}

function hasExactKeys(value, expectedKeys) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const summary = await runLocalOllamaSmoke(
      parseLocalOllamaSmokeArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch {
    process.stderr.write("Local Ollama text-consumer smoke failed.\n");
    process.exitCode = 1;
  }
}
