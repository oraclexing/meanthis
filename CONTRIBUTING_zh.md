# 为 MeanThis 贡献

[English](./CONTRIBUTING.md) | 中文

感谢你帮助改进 MeanThis。请保持改动范围窄、可复现，并符合 UI reference layer 的产品边界。

## 开发环境

使用 Node.js 22.12+ 或 24.x，以及 npm 11.16.0：

```bash
npm ci
npm test
npm run build
```

运行 `npm run demo` 启动浏览器 demo。体验扩展时先构建，再在 Chrome 120+ 中以 unpacked extension 加载 `apps/extension-mv3/dist-consumer`。

## 改动要求

- 优先使用确定性的 DOM、accessibility、style、bounds 与 locator facts。
- 不要把浏览器控制或源码编辑执行加入产品。
- Vision integration 保持可选。
- 非平凡行为改动需要 focused test。
- 面向用户的英文与简体中文文档保持结构一致。
- 只有在能明确降低实现风险时才添加依赖。

## 公共数据边界

不要提交私有页面内容、raw capture、credential、token、cookie、私有源码、个人配置、浏览器录制、模型 transcript 或机器绝对路径。请使用合成 fixture 与经过清理的示例。

疑似漏洞请按 [SECURITY_zh.md](./SECURITY_zh.md) 私下报告。

## 提交 pull request 前

```bash
npm test
npm run build
npm run pack:extension
npm audit --audit-level=moderate
git diff --check
```

若有检查无法执行，请说明原因。Pull request 中应写明受影响的产品 surface、focused verification 与剩余风险。
