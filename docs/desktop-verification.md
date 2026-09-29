# DSH 桌面端 Overleaf 工作台修复：v1.0.1 验收记录

> **文档状态：草稿（DRAFT）** —— t13（`40cf291`）已落地，§5 / §6 已按实测填入；§1 只写**已独立证实**的部分，**§7 端到端验证与「桌面端可用」结论必须等 t14（harness 补「站点自建 socket」独立通道）+ t10' 短复验**。
> 在本标记移除之前：本文出现的任何"通过／可用"字样都只描述**已完成的局部证据**，不构成验收结论；§7 **不得引用 t13 之前的任何端到端数字**（t3 首跑的站点 API 缺陷已由 t13 承接）。

- **文档日期**：2026-09-30
- **验收对象**：`dsh-app://` 自定义协议下 Overleaf 工作台打不开的桌面端修复
- **工作副本**：`E:\GalaxyC\DSH\DSH-Overleaf\dsh-overleaf-desktop`（分支 `desktop`）
- **根因记录**：见 [`docs/desktop-shell-custom-scheme-fix.md`](./desktop-shell-custom-scheme-fix.md) 的 §3 根因链 / §6 修复方案 R1–R4（本文只写验收，不重复整篇排查）
- **受影响宿主**：DSH 桌面端（Electron 壳，页面 origin `dsh-app://app`，宿主 `http://127.0.0.1:19387`，profile `desktop`）
- **不受影响**：`dsh web`（`http://127.0.0.1:3080`，profile `web`）——本次的红线是 web 端行为逐字不变

---

## 1. 结论（框架 A：**能证的证死、不能证的划清边界**）

| 分栏 | 内容 |
|---|---|
| **已证实** | ① **桥层修复成立**：离线套件 **13/13**、新前缀组 **16/16**、原 5 文件组 **467/467**（均 exit 0，见 §6）；双配置矩阵 R2-1/R2-2 漂移归零；变异负控具备真实失败能力。② **探针路由成立**：壳形状 WS 被改写到隧道。③ **web 零回归**：`pnpm test` 全链 **EXIT=0**（见 §6）。④ **修复版桥已在运行中的桌面端加载**：宿主 19387 服务的 `bridge.js` 含壳修复代码（现场复核见 §8）。 |
| **未证实（不得写成通过）** | **站点在壳内可用**：harness 的独立通道读到 **`site=0`**（tap 在页面脚本前生效，已排除注入时机与路由形态两种解释），本 harness **既不能证明也不能否证**该项（见 §7）。 |
| **由谁验收** | **§9 用户侧人工验收**——在**运行中的桌面窗口**采集 iframe 桥诊断与 Console 错误（§9 提供可直接粘贴的采集片段）；t15 的插桩结果作为"站点为何不自建 socket"的解释性旁证。 |

**本文不使用"桌面端可用"这类表述**：桥层与 web 层已证实，站点层交由 §9 的现场读数判定。

---

## 2. 判定口径与验收环境

**判定权威**：以 harness 的 `verdict` + **退出码**为准；human-readable `log` 与 JSON 报告**互为佐证**（两者一致，不存在口径差异）。

**稳定判定面（8 键，引用只取这些）**：`verdict` / `reasons` / `report` / `diagnostics` / `requests` / `requestTimeline` / `environment` / `worktree`。
`assertions` 等属于 harness 内部字段（**漂移面**），字段名与分档可能随工装演进，本文不引用它们做判定。

**环境（本次验收实际值）**：

| 项 | 值 |
|---|---|
| Electron / Node | 42.4.1 / 24.16.0（stock Electron，非壳内嵌内核） |
| 宿主 | `http://127.0.0.1:19387`（正在运行的桌面实例） |
| 页面 origin | `dsh-app://app` |
| 隧道端口 | 由页面公告，harness 运行时实测（示例 57956） |
| profile 隔离 | harness 用一次性 profile：`userDataDir=%TEMP%\dsh-overleaf-shell-harness-<pid>`、`defaultUserData=%APPDATA%\dsh-overleaf-desktop-shell-harness` ⇒ **未触碰用户的 desktop profile** |

