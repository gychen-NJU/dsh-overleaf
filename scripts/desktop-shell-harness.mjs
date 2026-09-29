/**
 * dsh-overleaf - real Electron desktop-shell acceptance harness.
 *
 * WHAT IT PROVES
 *   The DSH desktop shell loads pages from the custom scheme `dsh-app://app/`
 *   (`protocol.handle` + `registerSchemesAsPrivileged`). The Overleaf workbench
 *   is embedded as a frame whose URL stays `dsh-app://app/overleaf-proxy/` while
 *   its bytes are forwarded from the DSH host (`http://127.0.0.1:19387`). In that
 *   document `location.protocol === 'dsh-app:'` / `location.host === 'app'`, so
 *   the site's `location`-derived URLs degrade to `dsh-app://<site-host>/...` and
 *   `ws://dsh-app/socket.io/...` - URLs the shell cannot serve. The bridge script
 *   (`src/inject-script.ts`) must normalize them onto the loopback tunnel.
 *
 *   Asserted (all must hold for exit 0):
 *     - the frame really runs on `dsh-app://app/...` (custom scheme document);
 *     - the bridge is injected and reports `data-dsh-overleaf-bridge=ready`;
 *     - `data-dsh-overleaf-ws-target` is `127.0.0.1:<tunnel port>`;
 *     - `ws-state=open`, `socketio-state=connected`, `ws-messages` grows;
 *     - no polluted URL (see the classifier below) was requested;
 *     - real WebSocket traffic recorded by CDP/webRequest hit the tunnel.
 *   The recorded request targets are the hard evidence; the bridge's own
 *   `data-dsh-overleaf-*` attributes are corroboration.
 *
 * WHICH TREE IS UNDER TEST (read this before trusting a run)
 *   - bridge-side routing (`routeUrl`/`routeSocketUrl` - the fix) is served by
 *     THIS harness from THIS worktree's build output:
 *     `import { renderBridgeScript } from '../lib/types/inject-script.js'`.
 *     `dsh-app://app/overleaf/workbench/bridge.js` is answered locally, so the
 *     page never picks up the bridge served by 127.0.0.1:19387. That isolates
 *     the harness from the desktop profile's `node_modules/dsh-overleaf`
 *     junction (which can point at a PRE-FIX `lib/index.js` in another worktree).
 *   - the workbench page itself (`/overleaf-proxy/` HTML/CSS/JS), its injected
 *     `window.__DSH_OVERLEAF_*` variables and the tunnel port still come from the
 *     running host on 127.0.0.1:19387; the loopback socket tunnel lives in that
 *     host process and its forwarding behaviour is fix-independent.
 *   - so: `pnpm build` in THIS worktree is a prerequisite; restarting the desktop
 *     host is NOT needed for the bridge (the harness injects it).
 *   - equivalence boundary: this combination equals the released one only while
 *     `git diff --name-status main desktop` touches nothing but the bridge and
 *     client/docs/scripts/package.json. If proxy/socket/service/config differ
 *     between the two sides, the premise breaks.
 *
 * PREREQUISITES
 *   1. `pnpm build` in this worktree (the harness imports `lib/...`).
 *   2. The DSH desktop app must be RUNNING (host on 127.0.0.1:19387 serving
 *      `/overleaf/workbench/*` + `/overleaf-proxy/*`). The harness only reads
 *      through it - it never restarts, reconfigures or focuses it.
 *   3. A stock Electron runtime (see HOW TO RUN).
 *   4. Offline-safe apart from the site traffic the real workbench needs.
 *
 * HOW TO RUN
 *   A stock Electron runtime is REQUIRED, and the reasons were verified the hard
 *   way:
 *     - the DeepSeek Harness desktop exe is a PACKAGED Electron app: it ignores
 *       an external script argument and starts its own app.asar, then exits 0
 *       through the single-instance hand-off. Exit code 0 with no report is NOT
 *       success;
 *     - an ESM app entry (`main.mjs`) loads but `app.whenReady()` never settles,
 *       and the stock Electron default app cannot load an `.mjs` at all
 *       (`require()` throws). Hence the CJS entry in scripts/desktop-shell/.
 *
 *   scripts\desktop-shell-harness.cmd                     <- preferred
 *   scripts\desktop-shell-harness.cmd --negative-control
 *   scripts\desktop-shell-harness.cmd --report <path>
 *   "<stock electron.exe>" scripts/desktop-shell [flags]
 *   node scripts/desktop-shell-harness.mjs --help
 *
 *   Runtime resolution: $DSH_ELECTRON_EXE ->
 *   <worktree|parent>/node_modules/electron/dist/electron.exe ->
 *   %LOCALAPPDATA%\electron\Cache -> bounded scan for
 *   any/.../node_modules/electron/dist/electron.exe (E:\, D:\, %LOCALAPPDATA%,
 *   C:\Program Files, depth 3, 15 s budget). Nothing found: exit 2 with
 *   `npm i -D electron` guidance - never a silent pass.
 *   Verified working runtime on this machine:
 *   E:\vsf_ascii\SXSEditor\node_modules\electron\dist\electron.exe (42.4.1);
 *   `protocol.registerSchemesAsPrivileged` DOES exist in 42 - the real
 *   constraint is that it must be called before `app.ready`, which is why the
 *   CJS entry registers it and imports this module before ready.
 *   The launcher deletes the inherited `ELECTRON_RUN_AS_NODE` (this DSH session
 *   exports =1; Electron tests the variable's PRESENCE, so blanking is not
 *   enough) and forwards the pre-clearing value into the report.
 *
 * IMPLEMENTATION NOTES (hard-won, do not "simplify" away)
 *   - forwarding uses Node's fetch, not `ses.fetch`: a session fetch issued from
 *     inside a `protocol.handle` handler crashed Chromium's network service in
 *     Electron 42 ("Network service crashed or was terminated") and took the
 *     renderer with it. Node's fetch also accepts the `Origin` header that
 *     Chromium rejects with net::ERR_FAILED; renderer-side requests still get it
 *     from `session.webRequest.onBeforeSendHeaders`.
 *   - upstream redirects are passed through to the frame (302 + Location), which
 *     is what the shell does; the frame URL tracks the real proxied path
 *     (`/overleaf-proxy/` -> `/overleaf-proxy/console` on this site).
 *   - evidence comes from four independent sources and the report keeps them
 *     apart: CDP `Network.*` + `webRequest` targets (`requests`,
 *     `requestTimeline`), the bridge's own `data-dsh-overleaf-*` attributes
 *     (`diagnostics`, `samples`), an in-page probe that opens a shell-shaped
 *     `ws://dsh-app/socket.io/...` URL inside the frame (`socketProbe`,
 *     `probeRoutedToTunnel`, `probePolluted`, and the `probeSocket`
 *     construction set), and the SITE SOCKET TAP below (`siteSocket`).
 *     The probe socket is left open and completes a socket.io handshake, so a
 *     passing probe proves bridge routing + tunnel + upstream handshake even
 *     when the site's own boot is broken; the report labels it
 *     `evidenceSource: harness in-page probe` and it NEVER fills `siteSocket`.
 *
 * SITE SOCKET TAP - the attribution channel (t14)
 *   `socketio-state`/`ws-messages` are written by the bridge for every socket it
 *   constructs, and the bridge only constructs when a page script asks it to, so
 *   those attributes cannot say WHOSE socket it was. The tap closes that gap:
 *     - PRIMARY: the harness serves these documents itself (protocol handler ->
 *       forwardToHost), so the tap is inserted as the FIRST script of every
 *       forwarded HTML document AND of the harness document. It therefore runs
 *       before the bridge and before any other page script, with no CDP timing
 *       involved: `socketTap.beforePageScripts === true`, `mechanism` =
 *       "html-injection";
 *     - REINFORCEMENTS (never on the critical path): a fire-and-forget CDP
 *       `Page.addScriptToEvaluateOnNewDocument` with a 1.5 s budget (it does not
 *       settle before a document exists, so it may only cover later documents) and
 *       a post-load frame injection. If the inline injection ever did not happen,
 *       these are what the run falls back to, and `socketTap` then reports
 *       `beforePageScripts: false` plus a `mechanism` naming the fallback and
 *       `source` explicitly saying DEGRADED. Never a silent, self-congratulatory
 *       label: `attemptedSource` carries the API that was merely attempted.
 *     - the tap wraps `window.WebSocket` and records every construction as
 *       `{ url, stackHint, at, byProbe, hasBridgeFrame, hasSiteFrame, bridgeOnly }`;
 *     - the harness probe marks itself (`__DSH_SHELL_HARNESS_PROBE__`), so probe
 *       constructions land in `probeSocket`, never in `siteSocket`;
 *     - constructions whose stack carries only bridge.js/tap frames are
 *       bridge-internal and land in `bridgeSocketExcluded`.
 *   Verdict keys (stable):
 *     siteSocket{}            { source, observed, count, urls[], constructions[],
 *                               state{ tapInstalled, framesInjected[], framesSeen } }
 *     probeSocket{}           same shape; state = { tapInstalled }
 *     bridgeSocketExcluded{}  same shape; state = {}
 *     socketTap{}             { installed, beforePageScripts, mechanism,
 *                               auxiliaryMechanisms[], degraded, source,
 *                               attemptedSource, htmlInjections, scriptId, error,
 *                               frameInjections, framesInjected[], framesSeen,
 *                               totalConstructions, siteConstructions,
 *                               probeConstructions, bridgeConstructions }
 *   Judgment rule (deterministic, decided IN THE PAGE at construction time - no
 *   URL-shape or timestamp guessing, so probe evidence can never be promoted):
 *     probeSocket          := byProbe === true   (__DSH_SHELL_HARNESS_PROBE__ was set)
 *     bridgeSocketExcluded := byProbe !== true AND bridgeOnly === true
 *                             (a bridge.js frame on the stack, no page-script frame)
 *     siteSocket           := every remaining record (page-initiated)
 *   Each construction carries url / at / frameUrl / byProbe / hasBridgeFrame /
 *   hasSiteFrame / bridgeOnly / stackHint so the classification can be audited
 *   record by record.
 *   Failure mode: with no site-side socket.io traffic at all, `siteSocket.count`
 *   is 0, the harness says `未观测到站点自建 socket (site-built socket not
 *   observed)` in both the report evidence and stdout, and that assertion joins
 *   the failure surface (negative control included). Probe evidence is never
 *   substituted for it.
 *   Run (positive / negative, same window and same assertions):
 *     scripts\desktop-shell-harness.cmd
 *     scripts\desktop-shell-harness.cmd --negative-control
 *   then read `.tmp\desktop-shell-report.json` ->
 *   `.siteSocket.count` / `.probeSocket.count` / `.bridgeSocketExcluded.count` and
 *   `.socketTap.{beforePageScripts,mechanism}`.
 *
 * KNOWN FINDING FROM THE FIRST REAL RUN (2026-09-30, PASS with probe evidence)
 *   The workbench console loads, the bridge reports ready, and a shell-shaped
 *   WebSocket is rewritten onto `ws://127.0.0.1:<tunnel>/__dsh_socket__/...`,
 *   but the SITE's own API calls fail with "Network Error": the recorded XHRs
 *   are `https://app/api/{tag,project,project/total,user/invitation,
 *   project/invitation}`. The site builds protocol-relative URLs from
 *   `location.host` (`//app/api/...`), the bridge's fetch/XHR wrappers prefix
 *   them with the upstream protocol (upstreamProtocol + '//app/...') and
 *   `routeUrl` does not recognise `app` (the shell host) as the current origin,
 *   so the bogus host `app` is requested. vm-level reproduction:
 *   `routeUrl('https://app/api/tag')` currently returns it unchanged, while
 *   `routeUrl('dsh-app://app/api/tag')` correctly returns
 *   `/overleaf-proxy/api/tag`. Fixing the shell-host case in `routeUrl` (treat
 *   `parsed.host === shellHost` like the current origin) should restore the
 *   site's own socket; the harness will then show the site socket instead of
 *   relying on the probe.
 *
 * EVIDENCE CHANNEL (stdout is only a side note - judge by the JSON)
 *   The harness ALWAYS writes a report and uses the exit code as the verdict:
 *     default  <worktree>\.tmp\desktop-shell-report.json   (.tmp/ is gitignored)
 *     override --report <path>
 *   The absolute path is printed and echoed in the report's own `report` key.
 *   Frozen keys:
 *     verdict            "pass" | "fail", always present
 *     reasons[]          one string per failure
 *     report             absolute path of this report
 *     diagnostics{}      data-dsh-overleaf-* attributes at verdict time
 *                        (bridge/ws-port/ws-target/ws-state/socketio-state/
 *                        ws-messages always present)
 *     requests[]         aggregated { url, kind, count }
 *     requestTimeline[]  per-event { kind, url, observedAt }
 *     environment{}      { electronRunAsNodeBeforeClearing, electron, node,
 *                          userDataDir, hostOrigin }
 *     worktree{}         { libHasShellScheme, resolvedRoot }
 *     tunnelPort         number | null
 *     durationMs         finishedAt - startedAt
 *     generatedAt        ISO8601
 *   Audit data kept alongside: runtime, selfCheck, samples, forwardSamples,
 *   assertion list, consoleMessages, errors, log.
 *
 * FLAGS
 *   --host-port=<n>      DSH host HTTP port              (default 19387)
 *   --ws-port=<n>        tunnel port override            (default: parsed from the proxied page)
 *   --timeout=<sec>      connect observation window      (default 60)
 *   --settle=<sec>       extra window proving ws-messages growth (default 25)
 *   --frame-origin=http  load the frame over http://127.0.0.1:<host>/overleaf-proxy/
 *                        instead of dsh-app://app/overleaf-proxy/ (web-like control)
 *   --host-cookie=<v>    inject this Cookie header when forwarding (default: none)
 *   --cookie=<v|@file>   same as --host-cookie, and `@path` reads the value from a
 *                        file (never logged, never written into the report)
 *   --cookie-file=<path> same, always read from the given file
 *   --open-project=<id|url>
 *                        after load, point the station iframe at
 *                        /overleaf-proxy/console/<id> (the site's project route; an
 *                        explicit path or URL is used as-is) so the site boots into
 *                        a project instead of its landing page. The outcome lands in
 *                        `openProject{}`: frameUrl / documentStatus / documentBytes /
 *                        documentHasBridgeTag / readyState / bridgeAttribute /
 *                        bridgeScriptTag, so a 404 route can never masquerade as a
 *                        loaded project. Bridge attributes are re-collected from the
 *                        frame that navigated, and the in-page probe is forced onto
 *                        the current frame (`socketProbe.trigger`) even when no
 *                        bridge attribute ever appears.
 *   SECURITY: a cookie supplied via --cookie/--cookie-file/--host-cookie is never
 *   logged, never written into the report and never committed; only
 *   `openProject.cookieProvided` / `openProject.cookieSource` metadata is recorded.
 *   Keep cookie files under .tmp/ (gitignored) and never copy them elsewhere.
 *
 *   --debug-sockets      OPT-IN socket instrumentation (env alias
 *                        DSH_OVERLEAF_DEBUG_SOCKETS=1). Default OFF: the report keys,
 *                        assertion set, readings and exit codes are exactly as before.
 *                        ON adds three keys:
 *                          socketDebug[]      one entry per WebSocket construction:
 *                                             { class: site|bridge|probe, rawInput,
 *                                               usedNativePath, normalized, resolved,
 *                                               initiatorHint, error, at, frameUrl }
 *                          socketDebugNote    counts, or the explicit sentence that
 *                                             nothing was constructed anywhere
 *                          hostSource{}       { hostBase, bridgeSource, note }
 *                        Judgment (same deterministic rule as the tap):
 *                          class site   - byProbe !== true and bridgeOnly !== true
 *                          class bridge - byProbe !== true and bridgeOnly === true
 *                          class probe  - byProbe === true
 *                        Field meaning: `rawInput` is the caller's value BEFORE any
 *                        rewriting (captured by a layer installed on top of the
 *                        bridge's patched constructor, once __DSH_OVERLEAF_BRIDGE__ is
 *                        set); `normalized` is the bridge's routeSocketUrl output and
 *                        `resolved` is the string really handed to the native
 *                        constructor (both from the constructor tap underneath);
 *                        `usedNativePath` says whether the construction reached that
 *                        native boundary; `error` carries the constructor's throw or
 *                        the async error/close text INCLUDING the target URL.
 *                        Entries with rawInput null are constructions made before the
 *                        debug layer existed (they are shown, not dropped).
 *   --bridge-source=host serve /overleaf/workbench/bridge.js from the REAL host (the
 *                        running desktop app configuration: host proxy, host cookies,
 *                        host cache) instead of this worktree's lib/index.js.
 *                        Default: worktree bridge.
 *   --report=<path>      JSON report path (default <worktree>\.tmp\desktop-shell-report.json)
 *
 *   TIMEOUT BUDGET: nothing in the harness waits on CDP any more (the socket tap
 *   registration is fire-and-forget with a 1.5 s budget and degrades to frame
 *   injection). Recommended: --timeout 45 with --settle 15..30; on a slow machine
 *   --timeout 180. Credentialed run example (value comes from the caller, the
 *   harness never reads the host's cookie store):
 *     scripts\desktop-shell-harness.cmd --cookie @.tmp\host-cookie.txt --open-project <id>
 * *   --keep-tmp           keep the throwaway user-data-dir
 *   --negative-control   emulate the PRE-FIX bridge (restore the pristine
 *                        WebSocket constructor, i.e. let the site's polluted URL
 *                        through untouched) and run the SAME assertion set.
 *                        Expected result: verdict "fail" / exit 1 - that is the
 *                        proof the harness can fail. Exit 0 here means the
 *                        harness is blind and the whole verdict is worthless.
 *
 * NON-INTERFERENCE (hard requirements)
 *   - throwaway user-data-dir under the OS temp dir; the user's profile is never
 *     read or written; `app.setPath('userData')` runs before `app.whenReady()`
 *     (the CJS entry imports this module before ready for exactly that reason);
 *   - hidden window (`show:false`), never shown, never focused, no DevTools window;
 *   - no single-instance lock, so the already running desktop app is untouched;
 *   - all harness traffic goes through `session.fromPartition()`; no cookies are
 *     imported (a cookie may only be injected explicitly via `--host-cookie`).
 *
 * EXIT CODES
 *   0 assertions passed (or: --negative-control detected the defect)
 *   1 assertion failed  (report names the polluted URLs)
 *   2 precondition failed (host not running / tunnel port unknown / wrong runtime)
 *   3 harness internal error
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT_PASSED = 0
const EXIT_ASSERTION = 1
const EXIT_PRECONDITION = 2
const EXIT_INTERNAL = 3

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKTREE = path.resolve(HERE, '..')
const APP_DIR = path.join(HERE, 'desktop-shell')
const HARNESS_DOC_PATH = '/__dsh_shell_harness__'
const BRIDGE_PATH = '/overleaf/workbench/bridge.js'
const DEFAULT_REPORT = path.join(WORKTREE, '.tmp', 'desktop-shell-report.json')
const DIAGNOSTIC_KEYS = ['bridge', 'ws-port', 'ws-target', 'ws-state', 'socketio-state', 'ws-messages']
const POLLUTED_PATTERNS = [
  { name: 'ws://dsh-app/...', test: (url) => /^wss?:\/\/dsh-app(?:[:/]|$)/i.test(url) },
  { name: 'ws://app/...', test: (url) => /^wss?:\/\/app(?:[:/]|$)/i.test(url) },
  {
    name: 'dsh-app://<foreign host>/...',
    test: (url) => /^dsh-app:\/\//i.test(url) && !/^dsh-app:\/\/(?:app|shell)(?:[:/]|$)/i.test(url),
  },
]
// Only URLs *this plugin's bridge* constructs count as pollution. Other plugins
// in the shell legitimately use `ws://app/sidebar/ws/*` (the DSH sidebar) and the
// contract requires those to pass through untouched, so the classifier keys on
// the paths the bridge actually rewrites.
const PLUGIN_PATH_PREFIXES = [
  '/socket.io',
  '/heartbeat',
  '/__dsh_socket__',
  '/__dsh_texpage_output__',
  '/overleaf-proxy',
  '/overleaf/workbench',
]
// The fix's shell branch; `shellScheme` is the name the fix plan uses, the
// alternatives cover an equivalent implementation under a different name.
const SHELL_HANDLING_MARKERS = [
  ['shellScheme', /shellScheme/],
  ['isShell', /isShell(?:Context|Scheme|Doc)?\b/],
  ['unpoison', /unpoison/],
  ['dsh-app literal', /dsh-app/],
]

function parseArgs(argv) {
  const options = {
    hostPort: 19387,
    wsPort: 0,
    timeoutSec: 60,
    settleSec: 25,
    frameOrigin: 'shell',
    hostCookie: '',
    report: DEFAULT_REPORT,
    keepTmp: false,
    negativeControl: false,
    debugSockets: false,
    bridgeSource: 'worktree',
    help: false,
  }
  const read = (name) => {
    const prefix = `--${name}=`
    const hit = argv.find((arg) => arg.startsWith(prefix))
    if (hit) return hit.slice(prefix.length)
    const index = argv.indexOf(`--${name}`)
    if (index !== -1 && argv[index + 1] && argv[index + 1].charAt(0) !== '-') return argv[index + 1]
    return ''
  }
  const number = (name, fallback) => {
    const raw = read(name)
    if (raw === '') return fallback
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : fallback
  }
  if (argv.includes('--help') || argv.includes('-h')) options.help = true
  if (argv.includes('--keep-tmp')) options.keepTmp = true
  if (argv.includes('--negative-control')) options.negativeControl = true
  // Opt-in socket instrumentation. Default OFF: with the flag absent every report
  // key, assertion and reading stays exactly as before.
  if (argv.includes('--debug-sockets')) options.debugSockets = true
  if (process.env.DSH_OVERLEAF_DEBUG_SOCKETS === '1') options.debugSockets = true
  const bridgeSource = read('bridge-source')
  if (bridgeSource === 'host' || bridgeSource === 'worktree') options.bridgeSource = bridgeSource
  options.hostPort = number('host-port', options.hostPort)
  options.wsPort = number('ws-port', options.wsPort)
  options.timeoutSec = number('timeout', options.timeoutSec)
  options.settleSec = number('settle', options.settleSec)
  const origin = read('frame-origin')
  if (origin === 'http' || origin === 'shell') options.frameOrigin = origin
  options.hostCookie = read('host-cookie')
  // Credentialed / project-open modes (t14). `--cookie` accepts a literal value or
  // @<path>; `--cookie-file` always reads the file. The value is never logged.
  const cookie = read('cookie')
  const cookieFile = read('cookie-file') || read('cookieFile')
  let cookieSource = options.hostCookie ? 'host-cookie' : ''
  try {
    if (cookie.startsWith('@')) {
      options.hostCookie = fs.readFileSync(cookie.slice(1), 'utf8').trim()
      cookieSource = `cookie @${cookie.slice(1)}`
    } else if (cookie !== '') {
      options.hostCookie = cookie
      cookieSource = 'cookie (literal)'
    }
    if (cookieFile !== '') {
      options.hostCookie = fs.readFileSync(cookieFile, 'utf8').trim()
      cookieSource = `cookie-file ${cookieFile}`
    }
  } catch (err) {
    options.cookieError = err.message
  }
  options.cookieSource = cookieSource
  options.openProject = read('open-project') || read('openProject')
  options.report = read('report') || read('json-out') || options.report
  return options
}

const USAGE = `dsh-overleaf desktop shell harness

  scripts\\desktop-shell-harness.cmd [flags]
  "<stock electron.exe>" scripts/desktop-shell [flags]

asserts that the real Overleaf workbench, loaded the way the DSH desktop shell
loads it (dsh-app://app/overleaf-proxy/ forwarded from http://127.0.0.1:19387),
connects its socket through 127.0.0.1:<tunnel port> with no polluted URLs left.
The bridge script under test comes from this worktree's lib/, not from the host.

flags: --host-port= --ws-port= --timeout= --settle= --frame-origin=shell|http
       --host-cookie= --cookie=<v|@file> --cookie-file= --open-project=<id|url>
       --debug-sockets --bridge-source=worktree|host
       --report <path> --keep-tmp --negative-control --help
report: <worktree>\\.tmp\\desktop-shell-report.json (always written)

exit: 0 passed, 1 assertion failed, 2 precondition failed, 3 internal error
`

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * A stock Electron runtime is required: a PACKAGED Electron binary (the DeepSeek
 * Harness desktop exe included) ignores an external script argument. Search
 * order: explicit override, repo/parent node_modules, then a bounded, time-boxed
 * scan for any node_modules/electron/dist/electron.exe.
 */
