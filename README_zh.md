<p align="center">
  <img src="./assets/meanthis-mark.svg" width="96" height="96" alt="MeanThis 图标">
</p>

<h1 align="center">MeanThis</h1>

<p align="center"><strong>选中一次，把你所指的 UI 上下文准确交给 Agent。</strong></p>

<p align="center">
  <a href="./README.md">English</a> · 简体中文 ·
  <a href="https://oraclexing.github.io/meanthis/zh/privacy/">隐私</a> ·
  <a href="./SECURITY_zh.md">安全</a>
</p>

MeanThis 是面向人类与 Agent 协作的 local-first UI reference layer。你可以在真实 Web 页面中选择元素、检查捕获到的事实，只在需要工作的元素上补充任务说明，然后把结果交给 text Agent。

它优先提供确定性的 Web 信息：DOM、accessibility、style、bounds、context、locator candidate、replay evidence 与可选 source anchor。MeanThis 不会点击、输入、导航、编辑源码，也不会向下游授予权限。

> **发布状态：** `0.1.0` 仍是尚未发布的 candidate。公开仓库、npm packages 与 Chrome 扩展正在准备首次发布。

## 为什么使用 MeanThis

截图和自然语言经常让 Agent 猜测用户指的是哪个 control、label、container 或 state。MeanThis 把人类选择转换成可检查的 reference，显式保留 target identity 与有边界的上下文。

- **准确：** A-Z 标签把页面 overlay、任务说明与 handoff record 对应起来。
- **确定性优先：** Browser facts 是主要依据；vision 保持可选。
- **Local-first：** 除非用户明确复制、导出或批准 loopback companion，否则 capture 留在浏览器 profile 中。
- **可重新定位：** Locator candidate 会保留 uniqueness 与 verification evidence，不假设 selector 永远稳定。
- **默认 Agent-safe：** 默认 projection 会脱敏已识别的 secret，并明确排除 control authority。

## 三步工作流

| 步骤 | 人类操作 | MeanThis 结果 |
| --- | --- | --- |
| 1. 选择 | 选择**添加元素**，然后选中一个或多个页面目标。 | 可见的 A-Z reference 与结构化 target facts。 |
| 2. 描述 | 只给确实需要工作的元素添加任务说明。 | Requested work 与 context-only element 保持分离。 |
| 3. 交接 | 检查精确 handoff，然后选择**复制给 Agent**。 | 可直接粘贴给 text Agent 的人类可读 Agent-safe context。 |

可选本地 companion 可以通过 MCP 暴露经过明确批准的 Agent-safe capture，但手动复制流程本身就是完整可用的。

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

从浏览器工具栏打开 MeanThis，选择**添加元素**、选中目标、在侧边栏中检查内容并复制 handoff。

只运行独立 Web demo：

```bash
npm run demo
```

Demo 不会替代原生扩展 side panel 或 saved-capture 流程。

## 可选、宿主无关的 MCP companion

Public repository 中的 CLI workspace 提供默认关闭、只读的本地 companion。`meanthis mcp` 是同一套标准 stdio MCP server，并不只属于 Codex；不同宿主的 adapter 只负责描述怎样启动同一个 executable。

从源码 checkout 中，Codex adapter 可以自动安装并精确读回 registration：

```bash
npm run setup:codex-bridge
```

其他受支持宿主只需构建一次，然后生成对应 command 或 JSON config；MeanThis 不会修改这些宿主：

```bash
npm run build
node apps/cli/dist/index.js bridge config --host claude-code --json
node apps/cli/dist/index.js bridge config --host vscode --json
node apps/cli/dist/index.js bridge config --host cursor --json
```

| 宿主 | v0.1 setup 边界 |
| --- | --- |
| Codex | 自动安装、精确结构化读回与精确卸载 |
| Claude Code | 生成官方 stdio add command，由用户执行并验证 |
| VS Code | 生成官方 `code --add-mcp` command 与 server JSON |
| Cursor | 生成写入 `~/.cursor/mcp.json` 的 `mcpServers` JSON |

共享 descriptor 与四种 renderer 都有 contract test。没有真实安装和运行过的 client，不会被标记为通过 real-host canary。Bridge 只绑定 `127.0.0.1`，需要扩展显式创建连接请求并经过短时本地批准，只暴露已批准的 Agent-safe projection。它不接受任意 selector，也不提供浏览器控制操作。扩展的主要流程不依赖它。

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

MeanThis 没有 hosted capture service、analytics、telemetry、cloud sync 或 remote model call。只有明确复制、导出或批准 loopback action 后，capture 才会离开本地环境。Redaction 是 best-effort，不是 data-loss-prevention 保证；分享前必须检查 handoff。

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
