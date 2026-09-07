import { parseArgs } from "node:util";
import {
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
} from "@meanthis/schema";
import { resolveSourceInputsAcrossWorkspaces } from "@meanthis/source-resolver-mcp";
import { loadOrCreateLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
} from "./local-bridge-owner.js";
import {
  acknowledgeSharedCaptureRead,
  createHttpLocalBridgeReader,
  listSharedCaptures,
  readSharedCapture,
  type LocalBridgeReader,
  type SharedCaptureReadAcknowledgementInput,
  type SharedCaptureReadInput,
  type SharedCaptureSourceResolver,
} from "./local-bridge-mcp.js";

const DETAILS = new Set<SharedCaptureReadInput["detail"]>([
  "summary",
  "content",
  "task",
  "agent_context",
  "locator",
  "visual",
  "diagnostics",
  "context",
  "handoff",
]);

export interface CaptureCliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface CaptureCliDependencies {
  reader: LocalBridgeReader;
  ensureOwner(): Promise<void>;
  sourceResolver?: SharedCaptureSourceResolver;
}

type ParsedCaptureCommand =
  | { command: "list" }
  | { command: "read"; input: SharedCaptureReadInput }
  | { command: "ack"; input: SharedCaptureReadAcknowledgementInput };

const defaultIo: CaptureCliIo = {
  writeStdout(value) { process.stdout.write(value); },
  writeStderr(value) { process.stderr.write(value); },
};

export async function runCaptureCli(
  args: string[],
  io: CaptureCliIo = defaultIo,
  dependencies?: CaptureCliDependencies,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.writeStdout(renderCaptureHelp());
    return 0;
  }
  let parsed: ParsedCaptureCommand;
  try {
    parsed = parseCaptureArguments(args);
  } catch {
    return writeError(io, 2, "INVALID_ARGUMENTS", "Invalid capture command arguments.");
  }
  let activeDependencies: CaptureCliDependencies;
  try {
    activeDependencies = dependencies ?? await createDefaultDependencies();
    await activeDependencies.ensureOwner();
  } catch {
    return writeError(
      io,
      5,
      "BRIDGE_OWNER_UNAVAILABLE",
      "The local MeanThis browser bridge owner is unavailable.",
    );
  }
  if (parsed.command === "list") {
    try {
      return writeJson(io, await listSharedCaptures(activeDependencies.reader));
    } catch {
      return writeError(
        io,
        5,
        "BRIDGE_OWNER_UNAVAILABLE",
        "Shared captures are not available.",
      );
    }
  }
  const result = parsed.command === "ack"
    ? await acknowledgeSharedCaptureRead(activeDependencies.reader, parsed.input)
    : await readSharedCapture(
        activeDependencies.reader,
        parsed.input,
        {},
        activeDependencies.sourceResolver ?? ((inputs) => (
          resolveSourceInputsAcrossWorkspaces([process.cwd()], inputs)
        )),
      );
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    return writeError(io, 1, "INTERNAL_ERROR", "MeanThis returned an invalid capture result.");
  }
  if ("isError" in result && result.isError === true) {
    io.writeStderr(`${text}\n`);
    return 4;
  }
  io.writeStdout(`${text}\n`);
  return 0;
}

export function renderCaptureHelp(): string {
  return [
    "MeanThis shared capture fallback",
    "",
    "Usage:",
    "  meanthis capture list --json",
    "  meanthis capture read --instance <instance-id> --capture <capture-id> --sequence <n> [--detail <level>] [--target <target-id> ...] [--attachment <attachment-id> ...] --json",
    "  meanthis capture ack --instance <instance-id> --capture <capture-id> --sequence <n> --detail <level> --json",
    "",
    "Use this host-neutral fallback when the current agent task cannot call the registered MeanThis MCP tools directly.",
    "Prefer --target target_A for captured A-Z targets. Use --attachment only for compatibility.",
    "Use --detail agent_context to combine task, locator, bounded visual facts, and read-only source grounding.",
    "",
  ].join("\n");
}

