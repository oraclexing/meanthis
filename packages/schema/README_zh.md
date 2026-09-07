# @meanthis/schema

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

面向 MeanThis 集成的共享 UI attachment schema 与校验器。契约覆盖选中元素事实、locator candidates 与稳定性、replay metadata、disclosure policy、artifacts，以及有界的 local-bridge wire format。

通过 pointer 进行的选择可以包含可选 `selectionPoint`，其中 `xRatio` 与 `yRatio` 是有界的元素内相对位置。该字段记录用户在元素内的选择位置，不保留会随滚动或布局变化而漂移的 viewport 坐标。键盘或程序化选择会省略该字段，而不是伪造一个 pointer 位置。

当 attachment 选择了一个 `iframe` host 时，可以包含可选 `boundary` object。`innerDom: "not_captured"` 会把限制变成 machine-readable；`frameOrigin` 要么是没有 path、query、fragment 与 credentials 的 canonical HTTP(S) origin，要么是 `null`；可选的 `framePathname` 是去掉 query 与 fragment 的 canonical pathname；`dominantViewport` 表示该可见 frame 是否覆盖了大部分 viewport。这个字段只描述 frame host，绝不声称已经检查其嵌入文档。缺少 `framePathname` 的旧 boundary 仍然有效，但 exact frame selection 需要重新捕获 route。

## 私有排障摘要

`projectPrivateDebugSummaryV1` 会把一份有效、显式 capture-time `MetadataDiagnosticsV1` sidecar 转换为 `PrivateDebugSummaryV1` allowlist 投影。投影只保留有界 replay 结果计数、粗粒度设备/视口/触控类别、一次性 consent，以及全部为 false 的 execution-authority record。它会有意移除 capture identity、时间、页面身份或内容、locator、network/console 字段、精确尺寸与 user agent。若 source 含已采集的 network/console diagnostics 或 authority 不是 capture-time，则 fail closed。

`validatePrivateDebugSummaryV1`、`serializePrivateDebugSummaryV1` 与 `parsePrivateDebugSummaryV1` 会强制 exact keys、仅 data descriptor 的属性、有界 canonical JSON，以及与 source sidecar 相同的 replay/device 不变量。该 schema 自身不会复制、上传、下载或授予 browser control；host 必须把任何 clipboard action 作为独立、显式的用户操作暴露。

## 实验性不透明 source anchor

Attachment 可以包含 `sourceAnchor`，其中 `buildId` 与 `sourceId` 都是精确 43 字符的 base64url 标识。该 anchor 属于不可信页面数据：它不包含 repository path 或行号，也不声称已经验证源码位置。只有本地 source-map resolver 与可信 sidecar 匹配后，才可以暴露 workspace 文件。

## Saved snapshot control policy

`evaluateSavedSnapshotControlPolicy` 是面向 `ui-attach.saved-snapshot-authority` 契约的纯函数、fail-closed consumer guard。Trusted host 需要显式提供 `controlAttemptId`、从与 `authority` 相同且已接受的 saved bundle 派生出的精确 attachment ID 集合、由外部产生的 live-recheck receipt、显式 human-confirmation receipt，以及来自自身可信时钟的当前 `evaluatedAt`。Guard 会要求 origin、attempt、receipt、target set、时间顺序与 freshness 精确绑定；每个 target 都必须在 live recheck 中得到唯一匹配，并且 recheck 有效期不得超过 60 秒。

```ts
import { evaluateSavedSnapshotControlPolicy } from "@meanthis/schema";

const decision = evaluateSavedSnapshotControlPolicy({
  authority: savedBundle.authority,
  expectedAttachmentIds: ["att_save"],
  controlAttemptId,
  liveRecheck,
  userConfirmation,
  evaluatedAt,
});
```

`allowed: true` 只表示所提供对象在结构上满足这份有界 policy。Guard 不检查 DOM、不选择 tab、不 replay locator、不执行 browser control、不认证 receipt issuer、不证明 recheck 确实发生，也不能核实 caller 是否提供了真实当前时间。Host 仍负责从同一 bundle 派生 attachment ID、提供可信当前时间、信任 receipt producer，并限制之后 action 的范围。Model prose、通用 boolean、既有 chat history、另一份 artifact 的 target ID 与 local-bridge state 都不是 confirmation 或 live-recheck authority。

同 bundle 派生、monotonic host clock 注入与 external issuer fail-closed 编排见可运行、非控制型的 [saved-snapshot trusted-host 示例](../../examples/saved-snapshot-trusted-host/README_zh.md)。

## Local bridge MCP 读取回执

`parseLocalBridgeMcpReadReceipt` 与 `isLocalBridgeMcpReadReceipt` 用于校验显式 canonical-handoff MCP 读取所返回的可选、仅随响应存在的回执。回执通过小写 SHA-256 digest 绑定精确 UTF-8 handoff bytes，以及精确 instance、capture、snapshot sequence 与 `handoff` detail。`returned_to_mcp_client` status 只描述包含该回执的响应；固定 limitations 明确说明它不证明模型已注意、任务已创建或下游已执行。回执不持久化，也不授予 browser-control 或 live-DOM authority。

## 安装

```bash
npm install @meanthis/schema
```

## 示例

```ts
import { createAttachmentId, isUIAttachment } from "@meanthis/schema";

const id = createAttachmentId("checkout-submit");
if (isUIAttachment(value)) {
  console.log(id, value.locatorBundle.primary);
}
```
