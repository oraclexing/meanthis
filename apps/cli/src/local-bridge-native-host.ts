import type { Readable, Writable } from "node:stream";
import { UI_ATTACH_LOCAL_BRIDGE_ORIGIN } from "@meanthis/schema";
import { runBridgeCli } from "./bridge-cli.js";
import { readVerifiedLocalBridgeAgentToken } from "./local-bridge-agent-token.js";
import {
  loadLocalBridgeMcpHttpOwnerIdentity,
  probeLocalBridgeMcpHttpOwner,
  sameLocalBridgeMcpHttpOwnerIdentity,
} from "./local-bridge-mcp-http-owner.js";
import { readVerifiedLocalBridgeMcpHttpToken } from "./local-bridge-mcp-http-token.js";
import { createHttpLocalBridgeReader } from "./local-bridge-mcp.js";
import { loadLocalBridgeOwnerIdentity } from "./local-bridge-owner.js";
import { MEANTHIS_MCP_HTTP_URL } from "./mcp-host-config.js";
export {
  MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN,
  MEANTHIS_NATIVE_HOST_NAME,
} from "./local-bridge-native-host-contract.js";
import { MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN } from "./local-bridge-native-host-contract.js";

const NATIVE_MESSAGE_MAX_BYTES = 16 * 1024;
const REPAIR_REQUIRED_CODES = new Set([
  "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED",
  "MCP_HTTP_CREDENTIAL_ROTATION_REQUIRED",
]);
const ACTION_REQUIRED_CODES = new Set([
  "MCP_HTTP_UNVERIFIED_LISTENER",
  "MCP_HTTP_LEGACY_FOREGROUND_OWNER",
]);

interface NativeBridgeStartRequest {
  schemaVersion: "0.1.0";
  kind: "ui-attach.native-bridge-start" | "ui-attach.native-bridge-repair";
  requestId: string;
}

interface NativeBridgeStartSuccess {
  schemaVersion: "0.1.0";
  kind: "ui-attach.native-bridge-start-result";
  requestId: string;
  ok: true;
  data: { status: "ready" };
}

interface NativeBridgeStartFailure {
  schemaVersion: "0.1.0";
  kind: "ui-attach.native-bridge-start-result";
  requestId: string | null;
  ok: false;
  error: {
    code:
      | "NATIVE_CALLER_FORBIDDEN"
      | "NATIVE_REQUEST_INVALID"
      | "BRIDGE_REPAIR_REQUIRED"
      | "BRIDGE_SETUP_REQUIRED"
      | "BRIDGE_ACTION_REQUIRED"
      | "BRIDGE_START_FAILED";
  };
}

export type NativeBridgeStartResponse = NativeBridgeStartSuccess | NativeBridgeStartFailure;

export interface NativeBridgeCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeBridgeStartOptions {
  probeActiveOwners?: () => Promise<boolean>;
  runBridgeCommand?: (args: string[]) => Promise<NativeBridgeCliResult>;
}

interface ActiveLocalBridgeOwnersSnapshot {
  agentToken: string;
  mcpHttpToken: string;
  browserOwnerIdentity: ReturnType<typeof loadLocalBridgeOwnerIdentity>;
  mcpHttpOwnerIdentity: ReturnType<typeof loadLocalBridgeMcpHttpOwnerIdentity>;
}

export interface ActiveLocalBridgeOwnersProbeOptions {
  readSnapshot?: () => Promise<ActiveLocalBridgeOwnersSnapshot>;
  proveOwners?: (snapshot: Readonly<ActiveLocalBridgeOwnersSnapshot>) => Promise<void>;
}

