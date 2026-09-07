# 让 Agent 安装 MeanThis

本文是 coding agent 可直接执行的确定性安装契约。MeanThis 不要求额外 Skill：安装浏览器扩展、安装 host-neutral CLI/MCP companion、把 thin stdio broker 注册到用户实际使用的 MCP host，并在要求用户连接前验证本地桥接即可。

## 安全边界

- 默认 MCP surface 包含四个只读工具——`meanthis_list_captures`、`meanthis_wait_capture_change`（metadata-only 的有界等待）、`meanthis_read_capture` 与 `meanthis_resolve_source`——以及窄、瞬态的 `meanthis_ack_capture_read` mutation。该确认只记录 Agent 客户端已确认取回一个精确 capture revision 与 detail；它不授予 browser、DOM、source、cloud 或 task authority，也不证明模型已注意或理解、任务已创建或下游已执行。
- Host registration 只包含 absolute Node executable 与 built stdio-broker entry，不包含 token、environment override 或 working directory。Broker 启动时读取受保护的 profile credential，先用 fresh nonce、timestamp 与 request/response 双向 HMAC proof 核验 detached HTTP owner，且不会发送 raw token；核验后才在进程内存中持有用于固定 loopback `/mcp` 连接的 Bearer credential。该 credential 是同一用户本机进程读取 Agent-safe 只读上下文的 capability 边界；不授予 browser control。
- 普通 start 与 credential-load 路径绝不会复用或修复 insecure `bridge-agent-key-v2`。只有 Agent credential 出现 ACL drift 或可能泄露时，才使用 `meanthis bridge rotate-agent-token --host codex --json`。
- 不要把 MeanThis connection invitation 粘贴到网页、issue、日志或被跟踪的文件中。它是短时本地 capability。
- 只有用户在本设备创建邀请并明确授权连接后，Agent 才能接受邀请。
- 浏览器扩展安装或权限提示必须由用户可见地确认；不得声称已静默完成。

## 从当前仓库安装

在首个 npm 与 Chrome Web Store release 公开前使用这条路径：

```powershell
git clone https://github.com/oraclexing/meanthis.git
Set-Location meanthis
npm ci
```

Codex 使用：

```powershell
npm run setup:bridge:codex
meanthis bridge doctor --json
```

`npm` setup wrapper 会先 build 并 link CLI。这些是立即发生的本机副作用，即使后续 CLI registration preflight fail closed，也会保留。CLI 阶段会在修改 Codex configuration 前备份该 configuration，然后把 `meanthis` 注册为 stdio：absolute local Node executable 加一个 built broker-entry argument；`env` 与 `cwd` 为空，Codex configuration 不保存 token。它会创建或核验受保护的 profile credential，并启动或复用 detached browser owner 与唯一的 detached MCP HTTP owner。它只移除来自同一安装、可精确识别的 legacy `ui-attach`、direct-HTTP `meanthis`、full-stdio `meanthis` 与 standalone `meanthis-source-resolver` registration；绝不覆盖 foreign 或冲突 registration。直接运行 `meanthis bridge install --host codex --dry-run --json` 不会创建 credential、启动 owner 或修改 configuration。`doctor` 只读。本文描述受支持的迁移方式，但不能据此声称任意机器的全局 Codex configuration 已经完成迁移。

随后 wrapper 会安装当前 Windows 用户的 Chrome/Edge Native Messaging registration。这是让**创建邀请**无需额外命令即可启动或复用 bridge 的安装期步骤；扩展本身不会写 registry。

安装后，完全关闭并重新打开受影响的 Codex task 或 host，使其加载已注册的 broker。

每个重启后的 task 会启动一个 thin stdio broker。它会先复用通过认证且 build 匹配的 owner；正常系统重启后，则只使用已安装且受保护的 credential 启动 singleton browser owner 与 MCP HTTP owner，并在连接前完成核验。该自动路径绝不创建或修复 credential、轮换 token、修改 Codex registration 或终止未知 listener。`meanthis bridge start --json` 继续作为显式诊断或恢复命令：它可创建缺失 credential 或核验 secure credential，并在不修改 host configuration 的前提下启动或复用两个 exact-build owner。遇到 insecure Agent credential 时，它会拒绝继续并指向显式恢复命令，不会自动修复或复用。Broker 会透明转发 client capabilities、`roots/list` 等 server request 与 MCP traffic，并在共享 daemon 中建立一个独立 HTTP session。每个 session 只使用自己的 declared workspace roots；source resolution 不使用 daemon working-directory fallback，没有 roots 就 fail closed。Broker 不把 capture、MCP session 或 token 持久化到磁盘；其 stdio child 结束时会先请求立即删除 HTTP session，并随 task 退出；若该 DELETE 或 daemon 不可用，则由 daemon 的有界 disconnected-grace/idle cleanup 回收 retained session。不要运行 `meanthis bridge launch`：packaged Codex Desktop 无法可靠接收 per-launch environment injection，该命令现在会以 `HOST_LAUNCH_UNSUPPORTED` 安全失败。

`doctor` 只读，并在 `checks.agentCredential` 中报告 Agent credential。若该项为 `insecure`，使用下面的 Agent 恢复命令。它会在现有 profile transition lock 下先轮换 MCP HTTP bearer，再轮换 Agent token，使 HTTP owner 与 browser owner 都完成 turnover：

