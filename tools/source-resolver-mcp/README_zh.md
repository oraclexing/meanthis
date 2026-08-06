# @meanthis/source-resolver-mcp

[English](./README.md) | 中文

> 状态：纳入九个 package release set 的 public-package candidate。它已经过机械 pack 验证，但尚未发布。

这个 package 是 MeanThis Source Mapping v1 的最小只读 MCP adapter。它的 stdio server 只暴露一个 tool：`ui_attach_resolve_source`，并把校验委托给 `@meanthis/source-map-core`。

它不会启动或连接 MeanThis browser bridge，不会读取 browser credential、创建 approval request、持有 loopback state，也不暴露 click、type、navigate、script、file-write 或其他 browser-control capability。当 coding agent 只需要把**复制给 Agent**中的 opaque source anchor 转换成经过本地校验的 repository-relative source location 时，应使用这条路径。

## Tool 契约

把 handoff 的 `Source Anchor Tool Input` block 中完整 object 作为 `ui_attach_resolve_source` 的全部输入，不要添加 `resolverInput` 或其他 wrapper。Adapter 接受一个 opaque `sourceAnchor`，以及最多五个 bounded heuristic `candidates`。

Standalone server 优先使用 MCP client 声明的 `file://` workspace roots。如果 client 没有实现 roots capability，则只能使用该 client 传给 MCP process 的 launch directory。已声明 roots 始终优先，tool input 不能覆盖 workspace path。调用 `createSourceResolverMcpServer()` 的 library host 也可以显式注入可信的 `listWorkspaceRoots` provider；该 host-owned seam 优先于 client roots，standalone CLI 不会使用它。

只有 `verified` 可以证明 source location。零 verified match、多 verified matches、stale source bytes、格式错误或未知的 anchor、malformed sidecar、traversal、symlink escape 与 workspace 外路径都会 fail closed，返回 non-verified result。Output 只包含 repository-relative location，不包含 absolute path。

## 发布前的本地使用

首次 registry 发布前，从 repository checkout 使用这个 public-package candidate。推荐使用一条 Codex setup 命令：

```powershell
npm run setup:codex-source-resolver
```

它会构建 minimal resolver workspace，把当前 Node executable 与 built entry 解析成 absolute paths，在真实 registration change 前备份 active Codex config，通过 Codex 自己的 `mcp add` 写入配置，再验证 resulting readback。精确 registration 已存在时，重复执行是 no-op。同名 registration 的 command、entry、environment、working directory 若不同，或者 allow-list 遗漏 `ui_attach_resolve_source`、deny-list 包含该 tool，就会 fail closed，绝不会自动覆盖。

可用下面两条命令只读检查当前状态，或预览 install action：

```powershell
npm run doctor:codex-source-resolver
npm run setup:codex-source-resolver -- --dry-run
```

若要只移除当前 checkout 拥有的精确 registration，运行 `npm run remove:codex-source-resolver`。每次真实 add 或 remove 都会先把 `$CODEX_HOME/config.toml`（未设置 `CODEX_HOME` 时为 `~/.codex/config.toml`）复制成同目录带 timestamp 的 backup；backup 失败时不会执行 mutation。

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

现有 `npm run setup:codex-bridge` 路径会注册 public companion 的三工具 `ui-attach` 产品 MCP server，其中包含 `ui_attach_resolve_source` 与渐进式 shared-capture read；maintainer 可用 `meanthis mcp --compatibility` 额外启用四个 legacy diagnostics。只需要 source verification 时选择 standalone resolver；只有还需要另一条经显式批准的 browser-capture workflow 时，才选择完整 bridge。

两条 setup 路径都不会发布 package。Resolver 与 companion 已进入九个 package 的 public release candidate，但显式 publication 发生前仍不能从 registry 安装。

## 验证

在 repository root 运行：

```powershell
npm --workspace @meanthis/source-resolver-mcp test
npm --workspace @meanthis/source-resolver-mcp run build
npm run doctor:codex-source-resolver
npm run verify:source-mapping-package-packs
```

Focused tests 会覆盖 MCP client/server exchange、roots precedence 与 fallback、精确 unwrapped input schema、唯一 verified resolution、fail-closed states，以及 injected、no-mutation 的 registration-manager contract，同时不会启动 browser bridge。Package-pack verifier 还会把受限的 package tarball 安装进 offline consumer，并通过真实 MCP initialize、`roots/list` 与 tool call 驱动它的 standalone stdio entry。Doctor 只读取 built entry 与精确 Codex registration state。

完成上述 absolute-path registration 并确保它指向当前 build 后，maintainer 可以运行 authenticated fresh-Codex canary：

```powershell
npm run verify:codex-source-resolver-canary -- --model gpt-5.6-terra --codex codex.exe
```

`--codex` 会选择本轮实际测试的精确 CLI binary；如果 Desktop bundled CLI 与 `PATH` 上找到的 `codex.exe` 不同，应核对 receipt 中的 client version，并传入 absolute path。Codex CLI `0.146.0-alpha.3.1` 不能把 `--ignore-user-config` 与 injected MCP registration 组合使用。因此，harness 不会传入该 flag；它会读取已安装的 selected registration 与 MCP inventory，要求 command 与 entry 都是 absolute path，在 child process 中替换并禁用每一条 ambient registration，再运行不调用 model 的 inventory preflight，要求只有 `meanthis-source-resolver` 保持 enabled。Model-backed task 是 ephemeral、read-only 的；它会忽略 repository rules，禁用 shell、plugins、apps、memories、multi-agent、browser、computer-use、in-app browser、image generation 与 web search，并保留 selected server 所需的 deferred MCP discovery。它必须精确调用 resolver 一次、不执行任何其他 command 或 tool action，并返回精确 verified result。最新 commit-bound `gpt-5.6-terra` cohort 在 `0/3` repetitions 中都没有调用 resolver，但 `3/3` 都诚实报告未尝试状态；更早的第 94 轮 observations 仍为 Terra `3/5`、mini `1/2`。这是 surface-specific capability variance，不是 resolver failure 或通用 model ranking。该 authenticated manual canary 不属于 deterministic release gate；脱敏证据见[第 95 轮报告](../../docs/dogfood/2026-07-31-source-resolution-handoff-semantics-round-95_zh.md)。
