import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
  ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
  UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
  UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
  parseAnnotationLifecycleOperationProposal,
} from "@meanthis/schema";
import { loadOrCreateLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  ensureLocalBridgeOwner,
  loadLocalBridgeOwnerIdentity,
  spawnDetachedLocalBridgeOwner,
  waitForLocalBridgeOwner,
} from "./local-bridge-owner.js";
import {
  RESPONSE_PROOF_HEADER,
  createLocalBridgeAgentBodyRequestAuth,
  verifyLocalBridgeAgentBodyResponseProof,
} from "./local-bridge-agent-auth.js";
import { createHttpLocalBridgeReader } from "./local-bridge-mcp.js";
import type { LocalBridgeOwnerIdentity } from "./local-bridge.js";

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 32_768;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export interface AnnotationLifecycleControlCliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface AnnotationLifecycleControlCliDependencies {
  ensureOwner(): Promise<void>;
  request(path: string, body: unknown): Promise<unknown>;
  randomUUID?(): string;
}

type ParsedControlCommand =
  | { command: "submit"; path: string; body: unknown }
  | { command: "status"; path: string; body: unknown };

const defaultIo: AnnotationLifecycleControlCliIo = {
  writeStdout(value) { process.stdout.write(value); },
  writeStderr(value) { process.stderr.write(value); },
};

export async function runAnnotationLifecycleControlCli(
  args: string[],
  io: AnnotationLifecycleControlCliIo = defaultIo,
  dependencies?: AnnotationLifecycleControlCliDependencies,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.writeStdout(renderAnnotationLifecycleControlHelp());
    return 0;
  }
  let activeDependencies: AnnotationLifecycleControlCliDependencies;
  let parsed: ParsedControlCommand;
  try {
    activeDependencies = dependencies ?? await createDefaultDependencies();
    parsed = parseControlArguments(args, activeDependencies.randomUUID ?? randomUUID);
  } catch {
    return writeError(io, 2, "INVALID_ARGUMENTS", "Invalid annotation lifecycle control arguments.");
  }
  try {
    await activeDependencies.ensureOwner();
    const response = await activeDependencies.request(parsed.path, parsed.body);
    if (isControlFailureResponse(response)) {
      io.writeStderr(`${JSON.stringify(response)}\n`);
      return 4;
    }
    io.writeStdout(`${JSON.stringify(response)}\n`);
    return 0;
  } catch {
    return writeError(
      io,
      5,
      "CONTROL_OWNER_UNAVAILABLE",
      "The local MeanThis annotation lifecycle control owner is unavailable.",
    );
  }
}

export function renderAnnotationLifecycleControlHelp(): string {
  return [
    "MeanThis local annotation lifecycle control",
    "",
    "Usage:",
    "  meanthis control submit --instance <instance-id> --capture <capture-id> --sequence <n> --annotation <annotation-id> --expected <open|resolved> --next <open|resolved> [--operation <uuid>] --json",
    "  meanthis control status --operation <uuid> --fingerprint <sha256> --owner-generation <n> --connection-generation <n> --json",
    "",
    "Every proposal still requires an exact user approval in the MeanThis browser widget.",
    "After success, relist captures and read the new exact sequence through the read-only MCP or capture CLI.",
    "",
  ].join("\n");
}

