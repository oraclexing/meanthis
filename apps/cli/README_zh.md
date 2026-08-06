# MeanThis Companion

[English](./README.md) | 中文

`@meanthis/cli` 是 MeanThis 浏览器扩展的可选本地 companion。它通过只读 MCP surface，把用户明确批准且经过 Agent-safe 处理的捕获提供给本地 Agent。它不会控制浏览器、点击、输入、修改源文件，也不会把捕获发送到 MeanThis 托管服务。

## 安装

需要 Node.js `^22.12.0` 或 `^24.0.0`。

```sh
npm install --global @meanthis/cli
```

把默认 MCP surface 注册到 Codex：

```sh
meanthis bridge install --codex --json
```

随后重启 Agent client，打开 MeanThis 侧边栏，展开**本地 Agent 桥接**，选择信任范围，再点击**创建并复制请求**。复制出的请求只能粘贴到预期的本地 Agent 对话中。

## 默认 MCP surface

`meanthis mcp` 精确暴露三个只读工具：

- `ui_attach_list_captures` 列出当前已连接浏览器会话明确共享的 capture 的有界 metadata。
- `ui_attach_read_capture` 按渐进式详细程度读取一个精确 capture revision。
- `ui_attach_resolve_source` 在 MCP workspace roots 下，依据可信本地 sidecar 解析 opaque source anchor。

维护者使用的旧 diagnostics 只有在显式运行 `meanthis mcp --compatibility` 时才会出现，不属于推荐的产品流程。

Capture-session 文件与 stdin 输入会在 JSON 解析前限制为 1 MiB；`bundle --intent-file` 输入限制为 256 KiB。

## 信任与隐私

桥接只绑定 `127.0.0.1`，默认断开，并且需要明确的浏览器手势与短时本地批准。默认公开路径只接受 Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`，不提供 runtime 或 environment override。浏览器扩展只有在用户创建连接请求时，才会申请可选 loopback host permission。批准材料必须留在同一设备上，不能粘贴到网页、公开 issue、日志或提交文件中。

完整边界请参阅仓库的[隐私声明](../../PRIVACY_zh.md)与[安全策略](../../SECURITY_zh.md)。

## 状态

`0.1.0` 是尚未发布的 candidate。Package metadata 与 offline pack checks 只是在准备公开安装路径，并不代表 package 已发布。
