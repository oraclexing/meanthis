# @meanthis/source-map-core

[English](./README.md) | [中文](./README_zh.md)

MeanThis Source Mapping v1 的可信本地校验与解析器。

> 状态：纳入九个 package release set 的 public-package candidate。它已经过机械 pack 验证，但尚未发布。

Resolver 把页面提供的每个 anchor 都视为不可信 routing data。它只读取已声明本地 workspace 下 canonical `.ui-attach/source-map.json` sidecar，拒绝 traversal 与 symlink escape，限制文件大小，并用记录的 SHA-256 hash 校验当前 source bytes。成功输出只包含 repository-relative location；verification hash 保持内部使用。

`resolveUIAttachSourceAcrossWorkspaces` 要求 supplied workspace roots 中只有一个 verified match。零匹配、多匹配、stale source bytes、malformed sidecar、unknown ID 与 workspace 外路径都会返回明确的 non-verified result。Bounded heuristic candidates 始终保持 `candidate`；confidence 本身永远不能把它升级为 `verified`。

独立的 public-package candidate `@meanthis/source-resolver-mcp` 会把这个 core 暴露为只读 `ui_attach_resolve_source` tool。它从 MCP client 的 `roots/list` response 获取 roots；如果 client 没有实现 roots，则只能使用 MCP process 继承到的 launch directory，且显式 roots 始终优先。Tool input 不接受 workspace-path override。Public `@meanthis/cli` companion 会把同一个 adapter 组合进三工具产品 surface；仅维护者使用的旧 diagnostics 必须显式开启 compatibility mode。

在 repository root 运行 `npm run verify:source-mapping-package-packs`，会打包这个 core、minimal MCP adapter、private Vite producer 及其 public schema dependency，把这些精确 tarballs 安装进隔离的 offline consumer，再验证 standalone MCP exchange、source maps、types、runtime imports、真实 Vite build 与 opaque-output boundary。该检查只建立 package readiness：它不会发布任何内容，Vite producer 仍不进入 public release set。
