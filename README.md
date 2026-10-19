# dsh-plugin-curator · 插件管家

**官方「插件」页里的一个标签页**（`插件 → 插件管家`，紧挨着自带的「已安装」标签），回答四个问题：**装了什么、每个插件拖慢启动多少、平时有没有在用、哪些可以清掉**。它不自建侧栏入口 —— 插件管理本来就是那一页的事，管家只是把「实测」接了进去；同一份结论还会出现在每个插件自己的详情页底部。

它的第一原则是：**每个数字都标注测量方法**。面板里不会出现「预计节省 300 ms」这种没有来源的估算 —— 只有三种实测（本进程启动、子进程冷加载、浏览器 Resource Timing）和一条 A/B 启动历史。

```
插件（官方页） → 插件管家 标签
                    └─ 概览 / 插件 / 建议 / 启动开销 / 清理与找回
                         └─ 「插件」里官方组件默认折叠（203 行压成一行），
                            只列 26 个第三方条目；输入过滤词会自动展开
插件（官方页） → 某个插件详情 → 底部「插件管家 · 实测」小节
```

两个注册点都在官方插件页内，且随本插件 fiber 一起释放（重载不会留下残影）：

| Slot | id | 作用 |
|---|---|---|
| `plugins.tab` | `curator` | 官方插件页的标签页；id 就是标签 key（页面按 `{ only: tab }` 渲染） |
| `plugins.detail.section` | `curator-detail` | 单个插件详情页底部的小节；subject 不是组合里的插件时渲染 `null` |

---

## 一、它测什么，怎么测

| 数字 | 含义 | 测量方法 | 可信度 |
|---|---|---|---|
| 本机启动总时长 | 进程启动 → 所有已启用条目进入终态（active / failed），或相位 3 次轮询不再变化 | Host 半在 `apply()` 时用 `process.uptime()` 回推进程起点，然后每 250 ms 轮询 `pluginManager.listPlugins()`；**始终停在 pending 的条目**记为 `stalled`，不把等待超时冒充启动时长 | 实测整机，含所有插件 |
| 插件模块冷加载 | 单个插件的宿主入口「import 一次」花多久 | `bench-probe.mjs` 在**独立子进程**里 `import()` 该插件入口，跑 3 次取最小值 | 实测单插件，**不含 `apply()` 内的工作** |
| UI 资源 | 单插件 client bundle 的字节数 | `clientModules.clientPath(id)` + `statSync` | 实测文件大小 |
| UI 耗时 | 浏览器实际拉取/解析该 bundle 的时间 | 标签页在加载时读 `performance.getEntriesByType('resource')`，按 `window.__DSH_BOOT__.entries[].url` 精确匹配后回传 Host | 实测浏览器侧 |

**为什么不把它们加成一个「总开销」**：三者测的不是同一件事。子进程冷加载只测模块求值，插件在 `apply()` 里干的活（起进程、连 MCP、装监听）不计入那一列，但它确实体现在「本机启动」里。因此真正的因果证据是 **A/B 启动历史**：

- 每次启动写一条记录，带组合指纹（启用条目集合的 sha1 前 16 位）；
- 组合变化时，面板给出「与上一次**不同组合**相比 ±X ms」；
- 同一组合内不比较（同组合的抖动是噪声，不是插件造成的）。

热安装（进程已跑起来才装上本插件）不会伪造一条启动记录 —— 面板会显示「热安装」并让你重启后开始记录。

## 二、活跃度怎么统计，边界在哪

唯一被真实统计的通道是**会话日志里的 `tool/call` 事件**（`<DSH_HOME>/sessions/*/*/session*.jsonl.zstd`，滚动窗口默认 14 天）。