function parseCaptureArguments(args: string[]): ParsedCaptureCommand {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      instance: { type: "string" },
      capture: { type: "string" },
      sequence: { type: "string" },
      detail: { type: "string" },
      target: { type: "string", multiple: true },
      attachment: { type: "string", multiple: true },
      json: { type: "boolean" },
    },
  });
  if (parsed.values.json !== true || parsed.positionals.length !== 1) {
    throw new Error("Invalid capture command.");
  }
  const command = parsed.positionals[0];
  const optionNames = Object.keys(parsed.values);
  if (command === "list") {
    if (optionNames.some((name) => name !== "json")) throw new Error("Invalid list option.");
    return { command: "list" };
  }
  if (command !== "read" && command !== "ack") throw new Error("Invalid capture command.");
  const instanceId = parsed.values.instance;
  const captureId = parsed.values.capture;
  const sequence = parsed.values.sequence;
  const detail = parsed.values.detail ?? "summary";
  const targetIds = parsed.values.target;
  const attachmentIds = parsed.values.attachment;
  if (command === "ack") {
    if (
      optionNames.some((name) => !["instance", "capture", "sequence", "detail", "json"].includes(name)) ||
      typeof instanceId !== "string" || !/^instance-[0-9a-f]{12}$/.test(instanceId) ||
      typeof captureId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(captureId) ||
      typeof sequence !== "string" || !/^[1-9]\d*$/.test(sequence) ||
      !Number.isSafeInteger(Number(sequence)) ||
      typeof parsed.values.detail !== "string" ||
      !DETAILS.has(parsed.values.detail as SharedCaptureReadInput["detail"])
    ) {
      throw new Error("Invalid acknowledgement option.");
    }
    return {
      command: "ack",
      input: {
        instanceId,
        captureId,
        expectedSequence: Number(sequence),
        detail: parsed.values.detail as SharedCaptureReadAcknowledgementInput["detail"],
      },
    };
  }
  if (
    typeof instanceId !== "string" || !/^instance-[0-9a-f]{12}$/.test(instanceId) ||
    typeof captureId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(captureId) ||
    typeof sequence !== "string" || !/^(0|[1-9]\d*)$/.test(sequence) ||
    !Number.isSafeInteger(Number(sequence)) ||
    typeof detail !== "string" || !DETAILS.has(detail as SharedCaptureReadInput["detail"]) ||
    (targetIds !== undefined && attachmentIds !== undefined) ||
    !validUniqueIds(targetIds, /^target_[A-Za-z0-9_-]{1,64}$/) ||
    !validUniqueIds(attachmentIds, /^att_[A-Za-z0-9_-]{1,252}$/)
  ) {
    throw new Error("Invalid read option.");
  }
  return {
    command: "read",
    input: {
      instanceId,
      captureId,
      expectedSequence: Number(sequence),
      detail: detail as SharedCaptureReadInput["detail"],
      ...(targetIds === undefined ? {} : { targetIds }),
      ...(attachmentIds === undefined ? {} : { attachmentIds }),
    },
  };
}

function validUniqueIds(values: string[] | undefined, pattern: RegExp): boolean {
  return values === undefined || (
    values.length >= 1 &&
    values.length <= 26 &&
    values.every((value) => pattern.test(value)) &&
    new Set(values).size === values.length
  );
}

async function createDefaultDependencies(): Promise<CaptureCliDependencies> {
  const agentToken = await loadOrCreateLocalBridgeAgentToken();
  const expectedOwnerIdentity = loadLocalBridgeOwnerIdentity();
  const reader = createHttpLocalBridgeReader(UI_ATTACH_LOCAL_BRIDGE_ORIGIN, agentToken, {
    expectedOwnerIdentity,
  });
  return {
    reader,
    async ensureOwner() {
      const startupReader = createHttpLocalBridgeReader(UI_ATTACH_LOCAL_BRIDGE_ORIGIN, agentToken, {
        expectedOwnerIdentity: loadLocalBridgeOwnerIdentity(),
        requestTimeoutMs: 250,
      });
      await ensureLocalBridgeOwner({
        probe: async () => { await startupReader.getStatus(); },
        spawnOwner: spawnDetachedLocalBridgeOwner,
        wait: waitForLocalBridgeOwner,
      });
    },
  };
}

function writeJson(io: CaptureCliIo, value: unknown): number {
  io.writeStdout(`${JSON.stringify(value)}\n`);
  return 0;
}

function writeError(
  io: CaptureCliIo,
  exitCode: number,
  code: string,
  message: string,
): number {
  io.writeStderr(`${JSON.stringify({
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.local-bridge-error",
    ok: false,
    error: {
      code,
      message,
      nextAction: code === "BRIDGE_OWNER_UNAVAILABLE"
        ? {
            kind: "retry_list_captures",
            tool: "meanthis_list_captures",
            cli: { executable: "meanthis", arguments: ["capture", "list", "--json"] },
          }
        : null,
    },
  })}\n`);
  return exitCode;
}
