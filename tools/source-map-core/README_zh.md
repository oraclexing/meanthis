# @meanthis/source-map-core

[English](./README.md) | 中文

MeanThis Source Mapping v1 的可信本地校验与解析。

> 状态：纳入九个 package release set 的 public-package candidate。它已经过机械 pack 验证，但尚未发布。

Resolver 会把页面提供的每个 anchor 都视为不可信 routing data。它只读取已声明本地 workspace 下的 canonical `.ui-attach/source-map.json` sidecar，拒绝 traversal 与 symlink escape，限制文件大小，并用记录的 SHA-256 hash 校验当前 source bytes。成功输出只包含 repository-relative location；verification hash 保持内部使用。

Verified location 会保留 sidecar entry kind。Intrinsic location 包含 `tagName`；显式配置的 JSX host-component callsite 则包含 `callsiteKind: "configured_jsx_component"` 与本地 JSX `callsiteName`，不会虚构 DOM tag。后者只证明记录的 source callsite 与当前 source bytes；不证明 component 在 runtime 中转发了另一组 opaque callsite attributes，也不会暴露 producer 配置的 module specifier 或 export identity。

## Verified lexical component breadcrumb

Verified location 还可能包含 `componentBreadcrumb`：同一 source file 内由 `{ path, line, column, componentName }` frames 组成的 lexical breadcrumb，顺序为 outer→inner，最多保留最近 3 层。只有当前 source bytes 匹配 entry 记录的 hash 后才会发出。这是 lexical source evidence，不是 React Fiber 或 runtime stack，也不是跨文件推断。`candidate` 与 `unavailable` result 不包含 breadcrumb。Response 不会包含 source text、`contentHash`、`workspaceRoot`、absolute paths，也不授予 browser/source write authority。

`resolveUIAttachSourceAcrossWorkspaces` 要求在提供的 workspace roots 中得到唯一 verified match。零 match、多 match、stale source bytes、格式错误的 sidecar、未知 ID 与 workspace 外路径都会返回明确的 non-verified result。Bounded heuristic candidates 仍然是 `candidate`；confidence 单独不能把它升级为 `verified`。

独立的 public-package candidate `@meanthis/source-resolver-mcp` 会把这个 core 暴露为只读 `meanthis_resolve_source` tool。它从 MCP client 的 `roots/list` response 获取 roots。如果 client 没有实现 roots，只能使用 MCP process 继承的 launch directory；显式 roots 始终优先。Tool input 不接受 workspace-path override。公开的 `@meanthis/cli` companion 会把同一 adapter 组合成 product surface，提供四个只读工具 `meanthis_list_captures`、metadata-only 的有界 `meanthis_wait_capture_change`、`meanthis_read_capture` 与 `meanthis_resolve_source`，以及窄、瞬态的 `meanthis_ack_capture_read` acknowledgement mutation；maintainer-only legacy diagnostics 需要显式 compatibility mode。

## 验证

在 repository root 运行 focused workspace checks，然后运行 public package verification：

```powershell
npm --workspace @meanthis/source-map-core test
npm --workspace @meanthis/source-map-core run build
npm run verify:packages
```

Focused tests 会覆盖 source-map sidecar 校验、traversal 与 symlink boundary、stale-byte rejection、唯一 verified resolution，以及 opaque-output boundary。Root package verification 会在隔离 consumer 中构建并 pack-verify 九个 public workspace。它不会执行被排除的 private Vite producer，不会发布任何内容，也不能证明 live source-map integration。
