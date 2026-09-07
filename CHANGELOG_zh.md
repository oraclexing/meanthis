# Changelog

[English](./CHANGELOG.md) | 中文

所有重要变更都会记录在此文件中。

## [0.1.0] - 早期测试

- 初始 MeanThis 浏览器扩展 candidate。
- 六个用于 schema、prompt、DOM extraction、selection、replay 与 capture session 的公共 `@meanthis/*` package。
- 浏览器 demo 与 saved-snapshot integration 示例。
- 同一目标被多次捕获时，各条标注可独立编辑和删除。
- 可以清理损坏的已保存站点，同时保留其他站点和最近一次捕捉；取消操作不会改变存储。
- 浮层重新打开时，并发读取页面范围不会再残留误报的操作失败提示。
- Agent-safe 捕获和 handoff 增加对常见服务商 token 格式的脱敏。
- 可选 MCP companion 包含四个只读工具（`meanthis_list_captures`、metadata-only 的有界等待 `meanthis_wait_capture_change`、`meanthis_read_capture` 与 `meanthis_resolve_source`），以及窄、瞬态的 `meanthis_ack_capture_read` acknowledgement mutation；每个 task 使用一个 thin stdio broker，并共享一个 detached Streamable HTTP owner。Host registration 只保存 absolute Node 与 broker entry，不含 environment、working directory 或 token；每个 broker 会先用 nonce/timestamp request/response 双向 HMAC proof 认证 owner，再在内存中使用受保护的 profile credential，透明转发 capabilities 与 `roots/list`，获得独立 session roots 且不使用 daemon cwd fallback，并在 stdio 结束时先请求立即删除 HTTP session；若 DELETE 或 daemon 不可用，则由有界 disconnected-grace/idle cleanup 回收 retained session。Direct HTTP、full stdio 与 standalone resolver 只保留为 compatibility 或 migration path。
- 只读 doctor 会检查 `agentCredential`，并为 `bridge-agent-key-v2` ACL drift 或可能泄露提供显式 `meanthis bridge rotate-agent-token --host codex --json` 恢复。普通 start 与 credential-load 路径绝不会修复或复用 insecure key。恢复会在 profile transition lock 下先轮换 MCP HTTP bearer，再轮换 Agent token，使两个 owner 一起 turnover。Registration current 时会重启并核验两个 owner，并要求重启受影响的 task 或 host。Registration missing 或属于 managed legacy 时，secure readback 后会发布 A2-bound desired marker，启动或 turnover 并核验 browser owner；不会启动 MCP HTTP owner，也不宣称完整 MCP runtime，并返回 `runtimeActive:false`、`browserOwnerActive:true` 与 install next step。Registration drifted 时 fail closed。Partial 或 committed-but-unverified 结果不会输出 token、credential path 或底层 cause。

可用的扩展下载见 [GitHub Releases](https://github.com/oraclexing/meanthis/releases)。npm packages 与 Chrome Web Store 版本尚未发布。
