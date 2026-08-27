# dsh-overleaf

[English](README.md) | [中文](README.zh.md)

DeepSeek Harness（DSH）Web 的 **Overleaf 嵌入工作台**插件。它在会话页顶部的 `对话 / 轨迹 / 上下文` 旁新增第四个选项：通过同源反向代理加载你的 Overleaf 站点（公有云或自托管，如 `https://tex.nju.edu.cn`），页面**完整可操作**——编辑、编译、PDF 预览全部保留——页面下方仍是原生 DSH 对话输入框；选区引用、光标处写入、LaTeX 辅助面板在两者之间打通。

```
+--------------------------------------------------------------+
|  会话页选项条:  对话 | 轨迹 | 上下文 | [Overleaf]              |
+--------------------------------------------------------------+
|  工具栏: 刷新 / 新窗口 / 登录 / Cookie / 辅助面板              |
|  +----------------------------------------------------------+ |
|  |  https://.../overleaf-proxy/...（同源 iframe）            | |
|  |  Overleaf 编辑器、编译器、PDF 预览全部可用                 | |
|  +----------------------------------------------------------+ |
|  选区浮动「引用」气泡 —— 选区桥                                |
|  状态条 / 辅助面板（光标插入、文档大纲……）                     |
+--------------------------------------------------------------+
|  DSH composer（原生，未做任何改动）                            |
+--------------------------------------------------------------+
```