export async function handleNativeBridgeStartRequest(options: {
  callerArgs: string[];
  message: unknown;
  startBridge?: () => Promise<NativeBridgeCliResult>;
  repairBridge?: () => Promise<NativeBridgeCliResult>;
}): Promise<NativeBridgeStartResponse> {
  const request = parseStartRequest(options.message);
  if (!isAllowedCaller(options.callerArgs)) {
    return failure(request?.requestId ?? null, "NATIVE_CALLER_FORBIDDEN");
  }
  if (!request) return failure(null, "NATIVE_REQUEST_INVALID");

  let result: NativeBridgeCliResult;
  try {
    result = request.kind === "ui-attach.native-bridge-repair"
      ? await (options.repairBridge ?? runBridgeRepair)()
      : await (options.startBridge ?? runBridgeStart)();
  } catch {
    return failure(request.requestId, "BRIDGE_START_FAILED");
  }
  if (result.exitCode === 0 && isBridgeStartSuccess(parseSingleJson(result.stdout))) {
    return {
      schemaVersion: "0.1.0",
      kind: "ui-attach.native-bridge-start-result",
      requestId: request.requestId,
      ok: true,
      data: { status: "ready" },
    };
  }
  const errorCode = readCliErrorCode(result.stderr);
  return failure(
    request.requestId,
    errorCode !== null && REPAIR_REQUIRED_CODES.has(errorCode)
      ? "BRIDGE_REPAIR_REQUIRED"
      : errorCode === "BRIDGE_SETUP_REQUIRED"
        ? "BRIDGE_SETUP_REQUIRED"
      : errorCode !== null && ACTION_REQUIRED_CODES.has(errorCode)
        ? "BRIDGE_ACTION_REQUIRED"
      : "BRIDGE_START_FAILED",
  );
}

export async function runLocalBridgeNativeMessagingHost(options: {
  callerArgs?: string[];
  stdin?: Readable;
  stdout?: Writable;
  startBridge?: () => Promise<NativeBridgeCliResult>;
  repairBridge?: () => Promise<NativeBridgeCliResult>;
} = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const callerArgs = options.callerArgs ?? process.argv.slice(2);
  if (!isAllowedCaller(callerArgs)) {
    await writeNativeMessage(stdout, failure(null, "NATIVE_CALLER_FORBIDDEN"));
    return;
  }
  let message: unknown;
  try {
    message = await readNativeMessage(stdin);
  } catch {
    await writeNativeMessage(stdout, failure(null, "NATIVE_REQUEST_INVALID"));
    return;
  }
  const response = await handleNativeBridgeStartRequest({
    callerArgs,
    message,
    startBridge: options.startBridge,
    repairBridge: options.repairBridge,
  });
  await writeNativeMessage(stdout, response);
}

export function encodeNativeMessageFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error("Native message is invalid.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeNativeMessageFrame(frame: Buffer): unknown {
  if (frame.length < 4) throw new Error("Native message is invalid.");
  const length = frame.readUInt32LE(0);
  if (length === 0 || length > NATIVE_MESSAGE_MAX_BYTES || frame.length !== length + 4) {
    throw new Error("Native message is invalid.");
  }
  try {
    return JSON.parse(frame.subarray(4).toString("utf8"));
  } catch {
    throw new Error("Native message is invalid.");
  }
}

async function runBridgeStart(): Promise<NativeBridgeCliResult> {
  return runNativeBridgeStart();
}

export async function runNativeBridgeStart(
  options: NativeBridgeStartOptions = {},
): Promise<NativeBridgeCliResult> {
  const runCommand = options.runBridgeCommand ?? runBridgeCommand;
  const activeOwners = await (options.probeActiveOwners ?? probeActiveLocalBridgeOwners)()
    .catch(() => false);
  if (activeOwners) return bridgeStartReady();
  const doctor = await runCommand(["doctor", "--json"]);
  const preflight = inspectDoctorResult(doctor);
  if (preflight !== "ready") return nativeCliFailure(preflight);
  return runCommand(["start", "--json"]);
}

async function runBridgeRepair(): Promise<NativeBridgeCliResult> {
  const doctor = await runBridgeCommand(["doctor", "--json"]);
  const state = readDoctorState(doctor);
  if (!state) return nativeCliFailure("BRIDGE_START_FAILED");
  if (state.listenerActionRequired || state.registration === "action_required" ||
      state.credentials === "action_required") {
    return nativeCliFailure("BRIDGE_ACTION_REQUIRED");
  }
  if (state.credentials === "repair_required") {
    const rotated = await runBridgeCommand([
      "rotate-agent-token",
      "--host",
      "codex",
      "--json",
    ]);
    if (rotated.exitCode !== 0) return rotated;
  }
  if (state.registration === "setup_required") {
    const installed = await runBridgeCommand(["install", "--host", "codex", "--json"]);
    if (installed.exitCode !== 0) return installed;
  }
  return runBridgeStart();
}

