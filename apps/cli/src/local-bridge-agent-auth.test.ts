import { describe, expect, test } from "vitest";
import {
  createLocalBridgeAgentRequestAuth,
  createLocalBridgeAgentResponseProof,
  openLocalBridgeApprovalKey,
  sealLocalBridgeApprovalKey,
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
