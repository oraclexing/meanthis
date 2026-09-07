<p align="center">
  <img src="./assets/meanthis-mark.svg" width="96" height="96" alt="MeanThis 图标">
</p>

<h1 align="center">MeanThis</h1>

<p align="center"><strong>选中一次，把你所指的 UI 上下文准确交给 Agent。</strong></p>

<p align="center">
  <a href="./README.md">English</a> · 简体中文 ·
  <a href="./PRIVACY_zh.md">隐私</a> ·
  <a href="./SECURITY_zh.md">安全</a>
</p>

MeanThis 是面向人类与 Agent 协作的 local-first UI reference layer。你可以在真实 Web 页面中选择元素、检查捕获到的事实，只在需要工作的元素上补充任务说明，然后把结果交给 text Agent。

它优先提供确定性的 Web 信息：DOM、accessibility、style、bounds、context、locator candidate、replay evidence 与可选 source anchor。MeanThis 不会点击、输入、导航、编辑源码，也不会向下游授予权限。

> **发布状态：** `0.1.0` 面向早期测试。请使用源码，或 GitHub Releases 中可用的版本。npm packages 与 Chrome Web Store 版本尚未发布。

## 为什么使用 MeanThis

截图和自然语言经常让 Agent 猜测用户指的是哪个 control、label、container 或 state。MeanThis 把人类选择转换成可检查的 reference，显式保留 target identity 与有边界的上下文。

- **准确：** 引用标签把页面 overlay、任务说明与 handoff record 对应起来。
- **确定性优先：** Browser facts 是主要依据；vision 保持可选。
- **Local-first：** 除非用户明确复制、导出或授权 loopback companion，否则 capture 留在浏览器 profile 中。
- **可重新定位：** Locator candidate 会保留 uniqueness 与 verification evidence，不假设 selector 永远稳定。
- **默认 Agent-safe：** 默认 projection 会脱敏已识别的 secret，并明确排除 control authority。

## 三步工作流

| 步骤 | 人类操作 | MeanThis 结果 |
| --- | --- | --- |
| 1. 选择 | 选择**添加元素**，然后选中一个或多个页面目标。 | 可见的引用标签与结构化 target facts。 |
| 2. 描述 | 只给确实需要工作的元素添加任务说明。 | Requested work 与 context-only element 保持分离。 |
| 3. 交接 | 检查精确 handoff，然后选择**复制给 Agent**。 | 可直接粘贴给 text Agent 的人类可读 Agent-safe context。 |

可选本地 companion 可以通过 MCP 暴露经过用户明确授权的 Agent-safe capture，但手动复制流程本身就是完整可用的。

## Agent 会收到什么

根据 disclosure mode 与浏览器可提供的证据，handoff 可以包含：

| 证据 | 示例 |
| --- | --- |
| 语义身份 | tag、推断 role、accessible name、visible text |
| 几何与状态 | viewport bounds、visibility、enabled state |
| 视觉事实 | 选定的 computed style，如 display、color 与 background |
| 页面上下文 | parent summary、nearby text、经过 policy projection 的 source URL/path |
| 重新定位 | selector hint、locator candidate、uniqueness 与 replay evidence |
| 意图 | per-target 任务说明，以及 context-only/requested-work 分类 |
| 源码映射 | integration 可以验证时提供的可选 reviewed source anchor |

这些只是 reference context，不是操作浏览器、filesystem、source tree 或其他服务的权限。

## 安装扩展

### 下载 Release（无需编译）