---

## 3. 变更清单

| 提交 | 内容 | 关键文件 |
|---|---|---|
| `ff560b4` | 桥脚本协议无关化 + 客户端「新窗口打开」桌面端降级 | `src/inject-script.ts`（126/13）、`src/client/view.tsx`（8/1）、`src/client/locales.ts`（2/0）、`lib/index.js`、`lib/client.js` |
| `39ebca7` | R2-1/R2-2：编译日志 URL 基准按壳协议门控，web 端逐字不变 | `src/inject-script.ts`（13/4）、`lib/index.js` |
| `43d1330` | 桌面壳协议路由回归位（离线套件） | `scripts/smoke-desktop-scheme.mjs` |
| `01d5ea5` | 真机 Electron 验收 harness + 套件接线 | `scripts/desktop-shell-harness.mjs`、`scripts/desktop-shell/`、`scripts/desktop-shell-harness.cmd`、`package.json` |
| `40cf291` | 壳内 `https://app/…`（站点用 `location.host` 拼出的 API / socket.io 基址）按**本站 origin** 路由 | `src/inject-script.ts`、`lib/index.js`、`scripts/smoke-desktop-scheme.mjs`（新增用例） |

桥侧四块改动（README 同步引用同一口径；条数以最终代码为准）：

1. **壳判定 + 归一化**：页面跑在非 http(s) 协议时，`dsh-app://<站点主机>/<path>` 被还原为 `<上游协议>//<站点主机>/<path>`（query/hash 原样保留）后再走既有路由映射；壳自身主机 `app` 除外（保持路径语义，改由相对代理路径承接）。
2. **`routeUrl`**：协议相对 URL 改用上游协议补全（不再用 `location.protocol`，否则壳内会拼出 `dsh-app://…`）；壳内 URL 一律产出**相对代理路径**（不再依赖 `location.origin` 的合法性）；`implicitCurrentHost` 仅在 http(s) 下成立。
3. **`routeSocketUrl`**：壳内指向（`parsed.host === shellHost` 或协议即壳协议）的 WebSocket **只有** path 匹配 `/socket.io[/]` 才接管到 `ws://127.0.0.1:<隧道端口>/__dsh_socket__/socket.io/…`；其它路径原样放行（不劫持 `ws://app/sidebar/ws/*` 这类其它插件的连接）；隧道端口未知时**不伪造** `ws://app/…` 回退。
4. **壳内 `https://app/…` 视同本站 origin**（t13 / `40cf291`，**这是"工作台真能用"的关键一条**）：站点用 `location.host` 拼出的 API 基址在壳里是 `https://app/api/…`、`https://app/socket.io/…`；这类 URL 必须与站点同源路径一样走代理，否则站点 API 与 socket.io 基址仍会直接出网（壳不服务、必然失败）。判定形态：请求记录里由 **PASSED-THROUGH** 变为 **PROXIED**。

**t13 的不变量（已写入套件断言）**：已代理/工作台形态**归一为根相对、不得出现重复前缀**、`/overleaf/workbench/*` **不被代理前缀包住**。

客户端：工具栏「新窗口打开」按钮在非 http(s) 协议下 `disabled`，`title` 走 i18n 键 `toolbar.openWindowUnavailable`（中：桌面端应用内不支持新窗口：请在系统浏览器中打开站点；英：Not available inside the desktop app: open the site in your system browser）；http(s) 下行为与改前逐字一致。

---

## 4. 修复前指纹（原始现场）

来源：用户桌面端 DevTools Console 原文（根因记录 §2），**不是**本次回归跑出来的。

```
bridge.js:1353 WebSocket connection to 'ws://dsh-app/socket.io/?EIO=4&transport=websocket&t=Q3kXaMK' failed
dsh-app://socket.tex.nju.edu.cn/heartbeat?message=websocket+error&type=TransportError&... → 404 (Not Found)
socket.js:88 Error: Request failed with status code 404
index.js:195 Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'on')
```