function scanForElectron(root, depth, budget) {
  if (depth <= 0 || Date.now() > budget.deadline) return ''
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (Date.now() > budget.deadline) return ''
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules') {
      const direct = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      if (isFile(direct)) return direct
      continue
    }
    if (entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information' || entry.name === 'Windows') continue
    const found = scanForElectron(path.join(root, entry.name), depth - 1, budget)
    if (found) return found
  }
  return ''
}

function findElectronRuntime() {
  const candidates = []
  if (process.env.DSH_ELECTRON_EXE) candidates.push(process.env.DSH_ELECTRON_EXE)
  const relative = ['node_modules', 'electron', 'dist', 'electron.exe']
  let dir = WORKTREE
  for (let level = 0; level < 3 && dir; level += 1) {
    candidates.push(path.join(dir, ...relative))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache', 'electron.exe'))
  }
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (isFile(resolved)) return resolved
  }
  const budget = { deadline: Date.now() + 15000 }
  const roots = [path.parse(WORKTREE).root, 'E:\\', 'D:\\', process.env.LOCALAPPDATA || '', 'C:\\Program Files']
  for (const root of roots) {
    if (!root || !isDir(root)) continue
    const found = scanForElectron(root, 3, budget)
    if (found) return found
  }
  return ''
}

