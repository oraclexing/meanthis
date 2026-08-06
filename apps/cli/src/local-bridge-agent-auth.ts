import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { LocalBridgeApprovalMode } from "@meanthis/schema";

const REQUEST_TIMESTAMP_HEADER = "x-ui-attach-agent-timestamp";
const REQUEST_NONCE_HEADER = "x-ui-attach-agent-nonce";
const REQUEST_PROOF_HEADER = "x-ui-attach-agent-proof";
export const RESPONSE_PROOF_HEADER = "x-ui-attach-agent-response-proof";
const MAX_CLOCK_SKEW_MS = 10_000;
const APPROVAL_KEY_SEAL_VERSION = "ui-attach-local-bridge-approval-key-v1";

export interface LocalBridgeApprovalOwnerIdentity {
  executablePath: string;
  entryPath: string;
  buildHash: string;
}

export interface LocalBridgeApprovalSealContext {
  requestId: string;
  approvalMode: LocalBridgeApprovalMode;
  approvalVerifier: string;
  expectedOwnerIdentity: LocalBridgeApprovalOwnerIdentity;
}

export interface LocalBridgeAgentRequestAuth {
  method: "GET" | "POST";
  path: string;
  timestamp: string;
  nonce: string;
  headers: Record<string, string>;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export function createLocalBridgeAgentRequestAuth(
  token: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
  } = {},
): LocalBridgeAgentRequestAuth {
  validateToken(token);
  if (!path.startsWith("/v1/agent/")) throw new Error("Invalid local bridge agent path.");
  const timestamp = String((options.now ?? Date.now)());
  const nonce = Buffer.from(
    (options.randomBytes ?? ((size: number) => secureRandomBytes(size)))(16),
  ).toString("base64url");
  if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) {
    throw new Error("Invalid local bridge agent request entropy.");
  }
  const method = options.method ?? "GET";
  const proof = sign(token, canonicalRequest(method, path, timestamp, nonce));
  return {
    method,
    path,
    timestamp,
    nonce,
    headers: {
      [REQUEST_TIMESTAMP_HEADER]: timestamp,
      [REQUEST_NONCE_HEADER]: nonce,
      [REQUEST_PROOF_HEADER]: proof,
    },
  };
}

export function verifyLocalBridgeAgentRequestAuth(
  token: string,
  method: string,
  path: string,
  headers: HeaderSource,
  seenNonces: Map<string, number>,
  now = Date.now(),
): LocalBridgeAgentRequestAuth | null {
  validateToken(token);
  if ((method !== "GET" && method !== "POST") || !path.startsWith("/v1/agent/")) return null;
  const timestamp = readHeader(headers, REQUEST_TIMESTAMP_HEADER);
  const nonce = readHeader(headers, REQUEST_NONCE_HEADER);
  const proof = readHeader(headers, REQUEST_PROOF_HEADER);
  if (
    !timestamp || !/^\d{13}$/.test(timestamp) ||
    !nonce || !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
    !proof || !/^[A-Za-z0-9_-]{43}$/.test(proof)
  ) {
    return null;
  }
  const requestTime = Number(timestamp);
  if (!Number.isSafeInteger(requestTime) || Math.abs(now - requestTime) > MAX_CLOCK_SKEW_MS) {
    return null;
  }
  for (const [knownNonce, observedAt] of seenNonces) {
    if (now - observedAt > MAX_CLOCK_SKEW_MS) seenNonces.delete(knownNonce);
  }
  if (seenNonces.has(nonce)) return null;
  const expected = sign(token, canonicalRequest(method, path, timestamp, nonce));
  if (!sameProof(expected, proof)) return null;
  seenNonces.set(nonce, now);
  return {
    method,
    path,
    timestamp,
    nonce,
    headers: {
      [REQUEST_TIMESTAMP_HEADER]: timestamp,
      [REQUEST_NONCE_HEADER]: nonce,
      [REQUEST_PROOF_HEADER]: proof,
    },
  };
}

export function createLocalBridgeAgentResponseProof(
  token: string,
  request: LocalBridgeAgentRequestAuth,
  status: number,
  body: string,
): string {
  validateToken(token);
  return sign(token, canonicalResponse(request, status, body));
}

export function verifyLocalBridgeAgentResponseProof(
  token: string,
  request: LocalBridgeAgentRequestAuth,
  status: number,
  body: string,
  receivedProof: string | null,
): boolean {
  if (!receivedProof || !/^[A-Za-z0-9_-]{43}$/.test(receivedProof)) return false;
  const expected = createLocalBridgeAgentResponseProof(token, request, status, body);
  return sameProof(expected, receivedProof);
}

