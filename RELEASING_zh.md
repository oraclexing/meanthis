# 发布 MeanThis

[English](./RELEASING.md) | 中文

本仓库可以构建本地 release candidate。下列命令都不会发布、签名、上传、创建 tag 或改变仓库可见性。

## 本地门禁

在 clean exact commit 上使用固定的 Node.js 与 npm 版本：

```bash
npm ci
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

`npm run build` 会编译九个公共 package、demo 与 consumer extension，运行公共示例，并在临时 offline consumer 中验证 package tarball。

`npm run pack:extension` 会在 `output/extension-mv3/consumer/<version>/` 下生成未签名的 consumer ZIP 与 checksum manifest。该 artifact 是本地完整性 candidate，不是签名或 publisher attestation。

## 仓库历史

首个 public commit 是经过审查、已去除私有身份信息的根提交，并有意排除私有开发历史。公开后，本仓库保留正常的增量 commit 与 pull request；日常更新不能用重新生成的根提交替换历史，也不能 force-push。

如果公共贡献修改了 projection 管理的文件，maintainer 应先把变更导入私有上游并完成审查。下一次 projection update 必须停止，而不是覆盖尚未导入的公共变更。Projection 工具可以暂存经过验证的 tree，但仍由人类检查并创建 public commit。

## 外部 owner 步骤

公开前，owner 必须另行审查 exact commit、remote CI、repository settings、npm scope custody 与 trusted publishing、公开[隐私说明](./PRIVACY_zh.md)、browser-store disclosure、签名，以及 fresh install 或 upgrade 行为。
