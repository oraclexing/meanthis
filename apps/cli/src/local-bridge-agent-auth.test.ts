import { describe, expect, test } from "vitest";
import {
  createLocalBridgeAgentBodyRequestAuth,
  createLocalBridgeAgentBodyResponseProof,
  createLocalBridgeAgentRequestAuth,
  createLocalBridgeAgentResponseProof,
  openLocalBridgeApprovalKey,
  sealLocalBridgeApprovalKey,
  verifyLocalBridgeAgentBodyRequestAuth,
  verifyLocalBridgeAgentBodyResponseProof,
  verifyLocalBridgeAgentRequestAuth,
  verifyLocalBridgeAgentResponseProof,
} from "./local-bridge-agent-auth";

const TOKEN = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws";
const NOW = 1_768_454_400_000;
const OWNER_IDENTITY = {
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  entryPath: "C:\\fixtures\\ui-attach\\apps\\cli\\dist\\index.js",
  buildHash: "a".repeat(64),
};

describe("local bridge mutual agent authentication", () => {
  test("accepts one fresh request proof and rejects replay or expiry", () => {
    const request = createLocalBridgeAgentRequestAuth(TOKEN, "/v1/agent/status", {
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
    const seen = new Map<string, number>();

    expect(verifyLocalBridgeAgentRequestAuth(
      TOKEN,
      "GET",
      request.path,
      new Headers(request.headers),
      seen,
      NOW,
    )).toMatchObject({ nonce: request.nonce });
    expect(verifyLocalBridgeAgentRequestAuth(
      TOKEN,
      "GET",
      request.path,
      new Headers(request.headers),
      seen,
      NOW,
    )).toBeNull();
    expect(verifyLocalBridgeAgentRequestAuth(
      TOKEN,
      "GET",
      request.path,
      new Headers(request.headers),
      new Map(),
      NOW + 10_001,
    )).toBeNull();
  });

  test("binds the owner proof to request, status, and exact response bytes", () => {
    const request = createLocalBridgeAgentRequestAuth(TOKEN, "/v1/agent/status", {
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
    const body = '{"ok":true}\n';
    const proof = createLocalBridgeAgentResponseProof(TOKEN, request, 200, body);

    expect(verifyLocalBridgeAgentResponseProof(TOKEN, request, 200, body, proof)).toBe(true);
    expect(verifyLocalBridgeAgentResponseProof(TOKEN, request, 200, `${body} `, proof)).toBe(false);
    expect(verifyLocalBridgeAgentResponseProof(TOKEN, request, 404, body, proof)).toBe(false);
  });

  test("binds body-auth request proofs to the exact raw body bytes", () => {
    const path = "/v1/agent/annotation-lifecycle/proposals";
    const body = Buffer.from('{"nextState":"resolved"}\n', "utf8");
    const request = createLocalBridgeAgentBodyRequestAuth(TOKEN, path, body, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 17),
    });

    expect(request.bodySha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(request.headers),
      new Map(),
      NOW,
    )).toMatchObject({
      method: "POST",
      path,
      bodySha256: request.bodySha256,
    });
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      Buffer.from('{"nextState":"resolved"}', "utf8"),
      new Headers(request.headers),
      new Map(),
      NOW,
    )).toBeNull();
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      JSON.stringify({ nextState: "resolved" }) as unknown as Uint8Array,
      new Headers(request.headers),
      new Map(),
      NOW,
    )).toBeNull();
  });

  test("rejects body-auth tampering of method, path, timestamp, nonce, body, and token", () => {
    const path = "/v1/agent/annotation-lifecycle/proposals";
    const body = Buffer.from("raw-body-v1", "utf8");
    const request = createLocalBridgeAgentBodyRequestAuth(TOKEN, path, body, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 18),
    });
    const verify = (
      token: string,
      method: string,
      requestPath: string,
      requestBody: Uint8Array,
      headers: Headers,
      now = NOW,
    ) => verifyLocalBridgeAgentBodyRequestAuth(
      token,
      method,
      requestPath,
      requestBody,
      headers,
      new Map(),
      now,
    );

    expect(verify(TOKEN, "GET", path, body, new Headers(request.headers))).toBeNull();
    expect(verify(TOKEN, "POST", `${path}/other`, body, new Headers(request.headers))).toBeNull();
    expect(verify(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(request.headers),
      NOW + 10_001,
    )).toBeNull();

    const changedTimestamp = new Headers(request.headers);
    changedTimestamp.set("x-ui-attach-agent-timestamp", String(NOW + 1));
    expect(verify(TOKEN, "POST", path, body, changedTimestamp)).toBeNull();

    const changedNonce = new Headers(request.headers);
    changedNonce.set("x-ui-attach-agent-nonce", Buffer.alloc(16, 19).toString("base64url"));
    expect(verify(TOKEN, "POST", path, body, changedNonce)).toBeNull();
    expect(verify(TOKEN, "POST", path, Buffer.from("raw-body-v2", "utf8"), new Headers(request.headers)))
      .toBeNull();
    expect(verify(
      "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      "POST",
      path,
      body,
      new Headers(request.headers),
    )).toBeNull();

    const oldAuth = createLocalBridgeAgentRequestAuth(TOKEN, path, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 18),
    });
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(oldAuth.headers),
      new Map(),
      NOW,
    )).toBeNull();
  });

  test("rejects body-auth nonce replay and accepts a fresh nonce after expiry", () => {
    const path = "/v1/agent/annotation-lifecycle/proposals";
    const body = Buffer.from("proposal", "utf8");
    const request = createLocalBridgeAgentBodyRequestAuth(TOKEN, path, body, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 20),
    });
    const seen = new Map<string, number>();

    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(request.headers),
      seen,
      NOW,
    )).not.toBeNull();
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(request.headers),
      seen,
      NOW,
    )).toBeNull();

    const fresh = createLocalBridgeAgentBodyRequestAuth(TOKEN, path, body, {
      method: "POST",
      now: () => NOW + 10_001,
      randomBytes: (size) => Buffer.alloc(size, 21),
    });
    expect(verifyLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      "POST",
      path,
      body,
      new Headers(fresh.headers),
      seen,
      NOW + 10_001,
    )).not.toBeNull();
  });

  test("binds body-auth response proofs to request and exact response bytes", () => {
    const path = "/v1/agent/annotation-lifecycle/proposals";
    const requestBody = Buffer.from("request-bytes", "utf8");
    const request = createLocalBridgeAgentBodyRequestAuth(TOKEN, path, requestBody, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 22),
    });
    const responseBody = Buffer.from('{"state":"resolved"}\n', "utf8");
    const proof = createLocalBridgeAgentBodyResponseProof(TOKEN, request, 200, responseBody);

    expect(verifyLocalBridgeAgentBodyResponseProof(
      TOKEN,
      request,
      200,
      responseBody,
      proof,
    )).toBe(true);
    expect(verifyLocalBridgeAgentBodyResponseProof(
      TOKEN,
      request,
      200,
      Buffer.from('{"state":"resolved"}', "utf8"),
      proof,
    )).toBe(false);
    expect(verifyLocalBridgeAgentBodyResponseProof(
      TOKEN,
      request,
      201,
      responseBody,
      proof,
    )).toBe(false);

    const sameMetadataDifferentBody = createLocalBridgeAgentBodyRequestAuth(
      TOKEN,
      path,
      Buffer.from("different-request-bytes", "utf8"),
      {
        method: "POST",
        now: () => NOW,
        randomBytes: (size) => Buffer.alloc(size, 22),
      },
    );
    expect(verifyLocalBridgeAgentBodyResponseProof(
      TOKEN,
      sameMetadataDifferentBody,
      200,
      responseBody,
      proof,
    )).toBe(false);
    expect(verifyLocalBridgeAgentBodyResponseProof(
      "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      request,
      200,
      responseBody,
      proof,
    )).toBe(false);
    expect(verifyLocalBridgeAgentBodyResponseProof(
      TOKEN,
      request,
      200,
      JSON.stringify({ state: "resolved" }) as unknown as Uint8Array,
      proof,
    )).toBe(false);
  });

  test("binds approval authorization to the POST method", () => {
    const path = "/v1/agent/connection-requests/95e3e7b1-6f74-44ae-8954-e11f7f2a7c58/approve";
    const request = createLocalBridgeAgentRequestAuth(TOKEN, path, {
      method: "POST",
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });

    expect(request.method).toBe("POST");
    expect(verifyLocalBridgeAgentRequestAuth(
      TOKEN,
      "POST",
      path,
      new Headers(request.headers),
      new Map(),
      NOW,
    )).toMatchObject({ method: "POST", path });
    expect(verifyLocalBridgeAgentRequestAuth(
      TOKEN,
      "GET",
      path,
      new Headers(request.headers),
      new Map(),
      NOW,
    )).toBeNull();
  });

  test("seals the copied approval key to the authenticated owner credential", () => {
    const requestId = "95e3e7b1-6f74-44ae-8954-e11f7f2a7c58";
    const approvalKey = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
    const context = {
      requestId,
      approvalMode: "ask" as const,
      approvalVerifier: "MIwc-JegXDWE1xhuMLuAumhs4XH1TLOAsg-rk3mfc0E",
      expectedOwnerIdentity: OWNER_IDENTITY,
    };
    const sealed = sealLocalBridgeApprovalKey(TOKEN, context, approvalKey, {
      randomBytes: (size) => Buffer.alloc(size, 14),
    });

    expect(sealed).toMatch(/^[A-Za-z0-9_-]{80}$/);
    expect(sealed).not.toContain(approvalKey);
    expect(openLocalBridgeApprovalKey(TOKEN, context, sealed)).toBe(approvalKey);
    expect(openLocalBridgeApprovalKey(TOKEN, {
      ...context,
      requestId: "20a85d08-3aed-4c24-9006-221db95ab33c",
    }, sealed))
      .toBeNull();
    expect(openLocalBridgeApprovalKey(
      "DwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
      context,
      sealed,
    )).toBeNull();
    expect(openLocalBridgeApprovalKey(TOKEN, {
      ...context,
      expectedOwnerIdentity: { ...OWNER_IDENTITY, buildHash: "b".repeat(64) },
    }, sealed)).toBeNull();
  });
});
