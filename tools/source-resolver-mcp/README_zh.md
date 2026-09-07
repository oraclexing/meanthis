# @meanthis/source-resolver-mcp

[English](./README.md) | 中文

> 状态：纳入九个 package release set 的 public-package candidate。它已经过机械 pack 验证，但尚未发布。

这个 package 是 MeanThis Source Mapping v1 的最小只读 MCP adapter。它的 stdio server 只暴露一个 tool：`meanthis_resolve_source`，并把校验委托给 `@meanthis/source-map-core`。

它不会启动或连接 MeanThis browser bridge，不会读取 browser credential、创建 approval request、持有 loopback state，也不暴露 click、type、navigate、script、file-write 或其他 browser-control capability。当 coding agent 只需要把**复制给 Agent**中的 opaque source anchor 转换成经过本地校验的 repository-relative source location 时，应使用这条路径。

## Tool 契约

把 handoff 的 `Source Anchor Tool Input` block 中完整 object 作为 `meanthis_resolve_source` 的全部输入，不要添加 `resolverInput` 或其他 wrapper。Adapter 接受一个 opaque `sourceAnchor`，以及最多五个 bounded heuristic `candidates`。

Standalone server 优先使用 MCP client 声明的 `file://` workspace roots。如果 client 没有实现 roots capability，则只能使用该 client 传给 MCP process 的 launch directory。已声明 roots 始终优先，tool input 不能覆盖 workspace path。调用 `createSourceResolverMcpServer()` 的 library host 也可以显式注入可信的 `listWorkspaceRoots` provider；该 host-owned seam 优先于 client roots，standalone CLI 不会使用它。

只有 `verified` 可以证明 source location。零 verified match、多 verified matches、stale source bytes、格式错误或未知的 anchor、malformed sidecar、traversal、symlink escape 与 workspace 外路径都会 fail closed，返回 non-verified result。Output 只包含 repository-relative location，不包含 absolute path。

当 verified location 包含 `componentBreadcrumb` 时，它表示同一 source file 内的 lexical evidence，由 `{ path, line, column, componentName }` frames 组成，顺序为 outer→inner，最多保留最近 3 层。只有当前 source bytes 匹配记录的 hash 后才会返回；`candidate` 与 `unavailable` result 不包含它。它不是 React Fiber/runtime stack，也不是跨文件推断；adapter 不会返回 source text、`contentHash`、`workspaceRoot`、absolute paths，也不授予 browser/source write authority。

## 发布前的本地使用

首次 registry 发布前，从该 repository checkout 使用这个 public-package candidate。以下命令都从 repository root 运行；这个 package 尚未发布到 npm registry。

Package workspace 提供精确的 registration manager。先安装 checkout 依赖，再使用下面的命令构建并为 Codex 安装 standalone resolver：

```powershell
npm ci
npm --workspace @meanthis/source-resolver-mcp run setup:codex
```

该命令会构建 resolver，把当前 Node executable 与 built entry 解析成 absolute paths，在真实 registration change 前备份 active Codex config，通过 Codex 自己的 `mcp add` 写入配置，再验证 resulting readback。精确 registration 已存在时，重复执行是 no-op。同名 registration 的 command、entry、environment、working directory 若不同，或者 allow-list 遗漏 `meanthis_resolve_source`、deny-list 包含该 tool，就会 fail closed，绝不会自动覆盖。

可用下面两条命令只读检查当前状态，或预览 install action：

```powershell
npm --workspace @meanthis/source-resolver-mcp run doctor:codex
npm --workspace @meanthis/source-resolver-mcp run setup:codex -- --dry-run
```

若要只移除当前 checkout 拥有的精确 registration，运行：

```powershell
npm --workspace @meanthis/source-resolver-mcp run remove:codex
```

每次真实 add 或 remove 都会先把 `$CODEX_HOME/config.toml`（未设置 `CODEX_HOME` 时为 `~/.codex/config.toml`）复制成同目录带 timestamp 的 backup；backup 失败时不会执行 mutation。

Package binary 名称为 `meanthis-source-resolver`，推荐的 MCP registration name 也为 `meanthis-source-resolver`。为便于审计，install command 的手工等价操作如下：

```powershell
npm ci
npm --workspace @meanthis/source-resolver-mcp run build
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$entry = (Resolve-Path ".\tools\source-resolver-mcp\dist\cli.js").Path
codex mcp add meanthis-source-resolver -- "$node" "$entry"
codex mcp get meanthis-source-resolver --json
```

该 registration 中的 Node command 与 built entry 都是 absolute path。修改 registration 后请启动 fresh Codex task，因为 MCP discovery 发生在 task 启动时。手工 removal 等价命令是 `codex mcp remove meanthis-source-resolver`。

该命令运行 stdio server，且有意不提供交互式 browser setup。直接在 terminal 中打开它时，它会等待 stdin/stdout 上的 MCP client。

## 完整 bridge 兼容性

公开 companion 的 `setup:bridge:codex` 路径会注册 `meanthis` 产品 MCP server：四个只读工具 `meanthis_list_captures`、metadata-only 的有界等待 `meanthis_wait_capture_change`、`meanthis_read_capture` 与 `meanthis_resolve_source`，外加窄、瞬态的 `meanthis_ack_capture_read` acknowledgement mutation。只需要 source verification 时选择 standalone resolver；只有还需要另一条经显式批准的 browser-capture workflow 时，才选择完整 bridge。

两条 setup 路径都不会发布 package。Resolver 与 companion 已进入九个 package 的 public release candidate，但显式 publication 发生前仍不能从 registry 安装。

## 验证

在 repository root 运行 focused workspace checks，然后运行 public package verification：

```powershell
npm --workspace @meanthis/source-resolver-mcp test
npm --workspace @meanthis/source-resolver-mcp run build
npm run verify:packages
```

Focused tests 会覆盖 MCP client/server exchange、roots precedence 与 fallback、精确 unwrapped input schema、唯一 verified resolution、fail-closed states，以及 injected、no-mutation 的 registration-manager contract，同时不会启动 browser bridge。Root package verification 会在隔离 consumer 中构建并 pack-verify 九个 public workspace。它不会发布 package、运行 authenticated model canary，也不能证明 live Codex registration。
