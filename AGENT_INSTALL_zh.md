# 让 Agent 安装 MeanThis

本文是 coding agent 可直接执行的确定性安装契约。MeanThis 不要求额外 Skill：安装浏览器扩展、安装 host-neutral CLI/MCP companion、把它注册到用户实际使用的 MCP host，并在要求用户连接前验证本地桥接即可。

## 安全边界

- 默认 MCP surface 只读：`meanthis_list_captures`、`meanthis_read_capture` 与 `meanthis_resolve_source`。
- 不要把 MeanThis connection request 粘贴到网页、issue、日志或被跟踪的文件中。它是短时本地 capability。
- 只有用户在本设备创建了请求并明确要求连接后，才能批准连接。
- 浏览器扩展安装或权限提示必须由用户可见地确认；不得声称已静默完成。

## 从当前仓库安装

在首个 npm 与 Chrome Web Store release 公开前使用这条路径：

```powershell
git clone https://github.com/oraclexing/meanthis.git
Set-Location meanthis
npm ci
```

Codex 使用：

```powershell
npm run setup:bridge:codex
meanthis bridge doctor --json
```

Setup 会 build 并 link CLI，在真实修改前备份 Codex configuration，把 MCP server 注册为 `meanthis`，安全移除来自同一安装的精确 legacy `ui-attach` registration，并启动和验证本地 bridge owner。遇到冲突 registration 时不会覆盖。

Claude Code、VS Code 或 Cursor 先 build/link companion，再生成对应 host artifact：

```powershell
npm run build:bridge
npm link --workspace @meanthis/cli
meanthis bridge config --host claude-code --json
meanthis bridge config --host vscode --json
meanthis bridge config --host cursor --json
```

只应用用户实际 host 对应的 artifact，验证该 host 已列出带三个默认 tools 的 `meanthis` MCP server，然后运行：

```powershell
meanthis bridge start --json
```

## 浏览器扩展

Chrome Web Store listing 公开前，使用项目 release instructions 指定的已审阅 extension artifact。加载 unpacked build 需要 Chrome developer mode 与用户确认。商店 listing 公开后，打开该 listing，让用户确认 **添加至 Chrome**。Agent 不得替换成无关的 unpacked 或 development build。

## 建立连接

1. 请用户打开 MeanThis side panel，选择**创建并复制请求**。
2. 用户在同一设备把完整的 `MeanThis Connection Request` 发给 Agent。
3. 只有用户明确要求连接后，才运行该请求中精确的 `meanthis bridge approve ... --json` 命令。
4. 确认结果，但不要复述 approval key。
5. 先用 `meanthis_list_captures` 发现 capture，再用 `meanthis_read_capture` 渐进读取必要细节。只有 capture 含 source anchor 时才使用 `meanthis_resolve_source`。

如果 side panel 显示本地 Agent 连接失败，运行 `meanthis bridge start --json`，确认成功后再让用户重试。不要要求用户反复点击来隐式启动 runtime。

如果 `npm link` 因旧 `ui-attach` shim 返回 `EEXIST`，不要使用 `--force`。先检查该 shim 与 `npm root --global` 下的 package；只有两者都解析到当前精确 checkout，且 linked package 现在将自己标识为 `@meanthis/cli` 时，才用该 package metadata 中读到的精确 legacy package name 运行 `npm unlink --global`，再重试 setup。任何 foreign installation 都必须保持不动。

## Public package 发布后

届时可以用固定版本的公开 package 替代仓库安装：

```powershell
npm install --global @meanthis/cli@0.1.0
meanthis bridge install --host codex --json
```

自动化安装应固定精确 release 版本。不要只根据本文推断 package 已可用；必须先核验 release 与 package registry。