站点前台文案（非本插件文案）：「与服务器连接断开，请刷新后重试。」「修改尚未同步，无法切换文件，请稍后重试。」

要点：污染形态是 **`ws://dsh-app/…`**（协议名被当成 host）与 **`dsh-app://<站点主机>/…`**（壳只服务 `dsh-app://app/*`，其余 hostname 一律 404）。harness 的**负向对照**会用未修复的桥在真壳里独立复现同一形态，其结果见 §7。

---

## 5. 修复后指纹（正向；来源＝**队长运行**，`40cf291`，stock Electron 42.4.1，隧道端口 57956）

命令：`"E:\software\DeepSeek Harness\DeepSeek Harness.exe" scripts/desktop-shell-harness.mjs`

```
harness 11/11 assertions passed / verdict=pass / exit 0
diagnostics(判定时刻帧) = {bridge: ready, ws-port: 57956, ws-target: 127.0.0.1:57956,
                          ws-state: open, socketio-state: connected, ws-messages: 3}
requests = 52 / requestTimeline = 89
https://app/api/* 残留        = 0   （t3 首跑基线 = 10 条）
consoleMessages Network Error = 0   （t3 首跑基线 = 4 条）
壳内 distinct 目标 = 10；FOREIGN dsh-app:// = 0
WebSocket 目标（去重）= ws://127.0.0.1:57956/__dsh_socket__/socket.io/?EIO=4&transport=websocket
self-check: worktree bridge 121151 B (shell handling: yes)
            worktree lib/index.js 238263 B (shell handling: yes)
            host 19387 bridge.js 106029 B (shell handling: no, environment note only)
```

与 §4 对照：`ws://dsh-app/…` 与 `dsh-app://socket.<站点主机>/heartbeat` 均已消失；**唯一的 WebSocket 目标是环回隧道**；`Network Error` 与 `https://app/api/*` 残留双双归零。`ws-messages` 按 §7 的措辞纪律写作「递增成立（形如 `2→3`，末帧达成）」。

> ⚠️ **来源与终稿纪律**：本节数字来自**队长运行**，用于给出"改前 → 改后"的方向性对照。**§7 的站点侧判定以「空位 1 的现场读数」为主、t10' 的通道复验为辅**；两者不一致时以现场读数为准，本节随之更新。
> ⚠️ **计数口径**：本文统一按 **distinct URL** 计数（细则见 §7）；报告断言按 `url × kind` 分行展示时数字会翻倍。t13 之后壳内目标集合已变化，**最终 distinct 数以 t10' 报告为准**。

---

## 6. 行为级证据（离线，不依赖真壳）

- **离线壳协议套件**（本轮**本机实测**，`40cf291`）：`node --test scripts/smoke-desktop-scheme.mjs` → **tests 13 / pass 13 / fail 0，exit 0**。13 个用例覆盖：壳 socket.io 接管、心跳与协议相对路由、壳 host 的 http(s) 形态（站点 API 基址）、announced output/socket 与 content-origin 优先级、非 socket.io 放行、端口 0 不伪造回退、任何路径都不产出 `dsh-app://` / `ws://app/` / `ws://dsh-app/`、已代理形态不重复加前缀、web 端口 0 回退、web 编译日志基准位（R2-1/R2-2）、壳内编译日志走上游、客户端按钮门控、变异负控。
- **分组实测**（同为本机实测，`40cf291`）：
  - 新前缀组 `node --test scripts/smoke-desktop-scheme.mjs scripts/smoke-socket-routing.mjs scripts/smoke-texpage-output.mjs scripts/smoke-output-routing.mjs` → **16/16，exit 0**（= 套件 13 + 同组其它文件 3）。
  - 原 5 文件组 `node --test scripts/smoke-bib-compat.mjs scripts/smoke-texpage-bib.mjs scripts/smoke-texpage-bib-proxy.mjs scripts/smoke-texpage-tex-sync.mjs scripts/smoke-texpage-tex-proxy.mjs` → **467/467，exit 0**。
