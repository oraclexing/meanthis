import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  CAPTURE_SESSION_FILE_MAX_BYTES,
  deriveCapturePageRoutingHint,
  hydrateCaptureSessionFile,
  sanitizeCaptureSessionFileValidationIssues,
  type CaptureHubAttachmentResult,
  type CaptureHubSummaryResult,
  type CapturePromptBundleResult,
} from "@meanthis/hub-core";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type {
  AttachmentOutputV1,
  CliErrorCode,
  ErrorOutputV1,
  PromptBundleOutputV1,
  SessionSummaryOutputV1,
} from "./contracts.js";

export interface CliIo {
  readTextFile(path: string, maxBytes?: number): Promise<string>;
  readStdinText(maxBytes?: number): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

type CliCommand = "summary" | "attachment" | "bundle";

interface ParsedCliArguments {
  command: CliCommand;
  input: string;
  ids: string[];
  disclosureMode: UIAttachmentDisclosureMode;
  intent?: string;
  intentFile?: string;
  format: "json" | "markdown";
}

class CliArgumentError extends Error {}
const CLI_INTENT_FILE_MAX_BYTES = 262_144;

const defaultIo: CliIo = {
  async readTextFile(path: string, maxBytes?: number): Promise<string> {
    if (maxBytes === undefined) return readFile(path, "utf8");

    const handle = await open(path, "r");
    try {
      const fileStat = await handle.stat();
      if (fileStat.size > maxBytes) throw new CliInputTooLargeError();

      const buffer = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) throw new CliInputTooLargeError();
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  async readStdinText(maxBytes?: number): Promise<string> {
    process.stdin.setEncoding("utf8");
    let text = "";
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (maxBytes !== undefined && bytes > maxBytes) {
        process.stdin.pause();
        throw new CliInputTooLargeError();
      }
      text += chunk;
    }
    return text;
  },
  writeStdout(value: string): void {
    process.stdout.write(value);
  },
  writeStderr(value: string): void {
    process.stderr.write(value);
  },
};

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const parsed = parseCliArguments(args);
    const sessionText = parsed.input === "-"
      ? await readRequiredStdin(io, CAPTURE_SESSION_FILE_MAX_BYTES)
      : await readRequiredFile(io, parsed.input, CAPTURE_SESSION_FILE_MAX_BYTES);
    const sessionFile = parseSessionFile(sessionText);
    const hydrated = hydrateCaptureSessionFile(sessionFile);
    if (!hydrated.ok) {
      return writeError(
        io,
        3,
        "INVALID_SESSION_FILE",
        "Invalid capture session file.",
        sanitizeCaptureSessionFileValidationIssues(hydrated.issues),
      );
    }

    if (parsed.command === "summary") {
      const result = hydrated.hub.summarizeSession(hydrated.sessionId, {
        disclosureMode: "agent_safe",
      });
      if (!result.ok) return writeHubError(io, result);
      return writeJson(io, {
        schemaVersion: "0.1.0",
        kind: "ui-attach.session-summary",
        ok: true,
        data: withoutOk(result),
      } satisfies SessionSummaryOutputV1);
    }

    if (parsed.command === "attachment") {
      const result = hydrated.hub.getAttachment(hydrated.sessionId, parsed.ids[0], {
        disclosureMode: parsed.disclosureMode,
      });
      if (!result.ok) return writeHubError(io, result);
      return writeJson(io, toAttachmentOutput(result));
    }

    const intent = parsed.intentFile
      ? await readRequiredFile(io, parsed.intentFile, CLI_INTENT_FILE_MAX_BYTES, "intent")
      : parsed.intent;
    const result = hydrated.hub.buildPromptBundle({
      sessionId: hydrated.sessionId,
      attachmentIds: parsed.ids,
      disclosureMode: parsed.disclosureMode,
      intent,
    });
    if (!result.ok) return writeHubError(io, result);
    if (parsed.format === "markdown") {
      io.writeStdout(`${result.markdown}\n`);
      return 0;
    }
    return writeJson(io, {
      schemaVersion: "0.1.0",
      kind: "ui-attach.prompt-bundle",
      ok: true,
      data: withoutOk(result),
    } satisfies PromptBundleOutputV1);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      return writeError(io, 2, "INVALID_ARGUMENTS", error.message);
    }
    if (error instanceof CliIntentTooLargeError) {
      return writeError(io, 2, "INVALID_ARGUMENTS", "Intent exceeds the 256 KiB input limit.");
    }
    if (error instanceof CliInputTooLargeError) {
      return writeError(
        io,
        3,
        "INVALID_SESSION_FILE",
        "Capture session exceeds the 1 MiB input limit.",
      );
    }
    if (error instanceof CliInputReadError) {
      return writeError(io, 3, "INPUT_READ_FAILED", "Unable to read a local input file.");
    }
    if (error instanceof CliJsonError) {
      return writeError(io, 3, "INVALID_JSON", "Input session file is not valid JSON.");
    }
    return writeError(io, 1, "INTERNAL_ERROR", "Unexpected MeanThis CLI failure.");
  }
}

class CliInputReadError extends Error {}
class CliInputTooLargeError extends Error {}
class CliIntentTooLargeError extends Error {}
class CliJsonError extends Error {}

