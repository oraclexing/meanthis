import {
  createHash,
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const MEANTHIS_MCP_HTTP_HOST = "127.0.0.1" as const;
export const MEANTHIS_MCP_HTTP_DEFAULT_PORT = 38472 as const;
export const MEANTHIS_MCP_HTTP_PATH = "/mcp" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_KIND = "ui-attach.mcp-http-health" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER =
  "x-meanthis-health-timestamp" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER = "x-meanthis-health-nonce" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER = "x-meanthis-health-proof" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER =
  "x-meanthis-health-response-timestamp" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER =
  "x-meanthis-health-response-nonce" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER =
  "x-meanthis-health-response-proof" as const;
export const MEANTHIS_MCP_HTTP_HEALTH_PROOF_MAX_CLOCK_SKEW_MS = 30_000;

const HEALTH_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEALTH_PROOF_VERSION = "meanthis-mcp-http-health-proof-v1";
const EMPTY_BODY_HASH = createHash("sha256").update("", "utf8").digest("hex");

export interface LocalBridgeMcpHttpHealthProofRequest {
  timestamp: string;
  nonce: string;
  proof: string;
  headers: Record<string, string>;
}

export interface LocalBridgeMcpHttpHealthProofResponse {
  timestamp: string;
  nonce: string;
  proof: string;
  headers: Record<string, string>;
}

export interface LocalBridgeMcpHttpVerifiedOwnerHealth {
  schemaVersion: "0.1.0";
  kind: typeof MEANTHIS_MCP_HTTP_HEALTH_KIND;
  ok: true;
  transport: "streamable-http";
  endpoint: typeof MEANTHIS_MCP_HTTP_PATH;
  ownerIdentity: { buildHash: string };
}

export class LocalBridgeMcpHttpBearerTokenError extends Error {
  readonly code = "MCP_HTTP_BEARER_TOKEN_UNAVAILABLE";

  constructor() {
    super(
      "MeanThis MCP HTTP requires an independent 32-byte base64url mcp-http-key-v1 bearer token in MEANTHIS_MCP_HTTP_TOKEN.",
    );
    this.name = "LocalBridgeMcpHttpBearerTokenError";
  }
}

export function createLocalBridgeMcpHttpHealthProofRequest(
  bearerToken: string,
  options: {
    port?: number;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
  } = {},
): LocalBridgeMcpHttpHealthProofRequest {
  const token = requireMcpHttpBearerToken(bearerToken);
  const port = validateHealthProofPort(options.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT);
  const timestamp = createHealthProofTimestamp(options.now ?? Date.now);
  const nonce = createHealthProofNonce(options.randomBytes);
  const proof = createHealthProofHmac(token, canonicalHealthProofRequest({
    host: `${MEANTHIS_MCP_HTTP_HOST}:${port}`,
    timestamp,
    nonce,
  }));
  return {
    timestamp,
    nonce,
    proof,
    headers: {
      [MEANTHIS_MCP_HTTP_HEALTH_TIMESTAMP_HEADER]: timestamp,
      [MEANTHIS_MCP_HTTP_HEALTH_NONCE_HEADER]: nonce,
      [MEANTHIS_MCP_HTTP_HEALTH_PROOF_HEADER]: proof,
    },
  };
}

export function verifyLocalBridgeMcpHttpHealthProofRequest(
  bearerToken: string,
  requestProof: Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof">,
  options: { port?: number; now?: () => number } = {},
): boolean {
  try {
    const token = requireMcpHttpBearerToken(bearerToken);
    validateHealthProofRequestShape(requestProof);
    if (!isFreshHealthProofTimestamp(requestProof.timestamp, options.now ?? Date.now)) return false;
    const port = validateHealthProofPort(options.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT);
    const expected = createHealthProofHmac(token, canonicalHealthProofRequest({
      host: `${MEANTHIS_MCP_HTTP_HOST}:${port}`,
      timestamp: requestProof.timestamp,
      nonce: requestProof.nonce,
    }));
    return equalCanonicalHealthProof(requestProof.proof, expected);
  } catch {
    return false;
  }
}

export function createLocalBridgeMcpHttpHealthProofResponse(
  bearerToken: string,
  requestProof: Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof">,
  body: string,
  options: {
    port?: number;
    status?: number;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
  } = {},
): LocalBridgeMcpHttpHealthProofResponse {
  const token = requireMcpHttpBearerToken(bearerToken);
  validateHealthProofRequestShape(requestProof);
  const port = validateHealthProofPort(options.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT);
  const status = options.status ?? 200;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new Error("Invalid MeanThis MCP HTTP health proof status.");
  }
  const timestamp = createHealthProofTimestamp(options.now ?? Date.now);
  const nonce = createHealthProofNonce(options.randomBytes);
  const proof = createHealthProofHmac(token, canonicalHealthProofResponse({
    host: `${MEANTHIS_MCP_HTTP_HOST}:${port}`,
    request: requestProof,
    status,
    timestamp,
    nonce,
    bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
  }));
  return {
    timestamp,
    nonce,
    proof,
    headers: {
      [MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER]: timestamp,
      [MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER]: nonce,
      [MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER]: proof,
    },
  };
}

