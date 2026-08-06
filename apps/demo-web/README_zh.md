# MeanThis Demo

[English](./README.md) | 中文

这个小型 Vite app 在真实浏览器流程中展示公共 MeanThis packages。它提供元素选择、attachment preview、prompt serialization 与 locator replay，不会新增独立 transport 或 executor。

在仓库根目录运行：

```bash
npm ci
npm run build:packages
npm run demo
```

打开 Vite 输出的 loopback URL。页面使用合成内容，适合本地开发。`external-target.html` 是不 import MeanThis 的 standalone target；compatibility fixture 页面覆盖扩展与测试使用的 frame 和 locator 行为。

Demo 不会控制其他页面、把 capture 发送到 server 或编辑源码。
