# MeanThis Companion

[English](./README.md) | 中文

`@meanthis/cli` 是 MeanThis 浏览器扩展的可选本地 companion。它通过只读 MCP surface，把用户明确批准且经过 Agent-safe 处理的捕获提供给本地 Agent。它不会控制浏览器、点击、输入、修改源文件，也不会把捕获发送到 MeanThis 托管服务。

## 安装

需要 Node.js `^22.12.0` 或 `^24.0.0`。

`0.1.0` 仍未发布。从当前 checkout 安装：

```sh
npm ci
npm run build:bridge
npm link --workspace @meanthis/cli
```

Package 发布后的预期等价命令是：

```sh
npm install --global @meanthis/cli
```

## 同一个 MCP server，多个宿主

`meanthis mcp` 在所有 client 中启动的是同一套标准 stdio MCP server。公开 registration name 是 `meanthis`；底层 `ui-attach.*` schema kind 继续作为稳定兼容标识，这并不表示 server 只支持 Codex。

Codex 是第一个自动化 adapter，因为它的 CLI 支持结构化 registration 读回与精确移除：

```sh
meanthis bridge install --host codex --json
```

该命令还会启动并验证 detached local owner。它会安全迁移指向同一安装的精确 legacy `ui-attach` registration，绝不会覆盖冲突 registration。只要 MCP host process 仍在运行，它就会每 15 秒续订一次经过认证的 owner lease，并在 owner 丢失后重新创建；所有 host process 都退出后，owner 仍会在 30 分钟没有认证活动时关闭。

旧命令 `meanthis bridge install --codex --json` 继续兼容。对于其他宿主，MeanThis 只生成官方 command 或 JSON，不会修改宿主：

```sh
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

应用生成的 artifact 后运行 `meanthis bridge start --json`，这样 extension 可在 host 第一次调用 MCP tool 前连接。Host 启动 MCP server 后，同一 lease 机制会让 owner 保持可用。

| 宿主 | 生成的 setup | 自动验证 |
| --- | --- | --- |
| Codex | `codex mcp add` registration | 有：结构化精确读回 |
| Claude Code | `claude mcp add --transport stdio` argv | 无：需在 Claude Code 中执行并验证 |
| VS Code | `code --add-mcp` argv 与 server JSON | 无：需在 VS Code 中执行并验证 |
| Cursor | 写入 `~/.cursor/mcp.json` 的 `mcpServers` JSON | 无：需合并后在 Cursor 中验证 |

JSON output 同时包含共享的 absolute-path stdio descriptor 与 host-specific setup。Command 以 executable 加 argv 的结构返回，不拼接 shell quoted string。

随后重启 Agent client，打开 MeanThis 侧边栏，展开**本地 Agent 桥接**，选择信任范围，再点击**创建并复制请求**。复制出的请求只能粘贴到预期的本地 Agent 对话中。

## 默认 MCP surface

`meanthis mcp` 精确暴露三个只读工具：

- `meanthis_list_captures` 列出当前已连接浏览器会话明确共享的 capture 的有界 metadata。
- `meanthis_read_capture` 按渐进式详细程度读取一个精确 capture revision。
- `meanthis_resolve_source` 在 MCP workspace roots 下，依据可信本地 sidecar 解析 opaque source anchor。

维护者使用的旧 diagnostics 只有在显式运行 `meanthis mcp --compatibility` 时才会出现，不属于推荐的产品流程。

Capture-session 文件与 stdin 输入会在 JSON 解析前限制为 1 MiB；`bundle --intent-file` 输入限制为 256 KiB。

## 信任与隐私

桥接只绑定 `127.0.0.1`，默认断开，并且需要明确的浏览器手势与短时本地批准。默认公开路径只接受 Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`，不提供 runtime 或 environment override。浏览器扩展只有在用户创建连接请求时，才会申请可选 loopback host permission。批准材料必须留在同一设备上，不能粘贴到网页、公开 issue、日志或提交文件中。

完整边界请参阅仓库的[隐私声明](../../PRIVACY_zh.md)与[安全策略](../../SECURITY_zh.md)。

## 状态

`0.1.0` 是尚未发布的 candidate。Package metadata 与 offline pack checks 只是在准备公开安装路径，并不代表 package 已发布。
