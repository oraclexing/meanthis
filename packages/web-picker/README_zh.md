# @meanthis/web-picker

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

面向 Web app 的可复用 anchored UI comment 与元素选择流程。它可以作为 imported picker、injected reference runtime 或 bookmarklet wrapper 运行，并输出 attachment、人类意图和 Agent 可读 Markdown。

## 安装

```bash
npm install @meanthis/web-picker
```

## 示例

```ts
import { createUiAttachPicker } from "@meanthis/web-picker";

const picker = createUiAttachPicker({
  onSubmit: ({ attachment, intent, markdown }) => {
    console.log({ attachment, intent, markdown });
  },
});

picker.startComment();
```

## 安全默认值

Picker 与 injected runtime 使用确定性提取，并默认采用 `agent_safe` disclosure。它们不会联网发送数据、读取浏览器 storage、点击、输入、导航或提交表单。

Bookmarklet helper 会加载调用方提供的可信或自托管 browser ESM module，并拥有普通页面脚本权限。其事件和最近一次 export 对页面可见，所以只应在信任现有页面 JavaScript 时使用该 preview 路径。