Release 发布后，请从 [GitHub Releases](https://github.com/oraclexing/meanthis/releases) 下载同一版本的全部三个 asset：`meanthis-extension-mv3-<version>.zip`、对应 `.manifest.json` 与 `.sha256`。把它们放在同一目录，运行 `sha256sum --check meanthis-extension-mv3-<version>.sha256`；checksum file 会同时验证 ZIP 与 manifest。随后解压 ZIP，打开 `chrome://extensions`，启用**开发者模式**，选择**加载已解压的扩展程序**，再选择包含 `manifest.json` 的解压目录。

Windows 用户可以改为在下载目录打开 PowerShell（将 `<version>` 替换为下载的版本）。解压前，把显示的两个哈希值分别与校验文件中对应的条目比较：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "meanthis-extension-mv3-<version>.zip", "meanthis-extension-mv3-<version>.manifest.json"
Get-Content -LiteralPath "meanthis-extension-mv3-<version>.sha256"
```

这种方式不需要在本地安装 Node.js 或编译，但本质上仍是开发者模式的 unpacked installation。未来签名后的 Chrome Web Store 页面才是真正的一键安装路径；GitHub 不能把普通 CRX 直接安装进 Chrome。

### 从源码构建

需要 Node.js 22.12+ 或 24.x，以及 npm 11.16.0。

```bash
npm ci
npm test
npm run build
```

然后打开 `chrome://extensions`，启用**开发者模式**，选择**加载已解压的扩展程序**，并选择：

```text
apps/extension-mv3/dist-consumer
```

从浏览器工具栏打开 MeanThis，选择**添加元素**、选中目标，在浮层中检查内容并复制 handoff。选择**更多**可以打开侧边栏，管理已保存的捕捉并详细审阅。

只运行独立 Web demo：

```bash
npm run demo
```

Demo 不会替代原生扩展 side panel 或 saved-capture 流程。

## 让 Agent 帮你安装

你可以把仓库 URL 交给 coding Agent，并要求它安装 MeanThis。确定性双语安装契约见 [AGENT_INSTALL_zh.md](./AGENT_INSTALL_zh.md)。其中说明了 Agent 应如何 clone 并验证源码、构建和注册 host-neutral thin stdio broker、启动两个 local owner、重启受影响的 task 或 host，以及验证四个只读的 `meanthis_*` tools，其中包括 metadata-only 的有界等待 `meanthis_wait_capture_change`。

Agent 可以准备扩展文件并打开相应浏览器页面，但 Chrome 仍须把扩展安装或权限步骤显示给用户确认。MeanThis 不要求单独安装 Skill。在首个 npm 与 Chrome Web Store release 发布前，仓库 checkout 是权威安装来源。

## 可选、宿主无关的 MCP companion

Public repository 中的 CLI workspace 提供默认关闭、只读的本地 companion。默认 `meanthis` registration 会为每个 Agent task 启动一个 thin stdio broker：absolute Node executable 加一个 broker-entry argument，不含 environment、working directory 或 token。每个 broker 会读取受保护的 profile credential，先用 nonce/timestamp request/response 双向 HMAC proof 认证 detached HTTP owner，且不会发送 raw token；随后才在内存中持有用于固定 loopback `/mcp` 的 Bearer credential。它会透明转发 client capabilities 与 server `roots/list`，并精确暴露 `meanthis_list_captures`、metadata-only 的有界等待 `meanthis_wait_capture_change`、`meanthis_read_capture` 与 `meanthis_resolve_source`。每个 broker 都有独立 HTTP session 与 workspace roots；source resolution 绝不 fallback 到 daemon working directory。旧 direct-HTTP registration、`meanthis mcp` full stdio entry 与 standalone resolver 只保留为 compatibility 或 migration path，不是并行默认项。

从源码 checkout 中，Codex adapter 可以自动安装并精确读回 registration：

```bash
npm run setup:bridge:codex
meanthis bridge doctor --json
meanthis bridge start --json
# 完全关闭并重新打开受影响的 Codex task 或 host。
```

`npm` setup wrapper 会在调用 registration install 前 build 并 link CLI；即使后续 CLI preflight fail closed，这些立即发生的本机副作用也会保留。直接运行 `meanthis bridge install --host codex --dry-run --json` 的边界更窄：它不会创建 credential、启动 owner 或修改 configuration。`doctor` 只读并检查 `agentCredential`；结果为 `insecure` 时会指向 `rotate-agent-token`。普通 start 与 credential-load 路径绝不会复用或修复 insecure `bridge-agent-key-v2`。该恢复命令只用于 ACL drift 或 Agent key 可能泄露，并会在现有 profile transition lock 下先轮换 MCP HTTP bearer，再轮换 Agent token。Registration current 时会重启并核验两个 owner，随后要求重启受影响的 task 或 host。Registration missing 或属于 managed legacy 时，secure readback 后会发布 A2-bound desired marker，启动或 turnover 并核验 browser owner；不会启动 MCP HTTP owner，也不宣称完整 MCP runtime，并返回 `runtimeActive:false`、`browserOwnerActive:true` 与 install next step。Registration drifted 时 fail closed。Partial 或 committed-but-unverified 结果不会输出 token、credential path 或底层 cause。Install、系统重启或 token rotation 后，要完全重启受影响的 task 或 host，使其启动新 broker。不要运行 `bridge launch`：packaged Codex Desktop 无法可靠接收 per-launch environment injection，该命令现在会安全地报告 unsupported。Installer 只移除来自同一安装、可精确识别的 legacy `ui-attach`、direct-HTTP/full-stdio `meanthis` 与 standalone-resolver registration，遇到冲突会 fail closed；本文不声称任意机器的全局 configuration 已经完成迁移。

其他受支持宿主只需构建一次，然后生成对应 command 或 JSON config；MeanThis 不会修改这些宿主：

```bash
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge start --json
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

| 宿主 | v0.1 setup 边界 |
| --- | --- |
| Codex | 自动安装、精确结构化读回与精确卸载 |
| Claude Code | Manual stdio command 与 argument |
| VS Code | Manual stdio command 与 argument |
| Cursor | Manual stdio command 与 argument |

共享 descriptor 与四种 renderer 都有 contract test。非 Codex adapter 只返回 manual stdio command 与 broker argument；不会修改 host、暴露 credential 或声称通过 real-host canary。Broker 不持久化 capture、MCP session 或 token。Stdio 结束时会先请求立即删除 HTTP session；若该 DELETE 或 daemon 不可用，则由 daemon 的有界 disconnected-grace/idle cleanup 回收 retained session。Host 不持有 token，但 broker 会在 HMAC owner preflight 后向固定 loopback `/mcp` 发送 Bearer；如果 owner 随后死亡，且另一进程在重连前占用该 port，token 仍可能暴露，因为 v1 没有 TLS 或 channel binding。该 token 是同一用户本机进程读取 Agent-safe capture 与窄、瞬态 read acknowledgement 的 capability，不授予 browser-control authority。成功接受邀请后会返回精确的 capture-discovery next action。如果当前 Agent task 无法调用已注册的 MCP tools，`meanthis capture list/read/ack --json` 会通过同一渐进读取与显式确认实现提供宿主无关的 fallback。扩展的主要流程不依赖 companion。

## Packages

| Package | 用途 |
| --- | --- |
| `@meanthis/schema` | Attachment schema、validation 与 saved-snapshot policy guard |
| `@meanthis/prompt` | 面向人的 Agent handoff 文本序列化 |
| `@meanthis/web-extractor` | 有界、确定性的 DOM extraction |
| `@meanthis/web-picker` | 可复用的元素选择流程 |
| `@meanthis/replay` | Locator replay 与 verification contract |
| `@meanthis/hub-core` | 与 transport 无关的 capture session 和 handoff assembly |
| `@meanthis/source-map-core` | Source-anchor 匹配原语 |
| `@meanthis/source-resolver-mcp` | 只读 exact source resolver MCP |
| `@meanthis/cli` | 可选本地 Agent bridge 与 MCP companion |

## 仓库结构

```text
apps/
  cli/             可选本地 companion
  demo-web/        独立 capture 与 replay demo
  extension-mv3/   Chrome MV3 扩展
packages/
  hub-core/        capture session 与 handoff assembly
  prompt/          文本序列化
  replay/          locator replay contract
  schema/          schema 与 policy guard
  web-extractor/   DOM extraction
  web-picker/      元素选择
tools/
  source-map-core/       source-anchor 匹配
  source-resolver-mcp/   只读 source resolver
examples/
  saved-snapshot-trusted-host/
  saved-snapshot-text-consumer/
```

## 隐私与安全

MeanThis 没有 hosted capture service、analytics、telemetry、cloud sync 或 remote model call。只有明确复制、导出或用户授权 loopback action 后，capture 才会离开本地环境。Redaction 是 best-effort，不是 data-loss-prevention 保证；分享前必须检查 handoff。

请阅读[隐私说明](./PRIVACY_zh.md)与[安全策略](./SECURITY_zh.md)。疑似漏洞应通过 GitHub private vulnerability reporting 提交，不要创建 public issue。

## 项目边界

- MeanThis 捕获、序列化、恢复并帮助重新定位 UI reference。
- 它优先使用 Web/DOM 与 accessibility facts，而不是概率性 vision。
- Saved snapshot 在 live consumer 重新核验前只是历史 context。
- Capture、replay、source resolution 与 MCP read 都不会授权下游控制。
- 增加 network transport、model call、storage 或 execution 的 host 必须单独披露并保护这些新增行为。

## 贡献与发布

开发约定见 [CONTRIBUTING_zh.md](./CONTRIBUTING_zh.md)，owner-only 发布清单见 [RELEASING_zh.md](./RELEASING_zh.md)。提交变更前请运行：

```bash
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

## 许可证

MIT。参见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