- **变异负控（套件内）**：把壳分支锚点 `if (shellScheme !== '' && ` 两处替换为 `if (false && ` 后，**四条被点名断言**必须变红（`ws://dsh-app` 接管、`ws://app` 接管、heartbeat 归一、`ws://app/sidebar/ws/*` 放行）；本轮该控制用例通过 —— 证明这套用例**具备失败检测能力**，不是恒真断言。
- **harness 外置负控（可复现，与"失败能力"最相关）**：`--negative-control` 把桥构造还原成**原生 WebSocket**（不注入被测桥），在真壳里跑同一套判定 ⇒ `verdict=fail` / **exit 1**，`reasons` **7 条全部落在 socket 面**，同时桥仍 `ready`、壳文档面无 FOREIGN、`polluted` 为空。数字以 t10' 报告为准（落位见 §7 负向栏）。
- **计数脚注**：用例数量**随代码版本变化**，引用时必须同时给出**命令 + 提交号**。历史读数：套件 10（t3 轮）→ 12（t10 轮 verifier-2 运行时刻）→ **13（t13 后本机实测）**；本文以最终实测为准（套件 13/13、新前缀组 16/16、原 5 文件组 467/467）。
- **桥切片上下文分解**（来源＝队长运行）：壳上下文 9/9、web 上下文 4/4。
- **R2-1 / R2-2 双配置矩阵**（编译日志 URL 基准）：
  - **前提**：宿主已注入上游源全局 `__DSH_OVERLEAF_UPSTREAM_ORIGIN__`（web 与壳两态均注入，即真实部署形态）。
  - 在此前提下：修复前 web 下 `captureLogFromOutputPdf` / `captureCompileResponse` 的最终目标会漂移到上游域（`https://tex.nju.edu.cn/…`），修复后回到 `http://127.0.0.1:3080/…`。
  - **未注入该全局时**前后都走 `location.origin`，**不构成漂移** —— 所以这条不能写成"任何 web 场景都漂移"。
  - **反向对照**：`build:true` + `pdfDownloadDomain` 的 `output.log` 两版都走 `pdf.example.test` ⇒ 门控只加在 base 选择上，**没有过度矫正**。（`pdf.example.test` 是**合成域名**，仅用于触发分支，不是真实期望值。）

---

## 7. 端到端级证据（真机 Electron harness + 现场读数）

**框架 A：能证的证死、不能证的划清边界**

harness 内的独立通道读数：**未观测到站点自建 socket**（`site=0`；与页内探针**分列、禁止互相填充**；tap 在页面脚本前生效 `beforePageScripts=true`，已排除注入时机与路由形态两种解释）。因此本 harness **既不能证明也不能否证**"站点在壳内可用"。

- **已证实**：① 桥层修复（离线套件 + 双配置矩阵 + 变异负控，见 §6）② 探针路由（壳形状 WS 经隧道改写）③ **web 零回归**（`pnpm test` 全链 EXIT=0）。
- **交由 §9 判定**：站点可用性 —— 由人在**运行中的桌面窗口**采集现场读数。

**空位 1｜用户侧现场读数（采集方法见 §9；人在桌面窗口执行）**

- `frameUrl`：
- 桥诊断 `data-dsh-overleaf-{bridge,ws-port,ws-target,ws-state,socketio-state,ws-messages,last-error}`：
- Console 错误（是否仍有 `ws://dsh-app/…` 或 `dsh-app://socket…`）：
- **判读（三选一）**：
  - **a)** `ws-target=127.0.0.1:<隧道端口>` 且 `ws-state=open`、`socketio-state=connected` ⇒ **站点侧已在壳内连通**；
  - **b)** 桥已连上但站点仍报错 ⇒ 问题在**站点业务层**，不在桥；
  - **c)** 桥仍未连上 ⇒ 回到桥层排查（并引空位 2 的插桩输入）。

