# @meanthis/hub-core

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

面向 MeanThis 的 transport-agnostic capture session 与 Agent handoff 组装核心。该 package 负责内存 session 模型、summary-first 读取、按 disclosure mode 派生的 view、prompt bundle 与 canonical capture-session 校验。

`hub-core` API 与依赖中明确不包含 source-patch materialization 或 repair orchestration。历史 repair benchmark 的 fixture 与 prompt-building code 保留在该 public package 之外。所有源码访问、candidate 生成、审查、应用与验证均由 downstream host 负责。

它刻意不实现 MCP server、HTTP service、浏览器扩展或 CLI。

## 安装

```bash
npm install @meanthis/hub-core
```

## 示例

```ts
import { createCaptureHub } from "@meanthis/hub-core";

const hub = createCaptureHub();
const session = hub.createSession({ origin: "https://example.com" });
console.log(hub.summarizeSession(session.id));
```

## Capture session 文件

`validateCaptureSessionFile` 与 `hydrateCaptureSessionFile` 接受已完成解析的 capture-session 值。文件 I/O 和 JSON 解析由调用方负责；Hub 负责校验该值并 hydrate 内存模型。

校验采用 fail-closed 策略。Root、session、attachment item、source record 与已声明的 `UIAttachment` record 中出现未声明字段时，会在 hydrate 前被拒绝。校验器也会拒绝循环值、accessor property 与非 JSON container shape，且不会调用页面可控的 getter。

校验受以下导出常量约束：

- `CAPTURE_SESSION_FILE_MAX_BYTES`：compact JSON 表示最多 1,048,576 bytes。Raw JSON reader 必须在解析前实施相同的 byte limit；MeanThis CLI 已实施该限制。
- `CAPTURE_SESSION_FILE_MAX_ATTACHMENTS`：每个 session 最多 26 个 attachment。
- `CAPTURE_SESSION_FILE_MAX_COLLECTION_ITEMS`：任意 array 最多 256 个 item。
- `CAPTURE_SESSION_FILE_MAX_STRING_BYTES`：任意 string 或 object key 最多 1,048,576 UTF-8 bytes；compact JSON 总预算仍是有效的 aggregate bound。
- `CAPTURE_SESSION_FILE_MAX_OBJECT_KEYS`：每个 object 最多 64 个 own enumerable string key。
- `CAPTURE_SESSION_FILE_MAX_NESTING_DEPTH`：最多 32 层嵌套。
- `CAPTURE_SESSION_FILE_MAX_VALUE_NODES`：最多访问 65,536 个 value。
- `CAPTURE_SESSION_FILE_MAX_VALIDATION_ISSUES`：最多返回 100 个 validation issue。

## 本地页面 routing

`deriveCapturePageRoutingHint` 会从 capture record 派生可选、短时的 Chromium tab/frame candidate。`buildCapturePageRoutingRefs` 与 `serializeCapturePageRoutingSection` 为 JSON 和 Markdown handoff 提供同一 contract。Query string 与 fragment 会被移除；encoded path 只会为 bounded 敏感检测而 decode；无效或识别为敏感的 route 不会生成 hint。Consumer 必须在 browser control 前要求 tab-and-frame-route 只命中一个 live target，并取得用户确认。

这些 helper 不会连接浏览器、认证 profile、打开 port 或实现 MCP transport。在具备 profile-scoped live bridge 前，另一个 Chromium profile 仍可能出现巧合匹配。