- 许可证：MIT
- 目标运行时：DeepSeek Harness `0.1.1-rc.2` web profile（`http://127.0.0.1:3080`）
- 协议：附带符合 [dsh-std](https://github.com/Yan-Zero/dsh-std) 互操作规范的静态 Community v0.15 `dsh-plugin.json` 清单；经典双半区 bundle 加载仍是主激活路径。

## 为什么需要它

Overleaf 的每个响应都带 `X-Frame-Options` / CSP `frame-ancestors`，直接 `<iframe src="https://tex.nju.edu.cn">` 会被浏览器拒绝。本插件在 DSH 宿主进程内实现了一个 HTTP/1.1 反向代理：浏览器所有请求走 `/overleaf-proxy/<原路径>` 再转发到你配置的上游站点——上游被锁定为唯一配置来源，没有开放 SSRF 面。iframe 与 GUI 同源之后，浏览器级桥接才成为可能：嵌入编辑器里的文本选区可以结构化地进入对话框，生成的内容也可以写回编辑器光标处。

## 功能与验收对照

| 需求 | 实现状态 |
|---|---|
| R1 · 会话页第 4 个选项 | `conversation.view` 条目 `id:"overleaf"`、`order:30`；官方 tab 条可见时即可见（tabs >= 2） |
| R2 · 可配置地址 | 设置页（设置 > 插件 > 插件配置 > dsh-overleaf）修改 `baseUrl`；保存后热切换代理目标，无需重启 |
| R3 · 原站功能可用 | 流式反向代理保留路径与查询串；响应除取景限制头外透传；小幅 HTML 正文做链接/资源重定基并注入桥接脚本 |
| R4 · 底部原生输入框 | 视图只替换消息区域；composer、工作区记录、交付物一概不动 |
| R5 · 选区引用 | iframe 内 `selectionchange` 浮出引用按钮；点击经官方引用管线写入 chip（`inputTriggers.registerSource({name:'quote-ref'})` codec），管线缺失时退化为纯文本块引用 |
| R6 · 光标处生成 | 模板插入（section/subsection/figure/table/equation/BibTeX）与自由粘贴通过 CodeMirror API 写入实时光标（CM5 主通道，CM6 探测，可编辑兜底）。自动写入模型回复列入后续计划；按任务书要求注明所属 lane |
| R7 · 辅助功能 | 辅助面板：从编辑器缓冲抽取文档大纲并可跳转闪烁；登录/登出/Cookie 管理；状态上报（`assistPanelEnabled` 开关控制面板显隐） |

## 安装

npm 包名已被另一项目占用，因此仅通过 GitHub 或 tarball 分发：

```sh
# 从 GitHub releases 安装（推荐）：
dsh plugin --profile web add github:gychen-NJU/dsh-overleaf

# 从 release 资产安装：
dsh plugin --profile web add ./dsh-overleaf-0.1.0.tgz
```

随后重启一次 web 服务（客户端 bundle 在启动期进入 boot 图谱）：

```sh
dsh --profile web web        # 用你平时的方式启动即可
```

确认组合仍然成立：

```sh
dsh --profile web --dump-config   # 应看到 "# == dsh-overleaf" 配置块
```

随时可以干净卸载：

```sh
dsh plugin --profile web remove dsh-overleaf
```

### 共存保证

刻意避开已知插件的每一条命名面：

| 面 | dsh-overleaf 占用 | 其他插件已有占用 |
|---|---|---|
| Cordis 行 id | `overleaf-workbench` | `overleaf`（better-overleaf） |
| 客户端模块 id | `dsh-overleaf-workbench` | `dsh-overleaf`（better-overleaf banner） |
| HTTP 路由 | `/overleaf-proxy/*`、`/overleaf/workbench/*` | `/overleaf/*`（better-overleaf）、`/api/dsh-browser/*` |
| WS 升级 | `/overleaf-proxy/socket.io[/]` 精确匹配 | 无已知 |
| 凭据 ref | `OVERLEAF_WORKBENCH_COOKIE` | `OVERLEAF_COOKIE` / `OVERLEAF_GIT_TOKEN` |
| 数据目录 | `~/.dsh/plugin-data/dsh-overleaf-workbench/browser-profile` | `~/.dsh/plugin-data/dsh-overleaf/...` |
| 会话视图 id | `overleaf`，order 30 | chat 0 / trajectory 10 / context 20 |

两侧全部软失败：缺 `credentials` 服务则停用凭据存储（每次请求退化为手动粘贴模式）、缺 `settings` 则跳过设置卡；客户端任何异常只打日志不抛出，绝不阻塞 GUI 启动。

## 架构

```
src/
  index.ts          宿主侧统一导出 + 默认 Service 类（cordis loader 目标）
  service.ts        路由、status/login/projects 操作、settings 命名空间接线
  config.ts         schemastery schema + 默认值 + origin 归一化
  proxy.ts          ReverseProxy：流式 HTTP 反代 + 原始升级隧道
  inject-script.ts  浏览器桥接脚本 bridge.js 的源头
  login-cdp.ts      直连 CDP 登录（移植自 Hoemr/dsh-better-overleaf, MIT）
  credentials.ts    OVERLEAF_WORKBENCH_COOKIE credentialRef
  types.ts          wire 类型
  client/
    index.ts        客户端 apply(): 字典、quote-ref source、视图槽位、
                    设置卡槽位（对 settingsScope 软等待）
    view.tsx        OverleafView 组件（工具栏/iframe/CTA/面板/对话框）
    workbench.ts    根 ctx 捕获、引用注册表、composer 写入辅助
    settings-card.tsx  按 'dsh-overleaf' 命名空间的暂存式设置表单
    locales.ts      zh/en 平铺字典（zh 为 key 源）
scripts/
  smoke-offline.mjs 假上下文夹具：路由普查、JSON 流程、HTML 重写断言、
                    cookie/logout 生命周期、client factory 物化 + stub 服务上的
                    apply()
  smoke-live.mjs    以真实 @deepseek-ai/dsh-host-webserver 起 OS 随机端口，
                    指向本地 fixture 上游，验证重定基/注入、Set-Cookie 收域、
                    二进制流、JSON 路由、真实 RFC6455 隧道往返、bridge.js 资产路由
```

请求链路概述：

1. 浏览器向 DSH 服务器请求 `/overleaf-proxy/<path>?<query>`。
2. 宿主 handler 重建头部（host 改写为上游、委托 `Origin`、cookie 与已存凭据合并、文本正文保持 identity 编码以便改写）。
3. 上游响应流式转发；响应头调整：去 `X-Frame-Options`、从 CSP 移除 `frame-ancestors`、绝对重定向改挂到代理前缀下、`Set-Cookie` 的 Domain 属性剥离（Cookie 落为 host-only）。
4. 不超过 4MB 的 `text/html` 缓冲一次处理：根相对的 `href/src/action/poster/data-src` 与 `srcset` 加前缀，并在 `<head>` 后注入 `<base href="/overleaf-proxy/">` 与桥接脚本。超大 HTML 及其他类型一律原样流式。
5. WebSocket：真实 webserver 把精确升级路径分派给 TCP/TLS 隧道——向上游重放握手字节再双向逐字节拼接。

在被代理文档内，桥接脚本安装防御性包装（`fetch`、`XMLHttpRequest.open`、`EventSource`、`WebSocket`），让运行期新建的根相对 URL 也落回前缀；向父窗口上报选区变化；暴露光标写入/大纲/跳转命令；并在每次变更前保存 localStorage 快照供回滚。

## 登录

两条路径共用同一凭据库：

- **直连 CDP 抓取（推荐）**：插件用你选择的 Chromium 系浏览器（`auto` 自动发现默认浏览器与已装 Chromium；可指定渠道或路径）以独立配置目录（`~/.dsh/plugin-data/dsh-overleaf-workbench/browser-profile`）加预留 loopback 调试端口启动。登录一次后轮询 `Storage.getCookies` / `Network.getAllCookies`，直到出现配置主机的 `overleaf_session*` Cookie 且有页面抵达 `<baseUrl>/project*`。Cookie 行写入 `ctx.credentials`（`OVERLEAF_WORKBENCH_COOKIE`），此后随每个代理请求上行。
- **手动粘贴**：DevTools 复制整行 Cookie 经工具栏对话框粘贴入库；保存前以 redirect-manual GET 校验 `<baseUrl>/project`。

Cookie 值从不进入插件 config、路由返回值、日志或客户端存储。

## 安全模型

- 所有插件路由 socket 级 loopback 围栏（`127.0.0.1`/`::1`）；非回环调用者在读取请求体之前就被 403。
- 代理目标锁定单一配置 origin——URL 解析拒绝协议/路径/主机覆盖，不存在开放中继。
- 取景保护只对这一个用户主动选择的上游放宽，且只服务于刻意请求它的 loopback 客户端；其余头全部保留。
- 请像对待任何能持有你 LaTeX 账号会话的工具一样对待 `baseUrl`：只有当你的工作站本身就是信任边界时才接入内网实例。
- Cookie 只上行转发、从不出现在 API 返回里；logout 立即清除存储的凭据。
- 嵌入页与 GUI 同源，上游脚本也在其中运行——请自行审查所嵌入的内容。

## 已知限制

- Cookie 带上游标志位：现代 Chrome/Firefox/Edge 认为 loopback 可信，`Secure` Cookie 可经 `http://127.0.0.1:3080` 下发；老浏览器可能丢弃（宿主侧注入不受影响）。
- WS 精确匹配要求客户端访问 `/overleaf-proxy/socket.io[/]`：桥接包装会改写标准路径；绕过这些路径的特殊传输将退化到轮询。
- 某些纯客户端框架计算的 URL 依赖包装与 `<base>` 兜底；若站点开启无关路径的外连通道需自行补路由规则。
- CM6 支持依赖常见句柄探测；若 Overleaf 完成 CM6 迁移且内部句柄不同，模板插入退化为可编辑焦点兜底。
- 公有云个别项目页可能出现空白或重复渲染，需要按实例版本微调重定基规则；在宿主侧设 `DSH_OVERLEAF_DEBUG=1` 可打印 CSP 剥离日志。

## 开发

```sh
pnpm install
pnpm build        # tsc -b（类型 + 可运行 ESM/CJS 发射物）再 tsdown
pnpm test         # smoke-offline.mjs + smoke-live.mjs（无需起 DSH 实例）
pnpm typecheck
```

构建产物为 `lib/index.js`（node 半区，ESM）与 `lib/client.js`（浏览器半区，惰性 CJS 闭包，经 `window.__ModuleLoader__.load({ id:'dsh-overleaf-workbench', factory })` 注册）。客户端 bundle 只允许 require 平台种子表中的 React（含 jsx-runtime），其余全部内联——纯度门与社区惯例一致。

要在真实 profile 里试用本地改动：打包 tarball 后 add、重启 web 服务，然后同时观察外壳与 iframe 两份 DevTools 控制台中 `[dsh-overleaf]` 前缀日志。

## 兼容性说明

- 针对 DSH `0.1.1-rc.2` web profile 验证；peer 区间接受宿主服务 `>=0.1.0-rc.5`、cordis `^4.0.1`。
- Node `^22.19 || >=24`。
- 可与 `dsh-better-sidebar` / `dsh-better-overleaf` / `dsh-context` / paperlab 等并存；见共存表。
- `dsh-plugin.json` 遵循 dsh-std Community v0.15；实现了 `@dsh-std/adapter-dsh` 的 Host 可静态发现该清单，普通 profile 直接忽略。

## 致谢

- [Hoemr/dsh-better-overleaf](https://github.com/Hoemr/dsh-better-overleaf)（MIT）：直连 CDP 登录设计，已在 `login-cdp.ts` 中适配（域名参数化过滤 + 专属配置目录）。
- [Nono-neko/dsh-browser](https://github.com/Nono-neko/dsh-browser)：验证了 DSH 上同源反向代理 + loopback 围栏模式。
- [wangwei-wade/dsh-quote-annotate](https://github.com/wangwei-wade/dsh-quote-annotate)：建立了引用 chip 的插入/序列化流程，本插件将其扩展到代理页面。
- [Yan-Zero/dsh-std](https://github.com/Yan-Zero/dsh-std)：本包遵循的静态清单协议。

## 许可证

[MIT](LICENSE)
