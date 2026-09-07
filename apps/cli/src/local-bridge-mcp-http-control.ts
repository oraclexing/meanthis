import {
  CancelledNotificationSchema,
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";

export const MEANTHIS_MCP_HTTP_CONTROL_HEADER = "x-meanthis-mcp-control" as const;
export const MEANTHIS_MCP_HTTP_CONTROL_VALUE = "broker-v1" as const;

export function isLocalBridgeMcpHttpControlMessage(value: unknown): boolean {
  if (isCancelledNotificationCandidate(value)) {
    return isExactCancelledNotification(value);
  }
  return isJSONRPCResponse(value) || isJSONRPCErrorResponse(value);
}

export function createLocalBridgeMcpHttpControlAwareFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete(MEANTHIS_MCP_HTTP_CONTROL_HEADER);
    if (isControlHttpRequest(init)) {
      headers.set(MEANTHIS_MCP_HTTP_CONTROL_HEADER, MEANTHIS_MCP_HTTP_CONTROL_VALUE);
    }
    return baseFetch(input, { ...init, headers });
  };
}

function isControlHttpRequest(init: RequestInit | undefined): boolean {
  const method = init?.method?.toUpperCase();
  if (method === "DELETE") return true;
  const body = init?.body;
  if (method !== "POST" || typeof body !== "string") return false;
  try {
    return isLocalBridgeMcpHttpControlMessage(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

function isCancelledNotificationCandidate(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return isRecord(value) && value.method === "notifications/cancelled";
}

function isExactCancelledNotification(
  value: Record<PropertyKey, unknown>,
): boolean {
  if (Object.hasOwn(value, "id") || value.jsonrpc !== "2.0") return false;
  if (!hasOnlyOwnKeys(value, ["jsonrpc", "method", "params"])) return false;

  const params = value.params;
  if (!isRecord(params) || !hasOnlyOwnKeys(params, ["_meta", "requestId", "reason"])) {
    return false;
  }

  return CancelledNotificationSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyOwnKeys(
  value: Record<PropertyKey, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set<PropertyKey>(allowedKeys);
  return Reflect.ownKeys(value).every((key) => allowed.has(key));
}
