import { describe, expect, test, vi } from "vitest";
import {
  MEANTHIS_MCP_HTTP_CONTROL_HEADER,
  createLocalBridgeMcpHttpControlAwareFetch,
  isLocalBridgeMcpHttpControlMessage,
} from "./local-bridge-mcp-http-control.js";

describe("local bridge MCP HTTP control messages", () => {
  test("accepts an exact cancelled notification without an own id", () => {
    expect(isLocalBridgeMcpHttpControlMessage({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId: 7,
        reason: "stopped",
        _meta: { progressToken: "progress-1" },
      },
    })).toBe(true);
  });

  test("rejects a cancelled pseudo-request with its own id", async () => {
    const observed: RequestInit[] = [];
    const baseFetch: typeof fetch = vi.fn(async (_input, init) => {
      observed.push(init ?? {});
      return new Response(null, { status: 200 });
    });
    const controlFetch = createLocalBridgeMcpHttpControlAwareFetch(baseFetch);
    const message = {
      jsonrpc: "2.0",
      id: 91,
      method: "notifications/cancelled",
      params: { requestId: 7 },
    };

    expect(isLocalBridgeMcpHttpControlMessage(message)).toBe(false);
    await controlFetch("http://127.0.0.1/mcp", {
      method: "POST",
      body: JSON.stringify(message),
    });

    expect(new Headers(observed[0]?.headers).has(MEANTHIS_MCP_HTTP_CONTROL_HEADER))
      .toBe(false);
  });

  test.each([
    ["missing JSON-RPC envelope", {
      method: "notifications/cancelled",
      params: { requestId: 7 },
    }],
    ["wrong JSON-RPC version", {
      jsonrpc: "1.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    }],
    ["extra top-level field", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
      extra: true,
    }],
    ["extra params field", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, extra: true },
    }],
    ["missing params", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    }],
    ["malformed request id", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: {} },
    }],
    ["malformed reason", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: 1 },
    }],
    ["malformed metadata", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, _meta: "not-an-object" },
    }],
  ])("rejects %s", (_label, message) => {
    expect(isLocalBridgeMcpHttpControlMessage(message)).toBe(false);
  });
});
