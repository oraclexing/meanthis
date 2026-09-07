---
layout: default
title: MeanThis 隐私说明
permalink: /zh/privacy/
lang: zh-CN
---

# MeanThis 隐私说明

[English](https://github.com/oraclexing/meanthis/blob/main/PRIVACY.md) | 中文

最后更新：2026 年 8 月 10 日。

MeanThis 采用 local-first 设计。Consumer extension 不包含 analytics、telemetry、cloud sync、remote model call 或 hosted capture transport。可选本地 Agent 桥接默认关闭且只使用 loopback。

## MeanThis 读取什么

用户调用扩展并授予页面访问权限后，MeanThis 只为提取有限的 DOM、accessibility、style、bounds 与 locator facts 而读取选定的 HTTP(S) 页面。Toolbar 默认打开 extension-origin `widget.html` 页内工具；首次捕获 disclosure、selection、任务说明、复制与窄本地邀请流程都可以在那里完成，选择**更多**才会打开 side panel。只有显式选择操作才会创建 capture。

`widget.html` 是 consumer manifest 中唯一匹配 HTTP(S) 的 web-accessible resource，并且只会在用户调用后嵌入。它的 capability、任务说明文本与 invitation 不会写入 host-page DOM node 或 attribute；受 same-origin boundary 保护，普通 host-page script 无法读取 extension-origin frame document。页面仍可遮挡、移动或移除外层 host。这里不声称能够绝对隔离另一个拥有自身权限的同用户 extension、browser/OS compromise，或 Permissions Policy 等由浏览器执行的 policy。

## MeanThis 存储什么

Capture、任务说明、disclosure preference 与 saved-site metadata 保存在扩展所在的本地浏览器 profile 中。它们会保留到用户删除、清除 saved capture、卸载扩展或清除扩展数据为止。

## 什么会离开浏览器

任何数据都不会发送到 MeanThis server。只有用户显式复制 handoff、导出文件，或授权一份由可选本地 companion 接受的连接邀请时，文本才会离开扩展。该桥接只把 Agent-safe projection 发送到 `127.0.0.1`。之后由 clipboard、filesystem、browser、operating system 与接收应用控制这些数据。

## 权限

Consumer build 使用 `activeTab`、`alarms`、`contextMenus`、`nativeMessaging`、`scripting`、`sidePanel`、`storage` 与 `webNavigation`。用户创建邀请时，`nativeMessaging` 只向另行安装的 MeanThis 本地组件发送固定且有界的启动请求，不发送 executable path、command arguments、credential 或页面内容。`sidePanel` 用于通过**更多**打开的已保存捕捉、详细审阅、导出、设置与其他高级控件。它没有无条件 `host_permissions` 或静态 `content_scripts`。只有在用户于设置页或页面访问恢复卡中显式操作后，才会请求可选 HTTP(S) 页面 access，并可在扩展设置中撤销。仅有 permission 不会创建 capture。可选 `http://127.0.0.1/*` access 只会由 bridge connection action 请求，并在对应 state 结束时移除。

## Disclosure 限制

默认 disclosure mode 是 `Agent-safe`。Redaction 只是 best-effort recognition，不是 data-loss prevention。URL、可见 label、任务说明与周围 UI 文本仍可能包含敏感信息。复制前请检查 handoff。

## Chrome Web Store Limited Use

MeanThis 对信息的使用符合 [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)，包括其中的 Limited Use 要求。Consumer capture policy 强制要求 `allowNetworkSend: false`；MeanThis 不会出售数据，不会将其用于广告或信用决策，也不会向 data broker 提供数据。

## Saved snapshot

Saved snapshot 是历史上下文，不能证明页面仍然打开、未变化、可达或已获控制授权。下游 consumer 必须重新检查 live target，并取得所需的用户确认。

## 敏感页面与用户控制

- 优先使用不包含敏感信息的测试或 demo 页面。除非流程已获得明确授权并且会审阅输出，否则不要捕获 authentication、financial、health、private-message、secret-management 或 production-admin 页面。
- 除非确实需要更多细节，否则保持 `Agent-safe`。把 `full_debug` 视为明确的敏感模式。
- 使用**停止选择**或按 `Escape` 结束选择。切换 tab 和页面导航会自动撤销选择。
- 使用**移除**删除单个项目，使用**已保存捕捉**检查或清除本地保留的 capture，使用**清除全部已保存捕捉**删除本功能拥有的全部 capture 数据。要完全删除扩展存储，请清除浏览器扩展数据或卸载扩展；已导出的文件和剪贴板内容需要单独删除。

MeanThis 是 context-capture tool，不是 credential manager、privacy scanner、data-loss-prevention system 或 authorization system。

## 隐私政策网站

本说明可在 GitHub 仓库中阅读，也可以通过 GitHub Pages 提供。GitHub 可能按照其隐私声明处理请求 metadata。MeanThis 不会在该政策网站中添加 analytics、广告、cookie 或 tracking script。

## 变更与联系

重要变更会记录在 [MeanThis 仓库](https://github.com/oraclexing/meanthis)中。不涉及敏感信息的一般隐私问题可以创建 public GitHub issue。需要私下处理或涉及安全的问题，请遵循[安全策略](https://github.com/oraclexing/meanthis/blob/main/SECURITY_zh.md)。