**空位 2｜t15 插桩结果（解释"站点为何不自建 socket"）**

- 站点是否发起过 socket、及其实参/失败原因：
- 对 `site=0` 的解释：

**计数口径（已裁定，写死，避免自相矛盾）**

- 壳内目标一律按 **distinct URL** 计数；报告断言按 `url × kind`（`fetch` / `other`）分行展示时数字会翻倍，因此引用时**必须两种写法同时给出**（例：`5 个 distinct 壳内目标 URL` ↔ 报告断言 `10 distinct target(s)`）。**具体数值以 t10' 报告为准**，正向与负向同口径。
- 另须一并报告：**FOREIGN dsh-app 目标 = 0**（不属于本插件的壳内流量为 0）、以及**唯一 WebSocket 目标 = 环回隧道**（`ws://127.0.0.1:<隧道端口>/__dsh_socket__/socket.io/…`）。

**正/负两轮必须分开写**：正向（修复后的桥）与负向对照（未修复的桥，诊断带 `negative-control="pristine-websocket"`）。负向的失败必须**全部落在 socket 面**，同时桥仍 `ready`、壳文档面无 FOREIGN、`polluted` 为空 —— 以此说明失败来自**被测缺陷**，而不是环境崩塌。

**证据来源必须分两栏（t3 首跑暴露的关键区分）**

| 栏 | 内容 | 证明力 |
|---|---|---|
| 页内探针（harness in-page probe） | harness 自己构造一个壳形状的 `ws://` URL 交给被测桥，观察是否被改写 | **不构成站点可用性证据**：只证明桥的改写逻辑被正确加载与调用，**不能**证明站点侧真的连上 |
| 站点自建 socket（站点前台自己发起） | 请求记录出现 `ws://127.0.0.1:<隧道端口>/__dsh_socket__/socket.io/…`，且桥属性 `ws-state=open`、`socketio-state=connected`、`ws-messages` 递增 | 这才是"工作台真能用"的证据；`ws-messages` 来自桥自报，另有 `ws-state`、`socketio-state` 与真实请求记录**三条独立佐证** |

**`ws-messages` 措辞纪律**：写成「**递增成立（形如 `2→3`，末帧达成）**」，**不写"持续递增"**（样本量不支持）；具体跃迁数字以 t10 复验报告为准。

**判定权威**：`verdict` + 退出码；`reasons` 与诊断三元组作佐证。

---

## 8. 生效边界：**已验证 ≠ 已生效**（本节是本次验收最容易误读的地方）

**方法论上的区分（永久成立）**

- **本次验收证明的是**：「desktop worktree 构建出的桥，在真实 `dsh-app://` 壳里加载真实工作台时可用」。
- **本次验收不证明**：「harness 跑完这一步本身让用户的桌面 app 生效了」——harness 是**自带桥**加载自己的 frame，它不改变宿主服务的那一份。

**harness 记录到的当轮状态（t3 / t10 轮，当时宿主仍是 PRE-FIX）**

```
[harness] self-check worktree bridge: 120238 B, shell handling: yes (shellScheme)
[harness] self-check worktree lib/index.js: 237350 B, shell handling: yes (shellScheme)
[harness] self-check host 19387 bridge.js: HTTP 200, 106029 B, shell handling: no (environment note only - the harness serves the worktree bridge, not this one)
```

第三行当时说明：宿主 19387 服务的桥仍是 PRE-FIX。

**当前现场（2026-09-30 06:1x 复核，命令可复现；与上面三行不是同一时点）**