```powershell
meanthis bridge rotate-agent-token --host codex --json
# 按命令提示完全关闭并重新打开受影响的 Agent task 或 host。
```

Current broker registration 存在时，命令会重启并核验两个 owner，并要求重启每个受影响的 task 或 host。Registration missing 或属于 managed legacy 时，secure readback 后会发布 A2-bound desired marker，启动或 turnover 并核验 browser owner。它不会启动 MCP HTTP owner，也不宣称完整 MCP runtime；会报告 `runtimeActive:false`、`browserOwnerActive:true`，并把 `meanthis bridge install --host codex --json` 作为 next step。Registration drifted 时会在轮换前 fail closed。如果任一 credential rotation 处于 partial 或 committed-but-unverified 状态，命令会如实报告，并省略 token、credential path 与底层 error cause。

如果独立的 MCP HTTP credential 检查报告 `rotation_required`，下面这个更窄的命令只轮换该 bearer。Current broker registration 不存在时，它不会启动 owner 或宣称 runtime ready，并会提示下一步执行 install。任何成功轮换后，都要完全重启受影响的 task 或 host，使每个 broker 重新读取受保护的 credential：

```powershell
meanthis bridge rotate-mcp-token --host codex --json
# 完全关闭并重新打开受影响的 Agent task 或 host。
```

Claude Code、VS Code 或 Cursor 先 build/link companion，启动 detached runtime，再生成对应 host 的 manual metadata：

```powershell
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge start --json
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

只应用用户实际 host 对应的 artifact。这些 adapter 返回 manual stdio command：absolute Node executable 加唯一 broker-entry argument，不包含 environment、working directory 或 token；它们不会修改或验证 host。完全重启该 host，并验证它已列出四个只读工具加 `meanthis_ack_capture_read` 的 `meanthis` MCP server，其中包括 metadata-only 的有界等待 `meanthis_wait_capture_change`。

旧 direct-HTTP registration、`meanthis mcp` full stdio entry 与 standalone `meanthis-source-resolver` registration 只保留为旧本地安装的 compatibility 或 migration 路径，都不是默认架构。Current install 会移除可精确识别的 standalone resolver，避免与产品 surface 重复。

## 浏览器扩展

Chrome Web Store listing 公开前，使用项目 release instructions 指定的已审阅 extension artifact。加载 unpacked build 需要 Chrome developer mode 与用户确认。商店 listing 公开后，打开该 listing，让用户确认 **添加至 Chrome**。Agent 不得替换成无关的 unpacked 或 development build。

## 建立连接

1. 请用户打开 MeanThis side panel，选择授权范围，再点击**创建并复制连接邀请**。
2. 用户在同一设备把复制出的单行 `meanthis bridge accept <connection-code> --json` 命令发给 Agent。
3. 只有用户明确授权连接后，才原样运行这一行。
4. 确认结果，但不要复述 connection code。成功结果会包含 machine-readable `nextAction`，明确要求先发现 capture，再回答有关已捕获 A-Z 目标的问题。
5. 优先使用 `meanthis_list_captures` 并遵循其有边界的 `nextAction`。存在 user-authored note 时，`detail: "agent_context"` 会在一次 sequence-bound read 中同时返回 task、recommended locator、有界 visual facts、frame boundary 与 fail-closed source resolution。独立的 `summary`、`content`、`task`、`locator`、`visual` 和 `meanthis_resolve_source` 仍用于渐进检查或重试。选择 A-Z 目标时优先使用 capture-scoped `targetIds`，例如 `target_C`；`attachmentIds` 继续兼容。如果当前 task 无法直接调用已注册的 MCP tools，则使用返回的 CLI fallback：先运行 `meanthis capture list --json`，再运行 `nextAction` 返回的精确 `meanthis capture read ... --json` argv；只有在确认已取回时，才继续执行它返回的精确 `meanthis capture ack ... --json` argv。MCP 与 CLI 路径共用同一套读取与确认实现。任务说明是用户写下的 requested work，但绝不能把 capture 或 acknowledgement 当成 browser-control、live-DOM execution 或 source-write authority。

发布前有意不支持展开的 invitation 字段与旧 `bridge approve` 语法。

如果 side panel 显示本地 Agent 连接失败，先完整关闭并重新打开一次受影响的 task 或 host，使已注册的 MCP broker 启动或复用 owner，然后只重试一次。若仍失败，再运行只读的 `meanthis bridge doctor --json`；`meanthis bridge start --json` 只作为显式诊断或恢复操作。不要运行 `bridge launch`，也不要要求用户反复点击来隐式启动 runtime。

如果 `npm link` 因旧 `ui-attach` shim 返回 `EEXIST`，不要使用 `--force`。先检查该 shim 与 `npm root --global` 下的 package；只有两者都解析到当前精确 checkout，且 linked package 现在将自己标识为 `@meanthis/cli` 时，才用该 package metadata 中读到的精确 legacy package name 运行 `npm unlink --global`，再重试 setup。任何 foreign installation 都必须保持不动。

## Public package 发布后

届时可以用固定版本的公开 package 替代仓库安装：

```powershell
npm install --global @meanthis/cli@0.1.0
meanthis bridge install --host codex --json
meanthis bridge install-native-host --json
meanthis bridge start --json
# 完全关闭并重新打开受影响的 Codex task 或 host。
```

自动化安装应固定精确 release 版本。不要只根据本文推断 package 已可用；必须先核验 release 与 package registry。
