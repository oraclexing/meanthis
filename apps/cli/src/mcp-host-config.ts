import { resolve } from "node:path";

export const MEANTHIS_MCP_REGISTRATION_NAME = "meanthis";

export type MeanThisMcpHost = "codex" | "claude-code" | "vscode" | "cursor";

export interface MeanThisMcpDescriptor {
  name: typeof MEANTHIS_MCP_REGISTRATION_NAME;
  transport: {
    type: "stdio";
    command: string;
    args: string[];
    env: null;
    cwd: null;
  };
}

interface HostCommand {
  executable: string;
  args: string[];
}

export interface MeanThisMcpHostSetup {
  host: MeanThisMcpHost;
  installation: "automated" | "generated_only";
  verification: "structured_readback_available" | "manual_required";
  artifact: "command" | "command_and_config" | "config";
  command: HostCommand | null;
  config: Record<string, unknown> | null;
  configPath: string | null;
}

export function createMeanThisMcpDescriptor(
  nodePath: string,
  entryPath: string,
): MeanThisMcpDescriptor {
  return {
    name: MEANTHIS_MCP_REGISTRATION_NAME,
    transport: {
      type: "stdio",
      command: resolve(nodePath),
      args: [resolve(entryPath), "mcp"],
      env: null,
      cwd: null,
    },
  };
}

export function createMeanThisMcpHostSetup(
  host: MeanThisMcpHost,
  descriptor: MeanThisMcpDescriptor,
): MeanThisMcpHostSetup {
  const server = {
    command: descriptor.transport.command,
    args: [...descriptor.transport.args],
  };

  switch (host) {
    case "codex":
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
            server.command,
            ...server.args,
          ],
        },
        config: null,
        configPath: null,
      };
    case "claude-code":
      return {
        host,
        installation: "generated_only",
        verification: "manual_required",
        artifact: "command",
        command: {
          executable: "claude",
          args: [
            "mcp",
            "add",
            "--transport",
            "stdio",
            "--scope",
            "user",
            descriptor.name,
            "--",
            server.command,
            ...server.args,
          ],
        },
        config: null,
        configPath: null,
      };
    case "vscode": {
      const config = { name: descriptor.name, type: "stdio", ...server };
      return {
        host,
        installation: "generated_only",
        verification: "manual_required",
        artifact: "command_and_config",
        command: {
          executable: "code",
          args: ["--add-mcp", JSON.stringify(config)],
        },
        config,
        configPath: null,
      };
    }
    case "cursor":
      return {
        host,
        installation: "generated_only",
        verification: "manual_required",
        artifact: "config",
        command: null,
        config: { mcpServers: { [descriptor.name]: server } },
        configPath: "~/.cursor/mcp.json",
      };
  }
}