const options = parseArgs(process.argv.slice(2))
const runAsNodeBeforeClearing =
  process.env.DSH_HARNESS_RUN_AS_NODE_BEFORE || process.env.ELECTRON_RUN_AS_NODE || 'unset'

/**
 * Electron is only imported when the harness really runs inside Electron, so
 * `node scripts/desktop-shell-harness.mjs --help` stays usable without it.
 */
let electron = null
try {
  electron = await import('electron')
} catch {
  electron = null
}
const hasElectronApp = Boolean(electron && typeof electron.app !== 'undefined' && electron.app)

if (!options.help && !hasElectronApp) {
  const runAsNode = Boolean(process.env.ELECTRON_RUN_AS_NODE)
  const alreadyReexec = process.env.DSH_HARNESS_REEXEC === '1'
  if (!alreadyReexec) {
    const electronExe = findElectronRuntime()
    if (electronExe) {
      const entry = isDir(APP_DIR) ? APP_DIR : fileURLToPath(import.meta.url)
      const env = { ...process.env, DSH_HARNESS_REEXEC: '1', DSH_HARNESS_ELECTRON_RUNTIME: electronExe }
      // Electron tests the variable's presence, so it must be deleted, not blanked.
      if (env.ELECTRON_RUN_AS_NODE) env.DSH_HARNESS_RUN_AS_NODE_BEFORE = env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RUN_AS_NODE
      process.stderr.write(`[harness] re-executing under stock Electron: ${electronExe}\n`)
      const child = spawn(electronExe, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env })
      child.on('error', (err) => {
        process.stderr.write(`[harness] could not re-exec under Electron: ${err.message}\n`)
        process.exit(EXIT_PRECONDITION)
      })
      child.on('exit', (code) => process.exit(code === null ? EXIT_ASSERTION : code))
      await new Promise(() => {})
    }
  }
  const reason = runAsNode
    ? 'ELECTRON_RUN_AS_NODE is set, so this runs plain Node instead of Electron'
    : 'the "electron" module is not available in this runtime'
  process.stderr.write(
    `[harness] ${reason}, and no stock Electron runtime was found.\n` +
      '[harness] a PACKAGED Electron binary cannot run this harness: the DeepSeek\n' +
      '[harness] Harness desktop exe ignores a script argument and just starts its\n' +
      '[harness] own app (exiting 0 with no report). Use a stock Electron build:\n' +
      '  scripts\\desktop-shell-harness.cmd            (preferred: locates Electron)\n' +
      '  set DSH_ELECTRON_EXE=<stock electron.exe>     (explicit override)\n' +
      '  npm i -D electron                             (if none is installed)\n' +
      '  "<stock electron.exe>" scripts/desktop-shell [flags]\n',
  )
  process.exit(EXIT_PRECONDITION)
}

if (options.help) {
  process.stdout.write(USAGE)
  process.exit(EXIT_PASSED)
}

const { app, BrowserWindow, session } = electron

/**
 * Never call `app.whenReady()` blindly: under an ESM app entry it was observed
 * never settling. The CJS entry imports this module before ready (protocol
 * privileges and the throwaway profile must be set pre-ready), so awaiting ready
 * here is normally instantaneous.
 */
async function ensureReady() {
  if (app.isReady()) return true
  const settled = app.whenReady().then(
    () => true,
    () => false,
  )
  return Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(false), 30000))])
}

const logLines = []
const startedAtMs = Date.now()
const report = {
  // ---- frozen contract keys -------------------------------------------
  verdict: 'fail',
  reasons: [],
  report: path.resolve(options.report),
  diagnostics: {},
  requests: [],
  requestTimeline: [],
  environment: {
    electronRunAsNodeBeforeClearing: runAsNodeBeforeClearing,
    electron: process.versions.electron || 'unknown',
    node: process.versions.node || 'unknown',
    userDataDir: '',
    hostOrigin: `http://127.0.0.1:${options.hostPort}`,
  },
  worktree: {
    libHasShellScheme: false,
    resolvedRoot: WORKTREE,
  },
  tunnelPort: options.wsPort || null,
  durationMs: 0,
  generatedAt: '',
  // ---- audit layer (kept intentionally) --------------------------------
  startedAt: new Date(startedAtMs).toISOString(),
  mode: options.negativeControl ? 'negative-control' : 'positive',
  runtime: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    execPath: process.execPath,
    resolvedRuntime: process.env.DSH_HARNESS_ELECTRON_RUNTIME || process.execPath,
    runAsNodeEnv: runAsNodeBeforeClearing,
  },
  worktreeRoot: WORKTREE,
  selfCheck: {},
  forwardSamples: [],
  samples: [],
  consoleMessages: [],
  assertions: [],
  errors: [],
  log: logLines,
}

const networkTargets = new Map()
let stdoutBroken = false
// Forwarding runs on Node's fetch (undici), NOT on the Chromium network stack:
// a `ses.fetch` issued from inside a `protocol.handle` handler killed the network
// service in Electron 42 ("Network service crashed or was terminated"), taking
// the renderer with it. Undici also accepts an explicit `Origin` header, which
// Chromium rejects with net::ERR_FAILED. Renderer-initiated requests still go
// through the session, where `onBeforeSendHeaders` injects the same Origin.
let harnessFetch = null

function fetchUpstream(url, init) {
  if (harnessFetch) return harnessFetch(url, init)
  return electron.net.fetch(url, init)
}

function shellForwardHeaders() {
  const headers = {}
  if (options.frameOrigin === 'shell') headers.origin = 'dsh-app://app'
  if (options.hostCookie) headers.cookie = options.hostCookie
  return headers
}

/**
 * Credential material supplied through --cookie / --cookie-file / --host-cookie must
 * never reach stdout, the report or a commit. Every log line and the serialized
 * report pass through this redactor (defence in depth: the Origin self-check no
 * longer echoes the cookie either).
 */
function redactSecrets(text) {
  let out = String(text)
  try {
    const cookie = typeof options !== 'undefined' && options && options.hostCookie ? String(options.hostCookie) : ''
    if (!cookie) return out
    if (out.indexOf(cookie) !== -1) out = out.split(cookie).join('[redacted-cookie]')
    for (const pair of cookie.split(';')) {
      const eq = pair.indexOf('=')
      const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
      if (value.length >= 6 && out.indexOf(value) !== -1) out = out.split(value).join('[redacted]')
    }
  } catch (err) {
    /* never let redaction break the run */
  }
  return out
}

function log(message) {
  const line = redactSecrets(`${new Date().toISOString()} [harness] ${message}`)
  logLines.push(line)
  if (stdoutBroken) return
  try {
    process.stdout.write(`${line}\n`)
  } catch {
    stdoutBroken = true
  }
}