- 桌面 profile 的 link **已指向修复树**：`%USERPROFILE%\.dsh\profiles\desktop\package.json` → `"dsh-overleaf": "link:E:/GalaxyC/DSH/DSH-Overleaf/dsh-overleaf-desktop"`；其 `node_modules\dsh-overleaf` 是 junction，目标 = `E:\GalaxyC\DSH\DSH-Overleaf\dsh-overleaf-desktop`；该处 `lib/index.js` = **238,301 B**，含 `shellScheme`（26 处）。
- **桌面端已重启**：`DeepSeek Harness` 进程启动时间 **06:04:46–06:11:57**（前一轮为 01:44 / 03:56 / 04:29）。
- **宿主 19387 现在服务的桥含壳修复**：`Invoke-WebRequest http://127.0.0.1:19387/overleaf/workbench/bridge.js` → HTTP 200、**114,488 字符 / 114,518 字节**，含 `shellScheme`、`parsed.host === shellHost`、`originBase`、`unpoison`。
  ⇒ **「改了要重启才生效」这一步现实中已经完成**，宿主当前服务的确实是修复版桥（此前为 106,029 B、无壳处理）。
- **两端现在指向不同代码树**（互不干扰）：desktop profile → `dsh-overleaf-desktop`（修复树）；web profile → `dsh-overleaf`（main，未改）。web 实例 3080 的 `/overleaf-proxy/` 仍 HTTP 200 / 11,422 B。

**为什么"宿主服务的桥"与"worktree 渲染的桥"长度不同（114,488 vs 121,151 字符）—— 已查清，不是版本滞后**

宿主加载的是 **tsdown 打包后的宿主半体 `lib/index.js`**，其中内嵌的 texpage 适配器被打包器做了**常量折叠与重新引号**：`lib/index.js` 里是 `maxBytes = 2097152`，而 tsc 侧 `lib/types/texpage-bib.js` 里是 `maxBytes = 2 * 1024 * 1024`。**两处都含壳修复代码**，所以这是同一份修复的两种产物形态，不是旧构建。核对方法：对这两个产物分别 grep 上述两个字面量。

**shell 侧生效条件（供其它机器/用户复现）**

1. 让桌面 profile 指向修复后的代码：安装 `dsh plugin --profile desktop add github:gychen-NJU/dsh-overleaf#desktop`，或把 link 切到修复树；**并且**
2. **退出并重开 DeepSeek Harness** —— 桥由宿主现读、client bundle 只在启动期进 boot 图，热更新不生效。

**⛔ 反例纪律**：不要把多个 profile 指向同一棵工作树后去切它的分支。当前 desktop 与 web 已分别指向 `dsh-overleaf-desktop` 与 `dsh-overleaf`；若有人把 main 那棵树 `git checkout desktop`，会立刻改变 **web 端**加载的代码、并与 `dsh-overleaf-desktop` worktree 抢分支，直接毁掉"web 零回归"的测量前提。

---

## 9. 用户手动验收清单（**现在就能在运行中的桌面端逐条过**；日志通过 ≠ 合格）

> 前置已就绪：桌面 profile 已指向修复树、桌面端已于 2026-09-30 06:04 重启，宿主 19387 当前服务的是修复版桥（见 §8）。因此本清单是当前**唯一**可用于判定"站点侧可用性"的证据来源（见 §7 的边界说明）。

**采集片段**（在桌面窗口按 `Ctrl+Shift+I` 打开 DevTools → Console → 粘贴执行；**只读，不点不改**）：

```js
(() => {
  const f = [...document.querySelectorAll('iframe')].find(x => /overleaf-proxy/.test(x.src || ''))
  if (!f) return { error: 'no overleaf iframe found' }
  let attrs
  try {
    const d = f.contentDocument && f.contentDocument.documentElement
    const keys = ['bridge', 'ws-port', 'ws-target', 'ws-state', 'socketio-state', 'ws-messages', 'last-error']
    attrs = Object.fromEntries(keys.map(k => [k, d && d.getAttribute('data-dsh-overleaf-' + k)]))
  } catch (e) { attrs = 'threw: ' + e.message }
  return { frameUrl: f.src, attrs }
})()
```

