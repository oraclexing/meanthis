# 安全政策

[English](./SECURITY.md) | 中文

## 支持版本

首次 stable release 之前，安全修复面向 `main` 的最新 commit 与当前 `0.1.x` candidate line。

## 报告漏洞

疑似漏洞不要提交 public issue。请使用 [GitHub private vulnerability reporting](https://github.com/oraclexing/meanthis/security/advisories/new)，并提供受影响版本、可复现条件、影响，以及验证所需的最小清理后证据。

不要包含 credential、私有页面内容、cookie、token、私有源码或无关个人数据。我们会确认报告、按受支持边界验证，并在适当时协调修复与披露。

## 产品边界

MeanThis 捕获并序列化 UI reference context。它不是 browser-control executor 或 source-editing agent。Capture、locator replay 与 saved-snapshot policy result 不会授予下游权限。

本地 companion 使用相互独立、受保护的 Agent 与 MCP HTTP credential。普通 start 与 credential-load 路径绝不会复用或修复 insecure `bridge-agent-key-v2`。只有只读的 `meanthis bridge doctor --json` 因 ACL drift 把 `agentCredential` 报告为 insecure，或 Agent key 可能已经泄露时，才使用显式恢复命令 `meanthis bridge rotate-agent-token --host codex --json`。它会在 profile transition lock 下先轮换 MCP HTTP bearer，再轮换 Agent token。Registration current 时会重启并核验两个 owner，并要求重启受影响的 task 或 host。Registration missing 或属于 managed legacy 时，secure readback 后会发布 A2-bound desired marker，启动或 turnover 并核验 browser owner；不会启动 MCP HTTP owner，也不宣称完整 MCP runtime，并返回 `runtimeActive:false`、`browserOwnerActive:true` 与 install next step。从首个支持该协议的 marker-aware build 起可以自动 turnover。若机器上仍运行完全不认识 desired-marker 协议的更老 browser owner，它可能不会自退；CLI 会 fail closed，并提示用户停止占用 `127.0.0.1:38471` 的旧进程后重试。Registration drifted 时 fail closed。Partial 或 committed-but-unverified 结果不会输出 token、credential path 或底层 cause。该合同不会移除已接受的 fixed-port、无 TLS/channel-binding residual，也不授予 browser-control authority。

数据处理详情参见 [PRIVACY_zh.md](./PRIVACY_zh.md)。