function fail(message) {
  report.errors.push(message)
  log(`ERROR ${message}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase()
  if (value.indexOf('websocket') !== -1) return 'websocket'
  if (value === 'fetch' || value.indexOf('fetch') !== -1) return 'fetch'
  if (value === 'xhr' || value.indexOf('xhr') !== -1) return 'xhr'
  return 'other'
}

function recordTarget(url, kind) {
  if (typeof url !== 'string' || url === '') return
  const normalized = normalizeKind(kind)
  const at = Date.now()
  if (report.requestTimeline.length < 4000) {
    report.requestTimeline.push({ kind: normalized, url, observedAt: at })
  }
  const key = `${normalized}|${url}`
  const seen = networkTargets.get(key)
  if (seen) {
    seen.count += 1
    seen.lastObservedAt = at
    return
  }
  networkTargets.set(key, { url, kind: normalized, count: 1, lastObservedAt: at })
}

function shellHandlingMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  for (const [name, pattern] of SHELL_HANDLING_MARKERS) {
    if (pattern.test(text)) return name
  }
  return null
}

function pluginPathOf(url) {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function isPluginRelatedUrl(url) {
  const pathname = pluginPathOf(url)
  if (pathname === '') return false
  return PLUGIN_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function pollutionOf(url) {
  if (!isPluginRelatedUrl(url)) return null
  for (const pattern of POLLUTED_PATTERNS) {
    if (pattern.test(url)) return pattern.name
  }
  return null
}

function flushReport() {
  report.durationMs = Date.now() - startedAtMs
  report.generatedAt = new Date().toISOString()
  report.finishedAt = report.generatedAt
  report.requests = [...networkTargets.values()]
    .map((entry) => ({ url: entry.url, kind: entry.kind, count: entry.count }))
    .sort((a, b) => b.count - a.count)
  const failedAssertions = report.assertions.filter((entry) => entry.status !== 'passed')
  report.reasons = [
    ...failedAssertions.map((entry) => `${entry.criterion}${entry.evidence ? ` - ${entry.evidence}` : ''}`),
    ...report.errors,
  ]
  report.verdict =
    failedAssertions.length === 0 && report.errors.length === 0 && report.exitCode === EXIT_PASSED ? 'pass' : 'fail'
  try {
    fs.mkdirSync(path.dirname(report.report), { recursive: true })
    // Redaction happens on the serialized bytes, so no nested key can smuggle a
    // cookie value (or a single cookie pair) into the report.
    fs.writeFileSync(report.report, redactSecrets(`${JSON.stringify(report, null, 2)}\n`), 'utf8')
    return true
  } catch (err) {
    report.errors.push(`could not write report: ${err.message}`)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 1. Non-interference: throwaway profile, registered scheme          */
/* ------------------------------------------------------------------ */

const defaultUserData = app.getPath('userData')
const userDataDir = path.join(os.tmpdir(), `dsh-overleaf-shell-harness-${process.pid}`)
if (path.resolve(userDataDir) === path.resolve(defaultUserData)) {
  log('refusing to run: throwaway profile resolved to the real profile')
  process.exit(EXIT_INTERNAL)
}
fs.rmSync(userDataDir, { recursive: true, force: true })
fs.mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)
report.userDataDir = userDataDir
report.defaultUserData = defaultUserData
report.environment.userDataDir = userDataDir

// Same privileges the desktop shell declares for dsh-app; must be registered
// before app.whenReady(). The CJS entry already does it and sets
// DSH_HARNESS_SCHEME_REGISTERED=1; the harness keeps its own call for standalone
// use and tolerates "already ready" failures.
if (process.env.DSH_HARNESS_SCHEME_REGISTERED === '1') {
  report.selfCheck.schemeRegisteredBy = 'entry (scripts/desktop-shell/main.cjs)'
} else {
  try {
    electron.protocol.registerSchemesAsPrivileged([
      {
        scheme: 'dsh-app',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ])
    report.selfCheck.schemeRegisteredBy = 'harness'
  } catch (err) {
    report.selfCheck.schemeRegistrationError = err.message
  }
}

/* ------------------------------------------------------------------ */
/* 2. Which tree is under test                                        */
/* ------------------------------------------------------------------ */

let worktreeBridge = ''
async function startupSelfCheck(hostBase) {
  let bridge = ''
  try {
    const module = await import('../lib/types/inject-script.js')
    bridge = module.renderBridgeScript()
  } catch (err) {
    fail(`cannot import this worktree's bridge (run \`pnpm build\` here): ${err.message}`)
  }
  worktreeBridge = bridge
  report.selfCheck.bridgeBytes = bridge.length
  report.selfCheck.worktreeBridgeMarker = shellHandlingMarker(bridge)
  report.selfCheck.worktreeBridgeHasShellHandling = report.selfCheck.worktreeBridgeMarker !== null
  log(
    `self-check worktree bridge: ${bridge.length} B, shell handling: ` +
      `${report.selfCheck.worktreeBridgeHasShellHandling ? `yes (${report.selfCheck.worktreeBridgeMarker})` : 'NO'}`,
  )

  const bundledPath = path.join(WORKTREE, 'lib', 'index.js')
  let bundled = ''
  try {
    bundled = fs.readFileSync(bundledPath, 'utf8')
    report.selfCheck.bundledIndexMarker = shellHandlingMarker(bundled)
    report.selfCheck.bundledIndexHasShellHandling = report.selfCheck.bundledIndexMarker !== null
    report.selfCheck.bundledIndexBytes = bundled.length
    log(
      `self-check worktree lib/index.js: ${bundled.length} B, shell handling: ` +
        `${report.selfCheck.bundledIndexHasShellHandling ? `yes (${report.selfCheck.bundledIndexMarker})` : 'NO'}`,
    )
  } catch (err) {
    report.selfCheck.bundledIndexError = err.message
    log(`self-check worktree lib/index.js unreadable: ${err.message}`)
  }
  report.worktree.libHasShellScheme = /shellScheme/.test(bridge) || /shellScheme/.test(bundled)
  log(`self-check worktree.libHasShellScheme: ${report.worktree.libHasShellScheme}`)

  if (hostBase) {
    try {
      const response = await fetchUpstream(`${hostBase}${BRIDGE_PATH}`)
      const text = response.ok ? await response.text() : ''
      report.selfCheck.hostBridgeStatus = response.status
      report.selfCheck.hostBridgeBytes = text.length
      report.selfCheck.hostBridgeMarker = shellHandlingMarker(text)
      report.selfCheck.hostBridgeHasShellHandling = report.selfCheck.hostBridgeMarker !== null
      log(
        `self-check host 19387 bridge.js: HTTP ${response.status}, ${text.length} B, shell handling: ` +
          `${report.selfCheck.hostBridgeHasShellHandling ? `yes (${report.selfCheck.hostBridgeMarker})` : 'no'} ` +
          '(environment note only - the harness serves the worktree bridge, not this one)',
      )
    } catch (err) {
      report.selfCheck.hostBridgeError = err.message
      log(`self-check host bridge.js unreadable: ${err.message} (ignored)`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Preflight: the real host must be serving the plugin routes       */
/* ------------------------------------------------------------------ */

async function preflightHost() {
  const base = `http://127.0.0.1:${options.hostPort}`
  const status = await fetchUpstream(`${base}/overleaf/workbench/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch((err) => {
    throw new Error(`host ${base} unreachable: ${err.message}`)
  })
  if (!status.ok) throw new Error(`${base}/overleaf/workbench/status -> HTTP ${status.status}`)
  const payload = await status.json().catch(() => null)
  report.workbenchStatus = payload && payload.value ? payload.value : payload
  const proxied = await fetchUpstream(`${base}/overleaf-proxy/`)
  if (!proxied.ok) throw new Error(`${base}/overleaf-proxy/ -> HTTP ${proxied.status}`)
  const html = await proxied.text()
  report.proxiedBytes = html.length
  report.proxiedHasBridgeTag = html.indexOf(BRIDGE_PATH) !== -1
  const port = /__DSH_OVERLEAF_WS_PORT__\s*=\s*(\d+)/.exec(html)
  report.tunnelPortFromPage = port ? Number.parseInt(port[1], 10) : null
  return base
}

/**
 * Mirrors the shell's forwardWebRequest + host-cookie injection: every loopback
 * request the harness makes or forwards carries `Origin: dsh-app://app`
 * (browser-level injection - the only way Chromium honours it).
 */
function installForwardHeaders(ses) {
  try {
    ses.webRequest.onBeforeSendHeaders(
      { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
      (details, callback) => {
        const headers = details.requestHeaders
        if (options.frameOrigin === 'shell') headers.Origin = 'dsh-app://app'
        if (options.hostCookie) headers.Cookie = options.hostCookie
        callback({ requestHeaders: headers })
      },
    )
  } catch (err) {
    fail(`could not install the forward-header hook: ${err.message}`)
  }
}

/**
 * Self-check that the forwarded Origin header really leaves the process: a
 * loopback echo server is fetched once. Chromium refuses some loopback ports, so
 * a failed echo is a harness note rather than a verdict - the forwarded workbench
 * page loading at all is the real evidence.
 */
async function originSelfCheck() {
  const attempts = []
  for (const wanted of [0, 34567, 45123]) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Never echo credential material: only whether a cookie was present and how
      // long it was (the report must stay free of cookie values).
      res.end(
        JSON.stringify({
          origin: req.headers.origin || null,
          cookiePresent: Boolean(req.headers.cookie),
          cookieBytes: req.headers.cookie ? String(req.headers.cookie).length : 0,
        }),
      )
    })
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(wanted, '127.0.0.1', resolve)
      })
      const port = server.address().port
      const response = await fetchUpstream(`http://127.0.0.1:${port}/echo`, {
        headers: { 'x-harness': 'self-check', ...shellForwardHeaders() },
      })
      const echoed = await response.json()
      attempts.push({ port, echoed })
      if (echoed.origin === 'dsh-app://app') {
        report.originSelfCheck = { delivered: true, port, echoed }
        log(`self-check forwarded-request Origin: dsh-app://app delivered (echo port ${port})`)
        return
      }
    } catch (err) {
      attempts.push({ error: err.message })
    } finally {
      server.close()
      server.closeAllConnections?.()
    }
  }
  report.originSelfCheck = { delivered: false, attempts }
  log(`WARN origin self-check could not confirm the Origin header: ${JSON.stringify(attempts)}`)
}

/* ------------------------------------------------------------------ */
/* 4. dsh-app:// protocol handler (shell semantics)                    */
/* ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'host',
  'accept-encoding',
  'cookie',
  'origin',
  'referer',
])

function harnessDocument(hostBase) {
  const frameSrc = options.frameOrigin === 'http' ? `${hostBase}/overleaf-proxy/` : '/overleaf-proxy/'
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>dsh-overleaf desktop shell harness</title><script>${SOCKET_TAP_SOURCE}</script></head>
<body>
<iframe id="station" src="${frameSrc}" style="width:1200px;height:800px;border:0"></iframe>
<script>
  window.__dshHarness = { frameSrc: ${JSON.stringify(frameSrc)} }
  var station = document.getElementById('station')
  station.addEventListener('load', function () { window.__dshHarness.loaded = true })
</script>
</body>
</html>`
}

function negativeControlFragment() {
  // Emulate the pre-fix bridge at the exact seam the defect lived in: the site
  // builds a polluted WebSocket URL from `location` and the bridge used to pass
  // it through untouched. A fresh same-origin frame has its own unpatched
  // WebSocket, so restoring it reproduces "unfixed URL allowed out".
  return `
;(function () {
  try {
    var probe = document.createElement('iframe')
    probe.style.cssText = 'display:none;width:0;height:0;border:0'
    document.documentElement.appendChild(probe)
    var pristine = probe.contentWindow && probe.contentWindow.WebSocket
    if (probe.parentNode) probe.parentNode.removeChild(probe)
    if (typeof pristine === 'function') {
      window.WebSocket = pristine
      document.documentElement.setAttribute('data-dsh-overleaf-negative-control', 'pristine-websocket')
    }
  } catch (err) {}
})()
`
}

async function forwardToHost(request, url, hostBase) {
  const target = new URL(`${url.pathname}${url.search}`, hostBase)
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers.set(key, value)
  }
  const init = { method: request.method, headers }
  if (options.frameOrigin === 'shell') headers.set('origin', 'dsh-app://app')
  if (options.hostCookie) headers.set('cookie', options.hostCookie)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Buffer.from(await request.arrayBuffer())
  }
  let upstream
  try {
    upstream = await fetchUpstream(target.toString(), { ...init, redirect: 'manual' })
  } catch (err) {
    recordTarget(target.toString(), 'fetch')
    return new Response(`harness forward failed: ${err.message}`, { status: 502 })
  }
  const location = upstream.headers.get('location')
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    // Hand the redirect back to the frame exactly like the shell does; the next
    // dsh-app:// request comes through this handler again (no internal following,
    // so the frame URL tracks the real proxied path).
    recordTarget(new URL(location, target).toString(), 'fetch')
    if (report.forwardSamples.length < 30) {
      report.forwardSamples.push({
        method: request.method,
        path: `${target.pathname}${target.search}`,
        status: upstream.status,
        location,
        document: true,
        bytes: 0,
        hasBridgeTag: null,
        head: null,
      })
    }
    return new Response(null, { status: upstream.status, headers: { location } })
  }
  const body = Buffer.from(await upstream.arrayBuffer())
  const responseHeaders = new Headers()
  for (const [key, value] of upstream.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    responseHeaders.append(key, value)
  }
  recordTarget(target.toString(), 'fetch')
  if (report.forwardSamples.length < 30) {
    const contentType = String(upstream.headers.get('content-type') || '')
    const isDocument = /text\/html/i.test(contentType)
    report.forwardSamples.push({
      method: request.method,
      path: `${target.pathname}${target.search}`,
      status: upstream.status,
      contentType: contentType || null,
      bytes: body.length,
      document: isDocument,
      hasBridgeTag: isDocument
        ? body.toString('utf8', 0, Math.min(body.length, 200000)).indexOf(BRIDGE_PATH) !== -1
        : null,
      head: isDocument ? body.toString('utf8', 0, 200).replace(/\s+/g, ' ') : null,
    })
  }
  // Deterministic before-page-scripts install: the harness serves these documents
  // itself (protocol handler -> forwardToHost), so the tap becomes the FIRST script
  // of every HTML document. It runs before the bridge and before any other page
  // script, with no CDP timing involved. The tap self-guards, so the CDP and
  // frame-injection attempts below simply become no-ops.
  const servedContentType = String(upstream.headers.get('content-type') || '')
  let servedBody = body
  if (/text\/html/i.test(servedContentType) && request.method !== 'HEAD' && body.length > 0) {
    servedBody = injectSocketTapIntoHtml(body)
  }
  if (/text\/html/i.test(servedContentType)) {
    // Last known status per document path: the sample list is capped, so this map is
    // what `--open-project` reads to prove whether the project route really loaded.
    if (!report.documentStatuses) report.documentStatuses = {}
    report.documentStatuses[`${target.pathname}${target.search}`] = {
      status: upstream.status,
      bytes: body.length,
      hasBridgeTag: body.toString('utf8', 0, Math.min(body.length, 200000)).indexOf(BRIDGE_PATH) !== -1,
    }
  }
  return new Response(servedBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

/**
 * Insert the tap as the first script of a document. Returns a Buffer so the
 * response can be rebuilt without touching unrelated headers (content-length is
 * recomputed by Response).
 */
function injectSocketTapIntoHtml(body) {
  const html = body.toString('utf8')
  const tag = `<script>${SOCKET_TAP_SOURCE}</script>`
  const head = /<head[^>]*>/i.exec(html)
  const output = head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html
  const state = report.socketTap
  if (state) {
    state.htmlInjections = (state.htmlInjections || 0) + 1
    recordSocketMechanism(state, 'html-injection')
  }
  return Buffer.from(output, 'utf8')
}

function installProtocolHandler(ses, hostBase) {
  const handler = async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    recordTarget(request.url, request.method === 'GET' ? 'fetch' : 'other')
    if (url.hostname === 'app' && url.pathname === HARNESS_DOC_PATH) {
      return new Response(harnessDocument(hostBase), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    // The bridge under test comes from this worktree by default, never from the host,
    // so a pre-fix desktop profile junction cannot produce a false negative.
    // `--bridge-source=host` forwards this path to the real host instead: that is the
    // exact configuration the running desktop app serves (host proxy + host bridge +
    // host cookies + host cache behaviour), which is what t15 asks to observe.
    if (url.hostname === 'app' && url.pathname === BRIDGE_PATH) {
      if (options.bridgeSource === 'host') return forwardToHost(request, url, hostBase)
      const body = worktreeBridge || '/* worktree bridge unavailable */'
      return new Response(options.negativeControl ? `${body}\n${negativeControlFragment()}` : body, {
        status: 200,
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      })
    }
    if (url.hostname === 'shell') {
      // `dsh-app://shell/*` is the shell's own document; a minimal stand-in keeps
      // the semantics faithful.
      return new Response(
        '<!doctype html><html><head><title>dsh shell stand-in</title></head><body>shell</body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }
    if (url.hostname !== 'app') {
      // Same as the real shell: only `app` and `shell` are served.
      return new Response('not found', { status: 404 })
    }
    return forwardToHost(request, url, hostBase)
  }
  return ses.protocol.handle('dsh-app', handler)
}

/* ------------------------------------------------------------------ */
/* 5. Network recording: CDP first (authoritative), webRequest second  */
/* ------------------------------------------------------------------ */

function attachNetworkRecorder(webContents, ses) {
  const state = { cdp: false }
  try {
    webContents.debugger.attach('1.3')
    webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.webSocketCreated') {
        recordTarget(params.url, 'websocket')
        return
      }
      if (method === 'Network.webSocketWillSendHandshakeRequest') {
        recordTarget(params.url, 'websocket')
        return
      }
      if (method === 'Network.requestWillBeSent' && params.request) {
        recordTarget(params.request.url, params.type || 'other')
      }
    })
    webContents.debugger.sendCommand('Network.enable').catch((err) => fail(`Network.enable: ${err.message}`))
    state.cdp = true
  } catch (err) {
    fail(`CDP attach failed (falling back to webRequest): ${err.message}`)
  }
  const filters = [
    ['<all_urls>', 'ws://*/*', 'wss://*/*'],
    ['<all_urls>'],
  ]
  for (const urls of filters) {
    try {
      ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
        recordTarget(details.url, details.resourceType || 'other')
        callback({})
      })
      return state
    } catch (err) {
      if (urls.length === 1) fail(`webRequest filter rejected: ${err.message}`)
    }
  }
  return state
}