function inspectDoctorResult(result: NativeBridgeCliResult):
  "ready" | "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED" | "BRIDGE_SETUP_REQUIRED" |
  "BRIDGE_ACTION_REQUIRED" | "BRIDGE_START_FAILED" {
  const state = readDoctorState(result);
  if (!state) return "BRIDGE_START_FAILED";
  if (state.listenerActionRequired || state.registration === "action_required" ||
      state.credentials === "action_required") return "BRIDGE_ACTION_REQUIRED";
  if (state.credentials === "repair_required") {
    return "BRIDGE_AGENT_CREDENTIAL_ROTATION_REQUIRED";
  }
  return state.registration === "setup_required" ? "BRIDGE_SETUP_REQUIRED" : "ready";
}

export async function probeActiveLocalBridgeOwners(
  options: ActiveLocalBridgeOwnersProbeOptions = {},
): Promise<boolean> {
  try {
    const readSnapshot = options.readSnapshot ?? readActiveLocalBridgeOwnersSnapshot;
    const before = await readSnapshot();
    await (options.proveOwners ?? proveActiveLocalBridgeOwners)(before);
    const after = await readSnapshot();
    return sameActiveLocalBridgeOwnersSnapshot(before, after);
  } catch {
    return false;
  }
}

async function readActiveLocalBridgeOwnersSnapshot(): Promise<ActiveLocalBridgeOwnersSnapshot> {
  const [agentToken, mcpHttpToken] = await Promise.all([
    readVerifiedLocalBridgeAgentToken(),
    readVerifiedLocalBridgeMcpHttpToken(),
  ]);
  return {
    agentToken,
    mcpHttpToken,
    browserOwnerIdentity: loadLocalBridgeOwnerIdentity(),
    mcpHttpOwnerIdentity: loadLocalBridgeMcpHttpOwnerIdentity(),
  };
}

async function proveActiveLocalBridgeOwners(
  snapshot: Readonly<ActiveLocalBridgeOwnersSnapshot>,
): Promise<void> {
  const browserReader = createHttpLocalBridgeReader(
    UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
    snapshot.agentToken,
    {
      expectedOwnerIdentity: snapshot.browserOwnerIdentity,
      requestTimeoutMs: 750,
    },
  );
  await Promise.all([
    browserReader.getStatus(),
    probeLocalBridgeMcpHttpOwner(snapshot.mcpHttpToken, snapshot.mcpHttpOwnerIdentity, {
      requestTimeoutMs: 750,
    }),
  ]);
}

function sameActiveLocalBridgeOwnersSnapshot(
  left: Readonly<ActiveLocalBridgeOwnersSnapshot>,
  right: Readonly<ActiveLocalBridgeOwnersSnapshot>,
): boolean {
  return left.agentToken === right.agentToken &&
    left.mcpHttpToken === right.mcpHttpToken &&
    sameOwnerIdentity(left.browserOwnerIdentity, right.browserOwnerIdentity) &&
    sameLocalBridgeMcpHttpOwnerIdentity(left.mcpHttpOwnerIdentity, right.mcpHttpOwnerIdentity);
}

function sameOwnerIdentity(
  left: ReturnType<typeof loadLocalBridgeOwnerIdentity>,
  right: ReturnType<typeof loadLocalBridgeOwnerIdentity>,
): boolean {
  return left.executablePath === right.executablePath &&
    left.entryPath === right.entryPath &&
    left.buildHash === right.buildHash;
}

