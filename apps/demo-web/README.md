# MeanThis Demo

English | [中文](./README_zh.md)

This small Vite app demonstrates the public MeanThis packages in a real browser flow. It provides element selection, attachment preview, prompt serialization, and locator replay without adding a separate transport or executor.

From the repository root:

```bash
npm ci
npm run build:packages
npm run demo
```

Open the loopback URL printed by Vite. The page uses synthetic content and is suitable for local development. `external-target.html` is a standalone target with no MeanThis imports; the compatibility fixture pages cover frame and locator behavior used by the extension and tests.

The demo does not control another page, send captures to a server, or edit source.