function parseCliArguments(args: string[]): ParsedCliArguments {
  const parsed = (() => {
    try {
      return parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        input: { type: "string" },
        id: { type: "string", multiple: true },
        disclosure: { type: "string" },
        intent: { type: "string" },
        "intent-file": { type: "string" },
        format: { type: "string" },
      },
      } as const);
    } catch {
      throw new CliArgumentError("Invalid command arguments.");
    }
  })();

  if (parsed.positionals.length !== 1 || !isCliCommand(parsed.positionals[0])) {
    throw new CliArgumentError("Expected exactly one command: summary, attachment, or bundle.");
  }
  const command = parsed.positionals[0];
  const values = parsed.values;
  const supportedOptions = supportedOptionsFor(command);
  if (Object.keys(values).some((option) => !supportedOptions.has(option))) {
    throw new CliArgumentError(`Unsupported option for ${command}.`);
  }
  if (typeof values.input !== "string" || values.input.length === 0) {
    throw new CliArgumentError("Expected --input <session.json>.");
  }

  const ids = values.id ?? [];
  if (command === "attachment" && ids.length !== 1) {
    throw new CliArgumentError("Expected exactly one --id for attachment.");
  }
  if (command === "bundle" && ids.length === 0) {
    throw new CliArgumentError("Expected at least one --id for bundle.");
  }
  if (values.intent !== undefined && values["intent-file"] !== undefined) {
    throw new CliArgumentError("--intent and --intent-file cannot be used together.");
  }

  const disclosureMode = values.disclosure ?? "agent_safe";
  if (!isDisclosureMode(disclosureMode)) {
    throw new CliArgumentError("Unsupported disclosure mode.");
  }
  const format = values.format ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new CliArgumentError("Unsupported output format.");
  }

  return {
    command,
    input: values.input,
    ids,
    disclosureMode,
    intent: values.intent,
    intentFile: values["intent-file"],
    format,
  };
}

function supportedOptionsFor(command: CliCommand): Set<string> {
  switch (command) {
    case "summary":
      return new Set(["input"]);
    case "attachment":
      return new Set(["input", "id", "disclosure"]);
    case "bundle":
      return new Set(["input", "id", "disclosure", "intent", "intent-file", "format"]);
  }
}

function isCliCommand(value: string): value is CliCommand {
  return value === "summary" || value === "attachment" || value === "bundle";
}

function isDisclosureMode(value: string): value is UIAttachmentDisclosureMode {
  return value === "agent_safe" || value === "developer_diagnostic" || value === "full_debug";
}

async function readRequiredFile(
  io: CliIo,
  path: string,
  maxBytes?: number,
  inputKind: "session" | "intent" = "session",
): Promise<string> {
  try {
    const text = await io.readTextFile(path, maxBytes);
    enforceInputByteLimit(text, maxBytes);
    return text;
  } catch (error) {
    if (error instanceof CliInputTooLargeError) {
      if (inputKind === "intent") throw new CliIntentTooLargeError();
      throw error;
    }
    throw new CliInputReadError();
  }
}

async function readRequiredStdin(io: CliIo, maxBytes?: number): Promise<string> {
  try {
    const text = await io.readStdinText(maxBytes);
    enforceInputByteLimit(text, maxBytes);
    return text;
  } catch (error) {
    if (error instanceof CliInputTooLargeError) throw error;
    throw new CliInputReadError();
  }
}

function enforceInputByteLimit(text: string, maxBytes?: number): void {
  if (maxBytes !== undefined && Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new CliInputTooLargeError();
  }
}

function parseSessionFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliJsonError();
  }
}

function toAttachmentOutput(result: Extract<CaptureHubAttachmentResult, { ok: true }>): AttachmentOutputV1 {
  const { item, record } = result;
  const data: AttachmentOutputV1["data"] = {
    id: item.id,
    createdAt: item.createdAt,
    labels: item.labels,
    origin: record.origin,
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    capturedAt: record.capturedAt,
    routingHint: deriveCapturePageRoutingHint(record),
    attachment: record.attachment,
  };
  if (record.replayAttempts !== undefined) {
    data.replayAttempts = record.replayAttempts;
  }
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.attachment",
    ok: true,
    data,
  };
}

function writeHubError(
  io: CliIo,
  result:
    | Extract<CaptureHubSummaryResult, { ok: false }>
    | Extract<CaptureHubAttachmentResult, { ok: false }>
    | Extract<CapturePromptBundleResult, { ok: false }>,
): number {
  if (result.error.startsWith("Capture attachment not found")) {
    return writeError(io, 4, "ATTACHMENT_NOT_FOUND", "Capture attachment not found.");
  }
  if (result.error.startsWith("Cannot derive ")) {
    return writeError(io, 4, "DISCLOSURE_UPGRADE_DENIED", result.error);
  }
  return writeError(io, 1, "INTERNAL_ERROR", "Unexpected MeanThis CLI failure.");
}

function withoutOk<T extends { ok: true }>(value: T): Omit<T, "ok"> {
  const { ok: _ok, ...data } = value;
  return data;
}

function writeJson(
  io: CliIo,
  output: SessionSummaryOutputV1 | AttachmentOutputV1 | PromptBundleOutputV1,
): number {
  io.writeStdout(`${JSON.stringify(output)}\n`);
  return 0;
}

function writeError(
  io: CliIo,
  exitCode: number,
  code: CliErrorCode,
  message: string,
  issues?: ErrorOutputV1["error"]["issues"],
): number {
  const output: ErrorOutputV1 = {
    schemaVersion: "0.1.0",
    kind: "ui-attach.error",
    ok: false,
    error: { code, message, ...(issues ? { issues } : {}) },
  };
  io.writeStderr(`${JSON.stringify(output)}\n`);
  return exitCode;
}