export function verifyLocalBridgeMcpHttpHealthProofResponse(
  bearerToken: string,
  requestProof: Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof">,
  response: {
    port?: number;
    status: number;
    headers: Pick<Headers, "get">;
    body: string;
  },
  options: { now?: () => number } = {},
): boolean {
  try {
    const token = requireMcpHttpBearerToken(bearerToken);
    validateHealthProofRequestShape(requestProof);
    const port = validateHealthProofPort(response.port ?? MEANTHIS_MCP_HTTP_DEFAULT_PORT);
    const timestamp = response.headers.get(MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_TIMESTAMP_HEADER);
    const nonce = response.headers.get(MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_NONCE_HEADER);
    const proof = response.headers.get(MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER);
    if (!timestamp || !nonce || !proof || !isFreshHealthProofTimestamp(
      timestamp,
      options.now ?? Date.now,
    )) return false;
    if (!isCanonicalHealthProofValue(nonce) || !isCanonicalHealthProofValue(proof)) return false;
    const expected = createHealthProofHmac(token, canonicalHealthProofResponse({
      host: `${MEANTHIS_MCP_HTTP_HOST}:${port}`,
      request: requestProof,
      status: response.status,
      timestamp,
      nonce,
      bodyHash: createHash("sha256").update(response.body, "utf8").digest("hex"),
    }));
    return equalCanonicalHealthProof(proof, expected);
  } catch {
    return false;
  }
}

export function isLocalBridgeMcpHttpVerifiedOwnerHealth(
  value: unknown,
): value is LocalBridgeMcpHttpVerifiedOwnerHealth {
  if (!isRecord(value)) return false;
  const ownerIdentity = value.ownerIdentity;
  return value.schemaVersion === "0.1.0" &&
    value.kind === MEANTHIS_MCP_HTTP_HEALTH_KIND &&
    value.ok === true &&
    value.transport === "streamable-http" &&
    value.endpoint === MEANTHIS_MCP_HTTP_PATH &&
    isRecord(ownerIdentity) &&
    Object.keys(ownerIdentity).length === 1 &&
    typeof ownerIdentity.buildHash === "string" &&
    /^[a-f0-9]{64}$/.test(ownerIdentity.buildHash);
}

function createHealthProofTimestamp(now: () => number): string {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid MeanThis MCP HTTP health proof timestamp.");
  }
  return String(value);
}

function isFreshHealthProofTimestamp(timestamp: string, now: () => number): boolean {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(timestamp)) return false;
  const value = Number(timestamp);
  const current = now();
  return Number.isSafeInteger(value) && Number.isSafeInteger(current) &&
    Math.abs(current - value) <= MEANTHIS_MCP_HTTP_HEALTH_PROOF_MAX_CLOCK_SKEW_MS;
}

function createHealthProofNonce(randomBytes?: (size: number) => Uint8Array): string {
  const bytes = (randomBytes ?? secureRandomBytes)(32);
  if (bytes.byteLength !== 32) {
    throw new Error("Invalid MeanThis MCP HTTP health proof nonce.");
  }
  const nonce = Buffer.from(bytes).toString("base64url");
  if (!isCanonicalHealthProofValue(nonce)) {
    throw new Error("Invalid MeanThis MCP HTTP health proof nonce.");
  }
  return nonce;
}

function validateHealthProofPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid MeanThis MCP HTTP health proof port.");
  }
  return port;
}

function validateHealthProofRequestShape(
  value: Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof">,
): void {
  if (
    !/^(?:0|[1-9]\d{0,15})$/.test(value.timestamp) ||
    !isCanonicalHealthProofValue(value.nonce) ||
    !isCanonicalHealthProofValue(value.proof)
  ) {
    throw new Error("Invalid MeanThis MCP HTTP health proof request.");
  }
}

function canonicalHealthProofRequest(value: {
  host: string;
  timestamp: string;
  nonce: string;
}): string {
  return [
    HEALTH_PROOF_VERSION,
    "request",
    "GET",
    "/health",
    value.host,
    value.timestamp,
    value.nonce,
    EMPTY_BODY_HASH,
  ].join("\n");
}

function canonicalHealthProofResponse(value: {
  host: string;
  request: Pick<LocalBridgeMcpHttpHealthProofRequest, "timestamp" | "nonce" | "proof">;
  status: number;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [
    HEALTH_PROOF_VERSION,
    "response",
    "GET",
    "/health",
    value.host,
    value.request.timestamp,
    value.request.nonce,
    value.request.proof,
    String(value.status),
    value.timestamp,
    value.nonce,
    value.bodyHash,
  ].join("\n");
}

function createHealthProofHmac(bearerToken: string, canonical: string): string {
  return createHmac("sha256", Buffer.from(bearerToken, "base64url"))
    .update(canonical, "utf8")
    .digest("base64url");
}

function equalCanonicalHealthProof(left: string, right: string): boolean {
  if (!isCanonicalHealthProofValue(left) || !isCanonicalHealthProofValue(right)) return false;
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return timingSafeEqual(leftBytes, rightBytes);
}

function isCanonicalHealthProofValue(value: string): boolean {
  if (!HEALTH_PROOF_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function requireMcpHttpBearerToken(value: string | undefined): string {
  if (!value || !isCanonicalHealthProofValue(value)) {
    throw new LocalBridgeMcpHttpBearerTokenError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
