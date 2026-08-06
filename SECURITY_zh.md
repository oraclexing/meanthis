# 安全政策

[English](./SECURITY.md) | 中文

## 支持版本

首次 stable release 之前，安全修复面向 `main` 的最新 commit 与当前 `0.1.x` candidate line。

## 报告漏洞

疑似漏洞不要提交 public issue。请使用 [GitHub private vulnerability reporting](https://github.com/oraclexing/meanthis/security/advisories/new)，并提供受影响版本、可复现条件、影响，以及验证所需的最小清理后证据。

不要包含 credential、私有页面内容、cookie、token、私有源码或无关个人数据。我们会确认报告、按受支持边界验证，并在适当时协调修复与披露。

## 产品边界

MeanThis 捕获并序列化 UI reference context。它不是 browser-control executor 或 source-editing agent。Capture、locator replay 与 saved-snapshot policy result 不会授予下游权限。

数据处理详情参见 [PRIVACY_zh.md](./PRIVACY_zh.md)。
