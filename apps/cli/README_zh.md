# MeanThis Companion

[English](./README.md) | 中文

`@meanthis/cli` 是 MeanThis 浏览器扩展的可选本地 companion。它通过四个只读 MCP tools 与一个窄、瞬态的 read-acknowledgement mutation，把用户明确授权且经过 Agent-safe 处理的捕获提供给本地 Agent。它不会控制浏览器、点击、输入、修改源文件，也不会把捕获发送到 MeanThis 托管服务。

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

## 每个 task 一个 thin stdio broker，共享一个 HTTP owner

默认 `meanthis` registration 会为每个 Agent task 启动一个 thin stdio broker。Registration 只包含 absolute Node executable 与 built `local-bridge-mcp-stdio-broker.js` entry，不含 environment override、working directory 或 token。Broker 启动时会读取并核验受保护的 profile credential，先用 fresh nonce、timestamp 与 request/response 双向 HMAC proof 认证 `127.0.0.1:38472` 上的 detached HTTP owner，且不会发送 raw token；随后才在内存中持有用于固定 `/mcp` 连接的 Bearer credential。Broker 会透明转发 client capabilities、`roots/list` 等 server request 与全部 MCP traffic。每个 broker 都获得独立 HTTP session 与 workspace roots，一个 task 不能借用另一个 task 的 roots。Daemon 不会 fallback 到自己的 working directory，因此未声明 roots 的 source resolution 会 fail closed。底层 `ui-attach.*` schema kind 继续作为稳定兼容标识，这并不表示 server 只支持 Codex。

Codex 是第一个自动化 adapter，因为它的 CLI 支持结构化 registration 读回与精确移除：

```sh
meanthis bridge install --host codex --json
meanthis bridge install-native-host --json
meanthis bridge doctor --json
meanthis bridge start --json
# 完全关闭并重新打开受影响的 Codex task 或 host。
```

`install` 会注册 absolute Node 加 broker 的 stdio command，启动或复用两个 detached owner，并核验 `env`、`env_vars` 与 `cwd` 均为空的精确 structured readback。它只移除来自同一安装、可精确识别的 legacy `ui-attach`、direct-HTTP `meanthis`、full-stdio `meanthis` 与 standalone `meanthis-source-resolver` registration；绝不会覆盖 foreign 或冲突 registration。`doctor` 只读，并包含 `checks.agentCredential`。`start` 只会创建缺失的 credential 或核验 secure credential，并在不修改 host configuration 的情况下启动或复用两个 exact-build owner；普通 start 与 credential-load 路径绝不会复用或修复 insecure `bridge-agent-key-v2`。Install、系统重启或 credential rotation 后，要完全重启受影响的 task 或 host，使其启动新 broker。不要使用 `bridge launch`：packaged Codex Desktop 无法可靠接收 per-launch environment injection，该命令现在会以 `HOST_LAUNCH_UNSUPPORTED` 安全失败。

如果 `127.0.0.1:38472` 被无法完成 authenticated health proof 的 listener 占用，`doctor` 会报告 `unverified_listener`，`start` 或 `install` 则以 `MCP_HTTP_UNVERIFIED_LISTENER` 失败。MeanThis 不会把该 listener 认作自身进程、向其发送 Bearer credential 或自动 kill。请手动识别该进程，确认可以安全停止后将其停止，再运行 `meanthis bridge start --json`。来自旧 foreground lifecycle 且 HMAC-valid 的 listener 仍单独报告为 `legacy_foreground`。

`meanthis bridge install --host codex --dry-run --json` 是零 mutation 的 CLI preview：它不会创建 credential、启动 owner 或修改 configuration。该保证不适用于 checkout-level `npm run setup:bridge:codex` wrapper；wrapper 会在调用 install command 前 build 并 link CLI，即使后续 registration preflight fail closed，这些 build/link 副作用也会保留。

checkout-level setup wrapper 还会运行 `install-native-host`，安装**创建邀请**所需的当前 Windows 用户 Chrome/Edge Native Messaging registration。扩展本身不会写 registry。

