import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createMeanThisMcpDescriptor,
  createMeanThisMcpHostSetup,
} from "./mcp-host-config";

const NODE_PATH = resolve("fixtures", "MeanThis path & (test)", "node executable");
const ENTRY_PATH = resolve("fixtures", "MeanThis 路径 & (test)", "dist", "index.js");

describe("MeanThis MCP host configuration", () => {
  test("creates one host-neutral stdio descriptor", () => {
    expect(createMeanThisMcpDescriptor(NODE_PATH, ENTRY_PATH)).toEqual({
      name: "meanthis",
      transport: {
        type: "stdio",
        command: NODE_PATH,
        args: [ENTRY_PATH, "mcp"],
        env: null,
        cwd: null,
      },
    });
  });

  test("renders Codex and Claude Code commands from the same descriptor", () => {
    const descriptor = createMeanThisMcpDescriptor(NODE_PATH, ENTRY_PATH);

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
          ENTRY_PATH,
          "mcp",
        ],
      },
      config: null,
      configPath: null,
    });

    expect(createMeanThisMcpHostSetup("claude-code", descriptor)).toEqual({
      host: "claude-code",
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
          "meanthis",
          "--",
          NODE_PATH,
          ENTRY_PATH,
          "mcp",
        ],
      },
      config: null,
      configPath: null,
    });
  });

  test("renders VS Code and Cursor configuration without shell quoting", () => {
    const descriptor = createMeanThisMcpDescriptor(NODE_PATH, ENTRY_PATH);
    const vscodeServer = {
      name: "meanthis",
      type: "stdio",
      command: NODE_PATH,
      args: [ENTRY_PATH, "mcp"],
    };

    expect(createMeanThisMcpHostSetup("vscode", descriptor)).toEqual({
      host: "vscode",
      installation: "generated_only",
      verification: "manual_required",
      artifact: "command_and_config",
      command: {
        executable: "code",
        args: ["--add-mcp", JSON.stringify(vscodeServer)],
      },
      config: vscodeServer,
      configPath: null,
    });

    expect(createMeanThisMcpHostSetup("cursor", descriptor)).toEqual({
      host: "cursor",
      installation: "generated_only",
      verification: "manual_required",
      artifact: "config",
      command: null,
      config: {
        mcpServers: {
          "meanthis": {
            command: NODE_PATH,
            args: [ENTRY_PATH, "mcp"],
          },
        },
      },
      configPath: "~/.cursor/mcp.json",
    });
  });
});