同时把 Console 里与 `dsh-app` 相关的报错（若有）一并复制出来 —— 这两项即 §7 空位 1 所需的现场读数。

1. 打开 Overleaf 页签 → **能进入项目**（不再停在"正在加载/与服务器连接断开"）。
2. **能编译出 PDF**（编译日志与预览正常）。
3. **选区插入 / 双向同步可用**（选中文本 → 引用插入；`.tex` 拉取/推送正常）。
4. DevTools Console **不再出现** `ws://dsh-app/…` 与 `dsh-app://socket…` 的失败/404。
5. iframe 的 `<html>` 上：`data-dsh-overleaf-ws-state="open"`、`data-dsh-overleaf-socketio-state="connected"`，且 `data-dsh-overleaf-ws-messages` **递增成立**。
6. 工具栏「新窗口打开」按钮在桌面端呈 **disabled**，悬停提示为"桌面端应用内不支持新窗口…"（web 端仍可正常打开新窗口）。

---

## 10. 方法学与自纠留痕（为什么这些结论可信）

1. **等价性用切片实证**：评审用「改前产物切片 vs 改后切片 × 54 输入 × 3 配置」逐输入比对，而不是靠肉眼读 diff —— 这是"web 端逐字不变"这条红线的证据来源。
2. **变异法证明套件有牙齿**：把被测分支人为破坏后套件必须变红；离线套件与真机 harness 都做了这类负控。
3. **判定脚本的自纠**：harness 判定初版曾把**合法的** `dsh-app://app/*`（壳能服务的路径）误判为"污染"；后改为三分类（`tunnel` / `polluted` / `clean-shell-doc`）并按 host 归因 —— 这解释了为什么"污染"只针对**壳无法服务的 hostname**，也避免把正常壳流量算成缺陷。
4. **t13 的判据形态（壳内 API 基址）**：在**同组前后对照**下，壳页里的 `https://app/api/*` 与 `https://app/socket.io/*` 必须由 **PASSED-THROUGH（t13 前基线）** 变为 **PROXIED**（验证工程师有同组对照可引）。配套两条**用户观感判据**：**`Network Error` 归零**、**`https://app/api/*` 不再出现在请求记录里**。
5. **字段口径 ≠ 判定口径**：负向报告里 `assertions` 字段的计数（形如 `12/12`）是**工装内部字段**，与 log 行的 `5/12 assertions passed` **不是一回事**，两者不可互相换算、也不可只引其一。**判定一律以 log 行 + `verdict` + 退出码为准**（见 §2 的稳定面/漂移面划分）。

---

## 11. 未覆盖项与本版决定不动的项

- **`package.json` 的 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`**：**已评估，本版决定不动**。该包在当前 0.1.7 / 0.2.0 运行时里都不存在，属无害的陈旧声明；改动它只会触碰客户端半体纯度门与 boot 图，收益为 0、风险不为 0，且与桌面端问题无关。
- **package.json 的 `test` 脚本**：`smoke-desktop-scheme.mjs` 已接线进 `pnpm test`（`01d5ea5`），无需再处理。
- **仍需人工完成的部分**：§8 的"生效条件"（切 link/安装 + 重启宿主）与 §9 的用户侧人工验收——本机无法在**不重启当前会话宿主**的前提下完成，属于交付后动作。
- **未覆盖**：DSH 桌面壳自身的问题（`dsh-app://app/plugins/??…` 404、其它第三方插件的 `ws://app/…` 连接）不在本仓库范围内，见根因记录 §10。

---

## 12. 回滚

1. **代码**：`git revert <sha>`（`ff560b4` / `39ebca7` / `43d1330` / `01d5ea5` 按需），或恢复修前的 `lib/index.js`（改前请留存备份，见根因记录 §9）。
2. **回滚后必须重启宿主**才生效（同 §8 第 2 条）。
3. **注意**：桌面端与 web 端通过同一份链接代码共用，回滚会同时影响两端——web 端本来是好的，别把好的一端弄坏。
