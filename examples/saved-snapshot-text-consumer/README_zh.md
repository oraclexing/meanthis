# 已保存快照 Text-Consumer 示例

[English](./README.md) | 中文

这是用于接收扩展**机器可读 bundle** disclosure 所复制的结构化 JSON，并把一份 Agent-safe saved attachment、一份 text-consumer result 与一份独立派生的 effective control boundary 组合起来的可执行公共参考代码。核心保持 provider-neutral，不是 npm package、provider SDK、executor 或 action API。一份 example-local file/stdin connector 会向 host process 暴露同一 acceptance boundary；一份可选 Ollama recipe 会演示显式 loopback transport，但都不改变该核心 contract。

## 它证明什么

`acceptSavedSnapshotTextConsumerBundleJson` 接受最多 1 MiB 的 JSON text document，只解析并验证一次，然后精确返回 `{ acceptedContext, consumerReceipt }`。两个 plane 彼此分离：context 是敏感的本地 agent input，receipt 是固定、public-safe 的 acceptance record。兼容的 `bindSavedSnapshotTextConsumerContextJson` 与 `createSavedSnapshotPublicConsumerReceiptJson` 继续作为同一 core 的单 plane wrapper。它们都绝不解析 presentation Markdown 来恢复 identity 或 authority。`runSavedSnapshotTextConsumer` 随后接收 bound context、host-owned control evidence，以及注入的 `invokeTextConsumer` callback。它们共同完成：

1. 使用与 trusted-host policy example 相同的 example-local validator，从 producer-declared Agent-safe bundle 投影 allowlisted structured field。Structured routing field 被排除；markdown 仍是 opaque producer content。
2. 把 authority、attachment ID/ref 与完整 markdown bytes 绑定进 `contentSha256`。Runner 会重算该 digest，并在 model callback 前拒绝不再匹配 host-preserved acceptance binding 的内容。
3. 从 verified context 派生精确 attachment ID 与 authority，再通过 public `evaluateSavedSnapshotControlPolicy` guard 评估 evidence。
4. 在调用 text consumer 前把 decision 映射成 `effectiveControlBoundary`。通过的 policy 只变成 `eligible_for_host_review`，绝不代表 action authorization；所有 denial 都保持 `blocked`。
5. 只把 `{ attachmentContext, controlDecision: { allowed, code } }` 的 clone 交给 text consumer。Receipt、structured routing field、tab、frame 与 callback 都被排除。
6. 返回三个分离平面：accepted attachment context、不可信 model text 或 unavailable status，以及带 `modelFieldsUsed: []` 的 deterministic boundary。

Consumer receipt 会把 canonical bundle hash 与 accepted context hash/kind、attachment count、authority status、routing policy、accepted status 和零 model-field 使用绑定起来；不包含 clipboard field，也不构成 operating-system clipboard proof。

可选的 `createSavedSnapshotTextConsumerAdapter` wrapper 会再次验证这份精确 consumer input，向 provider 提供一份 deep-frozen clone 与 `AbortSignal`，施加 bounded timeout，只接受非空 text，并把所有 provider failure 替换成一条固定本地错误。它不选择 provider、不构造 network request、不解析 model output，也不增加 control field。

同目录的 `createLocalOllamaTextProvider` recipe 会为本地开发补上一份具体 `invokeProvider`。它只接受 `http://127.0.0.1:<explicit-port>`、一份显式 model 与 deterministic seed；不发送 credential、不跟随 redirect、不暴露 custom header，并把 JSON response 限制为 1 MiB。该 recipe 不是 provider registry 或通用 Ollama SDK。

Model text 不能更新或替换 effective boundary。如果 callback 抛错或返回非 string value，`modelOutput` 会变成 `{ status: "failed", value: null }`，独立派生的 boundary 保持不变。

## 运行 synthetic proof

```powershell
npm run example:saved-snapshot:text-consumer
```

