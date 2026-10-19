# 变更记录

## v0.1.0 — 2026-10-19

首版。它住在**官方「插件」页**里，不自建侧栏入口：一个标签页（`plugins.tab`，id `curator`），外加每个插件详情页底部的一小节（`plugins.detail.section`）。

**实测，而不是估算**

- 本机启动总时长：进程启动 → 所有已启用条目到达终态（或相位稳定），热安装与超时都不会被当成启动时长。
- 逐插件冷加载：独立子进程 `import()` 该插件入口，3 次取最小；跑在 DSH 自带的 node 上，不用 Electron 伪装。
- UI 耗时/体积：插件 client bundle 的字节数，加上浏览器 `Resource Timing` 按 `__DSH_BOOT__.entries[].url` 精确匹配后回传的真实耗时。
- A/B 启动历史：每次启动记一条组合指纹，组合变化时给出与上一次**不同组合**的差值。

**活跃度只统计真实发生的调用**

- 读会话日志里的 `tool/call`（逐 zstd 帧解码，滚动窗口默认 14 天）。
- 归属：`mcp__<server>__<tool>` 按该行 `serverName` 精确归属；其余工具名只在**声明形状**（`name: "x"`）里匹配，两个包同时声明则记为并列、不归属。
- 没有工具调用不等于没用：注入提示词/监听事件的插件只在冷加载 ≥ 60 ms 时才建议停用，否则报「本面板观测不到」。

**建议与清理**

- 规则：`load-failed`、`incompatible-version`、`stalled-pending`（启动后一直停在 pending/loading）、`disabled-long`、`slow-and-quiet`、`heavy-ui`、`quiet-host-only`、`unobservable-host-only`。
- 清理 = 停用 + 写回收站记录（入口 id、模块名、patch 行 id、原因、时间），不删包、不跑 pnpm。
- 找回 = 重新启用；patch 行已消失时追加一段 `- insert:`，先备份成 `cordis.patch.yml.bak-plugin-curator-<时间戳>`，再看 HMR 是否挂上，没挂上就明说「需要重启」。
- 官方组件（`@deepseek-ai/*` 与 `app.asar` 内的）在清单里默认折叠成一行，只列第三方条目；过滤时自动展开。

**验证**

- `node tools/verify-host.mjs`：21 项（判定规则、会话帧解码、工具归属、profile 探测、入口解析）。
- `node tools/verify-client.mjs`：16 项（stub React 渲染五个页签、官方组件折叠、三种 subject 的详情小节）。
- `node tools/verify-routes.mjs`：19 项（假 Host 上跑通七条路由，含真实子进程测量与 patch 回插 + 备份）。
- CI 另有「打好的 tarball 解包到临时目录后仍能跑通三套」的包契约检查。
