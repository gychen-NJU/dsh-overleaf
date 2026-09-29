# 桌面端（DSH Desktop）工作台打不开：`dsh-app://` 自定义协议破坏站点 URL 的根因与修复

- **文档日期**：2026-09-30（排查者：DSH 会话，非本仓库作者）
- **适用仓库**：https://github.com/gychen-NJU/dsh-overleaf ，工作副本 `E:\GalaxyC\DSH\DSH-Overleaf\dsh-overleaf`
- **涉及插件版本**：排查时 HEAD = `54bd653`（v1.0.0，`lib/` 已提交）；修复随后落在 **v1.0.1**（见 `docs/desktop-verification.md`）。本行保留排查时的时间语境
- **受影响宿主**：**仅 DSH 桌面端**（Electron 壳 0.2.0-rc.2，内置内核，`http://127.0.0.1:19387`，profile = `desktop`）
- **不受影响**：`dsh web`（npm 全局 0.1.7-rc.2，`http://127.0.0.1:3080`，profile = `web`）——实测可正常打开工作台、无验证界面
- **一句话根因**：桌面壳的页面 origin 是自定义协议 **`dsh-app://app`**；站点（TeXPage/Overleaf 前台）用 `location.protocol` / `location.host` 拼跨源 URL，拼出来的是 `dsh-app://…` / `ws://dsh-app/…`，**壳无法服务这类 URL**；而本插件的桥脚本（`src/inject-script.ts`）所有改写规则都以 http(s)/ws(s) 为前提，于是把这些 URL **原样放行** ⇒ 站点 socket 与心跳全挂 ⇒ 站点起不来。

---

## 1. 症状

桌面端打开 Overleaf 页签：**插件自己的面板与工具栏正常**（编译 / 审阅 / 日志按钮都在），但嵌入的站点打不开，页面上连弹：

```
与服务器连接断开，请刷新后重试。
与服务器连接断开，请刷新后重试。
修改尚未同步，无法切换文件，请稍后重试。
```

—— 这三句**不是本插件的文案**（已确认：插件源码 / DSH 0.1.7 与 0.2.0 运行时 / 站点主 console bundle 里都没有），是站点前台自己在报错。同一账号在 web 端一切正常。

---

## 2. 现场证据（用户提供的桌面端 DevTools 控制台，原文节选）

```
bridge.js:1353 WebSocket connection to 'ws://dsh-app/socket.io/?EIO=4&transport=websocket&t=Q3kXaMK' failed
socket.js:42 Error: websocket error
dsh-app://socket.tex.nju.edu.cn/heartbeat?message=websocket+error&type=TransportError&description=%7B%22isTrusted%22%3Atrue%7D → 404 (Not Found)
socket.js:88 Error: Request failed with status code 404
index.js:195 Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'on')

# 顺带暴露的同类问题（非本仓库范围，见 §10）
client.js:20093 WebSocket connection to 'ws://app/sidebar/ws/agent-opens?sessionId=…' failed
client.js:20093 WebSocket connection to 'ws://app/sidebar/ws/fs-watch?sessionId=…' failed
client.js:1051 [connection] connection lost, retry #1
```

**同时已排除的项**（宿主/插件后端链路是好的，别再往这个方向查）：

| 检查 | 结果 |
|---|---|
| 插件是否挂载 | ✅ `/overleaf/workbench/status` → 200，`{"loggedIn":true,"proxyReady":true,"baseUrl":"https://tex.nju.edu.cn"}` |
| 反向代理是否可用 | ✅ `/overleaf-proxy/` → 200，11,422 B 的 TeXPage 页面（含注入的 `__DSH_OVERLEAF_WS_PORT__`） |
| 隧道端口是否转发正常 | ✅ 裸 WebSocket 握手（3 种路径 × 2 种 Origin）全部拿到**上游 101**，甚至拿到真实 `{"sid":"…","pingInterval":25000,…}` |
| Electron 壳是否拦截 | ❌ 不拦。全壳仅一条 `cancel: true`：目标为 `ws://127.0.0.1/<宿主端口>` 且 `Origin ≠ dsh-app://app`；**其它 loopback 端口原样放行** |
| 站点风控 / Electron UA | ❌ 已证伪（web 端同一账号正常、无验证界面） |

---

## 3. 根因链（逐层）