只有 `doctor` 因 ACL drift 把 `bridge-agent-key-v2` 报告为 `insecure`，或该 Agent credential 可能已经泄露时，才使用 `rotate-agent-token`。它会在现有 profile transition lock 下先轮换 MCP HTTP bearer，再轮换 Agent token，确保 HTTP owner 与 browser owner 都 turnover：

```sh
meanthis bridge rotate-agent-token --host codex --json
# 按命令提示完全关闭并重新打开受影响的 Agent task 或 host。
```

Registration current 时，它会重启并核验两个 owner，随后要求重启受影响的 task 或 host。Registration missing 或属于 managed legacy 时，secure readback 后会发布 A2-bound desired marker，启动或 turnover 并核验 browser owner。它不会启动 MCP HTTP owner，也不宣称完整 MCP runtime；会报告 `runtimeActive:false`、`browserOwnerActive:true`，并返回 install 作为 next step。从首个支持该协议的 marker-aware build 起可以自动 turnover。若机器上仍运行完全不认识 desired-marker 协议的更老 browser owner，它可能不会自退；CLI 会 fail closed，并提示用户停止占用 `127.0.0.1:38471` 的旧进程后重试。Registration drifted 时 fail closed。Partial 或 committed-but-unverified 结果会如实报告，但不会输出 token、credential path 或底层 error cause。

如果独立的 MCP HTTP credential 检查报告 `rotation_required`，下面这个更窄的命令只轮换该 bearer。Current broker registration 尚未存在时，它不会启动 owner 或宣称 runtime ready，并会提示下一步执行 install。任何成功轮换后，都要完全重启受影响的 task 或 host，使其 broker 重新读取 credential：

```sh
meanthis bridge rotate-mcp-token --host codex --json
# 完全关闭并重新打开受影响的 Agent task 或 host。
```

旧命令 `meanthis bridge install --codex --json` 继续兼容。对于其他宿主，MeanThis 只返回 manual stdio command 与 argument，不会修改宿主：