- 会话日志是「每次 flush 追加一个 zstd 帧」的格式，`zlib` 只解第一帧。这里逐帧解码（边界解不开就扩到下一个 magic），所以能读出完整会话。
- 工具归属：`mcp__<server>__<tool>` 按 `configEditor` 里该行的 `serverName` **精确**归属；其余工具名到各插件包**宿主**源码里找字符串字面量（跳过 `client.js`、`node_modules`），**只被一个包命中**才归属，被两个包命中记为并列（不归属）。
- 纯 UI 插件根本没有 tool/call 通道 → 显示「未观测」，**不是**「没用」。

扫描有上限（400 个文件 / 320 MB 解压 / 25 s），面板会显示实际覆盖：读了多少个会话日志、帧数、是否提前停止。

## 三、建议规则（每条都带 code）

| code | 触发条件 | 结论 |
|---|---|---|
| `load-failed` | `fiberPhase === 'failed'` | 可清理 |
| `incompatible-version` | bundle 报 `incompatible-version` | 可清理 |
| `disabled-long` | 已停用 ≥ 14 天（时间由本插件记录） | 可清理 |
| `quiet-host-only` | 窗口内 0 次调用，且没有 client bundle | 可停用 |
| `slow-and-quiet` | 窗口内 0 次调用，有 UI，且冷加载 ≥ 60 ms | 可停用 |
| `heavy-ui` | 有 UI，0 次调用，bundle ≥ 300 KB | 待确认 |
| `quiet-host-only` | 没有 UI、0 次调用，**且冷加载 ≥ 60 ms** | 可停用 |
| `unobservable-host-only` | 没有 UI、0 次调用，但冷加载很小 | 待确认（面板看不见它的作用，不猜） |
| `stalled-pending` | 启动后一直停在 `pending`/`loading` | 可清理 |
| `ui-unobserved` | 有 UI，0 次调用 | 保留（不可观测） |
| `unobserved` | 还没扫描过活跃度 | 待确认 |
| `in-use` | 窗口内 > 0 次调用 | 保留 |

**为什么不把「没有工具调用」直接当成没用**：注入提示词、监听事件、装饰别的界面的插件（例如 `dsh-plugin-skill-autoroute`）一次 `tool/call` 都不会留下。这类插件只有在**冷加载真的贵**时才建议停用，否则只报「本面板观测不到」——宁可少给一条建议，也不误导你关掉正在干活的东西。

**只有第三方条目进入建议**。`@deepseek-ai/*` 与 `app.asar` 内的组件是 DSH 自带、行通常不可寻址，它们仍会出现在「插件」清单里（计数诚实），但不会变成「建议你停用」。

## 四、清理与找回

「清理」不是删除包，而是：

1. 调 `pluginManager.setPluginEnabled(entryId, false)`（当场热生效，profile 的 `cordis.patch.yml` 里记 `disabled: true`）；
2. 在 `<profile>/.plugin-curator/quarantine.json` 写一条记录（入口 id、模块名、patch 行 id、原状态、原因、时间）。

「找回」是它的逆操作：

- 行还在组合里 → 直接 `setPluginEnabled(id, true)`；
- 行已从 patch 里消失 → 向 `cordis.patch.yml` **追加**一段 `- insert:` 行，**先备份**成 `cordis.patch.yml.bak-plugin-curator-<时间戳>`，然后等 4 s 看 HMR 是否把它挂上；没挂上就明确告诉你「需要重启」。

## 五、Host 路由

| 路由 | 作用 |
|---|---|
| `POST /api/plugin-curator/report` | 全量报告（清单 + 实测 + 建议 + 清理 + 启动历史） |
| `POST /api/plugin-curator/toggle` | `{ entryId, enabled }` → `setPluginEnabled` |
| `POST /api/plugin-curator/quarantine` | `{ entryId, reasons }` → 停用 + 写回收站记录 |
| `POST /api/plugin-curator/restore` | `{ entryId }` → 启用或重新插回 patch |
| `POST /api/plugin-curator/measure` | `{ force }` → 启动逐插件冷加载测量（后台 job） |
| `POST /api/plugin-curator/activity` | `{ windowDays }` → 扫描会话日志（后台 job） |
| `POST /api/plugin-curator/client-timing` | 浏览器回传 Resource Timing |

