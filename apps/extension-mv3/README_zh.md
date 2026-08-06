# MeanThis 浏览器扩展

[English](./README.md) | 中文

Chrome Manifest V3 扩展是 MeanThis 的主要 capture surface。用户可以选择真实 UI 元素、检查 A-Z reference 与任务说明，再为 Agent 复制边界清晰的 handoff。

Consumer build 不包含 browser-control executor、source editor、analytics、telemetry、cloud sync 或 remote model call。

## 构建

在仓库根目录运行：

```bash
npm ci
npm run build
```

打开 `chrome://extensions`，启用开发者模式，选择**加载已解压的扩展程序**，再选择 `apps/extension-mv3/dist-consumer`。

## 使用

1. 在 HTTP(S) 页面上从工具栏调用 MeanThis。
2. 选择**添加元素**，再选择一个或多个 target。
3. 检查 reference 与可选任务说明。
4. 选择**复制给 Agent**。

核心流程在**复制给 Agent**完成，不需要 CLI。可选公开 `@meanthis/cli` companion 可通过三个只读 MCP tools 暴露经用户明确批准的 Agent-safe projection。同一 origin session 中保存在其他位置的 capture 会显示计数，但不会被包含在当前 page-scoped handoff 中。

## 权限与隐私

Consumer artifact 使用 `activeTab`、`alarms`、`contextMenus`、`scripting`、`sidePanel`、`storage` 与 `webNavigation`，没有无条件 `host_permissions` 或静态 `content_scripts`。可选页面 access 与 loopback access 需要分别由用户操作触发。

Capture 会保留在本地浏览器 profile 中，直到用户删除或清除扩展数据。Copy 与 export 都是显式操作。参见仓库的[隐私说明](../../PRIVACY_zh.md)。

## 打包未签名 candidate

```bash
npm run pack:extension
```

该命令会在被忽略的 `output/` 下生成确定性的本地 ZIP 与 checksum manifest，不会签名、上传或发布扩展。
