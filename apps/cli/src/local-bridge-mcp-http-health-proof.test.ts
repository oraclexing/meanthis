import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  LocalBridgeMcpHttpBearerTokenError,
  MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
  createLocalBridgeMcpHttpHealthProofRequest,
  createLocalBridgeMcpHttpHealthProofResponse,
  isLocalBridgeMcpHttpVerifiedOwnerHealth,
  verifyLocalBridgeMcpHttpHealthProofRequest,
  verifyLocalBridgeMcpHttpHealthProofResponse,
} from "./local-bridge-mcp-http-health-proof.js";

const NOW = 1_700_000_000_000;
const PORT = 38_472;
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const FOREIGN_TOKEN = Buffer.alloc(32, 8).toString("base64url");

describe("MeanThis MCP HTTP health proof", () => {
  test("preserves the exact v1 request and response canonical contract", () => {
    const requestNonce = Buffer.alloc(32, 1).toString("base64url");
    const request = createLocalBridgeMcpHttpHealthProofRequest(TOKEN, {
      port: PORT,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 1),
    });
    const emptyBodyHash = createHash("sha256").update("", "utf8").digest("hex");
    const expectedRequestProof = createHmac("sha256", Buffer.from(TOKEN, "base64url"))
      .update([
        "meanthis-mcp-http-health-proof-v1",
        "request",
        "GET",
        "/health",
        `127.0.0.1:${PORT}`,
        String(NOW),
        requestNonce,
        emptyBodyHash,
      ].join("\n"), "utf8")
      .digest("base64url");
    expect(request).toMatchObject({
      timestamp: String(NOW),
      nonce: requestNonce,
      proof: expectedRequestProof,
    });

    const body = '{"ok":true}\n';
    const responseNonce = Buffer.alloc(32, 2).toString("base64url");
    const response = createLocalBridgeMcpHttpHealthProofResponse(TOKEN, request, body, {
      port: PORT,
      status: 200,
      now: () => NOW + 1,
      randomBytes: () => Buffer.alloc(32, 2),
    });
    const expectedResponseProof = createHmac("sha256", Buffer.from(TOKEN, "base64url"))
      .update([
        "meanthis-mcp-http-health-proof-v1",
        "response",
        "GET",
        "/health",
        `127.0.0.1:${PORT}`,
        request.timestamp,
        request.nonce,
        request.proof,
        "200",
        String(NOW + 1),
        responseNonce,
        createHash("sha256").update(body, "utf8").digest("hex"),
      ].join("\n"), "utf8")
      .digest("base64url");
    expect(response).toMatchObject({
      timestamp: String(NOW + 1),
      nonce: responseNonce,
      proof: expectedResponseProof,
    });

    expect(() => createLocalBridgeMcpHttpHealthProofRequest("invalid"))
      .toThrow(LocalBridgeMcpHttpBearerTokenError);
  });

  test("round-trips request and response proofs while rejecting a foreign key", () => {
    const request = createLocalBridgeMcpHttpHealthProofRequest(TOKEN, {
      port: PORT,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 3),
    });

    expect(verifyLocalBridgeMcpHttpHealthProofRequest(
      TOKEN,
      request,
      { port: PORT, now: () => NOW },
    )).toBe(true);
    expect(verifyLocalBridgeMcpHttpHealthProofRequest(
      FOREIGN_TOKEN,
      request,
      { port: PORT, now: () => NOW },
    )).toBe(false);

    const body = '{"ok":true}\n';
    const response = createLocalBridgeMcpHttpHealthProofResponse(TOKEN, request, body, {
      port: PORT,
      status: 200,
      now: () => NOW + 1,
      randomBytes: () => Buffer.alloc(32, 4),
    });
    const responseInput = {
      port: PORT,
      status: 200,
      headers: new Headers(response.headers),
      body,
    };

    expect(verifyLocalBridgeMcpHttpHealthProofResponse(
      TOKEN,
      request,
      responseInput,
      { now: () => NOW + 1 },
    )).toBe(true);
    expect(verifyLocalBridgeMcpHttpHealthProofResponse(
      FOREIGN_TOKEN,
      request,
      responseInput,
      { now: () => NOW + 1 },
    )).toBe(false);
  });

  test("rejects non-canonical and tampered request or response inputs", () => {
    const request = createLocalBridgeMcpHttpHealthProofRequest(TOKEN, {
      port: PORT,
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 5),
    });
    expect(verifyLocalBridgeMcpHttpHealthProofRequest(
      TOKEN,
      { ...request, proof: tamperCanonicalBase64url(request.proof) },
      { port: PORT, now: () => NOW },
    )).toBe(false);
    expect(verifyLocalBridgeMcpHttpHealthProofRequest(
      TOKEN,
      { ...request, nonce: malleateBase64urlPadBits(request.nonce) },
      { port: PORT, now: () => NOW },
    )).toBe(false);
    expect(verifyLocalBridgeMcpHttpHealthProofRequest(
      TOKEN,
      request,
      { port: PORT + 1, now: () => NOW },
    )).toBe(false);
    for (const current of [NOW - 30_000, NOW + 30_000]) {
      expect(verifyLocalBridgeMcpHttpHealthProofRequest(
        TOKEN,
        request,
        { port: PORT, now: () => current },
      )).toBe(true);
    }
    for (const current of [NOW - 30_001, NOW + 30_001]) {
      expect(verifyLocalBridgeMcpHttpHealthProofRequest(
        TOKEN,
        request,
        { port: PORT, now: () => current },
      )).toBe(false);
    }

    const body = '{"ok":true}\n';
    const response = createLocalBridgeMcpHttpHealthProofResponse(TOKEN, request, body, {
      port: PORT,
      status: 200,
      now: () => NOW + 1,
      randomBytes: () => Buffer.alloc(32, 6),
    });
    const headers = new Headers(response.headers);
    const tamperedHeaders = new Headers(headers);
    tamperedHeaders.set(
      MEANTHIS_MCP_HTTP_HEALTH_RESPONSE_PROOF_HEADER,
      tamperCanonicalBase64url(response.proof),
    );

    for (const input of [
      { port: PORT, status: 200, headers: tamperedHeaders, body },
      { port: PORT, status: 200, headers, body: `${body} ` },
      { port: PORT, status: 201, headers, body },
      { port: PORT + 1, status: 200, headers, body },
    ]) {
      expect(verifyLocalBridgeMcpHttpHealthProofResponse(
        TOKEN,
        request,
        input,
        { now: () => NOW + 1 },
      )).toBe(false);
    }
  });

  test("recognizes only an authenticated health payload with an exact owner build identity", () => {
    const health = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.mcp-http-health",
      ok: true,
      transport: "streamable-http",
      endpoint: "/mcp",
      ownerIdentity: { buildHash: "a".repeat(64) },
      activeSessions: 1,
    };

    expect(isLocalBridgeMcpHttpVerifiedOwnerHealth(health)).toBe(true);
    expect(isLocalBridgeMcpHttpVerifiedOwnerHealth({ ...health, ownerIdentity: null })).toBe(false);
    expect(isLocalBridgeMcpHttpVerifiedOwnerHealth({
      ...health,
      ownerIdentity: { buildHash: "a".repeat(64), executablePath: "private" },
    })).toBe(false);
    expect(isLocalBridgeMcpHttpVerifiedOwnerHealth({ ...health, endpoint: "/health" })).toBe(false);
  });
});

function tamperCanonicalBase64url(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

function malleateBase64urlPadBits(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  if (value.length !== 43 || lastIndex < 0 || (lastIndex & 0b11) !== 0) {
    throw new Error("Expected canonical unpadded base64url for 32 bytes.");
  }
  return `${value.slice(0, -1)}${alphabet[lastIndex | 0b01]}`;
}
