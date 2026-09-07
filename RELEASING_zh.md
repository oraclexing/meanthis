# 发布 MeanThis

[English](./RELEASING.md) | 中文

本仓库可以构建本地 release candidate。下列命令都不会发布、签名、上传、创建 tag 或改变仓库可见性。

## 本地门禁

在 clean exact commit 上使用受支持的 Node.js release line 与精确 npm 版本：

```bash
npm ci
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

`npm run build` 会编译九个公共 package、demo 与 consumer extension，运行公共示例，并在临时的缓存优先 consumer 中验证 package tarball。该 consumer 使用 `--prefer-offline`，所以冷缓存下 npm 仍可能访问已配置的 registry。

`npm run pack:extension` 会在 `output/extension-mv3/consumer/<version>/` 下生成未签名的 consumer ZIP 与 checksum manifest。该 artifact 是本地完整性 candidate，不是签名或 publisher attestation。

## GitHub Release 草稿

Public repository 包含一个只响应精确 `vX.Y.Z` tag 的 workflow。它要求 tag version 与所有 public package 和 browser manifest 一致，要求 tagged commit 位于 `origin/main`，重新运行本地门禁，并只暂存三个 asset：

```text
meanthis-extension-mv3-<version>.zip
meanthis-extension-mv3-<version>.manifest.json
meanthis-extension-mv3-<version>.sha256
```

Checksum file 同时绑定 ZIP 与 manifest。Workflow 只创建 **draft** GitHub Release，随后验证它仍是 draft 且远端 asset name 完全一致，绝不会发布该 draft。它也不会创建 tag：owner 审查并批准 exact commit 后，再单独创建并推送 tag。

GitHub Release 可以让用户免编译下载，但 Chrome 仍要求解压，并在开发者模式中使用**加载已解压的扩展程序**。签名后的 Chrome Web Store listing 是另一条真正的一键安装路径。

npm 发布同样是独立步骤。MCP server 与宿主无关；npm 只是让 CLI executable 更易安装，不会改变协议，也不会授予任何 Host integration authority。

## 仓库历史

首个 public commit 是经过审查、已去除私有身份信息的根提交，并有意排除私有开发历史。公开后，本仓库保留正常的增量 commit 与 pull request；日常更新不能用重新生成的根提交替换历史，也不能 force-push。

如果公共贡献修改了 projection 管理的文件，maintainer 应先把变更导入私有上游并完成审查。下一次 projection update 必须停止，而不是覆盖尚未导入的公共变更。Projection 工具可以暂存经过验证的 tree，但仍由人类检查并创建 public commit。

## 外部 owner 步骤

公开前，owner 必须另行审查 exact commit、remote CI、repository settings、npm scope custody 与 trusted publishing、draft Release 与全部三个 asset、公开[隐私说明](./PRIVACY_zh.md)、browser-store disclosure、签名，以及 fresh install 或 upgrade 行为。发布 draft Release、发布 npm package、提交 Chrome Web Store 与改变 repository visibility 仍是彼此独立的 owner action。
