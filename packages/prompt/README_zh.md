# @meanthis/prompt

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

面向结构化 UI attachment 与单模态文本 Agent 的文本序列化器。Summary、Markdown、compact 和 intent-plus-summary handoff 格式会保留 locator、replay、disclosure 与脱敏上下文。

当 attachment 带有嵌入式 frame `boundary` 时，每种 serializer 都会说明内部 DOM 尚未捕获，只在可用时输出 canonical frame origin 与去掉 query/fragment 的 pathname，并提示 Agent 使用支持 frame 的浏览器工具，而不是把 host element 当作文档内容。

## 安装

```bash
npm install @meanthis/prompt @meanthis/schema
```

## 示例

```ts
import { serializeAttachmentSummary } from "@meanthis/prompt";

const summary = serializeAttachmentSummary(attachment);
console.log(summary);
```