export function sealLocalBridgeApprovalKey(
  token: string,
  context: LocalBridgeApprovalSealContext,
  approvalKey: string,
  options: { randomBytes?: (size: number) => Uint8Array } = {},
): string {
  validateToken(token);
  validateApprovalSealContext(context);
  if (!/^[A-Za-z0-9_-]{43}$/.test(approvalKey)) {
    throw new Error("Invalid local bridge approval key.");
  }
  const approvalKeyBytes = Buffer.from(approvalKey, "base64url");
  if (approvalKeyBytes.length !== 32 || approvalVerifier(approvalKeyBytes) !== context.approvalVerifier) {
    throw new Error("Local bridge approval key does not match its verifier.");
  }
  const nonce = Buffer.from(
    (options.randomBytes ?? ((size: number) => secureRandomBytes(size)))(12),
  );
  if (nonce.length !== 12) throw new Error("Invalid local bridge approval nonce.");
  const cipher = createCipheriv("aes-256-gcm", deriveApprovalSealKey(token, context), nonce);
  cipher.setAAD(approvalSealAad(context));
  const ciphertext = Buffer.concat([cipher.update(approvalKeyBytes), cipher.final()]);
  const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  if (!/^[A-Za-z0-9_-]{80}$/.test(sealed)) {
    throw new Error("Invalid sealed local bridge approval key.");
  }
  return sealed;
}

export function openLocalBridgeApprovalKey(
  token: string,
  context: LocalBridgeApprovalSealContext,
  sealed: string,
): string | null {
  try {
    validateToken(token);
    validateApprovalSealContext(context);
    if (!/^[A-Za-z0-9_-]{80}$/.test(sealed)) return null;
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length !== 60) return null;
    const nonce = bytes.subarray(0, 12);
    const ciphertext = bytes.subarray(12, 44);
    const authTag = bytes.subarray(44);
    const decipher = createDecipheriv("aes-256-gcm", deriveApprovalSealKey(token, context), nonce);
    decipher.setAAD(approvalSealAad(context));
    decipher.setAuthTag(authTag);
    const approvalKeyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (
      approvalKeyBytes.length !== 32 ||
      approvalVerifier(approvalKeyBytes) !== context.approvalVerifier
    ) {
      return null;
    }
    return approvalKeyBytes.toString("base64url");
  } catch {
    return null;
  }
}

function canonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
): string {
  return ["ui-attach-agent-request-v2", method, path, timestamp, nonce].join("\0");
}

function canonicalResponse(
  request: LocalBridgeAgentRequestAuth,
  status: number,
  body: string,
): string {
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  return [
    "ui-attach-agent-response-v2",
    request.method,
    request.path,
    request.timestamp,
    request.nonce,
    String(status),
    digest,
  ].join("\0");
}

function sign(token: string, value: string): string {
  return createHmac("sha256", Buffer.from(token, "base64url"))
    .update(value, "utf8")
    .digest("base64url");
}

function sameProof(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "ascii");
  const right = Buffer.from(received, "ascii");
  return left.length === right.length && timingSafeEqual(left, right);
}

function deriveApprovalSealKey(
  token: string,
  context: LocalBridgeApprovalSealContext,
): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(token, "base64url"),
    Buffer.from(APPROVAL_KEY_SEAL_VERSION, "utf8"),
    Buffer.from(canonicalOwnerIdentity(context.expectedOwnerIdentity), "utf8"),
    32,
  ));
}

function approvalSealAad(context: LocalBridgeApprovalSealContext): Buffer {
  return Buffer.from([
    APPROVAL_KEY_SEAL_VERSION,
    context.requestId,
    context.approvalMode,
    context.approvalVerifier,
    canonicalOwnerIdentity(context.expectedOwnerIdentity),
  ].join("\0"), "utf8");
}

function canonicalOwnerIdentity(identity: LocalBridgeApprovalOwnerIdentity): string {
  return [identity.executablePath, identity.entryPath, identity.buildHash].join("\0");
}

function approvalVerifier(approvalKeyBytes: Uint8Array): string {
  return createHash("sha256").update(approvalKeyBytes).digest("base64url");
}

function validateApprovalSealContext(context: LocalBridgeApprovalSealContext): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.requestId) ||
    (context.approvalMode !== "ask" && context.approvalMode !== "browser_session") ||
    !/^[A-Za-z0-9_-]{43}$/.test(context.approvalVerifier) ||
    !isApprovalOwnerIdentity(context.expectedOwnerIdentity)
  ) {
    throw new Error("Invalid local bridge approval seal context.");
  }
}

function isApprovalOwnerIdentity(value: LocalBridgeApprovalOwnerIdentity): boolean {
  return typeof value.executablePath === "string" && value.executablePath.length > 0 &&
    typeof value.entryPath === "string" && value.entryPath.length > 0 &&
    /^[0-9a-f]{64}$/.test(value.buildHash);
}

function readHeader(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

function validateToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid local bridge agent token.");
  }
}