该命令会 build public packages，从 repository-owned 双目标 fixture 创建 production Compact saved bundle，经与扩展 copy path 相同的 combined JSON ingress 序列化并只重新接收一次，再通过 provider adapter 分别运行一份 confirmed 与 denied synthetic scenario。它只打印 ingress kind、receipt kind、attachment count、model-output status、effective-boundary state 与零 model-field count，不打印 attachment markdown、locator、receipt hash、provider error 或 model text。

## 运行有界 file/stdin connector

Repository example contract 快速参考：

| 关注点 | 精确角色 |
| --- | --- |
| 入口 | npm script `example:saved-snapshot:text-consumer:accept` |
| npm 参数转发 | 紧跟 script name 的 `--` |
| Connector flag token | `--input` |
| 文件值 placeholder | 位于 `--input` 之后的 `<path>` |
| Stdin value token | 位于 `--input` 之后的 `-`；省略 connector argument 与其等价 |
| 成功 stdout | 一份 JSON document，顶层精确只有 `acceptedContext` 与 `consumerReceipt` 两个 key |
| Trusted-host 分流 | stdout 只发送给 trusted local host；只把 `acceptedContext` 传入 text-consumer path，把 `consumerReceipt` 留在 host evidence plane |

复制 machine-readable bundle 后，可使用显式本地文件：

```powershell
npm run --silent example:saved-snapshot:text-consumer:accept -- --input .\saved-bundle.json
```

也可以先 build package，再绕过 npm，通过 stdin 发送 UTF-8 text。该 direct-Node form 既不使用 npm script，也不使用 npm forwarding `--`；`--input -` 会直接传给 connector，并与省略 connector argument 等价：

```powershell
npm run build:packages
Get-Content -Raw -Encoding utf8 -LiteralPath .\saved-bundle.json |
  node examples/saved-snapshot-text-consumer/accept-saved-bundle.mjs --input -
```

Connector 会在 acceptance 前把原始 file 或收到的 stdin bytes 限制为 1 MiB，然后接收带或不带一个前置 byte-order mark 的 UTF-8。成功时只写出一份精确包含 `{ acceptedContext, consumerReceipt }` 的 deterministic JSON document；invalid argument 以 code 2 退出，unreadable、empty、invalid、oversized 或 non-Agent-safe input 以 code 3 退出，output transport failure 以 code 1 退出。失败只向 stderr 写一条固定消息，绝不回显 input、path、parser detail 或 stack。

成功 stdout 是刻意提供给本地 host 的 content-bearing transport，不是 publication-safe report。`acceptedContext` 可能含 page-derived Markdown 与 attachment identifier。只应把它导向 trusted local host、避免持久日志、把 `consumerReceipt` 留在 host evidence plane，并且只把 `acceptedContext` 传入 text-consumer path。

## 运行可选的本地 Ollama smoke

先在 loopback Ollama runtime 安装精确 model，再运行：

```powershell
npm run example:saved-snapshot:text-consumer:ollama -- --model <exact-local-model> --seed 22 --timeout-ms 120000
```

该 smoke 会让一份 production saved-context input 经过本地 recipe 与 adapter。它的 host evidence 刻意缺少 live recheck，因此即使 opaque model text 声称允许 action，结果也必须以 `live_recheck_required` 保持 `blocked`。标准输出只含 model 名称、有界 profile、attachment count、model-output status、deterministic boundary 与零 model-field count，绝不打印 attachment context、locator、model text 或 provider error。Ollama 或精确 model 不可用时会明确失败，不会 silent skip。


## Integration 形态