1. **壳的页面 origin 不是 http(s)**：`app.asar/lib/main.js` 里 `applicationUrl = "dsh-app://app/"`，且该 scheme 注册为 `standard / secure / supportFetchAPI / corsEnabled / stream / codeCache`。
2. **壳只认一个 hostname**：`protocol.handle(SCHEME, …)` 中，`dsh-app://shell/*` 是壳自带文档、`dsh-app://app/{,/index.html,/assets/*,favicon,manifest}` 是壳自带文档、**`dsh-app://app/` 的其它路径**才 `forwardWebRequest` 转给宿主 HTTP（要求 `Origin: dsh-app://app`，保留 method/path/body）。**hostname 既不是 `app` 也不是 `shell` 的 dsh-app URL ⇒ 直接 404。**
3. **站点用 `location` 拼跨源地址**（这是普通浏览器里的正确写法）：
   - 心跳：`location.protocol + '//' + socketHost + '/heartbeat'` ⇒ 壳里变成 **`dsh-app://socket.tex.nju.edu.cn/heartbeat`** ⇒ 上面第 2 条的 404（与日志完全一致）。
   - socket.io 的 URL 构造在非 http(s) 协议下退化（把 `dsh-app://app` 当成相对地址又前缀了一次），最终 **WS 目标 = `ws://dsh-app/socket.io/…`**（host 成了协议名，与日志完全一致）。
4. **桥脚本把这些 URL 放行了**（`src/inject-script.ts`）：
   - `routeUrl()` **L146**：`if (!/^https?:$/.test(parsed.protocol)) return raw` ⇒ 心跳原样出去 ⇒ 404。
   - fetch / EventSource / XHR(beacon) 三个包装 **L208 / L372 / L393**：协议相对 URL 用 **`location.protocol + rawUrl`** 补协议 ⇒ 在壳里直接产出 `dsh-app://…`。
   - `routeSocketUrl()` **L691**：协议必须是 `http(s)/ws(s)`；**L697/L700** 的 host 白名单只有「socket 主机 / upstream 主机 / `window.location.host`（壳里是 `app`）」——`dsh-app` 三者都不是 ⇒ **`return raw`**。
   - `routeSocketUrl()` **L704–L707**：连兜底分支也用 `location.protocol` / `window.location.host` ⇒ 壳里会产出 `ws://app/…`，同样不可用。
5. **后果**：站点拿不到 socket/心跳 ⇒ 前台报「与服务器连接断开」，编辑器状态机卡住 ⇒「修改尚未同步，无法切换文件」。插件面板走的是相对路径（`/overleaf/workbench/*`），所以它反而一直正常——这就是「界面出来了但站点打不开」的原因。

---

## 4. 为什么 web 端正常

普通浏览器里 `location.protocol === 'http:'`、`location.host === '127.0.0.1:3080'`，同一段代码拼出来的都是合法 URL，桥的既有规则全部命中 ⇒ 一切正常。**这决定了修复必须保持 web 端行为不变**（只新增"非 http(s) 协议"分支，不改既有分支语义）。

---

## 5. 五分钟自查（复现与确认）

```powershell
# 1) 宿主路由活着（插件路由不受宿主鉴权保护，可直接探）
Invoke-WebRequest http://127.0.0.1:19387/overleaf/workbench/status -Method POST `
  -ContentType application/json -Body '{}' -UseBasicParsing | Select-Object -ExpandProperty Content
# 期望 {"ok":true,"value":{"loggedIn":true,…,"proxyReady":true,…}}

