# @meanthis/web-extractor

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

用于 UI attachment 的确定性浏览器端 DOM 提取器。它会捕获元素事实、accessibility metadata、bounds、computed styles、周边上下文、locator candidates 和 disclosure audit metadata。默认 disclosure mode 为 `agent_safe`。

如果经过 instrumentation 的元素同时带有 `data-ui-attach-build-id` 与 `data-ui-attach-source-id`，extractor 会把它们复制到实验性的、不透明 `sourceAnchor`。不完整或格式错误的 anchor 会被忽略。Extractor 不会读取携带 path 的 source attribute，也不会把页面值当成已验证结果。

## 资源限制

Selected DOM text 的收集不会先物化元素的完整 `textContent`。Bounded traversal 最多收集 10,000 个节点；仅为区分刚好达到边界与确有截断，最多再检查 1 个节点；返回值最多 16,000 个字符。截断值以 `[truncated]` 结尾，且该 marker 计入字符限制。超过 16,000 个字符的页面 attribute 不会用于构造 locator candidate，因为截断 attribute 会生成页面上并不存在的 selector。实际发出的非坐标 locator 还会遵守共享的 4,096 字符 replay contract。

Stable-data locator discovery 最多检查所选元素的 256 个 attribute；form-label discovery 最多检查 64 个关联 label。这些只是 fallback discovery 的边界；直接 `data-testid`、`id` 与 accessible-name 路径仍保留正常优先级。

完成后的 attachment 必须不超过 131,072 个 serialized JSON 字符，否则 extraction 会抛出错误并 fail closed。Embedded-URL redaction 对单个 value 中不超过 64 个 URL start 保持既有行为；遇到第 65 个 start 时立即停止收集，并返回 fail-closed 的 `[redacted:url]`。

## 安装

```bash
npm install @meanthis/web-extractor @meanthis/schema
```

## 示例

```ts
import { extractElementAttachment } from "@meanthis/web-extractor";

const button = document.querySelector<HTMLButtonElement>("button[type=submit]");
if (button) {
  const attachment = extractElementAttachment(button);
  console.log(attachment.locatorBundle.primary);
}
```