```js
import {
  acceptSavedSnapshotTextConsumerBundleJson,
  runSavedSnapshotTextConsumer,
} from "./index.mjs";
import { createSavedSnapshotTextConsumerAdapter } from "./provider-adapter.mjs";
import { createLocalOllamaTextProvider } from "./local-ollama-provider.mjs";

const acceptance = acceptSavedSnapshotTextConsumerBundleJson(copiedBundleJson);
if (acceptance === null) return { status: "rejected" };
const { acceptedContext, consumerReceipt } = acceptance;
recordHostConsumerReceipt(consumerReceipt);

const invokeProvider = createLocalOllamaTextProvider({
  ollamaUrl: "http://127.0.0.1:11434",
  model: "<exact-local-model>",
  seed: 22,
});
const invokeTextConsumer = createSavedSnapshotTextConsumerAdapter({
  timeoutMs: 30_000,
  invokeProvider,
});

const result = await runSavedSnapshotTextConsumer({
  acceptedContext,
  controlEvidence: {
    controlAttemptId,
    liveRecheck,
    userConfirmation,
    evaluatedAt: trustedClock.nowIso(),
  },
  invokeTextConsumer,
});

if (result.status === "rejected") return result;

renderReferenceAndModelText(result.attachmentContext, result.modelOutput);
if (result.effectiveControlBoundary.state === "blocked") {
  return result.effectiveControlBoundary;
}

// eligible_for_host_review 仍不代表执行 action 的权限。
return result.effectiveControlBoundary;
```

对于其他 text provider，保留相同 adapter，只把 `invokeProvider` 换成一份 host-owned function：它接收 `{ consumerInput, signal }` 并返回非空 string。Endpoint selection、authentication、request serialization 与 response extraction 继续留在 provider-neutral contract 之外。

配套的 [trusted-host example](../saved-snapshot-trusted-host/README_zh.md)展示 host 如何依次调用 external live-recheck 与 human-confirmation issuer。本示例从已经可用的 evidence 开始并自行重新评估，绝不接受 model-authored boundary。

## Trust boundary

- `copiedBundleJson` 必须来自 host 信任的 producer。JSON ingress 会把完整 transport 限制在 1 MiB；shared projector 随后验证 allowlisted production shape，并把 markdown 限制为最多 262,144 bytes。两步都不能认证 clipboard provenance、解释 markdown instruction 或证明 redaction。
- `consumerReceipt` 只证明所提供的 JSON text 已成功解析，且其 canonicalized bundle 在当前 host invocation 中通过了该 deterministic public ingress。它不绑定原始 transport 的空白或换行 bytes，也不是 signature、authentication token、clipboard-provenance receipt、model-execution receipt 或 action authorization。
- Connector stdout 是刻意的 content-bearing local transport。Receipt 本身 public-safe，但相邻的 `acceptedContext` 并不会自动变得适合记录日志、公开或发送给 untrusted provider。
- `contentSha256` 让 runner 能依据 host 保留的 binding 检出内容变化。它不是 signature 或 secret MAC，无法防护 context 与 digest 同时被替换，也不证明 producer 发出了 canonical 或安全内容。
- `controlEvidence` 仍由 host 负责。Public evaluator 会验证其结构与 binding，但不能认证 issuer，也不能证明页面确实经过检查或 human 确实确认。
- `runSavedSnapshotTextConsumer` 仍只把 `invokeTextConsumer` 当作 transport injection。可选 provider adapter 增加本地 timeout 与 cooperative `AbortSignal`，但不选择 provider，也不发送 network request。独立 Ollama recipe 只选择显式 loopback model 并执行一次有界本地请求。忽略 signal 的 provider 可能在 adapter fail closed 后继续底层工作。
- 对于 provider throw、timeout、blank 或 non-text result，adapter 只暴露 `Saved-snapshot text provider failed.`。Provider endpoint、credential 与 raw error 必须留在返回的 MeanThis data 之外。
- `modelOutput.status: completed` 只表示返回了非空 text value。该文本不可信，也绝不参与 `effectiveControlBoundary`。
- 三个返回平面彼此独立 clone。Model-input 或 caller mutation 无法改变已经派生的 boundary。
- 该示例、process connector 与 opt-in local recipe 留在 publishable package tarball 之外，不增加 dependency、extension permission、publishable package CLI command、MCP tool、browser operation、remote endpoint 或 public-release claim。
