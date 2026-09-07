# @meanthis/web-picker

[English](./README.md) | 中文

> 发布状态：`0.1.0` 是尚未发布的 candidate。在[项目更新日志](https://github.com/oraclexing/meanthis/blob/main/CHANGELOG_zh.md)记录 publication 前，请使用当前 workspace 或已验证的 package tarball；下方 install 命令描述预期的 registry 用法。

这是供自有页面代码接入的 MeanThis 共享浏览器核心。它提供一套连续元素选择 controller、持久 A-Z overlays、浮动挂件 view 与单 document surface arbitration。SDK 挂件和 MV3 扩展 adapter 会复用这些 primitive，不再分别维护 pointer、hover、Escape 与 overlay 实现。

## 安装

```bash
npm install @meanthis/web-picker
```

## SDK 挂件

```ts
import { createMeanThisWebWidget } from "@meanthis/web-picker";

const widget = createMeanThisWebWidget({
  initialOpen: true,
  onCopy: ({ text }) => {
    console.log(text);
  },
});

// 应用自己的控制也可以复用同一个 controller。
widget.startSelection();
```

`createMeanThisWebWidget` 会在多次选择之间持续保持工作模式，在点击前显示 hover preview，提供 anchored edit/remove 操作，并从当前目标集合生成 Agent-safe handoff。在同一个 DOM 目标的不同位置点击，会在该目标下创建独立的编号注释；每条评论与选择点彼此独立，同时 locator 证据只输出一次。调用 `stopSelection()` 或按 `Escape` 可退出工作模式；宿主页面销毁集成时调用 `destroy()`。

## 共享 primitive

- `createElementSelectionController` 负责确定性的 pointer、click、Escape、preview 与 activation lifecycle；adapter 负责 extraction、storage 与 authorization。
- `createPersistentOverlayController` 负责目标 outline、label、anchor 与逐目标操作。
- `createInPageWidgetView` 负责可复用浮动 workbar 与 editor view。
- `claimMeanThisSurface` 防止 SDK 与扩展在同一个顶层 document 中重复挂载 MeanThis surface。

Surface claim 只包含公开的 owner/version 标记。它只用于避免冲突，不是认证，也不会保存任务说明、邀请、capture、token 或 capability。

## 调试与安全

仅在本地视觉 QA 时，可设置 `debugInspectableDom: true`，将同一套共享 view 挂载到 light DOM，让浏览器检查与评论工具能够选中内部控件。此模式会让宿主页面读取挂件内容（包括任务说明），不得在生产页面或敏感内容上启用；默认使用隔离的 closed Shadow DOM。

SDK 以宿主应用的页面权限运行，不提供 Native Messaging、扩展 storage 或本地 Agent 邀请。这些能力继续留在扩展 adapter 中。未 import 本 package 的任意网页仍需使用 MeanThis 扩展。