function bridgeStartReady(): NativeBridgeCliResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      schemaVersion: "0.1.0",
      kind: "ui-attach.bridge-start",
      ok: true,
      data: {
        runtimeActive: true,
        browserOrigin: UI_ATTACH_LOCAL_BRIDGE_ORIGIN,
        mcpHttpUrl: MEANTHIS_MCP_HTTP_URL,
      },
    })}\n`,
    stderr: "",
  };
}

function readDoctorState(result: NativeBridgeCliResult): {
  credentials: "ready" | "repair_required" | "action_required";
  listenerActionRequired: boolean;
  registration: "ready" | "setup_required" | "action_required";
} | null {
  if (result.exitCode !== 0) return null;
  const value = parseSingleJson(result.stdout);
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data) ||
      !isRecord(value.data.checks)) return null;
  const checks = value.data.checks;
  const registrationStatus = isRecord(checks.registration) ? checks.registration.status : null;
  const agentStatus = isRecord(checks.agentCredential) ? checks.agentCredential.status : null;
  const credentialStatus = isRecord(checks.credential) ? checks.credential.status : null;
  const ownerStatus = isRecord(checks.mcpHttpOwner) ? checks.mcpHttpOwner.status : null;
  const registration = value.data.registrationReady === true && registrationStatus === "current"
    ? "ready"
    : registrationStatus === "missing" || registrationStatus === "legacy"
      ? "setup_required"
      : "action_required";
  const statuses = [agentStatus, credentialStatus];
  const credentials = statuses.includes("insecure")
    ? "repair_required"
    : statuses.every((status) => status === "ready" || status === "missing")
      ? "ready"
      : "action_required";
  return {
    credentials,
    listenerActionRequired: ownerStatus === "unverified_listener" ||
      ownerStatus === "legacy_foreground",
    registration,
  };
}

function nativeCliFailure(code: string): NativeBridgeCliResult {
  return {
    exitCode: 5,
    stdout: "",
    stderr: `${JSON.stringify({ ok: false, error: { code } })}\n`,
  };
}

async function runBridgeCommand(args: string[]): Promise<NativeBridgeCliResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runBridgeCli(args, {
    writeStdout(value) {
      stdout += value;
    },
    writeStderr(value) {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
}

async function readNativeMessage(stream: Readable): Promise<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || length > NATIVE_MESSAGE_MAX_BYTES) {
        throw new Error("Native message is invalid.");
      }
      if (buffered.length > length + 4) {
        throw new Error("Native message is invalid.");
      }
      if (buffered.length === length + 4) {
        return decodeNativeMessageFrame(buffered);
      }
    }
    if (buffered.length > NATIVE_MESSAGE_MAX_BYTES + 4) {
      throw new Error("Native message is invalid.");
    }
  }
  throw new Error("Native message is invalid.");
}

function writeNativeMessage(stream: Writable, value: unknown): Promise<void> {
  const frame = encodeNativeMessageFrame(value);
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => error ? reject(error) : resolve());
  });
}

function parseStartRequest(value: unknown): NativeBridgeStartRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "kind", "requestId"])) {
    return null;
  }
  return value.schemaVersion === "0.1.0" &&
      (value.kind === "ui-attach.native-bridge-start" ||
        value.kind === "ui-attach.native-bridge-repair") &&
      typeof value.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
    ? value as unknown as NativeBridgeStartRequest
    : null;
}

function isAllowedCaller(args: string[]): boolean {
  return args[0] === MEANTHIS_NATIVE_HOST_EXTENSION_ORIGIN &&
    (args.length === 1 || (args.length === 2 && /^--parent-window=\d+$/.test(args[1])));
}

function readCliErrorCode(value: string): string | null {
  const parsed = parseSingleJson(value);
  return isRecord(parsed) && parsed.ok === false && isRecord(parsed.error) &&
      typeof parsed.error.code === "string"
    ? parsed.error.code
    : null;
}

function parseSingleJson(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function isBridgeStartSuccess(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === "0.1.0" &&
    value.kind === "ui-attach.bridge-start" && value.ok === true &&
    isRecord(value.data) && value.data.runtimeActive === true;
}

function failure(
  requestId: string | null,
  code: NativeBridgeStartFailure["error"]["code"],
): NativeBridgeStartFailure {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.native-bridge-start-result",
    requestId,
    ok: false,
    error: { code },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