# 2) 读出隧道端口
(Invoke-WebRequest http://127.0.0.1:19387/overleaf-proxy/ -UseBasicParsing).Content `
  | Select-String -Pattern '__DSH_OVERLEAF_WS_PORT__'
```

临时裸握手探针（**证明宿主侧隧道正常**；用完删，别提交）：

```js
// node ws-probe.mjs 57956 "/__dsh_socket__/socket.io/?EIO=4&transport=websocket" "dsh-app://app"
import net from 'node:net'; import crypto from 'node:crypto'
const [port, path, origin] = process.argv.slice(2)
const key = crypto.randomBytes(16).toString('base64')
const s = net.connect(Number(port), '127.0.0.1', () => s.write(
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`))
let buf = ''
s.on('data', (d) => { buf += d.toString(); const i = buf.indexOf('\r\n\r\n')
  if (i !== -1) { console.log(buf.slice(0, i).split('\r\n')[0]); s.destroy() } })
s.setTimeout(12000, () => { console.log('TIMEOUT'); s.destroy() })
s.on('close', () => process.exit(0))
```

**DevTools（桌面窗口 Ctrl+Shift+I）** 里看两处：

- Console 是否有 `ws://dsh-app/socket.io/…`、`dsh-app://…` 的失败/404；
- 站点 iframe 的 `<html>` 上由桥写的诊断属性：`data-dsh-overleaf-{bridge,ws-port,ws-target,ws-state,socketio-state,ws-messages,last-error}`（`bridge="ready"` 说明桥已注入）。

---

## 6. 修复方案（改 `src/inject-script.ts`，原则：**协议无关 + 只新增分支**）

> 目标：无论页面跑在 `http(s)://host` 还是自定义协议 `dsh-app://app` 下，桥产出的 URL 都必须是「相对代理路径」或「可用绝对地址（隧道端口）」。

**R1 — 引入壳判定与归一化助手**（放在 `routeUrl` 之前）：

```ts
// 页面若跑在非 http(s) 协议下（DSH 桌面壳 dsh-app://app），站点用 location 拼出来的
// 跨源 URL 会带上这个协议，必须先把它们"还原"成原始站点主机+路径再走既有映射。
var shellScheme = /^https?:$/.test(location.protocol) ? '' : location.protocol      // 'dsh-app:'
var shellHost = shellScheme !== '' ? location.host : ''                             // 'app'
var shellSchemeName = shellScheme.replace(/:$/, '')                                 // 'dsh-app'

function unpoison(url) {
  // 形如 dsh-app://socket.tex.nju.edu.cn/heartbeat → https://socket.tex.nju.edu.cn/heartbeat
  if (shellScheme === '' || url.protocol !== shellScheme) return url
  var upstreamProtocol = …已有的 upstreamProtocol…
  try { return new URL(upstreamProtocol + '//' + url.host + url.pathname + url.search + url.hash) }
  catch { return url }
}
```

**R2 — `routeUrl()`**：

1. L146 的守卫前先 `parsed = unpoison(parsed)`；再统一按既有 host 映射处理（socket 主机 → `PREFIX + '/__dsh_socket__' + path`；upstream / 内容域 / 本站 → `PREFIX + path`）。
2. **L208 / L372 / L393** 三处把 `location.protocol + rawUrl`（协议相对 URL 补协议）改为**既有的 `upstreamProtocol`**（L141 已经定义：`upstreamOrigin ? new URL(upstreamOrigin).protocol : location.protocol`）⇒ 壳里也会拼成 `https://socket.tex.nju.edu.cn/…`，随后落进 `announcedSocket` 分支（L161–L165）修好心跳。
3. 建议把 L150 的 `implicitCurrentHost`（`parsed.hostname === window.location.hostname`）**限定在 http(s) 协议下**：壳里 `location.hostname` 是 `app`，这条判断没有意义。
4. 可选但推荐：L159 / L164 / L170 的 `window.location.origin + PREFIX + …` 改成**相对路径** `PREFIX + …`（更不依赖 origin 的合法性；web 端语义不变）。

**R3 — `routeSocketUrl()`**：

```ts
// 桌面壳：站点从 location 推出的 socket 地址会退化成 ws://dsh-app/socket.io/… 或 ws://app/socket.io/…
var looksLikeCurrentHost = parsed.host === window.location.host          // 'app'
  || (shellSchemeName !== '' && parsed.host === shellSchemeName)         // 'dsh-app'
  || parsed.protocol === shellScheme                                     // 已被污染成 dsh-app://
if (!/^(?:https?|wss?):$/.test(parsed.protocol) && parsed.protocol !== shellScheme) return raw
if (socketHost !== '' && parsed.host === socketHost) {
  if (!/^\/socket\.io\/?$/.test(path)) return raw
  path = '/__dsh_socket__' + path
} else if (!looksLikeCurrentHost && parsed.host !== upstreamHost) {
  return raw
} else if (looksLikeCurrentHost && /^\/socket\.io\/?$/.test(path) && socketHost !== '') {
  path = '/__dsh_socket__' + path      // 补标记，让隧道拨 socket.<site> 而不是站点主域
}
var port = parseInt(window.__DSH_OVERLEAF_WS_PORT__, 10) || 0
if (port > 0) return 'ws://127.0.0.1:' + port + path + parsed.search     // 注意：桌面壳下必须是 127.0.0.1 隧道
markDiagnostic('ws-port', 'missing')
return raw     // 不要再用 location.protocol / location.host 拼一个壳不认的 ws://app/…
```

**R4 — 回归红线**：web（http(s)）路径的**每一个既有分支语义必须保持不变**；新逻辑只在 `shellScheme !== ''` 或 host 命中 `app`/协议名/自定义协议时生效。

---

## 7. 构建与交付

1. 改 `src/inject-script.ts` → `pnpm build`（= `tsc -b && tsdown`）。
2. **`lib/` 是提交进仓库的构建产物**（`package.json.files` 只发 `lib/`），必须把新的 `lib/index.js`（内联桥脚本）与 `lib/types/inject-script.js` 一并提交，否则 git 安装的用户拿不到修复。
3. 桥脚本属于 **host 半体**（由宿主路由 `/overleaf/workbench/bridge.js` 提供）⇒ **改完必须重启宿主**：桌面端＝退出 DeepSeek Harness 再打开；web 端＝`Ctrl+C` 后重跑 `dsh web`（web 端本来正常，只做回归）。
4. 交付纪律（本仓库惯例）：commit → push → `gh release` 打 patch 版本（v1.0.1）→ 若已有镜像安装则同步。
5. 顺手可清：`package.json` 的 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`（该包在 0.1.7 / 0.2.0 运行时里都不存在，属无害陈旧声明）。

---

## 8. 验证清单（逐条过，不许只看日志）

**A. 仓库内**

- `pnpm test`（重点：`scripts/smoke-socket-routing.mjs`、`scripts/smoke-texpage-socket.mjs`、`scripts/smoke-texpage.mjs`）。
- **新增用例**：把 `location` 模拟成自定义协议（`location.protocol='dsh-app:'`、`location.host='app'`、`location.origin='dsh-app://app'`），断言：
  - `routeSocketUrl('ws://dsh-app/socket.io/?EIO=4&transport=websocket')` → `ws://127.0.0.1:<隧道端口>/__dsh_socket__/socket.io/?EIO=4&transport=websocket`
  - `routeSocketUrl(new URL('ws://app/socket.io/…'))` → 同上
  - `routeUrl('dsh-app://socket.tex.nju.edu.cn/heartbeat?…')` → `dsh-app://app/overleaf-proxy/__dsh_socket__/heartbeat?…`（或等价的相对形式，只要不含非法主机）
  - **同时**保留 http(s) 下的旧断言全部通过。
- 可选：`DSH_COOKIE=… node scripts/debug-tunnel-live.mjs`（仓库自带的真机隧道验证）。

**B. 桌面端实测（重启宿主后）**

- DevTools Console 应出现 `ws://127.0.0.1:<port>/__dsh_socket__/socket.io/…` 且**不再**出现 `ws://dsh-app/…` 与 `dsh-app://socket.…` 的 404；
- 站点 iframe 的 `<html>`：`data-dsh-overleaf-ws-state="open"`、`socketio-state="connected"`、`ws-messages` 持续递增；
- **亲眼看**：能进项目、能编译出 PDF、选区插入/双向同步可用（本仓库核验准则：日志通过 ≠ 合格）。

**C. web 端回归**：`http://127.0.0.1:3080` 上打开工作台，编辑/编译/PDF/同步照旧。

---

## 9. 回滚

- 代码：`git revert <sha>`；或恢复修前的 `lib/index.js` 备份（修前请 `Copy-Item lib\index.js lib\index.js.bak-20260930`）。
- 回滚后**必须重启桌面宿主**才生效。
- 注意：桌面端与 web 端通过 `link:E:/GalaxyC/DSH/DSH-Overleaf/dsh-overleaf` 共用同一份代码，回滚同时影响两端（web 端本来是好的，别把好的一端弄坏）。

---

## 10. 明确不在本仓库范围（同一次排查中发现的其它问题）

| 现象 | 归属 | 说明 |
|---|---|---|
| `ws://app/sidebar/ws/{agent-opens,fs-watch}` 全部连接失败 | `dsh-better-sidebar`（第三方） | **同类根因**：用 `location.host` 拼 `ws://`；壳通过 boot IPC 提供 `streamBaseUrl`（真实宿主 origin）正是给这种场景用的。建议单独上报/单独修 |
| `dsh-app://app/plugins/??<bundles>&rev=…` → 404 | DSH 桌面壳 | 壳自带 renderer 文档与宿主 packet rev 可能不同步；与 Overleaf 无关 |
| `dsh-raw-html/{get-state,set-state,list-fonts,list-styles}` → 405 | `dsh-raw-html`（第三方） | 路由方法不匹配；与 Overleaf 无关 |
| ⛔ 不要改 `app.asar` | — | 壳本次**无过错**（唯一 cancel 规则只针对宿主端口 + 外星 Origin）；改安装目录会被桌面端升级覆盖 |
| ⛔ 不要改上游 `User-Agent` | — | "Electron UA 触发风控"已被实验证伪（web 端正常、无验证界面） |

---

## 11. 附：本次用到、可复用的外部事实

- 壳的转发实现：`app.asar/lib/main.js` 的 `forwardWebRequest`（要求 `Origin: dsh-app://app`，否则 403；保留 method/path/body，注入宿主 cookie）与 `protocol.handle("dsh-app", …)`（hostname 白名单：`shell` / `app`）。
- 壳的 WS 规则：`session.defaultSession.webRequest.onBeforeSendHeaders({urls:['ws://127.0.0.1/*']})` —— 只有「目标是宿主端口且 Origin 不是 `dsh-app://app`」才 `cancel`。
- **插件自注册的路由不受宿主鉴权保护**：`/overleaf/workbench/*`、`/overleaf-proxy/*` 在 19387 与 3080 上都直接返回 200（同一实例 `/` 返回 401）⇒ 可直接探活，不必找 token。
