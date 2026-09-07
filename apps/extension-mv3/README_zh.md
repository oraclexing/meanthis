# MeanThis 浏览器扩展

[English](./README.md) | 中文

Chrome Manifest V3 扩展是 MeanThis 的主要 capture surface。用户可以选择真实 UI 元素、检查引用标签与任务说明，再为 Agent 复制边界清晰的 handoff。

Consumer build 不包含 browser-control executor、source editor、analytics、telemetry、cloud sync 或 remote model call。

## 构建

在仓库根目录运行：

```bash
npm ci
npm run build
```

打开 `chrome://extensions`，启用开发者模式，选择**加载已解压的扩展程序**，再选择 `apps/extension-mv3/dist-consumer`。

## 使用

1. 在 HTTP(S) 页面上从工具栏调用 MeanThis。Toolbar 默认会打开 extension-origin 页内工具；若显示首次捕获 disclosure，请先检查。若要跨页面重复使用，也可以在页面访问恢复卡中显式请求可选的持续 HTTP(S) access。
2. 在页内工具中选择**添加元素**，再选择一个或多个 target。
3. 检查 reference 与可选任务说明。
4. 选择**复制给 Agent**。

核心流程在**复制给 Agent**完成，不需要 CLI。首次捕获 disclosure、selection、任务说明编辑、复制与窄本地连接邀请流程都可以在页内工具中完成；选择**更多**才会打开 side panel，用于已保存捕捉、详细审阅、导出、设置与其他高级控件。可选公开 `@meanthis/cli` companion 可通过四个只读 MCP tools（其中包括 metadata-only 的有界等待 `meanthis_wait_capture_change`）与一个窄、瞬态的 read-acknowledgement mutation，暴露经用户明确授权的 selected scope Agent-safe projection。连接后，实际变化会自动发布，不需要额外的“共享”动作。同一 origin session 中保存在其他位置的 capture 会显示计数，但不会被包含在当前 page-scoped handoff 中。

## 权限与隐私

Consumer artifact 使用 `activeTab`、`alarms`、`contextMenus`、`nativeMessaging`、`scripting`、`sidePanel`、`storage` 与 `webNavigation`。用户创建邀请时，`nativeMessaging` 只向另行安装的 companion 发送固定且有界的启动请求。它没有无条件 `host_permissions` 或静态 `content_scripts`。可选页面 access 与 loopback access 需要分别由用户操作触发。持续页面 access 不会创建 capture；**添加元素**仍是显式操作。

`widget.html` 是 consumer manifest 中唯一匹配 HTTP(S) 的 web-accessible resource，并且只会在用户调用后嵌入。Capability、任务说明文本与 invitation 不会写入 host-page DOM node 或 attribute；受 same-origin boundary 保护，普通 host-page script 无法读取 extension-origin frame document。页面仍可遮挡、移动或移除外层 host。这里不声称能够绝对隔离另一个拥有自身权限的同用户 extension、browser/OS compromise，或 Permissions Policy 等由浏览器执行的 policy。

Capture 会保留在本地浏览器 profile 中，直到用户删除或清除扩展数据。Copy 与 export 都是显式操作。参见仓库的[隐私说明](../../PRIVACY_zh.md)。

## 打包未签名 candidate

```bash
npm run pack:extension
```

该命令会在被忽略的 `output/` 下生成确定性的本地 ZIP 与 checksum manifest，不会签名、上传或发布扩展。