```sh
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

先运行 `meanthis bridge start --json`，再用返回的 absolute Node command 与唯一 broker-entry argument 配置 host，并完全重启。生成的 metadata 不包含 environment、working directory 或 token。

| 宿主 | 生成的 setup | 自动验证 |
| --- | --- | --- |
| Codex | Stdio `codex mcp add`，使用 absolute Node 与 broker entry | 有：结构化精确读回 |
| Claude Code | Manual stdio command 与 argument | 无：需在 Claude Code 中配置并验证 |
| VS Code | Manual stdio command 与 argument | 无：需在 VS Code 中配置并验证 |
| Cursor | Manual stdio command 与 argument | 无：需在 Cursor 中配置并验证 |

JSON output 包含 stdio-broker descriptor 与 host-specific setup metadata。Codex command 以 executable 加 argv 的结构返回，不拼接 shell quoted string。其他 adapter 只返回 metadata，不声称该 host 已配置完成。

Fresh Agent host 启动后，打开 MeanThis，选择授权范围，再点击**创建并复制连接邀请**。只能把复制出的单行 `meanthis bridge accept <connection-code> --json` 命令粘贴到预期的本地 Agent 对话中。这个 68 字符、带版本的纯字母数字 connection code 封装 request ID、所选 mode 与 32-byte approval key，并且不含会触发 Markdown 转义的标点；整个 code 都是短时本地 capability。接受成功后会返回用于发现 capture 的精确 machine-readable next action。不支持展开格式或旧的接受命令。

## 默认 MCP surface

默认 broker-backed `meanthis` registration 暴露四个只读工具，以及一个窄、瞬态的确认 mutation：

- `meanthis_list_captures` 会列出连接后由 MeanThis 所选范围明确共享的有界页面标识与 capture metadata。`focusedContexts` 条目带有 `focusKind: "meanthis_shared_scope"`；它不是操作系统前台标签页信号。即使尚未选择任何目标，它也可以标识精确、已清理的共享范围；它不会枚举无关 browser tab，也不会披露 element text、task-note text、locator 或 handoff content。`captureTitle` 与 `captureUpdatedAt` 只描述可选 capture，不描述网页。不需要额外的“捕捉”或“共享”动作。结构化 state 与 `nextAction` 字段会区分未连接、已有共享页面但没有已选目标、存在多个 capture，以及可以直接读取的 capture。Capture metadata 只包含任务说明数量，不包含说明文本；只有一个 capture 时，只要存在至少一条任务说明，`nextAction` 就推荐 `detail: "agent_context"`，否则推荐 `summary`。
- `meanthis_wait_capture_change` 接收一个精确的 `instanceId`、`captureId` 与 `afterSequence`，以及可选的 `timeoutMs`；后者默认是 `20,000` 毫秒，最大不超过 `25,000` 毫秒，从而为 30 秒 HTTP request timeout 留出余量。它只通过现有 `LocalBridgeReader` 做有界 polling。返回结果包含 capture identity、`previousSequence`、`currentSequence`、`changed`、`timedOut`、`state` 与全为 false 的 `executionAuthority`；发生变化后，精确 `nextAction` 是以 `detail: "summary"` 调用 `meanthis_read_capture`。它绝不返回 task、element、locator、context 或 handoff 内容，也不授予 browser control。Capture 已 stale、被 replaced 或 sequence regression 时都会 fail closed，并要求重新调用 `meanthis_list_captures`。
- `meanthis_read_capture` 将一个精确 capture revision 分层读取为 `summary`、`content`、`task`、`agent_context`、`locator`、`visual`、capture-level `diagnostics`、legacy `context` 或 canonical `handoff`。`agent_context` 是 requested work 的快速路径：先核验精确 snapshot sequence，再把每条 task note 与最小元素身份、`grounding.recommendedLocator`、frame boundary、有界 visual facts，以及依据该 client declared workspace roots 只读解析的 `grounding.sourceResolution` 一次返回。解析失败会在该 target 内显式 fail closed，不会丢弃整个 capture read；输出不含 raw content、screenshot artifact、source bytes、hash 或绝对 workspace path。独立的 `task`、`locator`、`visual` 与 `meanthis_resolve_source` 仍用于渐进检查或重试。`diagnostics` 只能读取整个 capture：当前只返回从这次明确捕捉中已存在的 replay 事实推导出的有界 attempt/verified/ambiguous/missing 计数。没有 diagnostics projection 的 legacy capture 返回 `null`；replay 事实不可用、malformed 或 overbound 时仍返回非空 sidecar，并在对应 `replay.status` 中明确表示。它绝不返回 raw locator 或 failure string；device、network、console 保持 `not_requested`，所有 execution-authority 字段保持 false。Discovery 只暴露 `metadataDiagnosticsVersion: "v1"`，不暴露计数。`task` 读取会把每条说明与最小元素身份、`grounding.recommendedLocator`、opaque source anchor 和 frame boundary 配在一起；它不包含 raw content 或 style。只要页面捕捉记录了 `contentParts` 字段（包括有意记录的空数组），`content` 读取就返回 `partsSource: "captured"`；仅当该字段缺失、reader 合成一个兼容分段时，才返回 `"legacy_fallback"`。选择 A-Z 目标时优先使用 capture-scoped `targetIds`，例如 `target_C`；`attachmentIds` 继续兼容。每次读取都会明确返回 `targetIdScope: "capture"` 与不授予执行权限的边界。任务说明属于 requested work，但 capture 本身不授予 browser-control 或 live-DOM execution authority。
- 每个成功的 `meanthis_read_capture` 响应都会返回 `meanthis_ack_capture_read` 的精确 `nextAction`，以及等价的 `meanthis capture ack ... --json` argv。确认与精确 `instanceId`、`captureId`、snapshot sequence 和读取 detail 绑定，只记录 Agent 客户端已确认取回该版本；它不证明模型已注意或理解、任务已创建或下游已执行。同一精确输入重复调用是幂等的；新 sequence、clear、disconnect 或 owner restart 都会清除确认。该确认只存在于瞬态 owner memory，不授予 browser、DOM、source、cloud、reply、thread 或 task authority。
- Canonical whole-capture `handoff` 读取可以显式设置 `includeReadReceipt: true`。内联的 `ui-attach.mcp-read-receipt` 通过 SHA-256 绑定精确返回的 UTF-8 handoff bytes 与精确 instance/capture/sequence/detail。它只随响应存在，不会持久化。`returned_to_mcp_client` 只表示 MCP 响应包含该回执；固定 limitations 明确说明这不证明模型已注意、任务已创建或下游已执行。
- Canonical read view 中每个 target 还会携带 `annotationIdentity`。当前扩展 session 会以 `annotationIdScope: "capture_session"` 暴露不透明 `annotationId` 及其创建/更新时间；精确 legacy session 与旧 cached bridge snapshot 会规范化为显式 `null`/`unknown` 字段。Annotation ID 只是只读 correlation handle，不是 selector 或 capability；它不会替代 `targetId`、绕过 `expectedSequence`，也不会授权 reply、resolve、edit、delete、browser control 或 source write。
- `meanthis_resolve_source` 在该 client 的 MCP workspace roots 下，依据可信本地 sidecar 解析 opaque source anchor。共享 HTTP owner 不使用 daemon working-directory fallback。

重复进行有界 wait 可以形成低权限 change-watch，但它不是 Agentation 式 thread/reply/resolve workflow，也不是 event stream。

## 需要用户批准的 annotation lifecycle proposal

四个 discovery/read/wait/source tools 仍然只读；`meanthis_ack_capture_read` 只修改瞬态读取确认状态。本地 Agent 可以通过独立 control CLI 提交一个精确的 `open -> resolved` 或 `resolved -> open` proposal：

```text
meanthis control submit --instance <instance-id> --capture <capture-id> --sequence <n> --annotation <annotation-id> --expected <open|resolved> --next <open|resolved> [--operation <uuid>] --json
meanthis control status --operation <uuid> --fingerprint <sha256> --owner-generation <n> --connection-generation <n> --json
```

`submit` 只会创建一个 proposal，并与 control owner 返回的精确 instance、capture、sequence、annotation、expected state、next state、operation ID、fingerprint、Owner generation 和 connection generation 绑定；它不会修改 annotation。MeanThis 必须在浏览器 widget 中显示这条精确 proposal，只有用户对其中精确的**批准**动作进行可信点击后才能 claim。Authority 缺失、stale、mismatch、expired、replaced 或已被 claim 时都会 fail closed。

批准后，扩展会持久化并读回 canonical lifecycle state 与 durable operation ledger，再发布新的 Bridge snapshot。只有 durable receipt 与当前 snapshot 在精确 annotation、next state、sequence advance 和 observed time 上一致时，Owner 才接受 terminal success。随后 Agent 必须运行 `meanthis capture list --json`（或 `meanthis_list_captures`），再读取返回的新精确 sequence。Control path 不授予 browser control、DOM mutation、source write、cloud send、reply、thread 或通用 edit/delete authority；之后每次 lifecycle transition 都必须再次得到精确、可见的用户批准。

旧 direct-HTTP registration、`meanthis mcp` full stdio entry 与 standalone `meanthis-source-resolver` registration 只保留为 compatibility 或 migration 路径。维护者使用的旧 diagnostics 只有在显式运行 `meanthis mcp --compatibility` 时才会出现。它们都不属于推荐的默认架构；current install 会移除可精确识别的 standalone resolver。

`@modelcontextprotocol/sdk` 1.29 的 direct-HTTP compatibility path 仍有一个限制：取消第一个 nested server request 时，由于其 numeric request ID 为 `0`，对应的 client-side handler 可能保留到 client 或 session close。默认 thin broker 以双向 truthy request-ID alias 避开该 ID-specific SDK 行为。同时，HTTP daemon 对应的 POST 与 session-accounting slot 已进入 terminal cleanup；被保留的只限 direct client handler。

Raw direct-HTTP client 还有一条 cancellation boundary：取消 outer JSON-RPC request 且其 ID 为 `0` 或 `""` 后，不得在同一 authenticated session 中复用该 ID。Direct client 也绝不能构造携带 MeanThis internal control header、针对 unknown 或 already-completed request 的 cancellation；否则其 cancellation intent 可能消费该 session 中随后复用相同 ID 的 request。该 control header 属于 thin broker 的内部合同，不是 direct-client API。推荐的默认 broker 通过 truthy ID alias 与内部 control-lane lifecycle 规避这两类情况。

如果当前 Agent task 无法直接调用已注册的 MCP tools，可以使用宿主无关的 fallback。它复用同一套 discovery 与 progressive-read 实现，不是第二套协议：

```text
meanthis capture list --json
meanthis capture read --instance <instance-id> --capture <capture-id> --sequence <n> --detail content --target target_C --json
meanthis capture read --instance <instance-id> --capture <capture-id> --sequence <n> --detail agent_context --target target_C --json
meanthis capture ack --instance <instance-id> --capture <capture-id> --sequence <n> --detail agent_context --json
```

接受连接的结果，以及每个可直接读取的 capture-list 结果，都会提供精确的 executable-plus-argv continuation，因此 Agent 无需自行构造原始 MCP JSON-RPC。

通过这条 CLI fallback 读取 `agent_context` 时，调用命令的 working directory 是唯一可信的 source-resolution root。应从预期 project root 运行返回的命令；sidecar 缺失、无关、存在歧义或已 stale 时，结果会显式保持 unavailable。

Capture-session 文件与 stdin 输入会在 JSON 解析前限制为 1 MiB；`bundle --intent-file` 输入限制为 256 KiB。

## 信任与隐私

两个 detached owner 都只绑定 `127.0.0.1`：browser owner 使用 `38471`，MCP HTTP owner 使用 `38472`。Broker 每次启动都会核验受保护的 credential，先通过 fresh nonce、timestamp 与 request/response 双向 HMAC proof 探测 `/health`，不暴露 raw token；确认 owner 后才向固定 `/mcp` 发送 Bearer credential。Host 永远不持有 token，但 broker 必须在进程内存中持有它。Broker 不持久化 capture、MCP session 或 token；stdio EOF 或终止会先请求立即删除 HTTP session 并结束 broker；若该 DELETE 或 daemon 不可用，则由 daemon 的有界 disconnected-grace/idle cleanup 回收 retained session。如果已验证 owner 随后死亡，且另一进程在现有 broker 重连前占用固定 port，该进程仍可能收到 Bearer credential；v1 没有 TLS 或 channel binding。该 credential 仍只是同一用户本机进程读取 Agent-safe 只读上下文的 capability，不授予 click、type、navigation、script execution、source editing 或 browser control。Browser bridge 默认断开，并且需要明确的浏览器手势，以及由预期 Agent 接受的短时本地连接邀请。默认公开路径只接受 Chrome Web Store extension ID `bbiiccaidhlhdagmabkogleldjdnmlfn`，不提供 runtime 或 environment override。浏览器扩展只有在用户创建连接邀请时，才会申请可选 loopback host permission。Credential 与邀请材料必须留在同一设备上，不能粘贴到网页、公开 issue、日志或提交文件中。

完整边界请参阅仓库的[隐私声明](../../PRIVACY_zh.md)与[安全策略](../../SECURITY_zh.md)。

## 状态

`0.1.0` 是尚未发布的 candidate。Package metadata 与本地/缓存优先的 pack checks 只是在准备公开安装路径，并不代表 package 已发布；它们使用 `--prefer-offline` 而非 `--offline`，因此 npm 在需要时仍可能访问已配置的 registry。
