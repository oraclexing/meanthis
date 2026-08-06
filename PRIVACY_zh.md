---
layout: default
title: MeanThis 隐私说明
permalink: /zh/privacy/
lang: zh-CN
---

# MeanThis 隐私说明

[English](https://oraclexing.github.io/meanthis/privacy/) | 中文

最后更新：2026 年 8 月 6 日。

MeanThis 采用 local-first 设计。Consumer extension 不包含 analytics、telemetry、cloud sync、remote model call 或 hosted capture transport。可选本地 Agent 桥接默认关闭且只使用 loopback。

## MeanThis 读取什么

用户调用扩展并授予页面访问权限后，MeanThis 只为提取有限的 DOM、accessibility、style、bounds 与 locator facts 而读取选定的 HTTP(S) 页面。只有显式选择操作才会创建 capture。

## MeanThis 存储什么

Capture、任务说明、disclosure preference 与 saved-site metadata 保存在扩展所在的本地浏览器 profile 中。它们会保留到用户删除、清除 saved capture、卸载扩展或清除扩展数据为止。

## 什么会离开浏览器

任何数据都不会发送到 MeanThis server。只有用户显式复制 handoff、导出文件，或连接并批准可选本地 companion 时，文本才会离开扩展。该桥接只把 Agent-safe projection 发送到 `127.0.0.1`。之后由 clipboard、filesystem、browser、operating system 与接收应用控制这些数据。

## 权限

Consumer build 使用 `activeTab`、`alarms`、`contextMenus`、`scripting`、`sidePanel`、`storage` 与 `webNavigation`，没有无条件 `host_permissions` 或静态 `content_scripts`。只有在用户显式操作后才会请求可选 HTTP(S) 页面 access，并可在扩展设置中撤销。可选 `http://127.0.0.1/*` access 只会由 bridge connection action 请求，并在对应 state 结束时移除。

## Disclosure 限制

默认 disclosure mode 是 `Agent-safe`。Redaction 只是 best-effort recognition，不是 data-loss prevention。URL、可见 label、任务说明与周围 UI 文本仍可能包含敏感信息。复制前请检查 handoff。

## Chrome Web Store Limited Use

MeanThis 对信息的使用符合 [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)，包括其中的 Limited Use 要求。Consumer capture policy 强制要求 `allowNetworkSend: false`；MeanThis 不会出售数据，不会将其用于广告或信用决策，也不会向 data broker 提供数据。

## Saved snapshot

Saved snapshot 是历史上下文，不能证明页面仍然打开、未变化、可达或已获控制授权。下游 consumer 必须重新检查 live target，并取得所需的用户确认。

## 隐私政策网站

本说明通过 GitHub Pages 托管。GitHub 可能按照其隐私声明处理请求 metadata。MeanThis 不会在该政策网站中添加 analytics、广告、cookie 或 tracking script。

## 变更与联系

重要变更会记录在 [MeanThis 仓库](https://github.com/oraclexing/meanthis)中。不涉及敏感信息的一般隐私问题可以创建 public GitHub issue。需要私下处理或涉及安全的问题，请遵循[安全策略](https://github.com/oraclexing/meanthis/blob/main/SECURITY_zh.md)。
