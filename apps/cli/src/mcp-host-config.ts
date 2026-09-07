import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEANTHIS_MCP_HTTP_TOKEN_ENV } from "./local-bridge-mcp-http-token.js";

export const MEANTHIS_MCP_REGISTRATION_NAME = "meanthis";
export const MEANTHIS_MCP_HTTP_URL = "http://127.0.0.1:38472/mcp";
export const MEANTHIS_MCP_HTTP_TOKEN_ENV_VAR = MEANTHIS_MCP_HTTP_TOKEN_ENV;

export type MeanThisMcpHost = "codex" | "claude-code" | "vscode" | "cursor";

export interface MeanThisStdioBrokerMcpDescriptor {
  name: typeof MEANTHIS_MCP_REGISTRATION_NAME;
  transport: {
    type: "stdio";
    command: string;
    args: [string];
    env: null;
    cwd: null;
  };
}

export interface MeanThisStdioCompatibilityMcpDescriptor {
  name: typeof MEANTHIS_MCP_REGISTRATION_NAME;
  transport: {
    type: "stdio_compatibility";
    command: string;
    args: string[];
    env: null;
    cwd: null;
  };
}

export type MeanThisMcpDescriptor = MeanThisStdioBrokerMcpDescriptor;

interface HostCommand {
  executable: string;
  args: string[];
}

interface CodexReadbackExpectation {
  command: HostCommand;
  expected: {
    name: typeof MEANTHIS_MCP_REGISTRATION_NAME;
    enabled: true;
    transport: {
      type: "stdio";
      command: string;
      args: [string];
      env: null;
      env_vars: [];
      cwd: null;
    };
  };
}

export interface MeanThisCodexMcpHostSetup {
  host: "codex";
  installation: "automated";
  verification: "structured_readback_available";
  artifact: "command";
  command: HostCommand;
  readback: CodexReadbackExpectation;
  manual: null;
}

export interface MeanThisManualMcpHostSetup {
  host: Exclude<MeanThisMcpHost, "codex">;
  installation: "manual";
  verification: "manual_required";
  artifact: "manual";
  command: null;
  readback: null;
  manual: {
    transport: "stdio";
    command: string;
    args: [string];
    env: null;
    cwd: null;
  };
}

export type MeanThisMcpHostSetup =
  | MeanThisCodexMcpHostSetup
  | MeanThisManualMcpHostSetup;

export function createMeanThisMcpDescriptor(
  nodePath: string = process.execPath,
  brokerEntryPath: string = fileURLToPath(
    new URL("./local-bridge-mcp-stdio-broker.js", import.meta.url),
  ),
): MeanThisStdioBrokerMcpDescriptor {
  return {
    name: MEANTHIS_MCP_REGISTRATION_NAME,
    transport: {
      type: "stdio",
      command: resolve(nodePath),
      args: [resolve(brokerEntryPath)],
      env: null,
      cwd: null,
    },
  };
}

export function createMeanThisStdioCompatibilityDescriptor(
  nodePath: string,
  entryPath: string,
): MeanThisStdioCompatibilityMcpDescriptor {
  return {
    name: MEANTHIS_MCP_REGISTRATION_NAME,
    transport: {
      type: "stdio_compatibility",
      command: resolve(nodePath),
      args: [resolve(entryPath), "mcp"],
      env: null,
      cwd: null,
    },
  };
}

export function createMeanThisMcpHostSetup(
  host: MeanThisMcpHost,
  descriptor: MeanThisStdioBrokerMcpDescriptor,
): MeanThisMcpHostSetup {
  if (host === "codex") {
    return {
      host,
      installation: "automated",
      verification: "structured_readback_available",
      artifact: "command",
      command: {
        executable: "codex",
        args: [
          "mcp",
          "add",
          descriptor.name,
          "--",
          descriptor.transport.command,
          ...descriptor.transport.args,
        ],
      },
      readback: {
        command: {
          executable: "codex",
          args: ["mcp", "get", descriptor.name, "--json"],
        },
        expected: {
          name: descriptor.name,
          enabled: true,
          transport: {
            type: "stdio",
            command: descriptor.transport.command,
            args: descriptor.transport.args,
            env: null,
            env_vars: [],
            cwd: null,
          },
        },
      },
      manual: null,
    };
  }

  return {
    host,
    installation: "manual",
    verification: "manual_required",
    artifact: "manual",
    command: null,
    readback: null,
    manual: {
      transport: "stdio",
      command: descriptor.transport.command,
      args: descriptor.transport.args,
      env: null,
      cwd: null,
    },
  };
}