/* ------------------------------------------------------------------ */
/* 5b. Site socket tap (the site-built socket evidence channel)        */
/*                                                                     */
/* The bridge reports socket.io state for sockets IT constructs, but    */
/* the bridge only ever constructs a socket when the PAGE asks for one, */
/* so `socketio-state` alone cannot tell "the site built a socket" from */
/* "the harness probe built one". This tap is installed through CDP      */
/* `Page.addScriptToEvaluateOnNewDocument` BEFORE any page script (and   */
/* therefore before the bridge), in every frame, and records every       */
/* `new WebSocket(...)` with its URL, a stack hint and a timestamp.      */
/*                                                                       */
/* Classification (never lets the probe fill the site collection):       */
/*   probe  - the harness probe sets __dshHarnessProbeActive             */
/*   bridge - the stack carries only bridge.js / tap frames (a socket    */
/*            the bridge builds on its own; excluded from the site set)  */
/*   site   - anything else, i.e. a construction whose stack still shows */
/*            a page script (the scene's own socket.io client, or the    */
/*            site's socket routed through the bridge)                   */
/* ------------------------------------------------------------------ */

const SOCKET_TAP_SOURCE = `(() => {
  try {
    if (window.__DSH_SHELL_HARNESS_TAP__) return 'already-installed'
    var Native = window.WebSocket
    if (typeof Native !== 'function') return 'no-websocket-constructor'
    var records = []
    function stackFrames() {
      try { return String(new Error().stack || '').split('\\n').slice(1, 7) } catch (err) { return [] }
    }
    function analyseFrames(frames) {
      var hasBridgeFrame = false
      var hasSiteFrame = false
      var hint = frames.join(' | ').slice(0, 900)
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i]
        if (!frame) continue
        if (/bridge\\.js/i.test(frame)) { hasBridgeFrame = true; continue }
        if (/__DSH_SHELL_HARNESS|^\\s*at Tap\\b/.test(frame)) continue
        if (/<anonymous>|eval at|about:blank/.test(frame)) continue
        if (/[a-z][a-z0-9+.-]*:\\/\\//i.test(frame)) hasSiteFrame = true
      }
      return { hint: hint, hasBridgeFrame: hasBridgeFrame, hasSiteFrame: hasSiteFrame }
    }
    function push(entry) {
      try { records.push(entry); if (records.length > 300) records.shift() } catch (err) {}
    }
    function Tap(url, protocols) {
      var analysis = analyseFrames(stackFrames())
      var byProbe = window.__DSH_SHELL_HARNESS_PROBE__ === true
      var debug = window.__DSH_SOCKET_DEBUG_PENDING__ || null
      var entry = {
        url: String(url),
        stackHint: analysis.hint,
        at: Date.now(),
        byProbe: byProbe,
        hasBridgeFrame: analysis.hasBridgeFrame,
        hasSiteFrame: analysis.hasSiteFrame,
        bridgeOnly: !byProbe && analysis.hasBridgeFrame && !analysis.hasSiteFrame,
        rawInput: debug ? debug.rawInput : null,
        debugId: debug ? debug.id : null,
        error: null,
      }
      push(entry)
      var socket
      try {
        socket = protocols === undefined ? new Native(url) : new Native(url, protocols)
      } catch (err) {
        entry.error =
          'WebSocket constructor threw for target ' + String(url) + ': ' + (err && err.message ? err.message : String(err))
        throw err
      }
      if (window.__DSH_SHELL_HARNESS_DEBUG__) {
        // Async failures are what the user actually sees ("connection lost"); capture
        // them with the target URL. Only attached when the debug switch is on.
        try {
          socket.addEventListener('error', function () {
            if (!entry.error) entry.error = 'WebSocket connection to ' + String(url) + ' failed (error event)'
          })
          socket.addEventListener('close', function (event) {
            if (!entry.error && event && event.code !== 1000) {
              entry.error = 'WebSocket connection to ' + String(url) + ' closed (code ' + event.code + ')'
            }
          })
        } catch (err) {}
      }
      return socket
    }
    Tap.prototype = Native.prototype
    try { Object.setPrototypeOf(Tap, Native) } catch (err) {}
    window.WebSocket = Tap
    window.__DSH_SHELL_HARNESS_TAP__ = {
      source: 'page WebSocket constructor tap (CDP, installed before page scripts)',
      records: records,
      probe: function (url) {
        var previous = window.__DSH_SHELL_HARNESS_PROBE__
        window.__DSH_SHELL_HARNESS_PROBE__ = true
        try { return new window.WebSocket(url) } finally { window.__DSH_SHELL_HARNESS_PROBE__ = previous }
      },
    }
    return 'installed'
  } catch (err) {
    return 'error: ' + (err && err.message ? err.message : String(err))
  }
})()`

