# 已保存快照 Trusted-Host 示例

[English](./README.md) | 中文

这是面向 `@meanthis/schema` integration 的可执行公共参考代码，不会把 MeanThis 变成 browser-control executor。它不是 npm package、connector 或 action API。

## 它证明什么

`evaluateAcceptedSavedSnapshotWithTrustedHost` 接收一份 production `ui-attach.saved-snapshot-prompt-bundle` object。在任何异步 adapter call 前，它会从同一份 accepted object 复制 `agent_safe` authority、attachment ID 与 attachment ref，拒绝 routing field 或不一致的 ID/ref set，再依次调用 public policy guard：

1. Host 生成一份 opaque control-attempt ID，并提供 canonical current time。
2. 无 receipt preflight 必须返回 `live_recheck_required`。
3. External live-recheck issuer 接收被冻结的 saved reference。只有 receipt 在结构、freshness、origin、attempt 与逐 target unique match 上全部成立，才会请求 user confirmation。
4. External human-confirmation issuer 把自己的 receipt 绑定到同一 attempt 与精确 recheck receipt。
5. 最终 policy evaluation 使用新的、monotonic host time。

函数只返回 `SavedSnapshotControlPolicyDecisionV1`。它没有 action payload、success callback、DOM query、locator replay、tab selection、local-bridge call 或 browser-control operation。

## 运行 synthetic proof

```powershell
npm run example:saved-snapshot:trusted-host
```

该命令会 build public packages，从 repository-owned 双目标 capture fixture 创建 production Compact saved bundle，注入 deterministic synthetic issuer，并且只打印 decision：

```json
{
  "allowed": true,
  "code": "requirements_satisfied",
  "liveRecheckReceiptId": "receipt_0123456789abcdef"
}
```

## Integration 形态

```js
import { evaluateAcceptedSavedSnapshotWithTrustedHost } from "./index.mjs";

const decision = await evaluateAcceptedSavedSnapshotWithTrustedHost({
  acceptedBundle,
  createControlAttemptId: hostAttemptIds.create,
  nowIso: trustedClock.nowIso,
  issueLiveRecheck: livePageAdapter.issueRecheckReceipt,
  issueUserConfirmation: humanUi.issueConfirmationReceipt,
});

if (!decision.allowed) {
  // 停止。Denial code 可以安全记录或显示给用户审阅。
  return decision;
}

// MeanThis 不执行后续 action。Host 仍负责 action scope、receipt-issuer
// trust，以及是否允许执行任何 action 的最终决定。
```

## Trust boundary

- `acceptedBundle` 必须来自 host 信任的 producer。该示例验证其有界 shape，但不能认证 provenance。
- Synthetic runner 不检查 live page，也不证明 human 确实操作了 confirmation UI；真实 issuer 仍是 host-owned adapter。
- 真实 issuer adapter 必须执行自己的 bounded timeout 与 cancellation policy。这个不含 transport 的示例会等待每个 adapter，无法取消永不 settle 的底层工作。
- `nowIso` 必须使用 host 的 trusted current clock。示例会拒绝 invalid 或 backward timestamp，但不能证明 clock 本身诚实。
- `allowed: true` 是 structural policy evidence，不是 authorization token，也不证明后续 action 安全。
- 该示例留在 publishable package tarball 之外，不增加 extension permission、CLI command、connector transport 或 control capability。
