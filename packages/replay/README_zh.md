# @meanthis/replay

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

面向结构化 UI attachment 的 Playwright-like locator replay verifier。它先检查 primary locator，再检查去重后的 fallback candidates，并返回用于诊断的结构化 attempts；不会点击、输入、修改页面，也不要求把 Playwright 作为依赖。

## 安装

```bash
npm install @meanthis/replay @meanthis/schema
```

## 示例

```ts
import { applyReplayResult, verifyAttachmentLocator } from "@meanthis/replay";

const replay = await verifyAttachmentLocator(pageAdapter, attachment);
const updated = applyReplayResult(attachment, replay);
```

如果 adapter 实现只需要解析一组已经选定的 strategy/value，可以使用更高层的 `resolveReplayLocator` 导出。它只返回 replay locator 或固定失败原因，不会把 locator-expression parser 暴露为公共 API。