async function sendCdpWithTimeout(webContents, method, params, timeoutMs = 5000) {
  let timer = null
  try {
    return await Promise.race([
      webContents.debugger.sendCommand(method, params),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Opt-in debug layer (t15, `--debug-sockets`). Installed ON TOP of the bridge's
 * patched constructor - and only once the bridge is really there - so it sees the
 * CALLER's original value before any rewriting, while the tap underneath still
 * records what the bridge finally handed to the native constructor. Costs nothing
 * unless the switch is on.
 */
const SOCKET_DEBUG_SOURCE = `(() => {
  try {
    if (window.__DSH_SHELL_HARNESS_DEBUG__) return 'already-installed'
    if (!window.__DSH_OVERLEAF_BRIDGE__) return 'bridge-not-ready'
    var Inner = window.WebSocket
    if (typeof Inner !== 'function') return 'no-websocket-constructor'
    var records = []
    var nextId = 1
    function hint() {
      try { return String(new Error().stack || '').split('\\n').slice(1, 6).join(' | ').slice(0, 300) } catch (err) { return '' }
    }
    function DebugSocket(url, protocols) {
      var record = {
        id: nextId++,
        rawInput: String(url),
        initiatorHint: hint(),
        at: Date.now(),
        error: null,
        // The probe marks itself; without this the negative-control path (where the
        // bridge's patch is bypassed and the tap never runs) would mislabel the
        // probe's own construction as a site one.
        byProbe: window.__DSH_SHELL_HARNESS_PROBE__ === true,
      }
      try { records.push(record); if (records.length > 200) records.shift() } catch (err) {}
      window.__DSH_SOCKET_DEBUG_PENDING__ = record
      var socket
      try {
        socket = protocols === undefined ? new Inner(url) : new Inner(url, protocols)
      } catch (err) {
        record.error = 'WebSocket constructor threw for target ' + String(url) + ': ' + (err && err.message ? err.message : String(err))
        delete window.__DSH_SOCKET_DEBUG_PENDING__
        throw err
      }
      delete window.__DSH_SOCKET_DEBUG_PENDING__
      try {
        socket.addEventListener('error', function () {
          if (!record.error) record.error = 'WebSocket connection to ' + String(url) + ' failed (error event)'
        })
        socket.addEventListener('close', function (event) {
          if (!record.error && event && event.code !== 1000) {
            record.error = 'WebSocket connection to ' + String(url) + ' closed (code ' + event.code + ')'
          }
        })
      } catch (err) {}
      return socket
    }
    DebugSocket.prototype = Inner.prototype
    try { Object.setPrototypeOf(DebugSocket, Inner) } catch (err) {}
    window.WebSocket = DebugSocket
    window.__DSH_SHELL_HARNESS_DEBUG__ = {
      source: 'debug layer above the bridge WebSocket wrapper (records rawInput before rewriting)',
      records: records,
    }
    return 'installed'
  } catch (err) {
    return 'error: ' + (err && err.message ? err.message : String(err))
  }
})()`

function recordSocketMechanism(state, name) {
  if (!state) return
  if (!Array.isArray(state.mechanisms)) state.mechanisms = []
  if (state.mechanisms.indexOf(name) === -1) state.mechanisms.push(name)
}

/**
 * Collapse the mechanisms that actually took effect into the two auditable result
 * fields (`beforePageScripts`, `mechanism`) plus an honest `source`. Nothing here
 * claims more than what happened: a run that never got in front of the page scripts
 * reports `beforePageScripts: false`, a mechanism named after the fallback and
 * `degraded: true`, and `source` says so explicitly.
 */
function finalizeSocketTapState(state) {
  if (!state) return state
  const mechanisms = Array.isArray(state.mechanisms) ? state.mechanisms : []
  const htmlInjected = mechanisms.indexOf('html-injection') !== -1
  const cdpBefore = mechanisms.indexOf('cdp-add-script-before-load') !== -1
  const cdpAfter = mechanisms.indexOf('cdp-add-script-after-load') !== -1
  const frameInjected = mechanisms.indexOf('frame-injection') !== -1
  state.installed = mechanisms.length > 0
  state.beforePageScripts = htmlInjected || cdpBefore
  state.mechanism = htmlInjected
    ? 'html-injection'
    : cdpBefore
      ? 'cdp-add-script-before-load'
      : cdpAfter
        ? 'cdp-add-script-after-load'
        : frameInjected
          ? 'frame-injection'
          : 'none'
  state.auxiliaryMechanisms = mechanisms.filter((name) => name !== state.mechanism)
  state.degraded = !state.beforePageScripts
  state.source = htmlInjected
    ? 'inline tap injected as the first script of every forwarded document (runs before the bridge and any other page script)'
    : cdpBefore
      ? 'CDP Page.addScriptToEvaluateOnNewDocument, registered before the first document'
      : cdpAfter
        ? 'DEGRADED - CDP registration after load plus frame injection: constructions made by the first page scripts may be missed'
        : frameInjected
          ? 'DEGRADED - frame injection after load only: constructions made by the first page scripts may be missed'
          : 'not installed - no tap mechanism took effect'
  return state
}

/**
 * Register the tap for future documents. This is DELIBERATELY not awaited: the CDP
 * command can stay pending until a page target exists (observed: it never settled
 * before load, and awaiting it hung the whole run until the launcher watchdog killed
 * the child). The registration gets a 1.5 s budget and the run proceeds immediately;
 * the inline document injection above is what actually guarantees `beforePageScripts`.
 */
function installSocketTap(webContents) {
  const state = {
    installed: false,
    beforePageScripts: false,
    attemptedSource: 'CDP Page.addScriptToEvaluateOnNewDocument (attempted before the first document)',
    source: 'pending',
    mechanism: 'none',
    mechanisms: [],
    htmlInjections: 0,
    scriptId: null,
    error: null,
    frameInjections: 0,
    loadStartedAt: null,
  }
  report.socketTap = state
  sendCdpWithTimeout(webContents, 'Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_TAP_SOURCE }, 1500)
    .then((result) => {
      state.scriptId = result && result.identifier ? result.identifier : null
      recordSocketMechanism(state, state.loadStartedAt === null ? 'cdp-add-script-before-load' : 'cdp-add-script-after-load')
      log(`site socket tap CDP registration settled (${state.scriptId || 'no identifier'})`)
    })
    .catch((err) => {
      state.error = err.message
      log(`site socket tap CDP registration did not settle: ${err.message} (inline/frame injection in use)`)
    })
  return state
}

/**
 * Second registration attempt once the page target exists. The pre-load attempt can
 * time out (no document yet), the post-load one normally succeeds and then covers
 * documents created later. It can never make `beforePageScripts` true.
 */
async function retrySocketTapRegistration(webContents) {
  const state = report.socketTap || { frameInjections: 0 }
  try {
    const result = await sendCdpWithTimeout(webContents, 'Page.addScriptToEvaluateOnNewDocument', {
      source: SOCKET_TAP_SOURCE,
    })
    state.scriptId = result && result.identifier ? result.identifier : state.scriptId || null
    recordSocketMechanism(state, 'cdp-add-script-after-load')
    log(`site socket tap registered after load (${state.scriptId || 'no identifier'})`)
  } catch (err) {
    state.retryError = err.message
    log(`site socket tap post-load registration failed: ${err.message}`)
  }
  report.socketTap = state
  return state
}

/**
 * Fallback / reinforcement: inject the tap into every frame that exists right now.
 * Safe to call repeatedly (the tap self-guards with an `already-installed` return).
 * It wraps whichever WebSocket constructor the frame currently exposes, so
 * page-level constructions are still recorded with their own stack even when the
 * bridge patched first - but it runs after load, so it counts as a degraded path.
 */
async function injectSocketTapIntoFrames(webContents, state) {
  const frames = descendantFrames(webContents.mainFrame)
  let injected = 0
  for (const frame of frames) {
    try {
      const result = await frame.executeJavaScript(SOCKET_TAP_SOURCE, false)
      if (result === 'installed' || result === 'already-installed') injected += 1
    } catch (err) {
      /* frame has no JS context yet or navigated away */
    }
  }
  if (state) {
    state.frameInjections += injected
    if (injected > 0) recordSocketMechanism(state, 'frame-injection')
  }
  return injected
}

/** Inject the opt-in debug layer into every frame that exists right now (debug only). */
async function injectSocketDebugIntoFrames(webContents) {
  if (!options.debugSockets) return 0
  const frames = descendantFrames(webContents.mainFrame)
  let injected = 0
  for (const frame of frames) {
    try {
      const result = await frame.executeJavaScript(SOCKET_DEBUG_SOURCE, false)
      if (result === 'installed' || result === 'already-installed') injected += 1
    } catch (err) {
      /* frame has no JS context yet or navigated away */
    }
  }
  if (injected > 0 && report.socketTap) {
    report.socketTap.debugLayerInjections = (report.socketTap.debugLayerInjections || 0) + injected
  }
  return injected
}

/**
 * Compose the per-construction debug list (debug switch only). The debug layer
 * supplies `rawInput`/`initiatorHint` (the caller's value before any rewriting) and
 * the tap underneath supplies `normalized` (= routeSocketUrl output, i.e. what the
 * bridge produced) and `resolved` (= the string really handed to the native
 * constructor), plus any error text with its target URL.
 */
async function collectSocketDebug(webContents) {
  const frames = descendantFrames(webContents.mainFrame)
  const entries = []
  for (const frame of frames) {
    let debugRecords = null
    let tapRecords = []
    try {
      const raw = await frame.executeJavaScript(
        `(() => {
          const debug = window.__DSH_SHELL_HARNESS_DEBUG__
          const tap = window.__DSH_SHELL_HARNESS_TAP__
          return JSON.stringify({ debug: debug ? debug.records : null, tap: tap ? tap.records : [] })
        })()`,
        false,
      )
      if (raw) {
        const parsed = JSON.parse(raw)
        debugRecords = parsed.debug
        tapRecords = parsed.tap || []
      }
    } catch (err) {
      continue
    }
    if (!debugRecords) continue
    const byId = new Map()
    for (const tapRecord of tapRecords) {
      if (tapRecord.debugId !== null && tapRecord.debugId !== undefined) byId.set(tapRecord.debugId, tapRecord)
    }
    const covered = new Set()
    for (const record of debugRecords) {
      const tapRecord = byId.get(record.id) || null
      if (tapRecord) covered.add(record.id)
      entries.push({
        class: tapRecord ? classifySocketConstruction(tapRecord) : record.byProbe === true ? 'probe' : 'site',
        rawInput: record.rawInput,
        usedNativePath: Boolean(tapRecord),
        normalized: tapRecord ? tapRecord.url : null,
        resolved: tapRecord ? tapRecord.url : record.rawInput,
        initiatorHint: String(record.initiatorHint || '').slice(0, 300),
        error: (tapRecord && tapRecord.error) || record.error || null,
        at: record.at,
        frameUrl: frame.url,
      })
    }
    // Constructions that never passed through the debug layer (made before it was
    // installed, or bridge-internal ones): reported with rawInput null rather than
    // dropped, so nothing is silently invisible.
    for (const tapRecord of tapRecords) {
      const hasDebugId = tapRecord.debugId !== null && tapRecord.debugId !== undefined
      if (hasDebugId) continue
      entries.push({
        class: classifySocketConstruction(tapRecord),
        rawInput: null,
        usedNativePath: true,
        normalized: tapRecord.url,
        resolved: tapRecord.url,
        initiatorHint: String(tapRecord.stackHint || '').slice(0, 300),
        error: tapRecord.error || null,
        at: tapRecord.at,
        frameUrl: frame.url,
      })
    }
  }
  return entries
}

function classifySocketConstruction(entry) {
  // Deterministic attribution, decided in the page at construction time:
  //   byProbe    - the harness probe set __DSH_SHELL_HARNESS_PROBE__
  //   bridgeOnly - the stack carries a bridge.js frame and no page-script frame
  // Everything else is a page-initiated construction. No URL/timestamp guessing.
  if (!entry) return 'bridge'
  if (entry.byProbe === true) return 'probe'
  if (entry.bridgeOnly === true) return 'bridge'
  return 'site'
}

async function collectSocketEvidence(webContents) {
  const frames = descendantFrames(webContents.mainFrame)
  const tapped = []
  const framesTapped = []
  for (const frame of frames) {
    try {
      const raw = await frame.executeJavaScript(
        `(() => {
          const tap = window.__DSH_SHELL_HARNESS_TAP__
          if (!tap) return null
          return JSON.stringify({ source: tap.source, records: tap.records })
        })()`,
        false,
      )
      if (!raw) continue
      const parsed = JSON.parse(raw)
      framesTapped.push(frame.url)
      for (const entry of parsed.records || []) tapped.push({ ...entry, frameUrl: frame.url })
    } catch (err) {
      /* frame navigated away or has no tap: it simply contributes nothing */
    }
  }
  const probeSocket = tapped.filter((entry) => classifySocketConstruction(entry) === 'probe')
  const bridgeSocket = tapped.filter((entry) => classifySocketConstruction(entry) === 'bridge')
  const siteSocket = tapped.filter((entry) => classifySocketConstruction(entry) === 'site')
  return { tapped, siteSocket, probeSocket, bridgeSocket, framesTapped, framesSeen: frames.length }
}

function socketCollection(state, entries, source) {
  const urls = []
  for (const entry of entries) {
    if (entry && entry.url && urls.indexOf(entry.url) === -1) urls.push(entry.url)
  }
  return {
    source,
    observed: entries.length > 0,
    count: entries.length,
    urls,
    constructions: entries.map((entry) => ({
      url: entry.url,
      at: entry.at,
      frameUrl: entry.frameUrl,
      byProbe: entry.byProbe === true,
      hasBridgeFrame: entry.hasBridgeFrame === true,
      hasSiteFrame: entry.hasSiteFrame === true,
      bridgeOnly: entry.bridgeOnly === true,
      stackHint: String(entry.stackHint || '').slice(0, 300),
    })),
    state,
  }
}

/* ------------------------------------------------------------------ */
/* 6. Frame sampling                                                   */
/* ------------------------------------------------------------------ */

const SAMPLE_SCRIPT = `(() => {
  const el = document.documentElement
  const attrs = {}
  if (el && el.attributes) {
    for (const attribute of el.attributes) {
      if (attribute.name.indexOf('data-dsh-overleaf-') === 0) {
        attrs[attribute.name.slice('data-dsh-overleaf-'.length)] = attribute.value
      }
    }
  }
  let stationAccessible = null
  let stationAttrs = null
  try {
    const station = document.getElementById('station')
    if (station && station.contentDocument) {
      stationAccessible = true
      const inner = station.contentDocument.documentElement
      stationAttrs = {}
      if (inner && inner.attributes) {
        for (const attribute of inner.attributes) {
          if (attribute.name.indexOf('data-dsh-overleaf-') === 0) {
            stationAttrs[attribute.name.slice('data-dsh-overleaf-'.length)] = attribute.value
          }
        }
      }
    }
  } catch (err) { stationAccessible = false }
  return JSON.stringify({
    attrs, stationAttrs, stationAccessible,
    href: location.href, protocol: location.protocol, host: location.host,
    hostname: location.hostname, origin: location.origin,
    readyState: document.readyState, title: document.title,
    base: (document.querySelector('base') || {}).href || null,
    scriptSrcs: [].map.call(document.querySelectorAll('script[src]'), (node) => node.getAttribute('src')).slice(0, 6),
    bodyText: (document.body ? document.body.innerText : '').slice(0, 160),
    htmlHead: String(document.documentElement ? document.documentElement.outerHTML : '').slice(0, 240),
  })
})()`

function descendantFrames(root) {
  const out = []
  const walk = (frame) => {
    out.push(frame)
    let children = []
    try {
      children = typeof frame.frames === 'function' ? frame.frames() : (frame.frames || [])
    } catch {
      children = []
    }
    for (const child of children || []) walk(child)
  }
  walk(root)
  return out
}

function looksLikeStation(frameUrl) {
  if (typeof frameUrl !== 'string') return false
  return frameUrl.indexOf('/overleaf-proxy') !== -1
}

// Independent of the site's own boot sequence: create a shell-shaped WebSocket
// target inside the workbench frame and see what the bridge turns it into. The
// tunnel records the attempt and the upstream socket.io answers, so this proves
// routing + tunnel + handshake even when the site's own API calls are broken for
// unrelated reasons. The socket is deliberately left open (closing it would make
// the bridge report ws-state=closed and mask the result), and the report marks
// this evidence as probe-sourced so it is never mistaken for the site's socket.
const PROBE_WS_URL = 'ws://dsh-app/socket.io/?EIO=4&transport=websocket'
const PROBE_SCRIPT = `(() => {
  try {
    const tap = window.__DSH_SHELL_HARNESS_TAP__
    window.__DSH_SHELL_HARNESS_PROBE__ = true
    let socket
    try {
      socket = tap && typeof tap.probe === 'function'
        ? tap.probe(${JSON.stringify(PROBE_WS_URL)})
        : new WebSocket(${JSON.stringify(PROBE_WS_URL)})
    } finally {
      window.__DSH_SHELL_HARNESS_PROBE__ = false
    }
    window.__dshHarnessProbeSocket = socket
    socket.addEventListener('open', () => {
      try { socket.send('40') } catch (err) {}
    })
    socket.addEventListener('error', () => {})
    return 'created'
  } catch (err) {
    return 'error: ' + (err && err.message ? err.message : String(err))
  }
})()`

async function runSocketProbe(webContents) {
  const frames = descendantFrames(webContents.mainFrame)
  const station = frames.find((frame) => looksLikeStation(frame.url)) || webContents.mainFrame
  try {
    const result = await station.executeJavaScript(PROBE_SCRIPT, false)
    return { frameUrl: station.url, result, evidenceSource: 'harness in-page probe (site socket not required)' }
  } catch (err) {
    return { frameUrl: station.url, error: err.message }
  }
}

async function sampleFrame(webContents) {
  const frames = descendantFrames(webContents.mainFrame)
  const station = frames.find((frame) => looksLikeStation(frame.url))
  const frame = station || webContents.mainFrame
  let payload = null
  try {
    const raw = await frame.executeJavaScript(SAMPLE_SCRIPT, false)
    payload = JSON.parse(raw)
  } catch (err) {
    return { at: Date.now(), frameUrl: frame.url, error: err.message }
  }
  payload.at = Date.now()
  payload.frameUrl = frame.url
  payload.frameCount = frames.length
  payload.isStation = Boolean(station)
  return payload
}

/**
 * Optional credentialed / project-open mode (t14): point the station iframe at a
 * real project route so the site boots past its landing page, and count what the
 * site's own socket does. The session may carry a cookie supplied through
 * --cookie / --cookie-file / --host-cookie; the harness NEVER reads the host's
 * cookie store itself (non-interference rule above), and the cookie value never
 * appears in a log line, in the report, or in any committed file - only
 * `cookieProvided` / `cookieSource` metadata is recorded.
 *
 * Target shape: a bare id becomes `/overleaf-proxy/console/<id>`, which is the
 * site's own project route (verified against the host proxy: `/console/<id>` serves
 * the bridged HTML while the legacy `/project/<id>` shape 404s). An explicit path
 * or absolute URL is used exactly as passed.
 */
async function maybeOpenProject(webContents) {
  const requested = options.openProject
  if (!requested) return null
  const target =
    requested.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:\/\//i.test(requested)
      ? requested
      : `/overleaf-proxy/console/${requested}`
  let result
  try {
    result = await webContents.mainFrame.executeJavaScript(
      `(() => {
        const station = document.getElementById('station')
        if (!station) return 'no-station-frame'
        station.src = ${JSON.stringify(target)}
        return station.src
      })()`,
      false,
    )
  } catch (err) {
    result = `error: ${err.message}`
  }
  log(`open-project: ${target} (station navigation: ${JSON.stringify(result)})`)
  // Re-collect from the frame that actually navigated: the landing page's samples
  // are stale the moment the project route loads, so they must never feed the verdict.
  const loaded = await waitForStationFrame(webContents, target)
  const forward = (report.forwardSamples || [])
    .filter((entry) => entry.document && entry.path === target)
    .pop()
  const documented = report.documentStatuses ? report.documentStatuses[target] : null
  report.openProject = {
    requested,
    target,
    result,
    cookieProvided: Boolean(options.hostCookie),
    cookieSource: options.cookieSource || '',
    frameUrl: loaded ? loaded.frameUrl : null,
    readyState: loaded ? loaded.readyState : null,
    title: loaded ? loaded.title : null,
    bridgeAttribute: loaded ? loaded.bridge : null,
    bridgeScriptTag: loaded ? loaded.hasBridge : null,
    documentStatus: documented ? documented.status : forward ? forward.status : null,
    documentBytes: documented ? documented.bytes : forward ? forward.bytes : null,
    documentHasBridgeTag: documented
      ? documented.hasBridgeTag
      : forward
        ? forward.hasBridgeTag
        : null,
    documentLoaded: Boolean(loaded && loaded.readyState === 'complete' && loaded.hasBridge),
  }
  log(
    `open-project loaded: frame=${report.openProject.frameUrl} status=${report.openProject.documentStatus} ` +
      `readyState=${report.openProject.readyState} bridge=${JSON.stringify(report.openProject.bridgeAttribute)} ` +
      `bridgeScript=${report.openProject.bridgeScriptTag}`,
  )
  await delay(3000)
  return report.openProject
}

/**
 * Wait until the station frame carries the requested route and finished its document
 * load, re-reading the bridge attributes from THAT frame. Returns the last partial
 * observation instead of throwing; a non-2xx route shows up as `documentStatus` on
 * the forwarded sample list, so a 404 project route can never masquerade as a
 * loaded project.
 */
async function waitForStationFrame(webContents, pathFragment, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  // Do not accept "some station frame" while the requested route is still loading:
  // the landing page matches looksLikeStation() too, and accepting it would record
  // the console page as if the project had opened.
  const fallbackAt = Date.now() + 6000
  let last = null
  while (Date.now() < deadline) {
    const frames = descendantFrames(webContents.mainFrame)
    const exact = frames.find((frame) => String(frame.url).indexOf(pathFragment) !== -1)
    const station = exact || (Date.now() > fallbackAt ? frames.find((frame) => looksLikeStation(frame.url)) : null)
    if (station) {
      try {
        const info = JSON.parse(
          await station.executeJavaScript(
            `JSON.stringify({
              href: location.href,
              readyState: document.readyState,
              title: document.title,
              hasBridge: Boolean(document.querySelector('script[src*="bridge.js"]')),
              bridge: (document.documentElement && document.documentElement.getAttribute('data-dsh-overleaf-bridge')) || null,
            })`,
            false,
          ),
        )
        last = { frameUrl: station.url, ...info }
        if (info.readyState === 'complete' && info.hasBridge) return last
      } catch (err) {
        /* frame is mid-navigation */
      }
    }
    await delay(400)
  }
  return last
}

function messagesOf(sample) {
  const attrs = sample && sample.attrs ? sample.attrs : {}
  const value = Number.parseInt(attrs['ws-messages'], 10)
  return Number.isFinite(value) ? value : null
}

function attributeMap(sample) {
  const attrs = {}
  if (sample && sample.attrs) Object.assign(attrs, sample.attrs)
  if (sample && !sample.isStation && sample.stationAttrs) Object.assign(attrs, sample.stationAttrs)
  return attrs
}

/* ------------------------------------------------------------------ */
/* 7. Main                                                            */
/* ------------------------------------------------------------------ */

function satisfiedPositive(attrs, tunnelPort) {
  return (
    attrs.bridge === 'ready' &&
    String(attrs['ws-target'] || '').startsWith(`127.0.0.1:${tunnelPort}`) &&
    attrs['ws-state'] === 'open' &&
    attrs['socketio-state'] === 'connected'
  )
}

async function main() {
  log(`electron ${process.versions.electron} / node ${process.versions.node}, profile ${userDataDir}`)
  log(`host 127.0.0.1:${options.hostPort}, frame origin mode ${options.frameOrigin}, mode ${report.mode}`)
  log(`self-check report path (absolute): ${report.report}`)
  log(`self-check electronRunAsNodeBeforeClearing: ${report.environment.electronRunAsNodeBeforeClearing}`)

  // One session for protocol handling, request recording and the Origin hook used
  // by the renderer's own requests.
  const ses = session.fromPartition('dsh-overleaf-shell-harness')
  harnessFetch =
    typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : electron.net.fetch
  installForwardHeaders(ses)

  let hostBase = ''
  try {
    hostBase = await preflightHost()
  } catch (err) {
    fail(`precondition: ${err.message}`)
    log('start the DeepSeek Harness desktop app first, then rerun the harness')
    report.assertions.push({ criterion: 'host reachable', status: 'failed', evidence: err.message })
    return EXIT_PRECONDITION
  }
  report.hostBase = hostBase
  log(
    `host ready: proxy page ${report.proxiedBytes} bytes, bridge tag ${report.proxiedHasBridgeTag}, ` +
      `tunnel port ${report.tunnelPortFromPage}`,
  )

  await startupSelfCheck(hostBase)
  if (!report.selfCheck.worktreeBridgeHasShellHandling) {
    log(
      'note: the worktree bridge does not look shell-aware yet - the positive run is expected to fail until the fix is built here',
    )
  }
  await originSelfCheck()

  const tunnelPort = options.wsPort || report.tunnelPortFromPage
  if (!tunnelPort) {
    fail('precondition: no __DSH_OVERLEAF_WS_PORT__ in the proxied page and no --ws-port override')
    report.assertions.push({ criterion: 'tunnel port known', status: 'failed', evidence: 'missing' })
    return EXIT_PRECONDITION
  }
  report.tunnelPort = tunnelPort
  log(`tunnel port under test: ${tunnelPort}`)

  installProtocolHandler(ses, hostBase)

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    title: 'dsh-overleaf shell harness (hidden)',
    webPreferences: {
      partition: 'dsh-overleaf-shell-harness',
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.on('console-message', (...args) => {
    const details =
      args.length >= 5 ? { level: args[1], message: args[2], line: args[3], source: args[4] } : args[0] || {}
    const message = String(details.message || '').slice(0, 400)
    if (!message) return
    report.consoleMessages.push({ level: details.level, message, source: String(details.source || '').slice(0, 200) })
    if (report.consoleMessages.length > 200) report.consoleMessages.shift()
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    report.errors.push(`did-fail-load ${code} ${description} ${url} mainFrame=${isMainFrame}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    fail(`renderer gone: ${JSON.stringify(details)}`)
  })
  attachNetworkRecorder(window.webContents, ses)
  // Fired, never awaited: a CDP command that stays pending must not delay the run
  // (see installSocketTap). The frame injection below covers the frames anyway.
  installSocketTap(window.webContents)
  // Reinforcement for frames the CDP registration cannot reach (or when it did not
  // take): inject as soon as a frame navigates, and again after load.
  window.webContents.on('did-frame-navigate', () => {
    injectSocketTapIntoFrames(window.webContents, report.socketTap).catch(() => {})
    injectSocketDebugIntoFrames(window.webContents).catch(() => {})
  })

  const frameUrl =
    options.frameOrigin === 'http' ? `${hostBase}/overleaf-proxy/` : `dsh-app://app${HARNESS_DOC_PATH}`
  log(`loading ${frameUrl}`)
  if (report.socketTap) report.socketTap.loadStartedAt = Date.now()
  try {
    await window.loadURL(frameUrl)
  } catch (err) {
    fail(`loadURL failed: ${err.message}`)
  }
  await injectSocketTapIntoFrames(window.webContents, report.socketTap)
  await retrySocketTapRegistration(window.webContents)
  await maybeOpenProject(window.webContents)
  // Debug layer goes in after the bridge has patched (it returns 'bridge-not-ready'
  // otherwise and is retried at every later injection point).
  await injectSocketDebugIntoFrames(window.webContents)

  const deadline = Date.now() + options.timeoutSec * 1000
  const settleMs = options.settleSec * 1000
  let connectedSample = null
  let connectedMessages = null
  let growthObserved = false
  let lastSample = null
  let settleDeadline = 0
  let probeRun = false
  // With --open-project the landing page's bridge attributes are gone, so the probe
  // is also forced once the project route has had time to boot: it must run against
  // the CURRENT station frame and never silently end as probe=null.
  const probeFallbackAt = report.openProject ? Date.now() + 8000 : 0

  while (Date.now() < deadline) {
    const sample = await sampleFrame(window.webContents)
    report.samples.push(sample)
    if (!sample.error) lastSample = sample
    const attrs = attributeMap(sample)
    const messages = messagesOf(sample)
    const target = attrs['ws-target'] || ''
    if (!probeRun && (attrs.bridge === 'ready' || (probeFallbackAt !== 0 && Date.now() > probeFallbackAt))) {
      probeRun = true
      const probeTrigger = attrs.bridge === 'ready' ? 'bridge-ready' : 'open-project-fallback'
      report.socketProbe = { url: PROBE_WS_URL, trigger: probeTrigger, ...(await runSocketProbe(window.webContents)) }
      log(`socket probe: ${JSON.stringify(report.socketProbe)}`)
      await delay(1500)
      continue
    }
    const fullyConnected =
      attrs.bridge === 'ready' &&
      target.startsWith(`127.0.0.1:${tunnelPort}`) &&
      attrs['ws-state'] === 'open' &&
      attrs['socketio-state'] === 'connected' &&
      messages !== null
    if (fullyConnected) {
      if (!connectedSample) {
        connectedSample = sample
        connectedMessages = messages
        settleDeadline = Date.now() + settleMs
        log(`connected at sample ${report.samples.length}: ${JSON.stringify(attrs)}`)
      } else if (messages !== null && connectedMessages !== null && messages > connectedMessages) {
        growthObserved = true
        log(`ws-messages grew ${connectedMessages} -> ${messages}`)
        break
      }
    }
    if (connectedSample && settleDeadline && Date.now() > settleDeadline) break
    await delay(400)
  }

  if (connectedSample && !growthObserved) {
    // One last look: a quiet settle window must not become a false failure.
    const sample = await sampleFrame(window.webContents)
    report.samples.push(sample)
    const messages = messagesOf(sample)
    if (messages !== null && connectedMessages !== null && messages > connectedMessages) growthObserved = true
  }

  const finalAttrs = attributeMap(lastSample || {})
  // Frozen-key contract: the verdict-time frame, with the six keys always present.
  report.diagnostics = {}
  for (const key of DIAGNOSTIC_KEYS) {
    report.diagnostics[key] = finalAttrs[key] === undefined ? null : finalAttrs[key]
  }
  for (const [key, value] of Object.entries(finalAttrs)) {
    if (report.diagnostics[key] === undefined) report.diagnostics[key] = value
  }
  report.frame = lastSample
    ? {
        url: lastSample.frameUrl,
        href: lastSample.href,
        protocol: lastSample.protocol,
        host: lastSample.host,
        origin: lastSample.origin,
        title: lastSample.title,
        attrs: finalAttrs,
      }
    : null

  const polluted = [...networkTargets.values()]
    .map((entry) => ({ entry, pattern: pollutionOf(entry.url) }))
    .filter(({ pattern }) => pattern !== null)
    .map(({ entry, pattern }) => ({ url: entry.url, kind: entry.kind, count: entry.count, pattern }))
  report.polluted = polluted
  // Legit traffic from OTHER shell plugins (e.g. ws://app/sidebar/ws/...) must stay
  // pass-through: recorded, reported, never counted as pollution.
  report.otherPluginShellTraffic = [...networkTargets.values()]
    .filter((entry) => !isPluginRelatedUrl(entry.url) && POLLUTED_PATTERNS.some((pattern) => pattern.test(entry.url)))
    .map((entry) => entry.url)
  const socketRequests = [...networkTargets.values()].filter((entry) => entry.kind === 'websocket')
  const tunnelSocketRequests = socketRequests.filter((entry) => /^wss?:\/\/127\.0\.0\.1:\d+/i.test(entry.url))
  const probeRoutedToTunnel = report.requestTimeline.some(
    (entry) =>
      entry.kind === 'websocket' &&
      entry.url.indexOf(`127.0.0.1:${tunnelPort}`) !== -1 &&
      entry.url.indexOf('/socket.io') !== -1,
  )
  const probePolluted = report.requestTimeline.some(
    (entry) =>
      entry.kind === 'websocket' &&
      (entry.url.startsWith('ws://dsh-app') || entry.url.startsWith('ws://app')),
  )
  report.probeRoutedToTunnel = probeRoutedToTunnel
  report.probePolluted = probePolluted
  report.websocketRequests = socketRequests.map((entry) => ({ url: entry.url, kind: entry.kind, count: entry.count }))
  report.tunnelSocketRequests = tunnelSocketRequests.map((entry) => entry.url)
  report.websocketTargets = socketRequests.map((entry) => `${entry.url} x${entry.count}`)
  report.tunnelHits = [...networkTargets.values()]
    .filter((entry) => entry.url.indexOf(`127.0.0.1:${tunnelPort}`) !== -1)
    .map((entry) => ({ url: entry.url, kind: entry.kind, count: entry.count }))
  report.cleanShellDocs = [...networkTargets.values()]
    .filter((entry) => /^dsh-app:\/\/app(?:[:/]|$)/i.test(entry.url))
    .map((entry) => ({ url: entry.url, kind: entry.kind, count: entry.count }))

  // Site-built socket evidence: a second, independent channel that never borrows
  // from the harness probe. Empty here means "no site-built socket observed".
  await injectSocketTapIntoFrames(window.webContents, report.socketTap)
  await injectSocketDebugIntoFrames(window.webContents)
  const socketEvidence = await collectSocketEvidence(window.webContents)
  // Finalize the tap state first: `installed` / `beforePageScripts` / `mechanism`
  // are derived from the mechanisms that actually took effect, and the socket
  // collections below read that same verdict (never a second, disagreeing copy).
  report.socketTap = finalizeSocketTapState({
    ...report.socketTap,
    framesInjected: socketEvidence.framesTapped,
    framesSeen: socketEvidence.framesSeen,
    totalConstructions: socketEvidence.tapped.length,
    siteConstructions: socketEvidence.siteSocket.length,
    probeConstructions: socketEvidence.probeSocket.length,
    bridgeConstructions: socketEvidence.bridgeSocket.length,
  })
  const tapInstalled = Boolean(report.socketTap.installed)
  report.siteSocket = socketCollection(
    {
      tapInstalled,
      framesInjected: socketEvidence.framesTapped,
      framesSeen: socketEvidence.framesSeen,
    },
    socketEvidence.siteSocket,
    'page WebSocket constructor tap (excludes harness probe and bridge-internal constructions)',
  )
  report.probeSocket = socketCollection({ tapInstalled }, socketEvidence.probeSocket, 'harness in-page probe (socketProbe/PROBE_WS_URL)')
  report.bridgeSocketExcluded = socketCollection({}, socketEvidence.bridgeSocket, 'bridge-internal constructions excluded from siteSocket (stack carries only bridge.js frames)')
  log(
    `site socket evidence: site=${socketEvidence.siteSocket.length} probe=${socketEvidence.probeSocket.length} ` +
      `bridgeExcluded=${socketEvidence.bridgeSocket.length} framesInjected=${socketEvidence.framesTapped.length} ` +
      `beforePageScripts=${report.socketTap.beforePageScripts} mechanism=${report.socketTap.mechanism}`,
  )

  // Opt-in debug channel (t15): raw input before rewriting, the routed target, real
  // failure text with its URL. Absent entirely unless --debug-sockets is used, so the
  // default report keys stay stable.
  if (options.debugSockets) {
    report.socketDebug = await collectSocketDebug(window.webContents)
    const counts = { site: 0, bridge: 0, probe: 0 }
    for (const entry of report.socketDebug) {
      if (counts[entry.class] !== undefined) counts[entry.class] += 1
    }
    report.socketDebugNote =
      report.socketDebug.length === 0
        ? 'no WebSocket construction captured in any frame: the site built no socket, the bridge built none, and even the harness probe is absent'
        : `${report.socketDebug.length} construction(s): site=${counts.site}, bridge=${counts.bridge}, probe=${counts.probe}`
    log(`socketDebug: ${report.socketDebugNote}`)
    for (const entry of report.socketDebug.slice(0, 8)) {
      log(
        `  socketDebug[${entry.class}] rawInput=${JSON.stringify(entry.rawInput)} normalized=${JSON.stringify(entry.normalized)} ` +
          `resolved=${JSON.stringify(entry.resolved)} usedNativePath=${entry.usedNativePath} error=${JSON.stringify(entry.error)}`,
      )
    }
  }
  if (options.debugSockets || options.bridgeSource === 'host') {
    report.hostSource = {
      hostBase: report.hostBase,
      bridgeSource: options.bridgeSource,
      note:
        options.bridgeSource === 'host'
          ? 'bridge forwarded from the real host (the running desktop app configuration)'
          : 'bridge served from this worktree lib/index.js',
    }
  }

  const assertions = []
  const assert = (criterion, ok, evidence) => {
    assertions.push({ criterion, status: ok ? 'passed' : 'failed', evidence })
    log(`${ok ? 'PASS' : 'FAIL'} ${criterion}${evidence ? ` - ${evidence}` : ''}`)
  }

  if (options.negativeControl) {
    // Falsifiability check: with the pre-fix behaviour emulated the harness MUST
    // fail. The positive assertion set below is still evaluated on purpose, so a
    // negative-control run is expected to end with verdict="fail" and exit 1; a
    // pass here would mean the harness cannot see the defect at all.
    assert(
      'negative control: the pre-fix symptom is observable (polluted WebSocket target or no connection)',
      polluted.length > 0 || probePolluted || !connectedSample,
      polluted.length > 0
        ? `polluted targets: ${polluted.slice(0, 4).map((entry) => entry.url).join(', ')}`
        : `probePolluted=${probePolluted} ws-state=${JSON.stringify(finalAttrs['ws-state'])} bridge=${JSON.stringify(finalAttrs.bridge)}`,
    )
    log(`negative control: fixed-bridge criteria satisfied=${satisfiedPositive(finalAttrs, tunnelPort)} (must be false)`)
  }

  // The positive assertion set runs in both modes (see the falsifiability note
  // above); a bare block keeps its scope separate from the negative-control check.
  {
    assert(
      'frame document runs on the custom scheme (dsh-app://app/...)',
      options.frameOrigin === 'http'
        ? Boolean(lastSample && lastSample.protocol === 'http:')
        : Boolean(lastSample && lastSample.protocol === 'dsh-app:' && lastSample.host === 'app'),
      `frame ${lastSample ? `${lastSample.protocol}//${lastSample.host}` : 'missing'}`,
    )
    assert(
      'bridge injected in the workbench frame (data-dsh-overleaf-bridge=ready)',
      finalAttrs.bridge === 'ready',
      `bridge=${JSON.stringify(finalAttrs.bridge)}`,
    )
    assert(
      `WebSocket went to the loopback tunnel (127.0.0.1:${tunnelPort})`,
      String(finalAttrs['ws-target'] || '').startsWith(`127.0.0.1:${tunnelPort}`),
      `ws-target=${JSON.stringify(finalAttrs['ws-target'])}`,
    )
    assert(
      'socket stayed open (data-dsh-overleaf-ws-state=open)',
      finalAttrs['ws-state'] === 'open',
      `ws-state=${JSON.stringify(finalAttrs['ws-state'])}`,
    )
    assert(
      'socket.io handshake completed (data-dsh-overleaf-socketio-state=connected)',
      finalAttrs['socketio-state'] === 'connected',
      `socketio-state=${JSON.stringify(finalAttrs['socketio-state'])}`,
    )
    assert(
      'socket.io messages were received (data-dsh-overleaf-ws-messages grows)',
      growthObserved,
      `ws-messages ${connectedMessages === null ? 'n/a' : connectedMessages} -> ${messagesOf(lastSample || {})}`,
    )
    assert(
      'no polluted URL in any recorded WebSocket/fetch/XHR target',
      polluted.length === 0,
      polluted.length === 0
        ? 'clean'
        : polluted
            .slice(0, 5)
            .map((entry) => `${entry.url} (${entry.pattern})`)
            .join(', '),
    )
    assert(
      'independent in-page probe: the bridge rewrote a shell-shaped ws:// URL onto the tunnel',
      probeRoutedToTunnel,
      `probe=${JSON.stringify(report.socketProbe || null)} probeRoutedToTunnel=${probeRoutedToTunnel}`,
    )
    // Attribution gate: the probe proves the bridge+tunnel path, NOT that the site
    // connected. This assertion is the only one allowed to speak for the site and
    // it reads the constructor tap exclusively (never socketProbe/diagnostics).
    assert(
      'site-built socket observed (page-created WebSocket; probe/bridge constructions never fill this set)',
      socketEvidence.siteSocket.length > 0,
      socketEvidence.siteSocket.length > 0
        ? `${socketEvidence.siteSocket.length} construction(s): ${report.siteSocket.urls.slice(0, 3).join(', ')}`
        : `未观测到站点自建 socket (site-built socket not observed) - probe constructions: ${socketEvidence.probeSocket.length}, ` +
          `bridge-internal excluded: ${socketEvidence.bridgeSocket.length}, frames tapped: ${socketEvidence.framesTapped.length} of ${socketEvidence.framesSeen}, ` +
          `tap installed: ${Boolean(report.socketTap && report.socketTap.installed)}, mechanism: ${report.socketTap ? report.socketTap.mechanism : 'n/a'}, ` +
          `before page scripts: ${Boolean(report.socketTap && report.socketTap.beforePageScripts)}`,
    )
    assert(
      `at least one real WebSocket request targets the loopback tunnel (127.0.0.1:${tunnelPort})`,
      tunnelSocketRequests.length > 0,
      tunnelSocketRequests.length > 0
        ? tunnelSocketRequests.map((entry) => entry.url).join(', ')
        : `websocket requests: ${socketRequests.length === 0 ? 'none' : socketRequests.map((entry) => entry.url).join(', ')}`,
    )
    assert(
      `at least one request hit the tunnel 127.0.0.1:${tunnelPort}`,
      report.tunnelHits.length > 0,
      report.tunnelHits.length > 0 ? `${report.tunnelHits.length} distinct target(s)` : 'none observed',
    )
    if (options.frameOrigin !== 'http') {
      assert(
        'clean dsh-app://app/... requests were used (shell paths stay serveable)',
        report.cleanShellDocs.length > 0,
        `${report.cleanShellDocs.length} distinct target(s)`,
      )
    }
  }

  report.assertions = assertions
  log(`${assertions.filter((entry) => entry.status === 'passed').length}/${assertions.length} assertions passed`)
  if (assertions.some((entry) => entry.status !== 'passed')) printDiagnostics()
  return assertions.every((entry) => entry.status === 'passed') ? EXIT_PASSED : EXIT_ASSERTION
}

function printDiagnostics() {
  const last = report.samples[report.samples.length - 1]
  log('--- diagnostics ---')
  log(`frame url: ${last ? last.frameUrl : 'n/a'}`)
  log(`bridge attributes: ${JSON.stringify(report.diagnostics)}`)
  log(
    `polluted targets: ${
      report.polluted.length === 0 ? 'none' : report.polluted.map((entry) => `${entry.url} x${entry.count}`).join(' | ')
    }`,
  )
  log(
    `tunnel targets: ${
      report.tunnelHits.length === 0
        ? 'none'
        : report.tunnelHits.map((entry) => `${entry.url} x${entry.count}`).join(' | ')
    }`,
  )
  log(`clean dsh-app://app targets: ${report.cleanShellDocs.length}`)
  log(`websocket targets: ${report.websocketTargets.length === 0 ? 'none' : report.websocketTargets.join(' | ')}`)
  log(
    `site socket (constructor tap): ${
      report.siteSocket
        ? report.siteSocket.count === 0
          ? '未观测到站点自建 socket (site-built socket not observed)'
          : `${report.siteSocket.count} construction(s) - ${report.siteSocket.urls.join(' | ')}`
        : 'n/a'
    }`,
  )
  log(
    `probe socket: ${
      report.probeSocket
        ? report.probeSocket.count === 0
          ? 'none'
          : `${report.probeSocket.count} construction(s) - ${report.probeSocket.urls.join(' | ')}`
        : 'n/a'
    }`,
  )
  log(
    `bridge-internal constructions excluded from the site set: ${
      report.bridgeSocketExcluded ? report.bridgeSocketExcluded.count : 'n/a'
    }`,
  )
  for (const line of report.consoleMessages.slice(-12)) log(`console[${line.level}] ${line.message}`)
  for (const error of report.errors.slice(-6)) log(`error: ${error}`)
}

let exitCode = EXIT_INTERNAL
try {
  if (!(await ensureReady())) {
    fail('app.whenReady() did not settle within 30s - the harness cannot create its window')
    exitCode = EXIT_PRECONDITION
  } else {
    report.runtime.ready = true
    exitCode = await main()
  }
} catch (err) {
  fail(`harness internal error: ${err && err.stack ? err.stack : String(err)}`)
  exitCode = EXIT_INTERNAL
} finally {
  report.exitCode = exitCode
  if (!report.assertions.length) {
    report.assertions.push({
      criterion: 'harness produced a verdict',
      status: 'failed',
      evidence: `exit ${exitCode} without a completed assertion set`,
    })
  }
  const written = flushReport()
  log(`verdict ${report.verdict} (exit ${exitCode})`)
  log(
    written ? `report written: ${report.report} (verdict=${report.verdict})` : `could not write report: ${report.report}`,
  )
  if (!options.keepTmp) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* the OS temp dir is cleaned up later */
    }
  }
  setTimeout(() => app.exit(exitCode), 1000).unref?.()
  setTimeout(() => process.exit(exitCode), 2500)
}