全部只接受 `POST`；每个 handler 有 body 上限与超时，失败返回 `{ ok: false, error }` 而不是抛。

## 六、状态文件（都在 profile 内，不在包里）

```
<profile>/.plugin-curator/
├── boots.json       # 启动历史（最多 40 条，带组合指纹）
├── bench.json       # 冷加载结果缓存（键含包 mtime，重建后自动失效）
├── activity.json    # 最近一次活跃度扫描
├── client.json      # 浏览器回传的 UI 耗时
├── flags.json       # 各条目「何时被停用」
└── quarantine.json  # 回收站 + 找回历史
```

删掉这个目录不会有任何风险：历史与回收站记录会丢，插件本身不受影响。

## 七、安装 / 卸载

```powershell
# 安装（link 到本地检出，热生效；Host 半需要重启一次）
#   在 DSH 里由模型执行：
#   plugin_manager install_bundle { target: "link:F:\\CodeProj\\dsh-plugin-curator" }

# 卸载
#   plugin_manager remove_bundle { target: "dsh-plugin-curator" }
```

包结构：

```
entry.js            Host 半（路由 + 报告 + 测量 + 清理），无第三方依赖
bench-probe.mjs     子进程探针：只 import 一个入口并打印耗时
probe-selfcheck.mjs 探针用的最小模块（用来验证 node 可执行文件能不能跑）
src/client.js       官方插件页里的标签页 + 详情小节（`window.__ModuleLoader__.load` 包裹的 Cordis 插件对象）
lib/client.js       由 build-client.mjs 校验后拷贝产出
cordis.patch.yml    bundle patch：一条 insert 行
tools/              离线验证（不需要 DSH）
```

## 八、验证

```powershell
node tools/verify-host.mjs    # 21 项：判定规则、会话帧解码、工具归属、profile 探测、入口解析
node tools/verify-client.mjs  # 13 项：stub React 里渲染五个页签 + 三种 subject 的详情小节
node tools/verify-routes.mjs  # 19 项：假 Host 上跑通 7 条路由（含真实子进程测量与 patch 回插）
node build-client.mjs         # 产出 lib/client.js
```

`verify-routes.mjs` 会建一个临时 profile、一个 `node_modules` junction、一个可 import 的夹具包和一个「加载失败」条目，然后真的调用 `apply()`、真的 spawn 探针、真的写 patch 并校验备份。它不碰真实 profile。

## 九、已知限制（不是「待办」，是当前事实）

- **清单只覆盖 profile 层的 Loader 条目**：`agentPresets` 那一层（每会话工具插件，例如 `@nanmicoder/dsh-agent-teams`）不在 `listPlugins()` 里，本面板看不到它们。实测：这些工具在会话日志里有调用，但对应插件不出现在本清单中。
- `settledMs` 在**热安装**那一次没有意义，面板显示「—」，不显示进程 uptime；重启后正常记录。
- 子进程冷加载测不到 `apply()` 里的开销；这类开销只在「本机启动」和 A/B 历史里体现。
- **内置组件不测冷加载**：它们在 `app.asar` 内，纯 node 子进程读不了那个归档，所以只计数不计时（记为不可测，不是 0 ms）。
- 活跃度只覆盖 `tool/call`。UI 画了多少次、提示词注入了几次，DSH 没有留痕，本插件也不伪造；这类插件只在冷加载贵时才建议停用。
- 工具归属靠源码里的**声明形状**（`name: "x"`）匹配，是推断：同名声明出现在两个包里时会被标成并列而不归属。
- 「清理」不会删包、不会跑 pnpm；真正的卸载仍由 `plugin_manager remove_bundle` 负责。
- 内置组件（`@deepseek-ai/*`）不进建议、不进清理，即使它们加载失败 —— 面板只在「内置组件」卡片里报数量。