function parseControlArguments(
  args: string[],
  createOperationId: () => string,
): ParsedControlCommand {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      instance: { type: "string" },
      capture: { type: "string" },
      sequence: { type: "string" },
      annotation: { type: "string" },
      expected: { type: "string" },
      next: { type: "string" },
      operation: { type: "string" },
      fingerprint: { type: "string" },
      "owner-generation": { type: "string" },
      "connection-generation": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (parsed.positionals.length !== 1 || parsed.values.json !== true) {
    throw new Error("Invalid control command.");
  }
  const command = parsed.positionals[0];
  if (command === "submit") {
    const allowed = new Set([
      "instance", "capture", "sequence", "annotation", "expected", "next", "operation", "json",
    ]);
    if (Object.keys(parsed.values).some((key) => !allowed.has(key))) {
      throw new Error("Invalid submit option.");
    }
    const operationId = parsed.values.operation ?? createOperationId();
    const expectedSequence = parsePositiveInteger(parsed.values.sequence);
    const proposal = parseAnnotationLifecycleOperationProposal({
      schemaVersion: ANNOTATION_LIFECYCLE_CONTROL_SCHEMA_VERSION,
      kind: ANNOTATION_LIFECYCLE_OPERATION_PROPOSAL_KIND,
      operationId,
      instanceId: parsed.values.instance,
      captureId: parsed.values.capture,
      expectedSequence,
      annotationId: parsed.values.annotation,
      expectedState: parsed.values.expected,
      nextState: parsed.values.next,
    });
    if (!proposal.ok) throw new Error("Invalid lifecycle proposal.");
    return {
      command,
      path: "/v1/agent/annotation-lifecycle/proposals",
      body: proposal.value,
    };
  }
  if (command !== "status") throw new Error("Invalid control command.");
  const allowed = new Set([
    "operation", "fingerprint", "owner-generation", "connection-generation", "json",
  ]);
  if (Object.keys(parsed.values).some((key) => !allowed.has(key))) {
    throw new Error("Invalid status option.");
  }
  const operationId = parsed.values.operation;
  const fingerprint = parsed.values.fingerprint;
  const ownerGeneration = parsePositiveInteger(parsed.values["owner-generation"]);
  const connectionGeneration = parsePositiveInteger(parsed.values["connection-generation"]);
  if (
    typeof operationId !== "string" || !UUID_V4_PATTERN.test(operationId) ||
    typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint) ||
    ownerGeneration === null || connectionGeneration === null
  ) throw new Error("Invalid lifecycle operation reference.");
  return {
    command,
    path: "/v1/agent/annotation-lifecycle/proposals/status",
    body: { operationId, fingerprint, ownerGeneration, connectionGeneration },
  };
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function createDefaultDependencies(): Promise<AnnotationLifecycleControlCliDependencies> {
  const agentToken = await loadOrCreateLocalBridgeAgentToken();
  const expectedOwnerIdentity = loadLocalBridgeOwnerIdentity();
  return {
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
    request: (path, body) => requestControlOwner(
      agentToken,
      expectedOwnerIdentity,
      path,
      body,
    ),
  };
}

async function requestControlOwner(
  agentToken: string,
  expectedOwnerIdentity: LocalBridgeOwnerIdentity,
  path: string,
  bodyValue: unknown,
): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(bodyValue), "utf8");
  const auth = createLocalBridgeAgentBodyRequestAuth(agentToken, path, body, { method: "POST" });
  const response = await fetch(`${UI_ATTACH_LOCAL_BRIDGE_ORIGIN}${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { ...auth.headers, "content-type": "application/json" },
    body,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.byteLength > MAX_RESPONSE_BYTES ||
    !verifyLocalBridgeAgentBodyResponseProof(
      agentToken,
      auth,
      response.status,
      bytes,
      response.headers.get(RESPONSE_PROOF_HEADER),
    )
  ) throw new Error("Invalid local control response proof.");
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isControlOwnerEnvelope(value, expectedOwnerIdentity) || response.ok !== (
    (value as Record<string, unknown>).ok === true
  )) {
    throw new Error("Local control request was rejected.");
  }
  return value;
}

function isControlOwnerEnvelope(
  value: unknown,
  expectedOwnerIdentity: LocalBridgeOwnerIdentity,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION ||
      (record.ok !== true && record.ok !== false)) {
    return false;
  }
  const owner = record.ownerIdentity;
  return typeof owner === "object" && owner !== null && !Array.isArray(owner) &&
    Object.keys(owner).length === 3 &&
    (owner as Record<string, unknown>).executablePath === expectedOwnerIdentity.executablePath &&
    (owner as Record<string, unknown>).entryPath === expectedOwnerIdentity.entryPath &&
    (owner as Record<string, unknown>).buildHash === expectedOwnerIdentity.buildHash;
}

function isControlFailureResponse(value: unknown): value is Record<string, unknown> & {
  ok: false;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getOwnPropertyDescriptor(value, "ok")?.value === false;
}

function writeError(
  io: AnnotationLifecycleControlCliIo,
  exitCode: number,
  code: string,
  message: string,
): number {
  io.writeStderr(`${JSON.stringify({
    schemaVersion: UI_ATTACH_LOCAL_BRIDGE_SCHEMA_VERSION,
    kind: "ui-attach.local-bridge-error",
    ok: false,
    error: { code, message },
  })}\n`);
  return exitCode;
}
