import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createMeanThisMcpDescriptor,
  createMeanThisMcpHostSetup,
  createMeanThisStdioCompatibilityDescriptor,
  MEANTHIS_MCP_HTTP_TOKEN_ENV_VAR,
  MEANTHIS_MCP_HTTP_URL,
} from "./mcp-host-config";

const NODE_PATH = resolve("fixtures", "MeanThis path & (test)", "node executable");
const ENTRY_PATH = resolve("fixtures", "MeanThis 路径 & (test)", "dist", "index.js");
const BROKER_ENTRY_PATH = resolve(
  "fixtures",
  "MeanThis 路径 & (test)",
  "dist",
  "local-bridge-mcp-stdio-broker.js",
);

describe("MeanThis MCP host configuration", () => {
  test("creates one host-neutral thin stdio broker descriptor by default", () => {
    expect(createMeanThisMcpDescriptor()).toEqual({
      name: "meanthis",
      transport: {
        type: "stdio",
        command: resolve(process.execPath),
        args: [fileURLToPath(new URL("./local-bridge-mcp-stdio-broker.js", import.meta.url))],
        env: null,
        cwd: null,
      },
    });

    expect(createMeanThisMcpDescriptor(NODE_PATH, BROKER_ENTRY_PATH)).toEqual({
      name: "meanthis",
      transport: {
        type: "stdio",
        command: NODE_PATH,
        args: [BROKER_ENTRY_PATH],
        env: null,
        cwd: null,
      },
    });

    expect(MEANTHIS_MCP_HTTP_URL).toBe("http://127.0.0.1:38472/mcp");
    expect(MEANTHIS_MCP_HTTP_TOKEN_ENV_VAR).toBe("MEANTHIS_MCP_HTTP_TOKEN");
  });

  test("keeps stdio as an explicit compatibility-only descriptor", () => {
    expect(createMeanThisStdioCompatibilityDescriptor(NODE_PATH, ENTRY_PATH)).toEqual({
      name: "meanthis",
      transport: {
        type: "stdio_compatibility",
        command: NODE_PATH,
        args: [ENTRY_PATH, "mcp"],
        env: null,
        cwd: null,
      },
    });
  });

  test("renders the exact Codex broker command and structured readback expectation", () => {
    const descriptor = createMeanThisMcpDescriptor(NODE_PATH, BROKER_ENTRY_PATH);

    expect(createMeanThisMcpHostSetup("codex", descriptor)).toEqual({
      host: "codex",
      installation: "automated",
      verification: "structured_readback_available",
      artifact: "command",
      command: {
        executable: "codex",
        args: [
          "mcp",
          "add",
          "meanthis",
          "--",
          NODE_PATH,
          BROKER_ENTRY_PATH,
        ],
      },
      readback: {
        command: {
          executable: "codex",
          args: ["mcp", "get", "meanthis", "--json"],
        },
        expected: {
          name: "meanthis",
          enabled: true,
          transport: {
            type: "stdio",
            command: NODE_PATH,
            args: [BROKER_ENTRY_PATH],
            env: null,
            env_vars: [],
            cwd: null,
          },
        },
      },
      manual: null,
    });
  });

  test.each(["claude-code", "vscode", "cursor"] as const)(
    "marks %s setup as manual without emitting a token literal",
    (host) => {
      const setup = createMeanThisMcpHostSetup(
        host,
        createMeanThisMcpDescriptor(NODE_PATH, BROKER_ENTRY_PATH),
      );

      expect(setup).toEqual({
        host,
        installation: "manual",
        verification: "manual_required",
        artifact: "manual",
        command: null,
        readback: null,
        manual: {
          transport: "stdio",
          command: NODE_PATH,
          args: [BROKER_ENTRY_PATH],
          env: null,
          cwd: null,
        },
      });
      expect(JSON.stringify(setup)).not.toContain("Authorization");
      expect(JSON.stringify(setup)).not.toContain("Bearer ");
      expect(JSON.stringify(setup)).not.toContain("MEANTHIS_MCP_HTTP_TOKEN");
    },
  );
});
