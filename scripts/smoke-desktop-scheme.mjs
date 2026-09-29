/**
 * Desktop-shell scheme routing smoke (DSH Electron shell, dsh-app://app).
 *
 * The shell serves the embedded workbench from a non-http(s) origin, so the
 * site's `location`-derived cross-origin URLs come out as `dsh-app://<host>/...`
 * and `ws://dsh-app/...`. The bridge must normalise those into root-relative
 * proxy paths or the 127.0.0.1 tunnel, while the http(s) web path keeps every
 * existing branch byte-identical.
 *
 * Case coverage:
 *  - shell socket.io takeover (`ws://dsh-app/...`, `ws://app/...` -> tunnel)
 *  - shell heartbeat / protocol-relative socket.io -> proxy path
 *  - shell websockets that are NOT /socket.io stay untouched (no hijacking of
 *    other plugins' `ws://app/sidebar/ws/*`)
 *  - unknown tunnel port never fabricates a `ws://app/...` fallback
 *  - web port-0 fallback (same shape as smoke-socket-routing.mjs)
 *  - R2-1/R2-2 compile-log URL bases stay pinned to location.* on the web
 *  - client toolbar "open in new window" gate (desktop predicate + disabled)
 *  - negative control: neutralising the shell branch must turn the shell cases
 *    red, so this suite provably has failure detection
 *
 * Slicing follows the other routing smokes: the single routeUrl /
 * routeSocketUrl bodies are extracted from the rendered bridge and executed in
 * an isolated vm context, so they must stay self-contained.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'
import { renderBridgeScript } from '../lib/types/inject-script.js'

const PREFIX = '/overleaf-proxy'
const WS_PORT = 50999
const UPSTREAM = 'https://tex.nju.edu.cn'
const SOCKET_ORIGIN = 'https://socket.tex.nju.edu.cn'
const TEXPAGE_OUTPUT_ORIGIN = 'https://latex-file.texpageusercontent.com'
const LOOPBACK = 'http://127.0.0.1:3080'
const TUNNEL_SOCKET = `ws://127.0.0.1:${WS_PORT}/__dsh_socket__/socket.io/?EIO=4&transport=websocket`
const SHELL_SOCKET_CASES = [
  'ws://dsh-app/socket.io/?EIO=4&transport=websocket',
  'ws://app/socket.io/?EIO=4&transport=websocket',
]

const WEB_LOCATION = {
  origin: LOOPBACK, host: '127.0.0.1:3080', hostname: '127.0.0.1', protocol: 'http:',
  href: `${LOOPBACK}${PREFIX}/project/user/example`,
}
const SHELL_LOCATION = {
  origin: 'dsh-app://app', host: 'app', hostname: 'app', protocol: 'dsh-app:',
  href: 'dsh-app://app/overleaf-proxy/project/user/example',
}

const bridge = renderBridgeScript()

function sectionOf(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `generated bridge section exists: ${startMarker}`)
  return source.slice(start, end)
}

/* Self-contained program: the shell helpers plus the single functions the
   routing smokes execute in isolation. Recomputed per source so the negative
   control can run the very same assertions against a mutated bridge. */
function sectionsFor(source) {
  return [
    sectionOf(source, '  var shellScheme = ', '  function routeUrl(raw) {'),
    sectionOf(source, '  function routeUrl(raw) {', '\n  /* ---------------------------------------------------------------- */'),
    sectionOf(source, '  function routeSocketUrl(raw) {', '\n  try {'),
    sectionOf(source, '  function captureCompileResponse(json, requestedGeneration) {', '  function captureLogFromOutputPdf(rawUrl) {'),
    sectionOf(source, '  function captureLogFromOutputPdf(rawUrl) {', '  function currentFileTreeDocument() {'),
  ].join('\n')
}

function loadBridge(source, location, wsPort = WS_PORT) {
  const fetches = []
  const diagnostics = {}
  const windowStub = {
    location,
    __DSH_OVERLEAF_UPSTREAM_ORIGIN__: UPSTREAM,
    __DSH_OVERLEAF_SOCKET_ORIGIN__: SOCKET_ORIGIN,
    __DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__: TEXPAGE_OUTPUT_ORIGIN,
    __DSH_OVERLEAF_WS_PORT__: wsPort,
  }
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location,
    window: windowStub,
    PREFIX,
    DEBUG: false,
    log() {},
    markDiagnostic: (key, value) => { diagnostics[key] = value },
    contentOrigin: () => '',
    isProxyUrl: (value) => typeof value === 'string' && value.startsWith(PREFIX + '/'),
    compileGeneration: 0,
    lastCompileStatus: undefined,
    beginCompileGeneration: () => 0,
    publishCompileLog() {},
    sendToParent() {},
    fetchAndPublishLog: (url, path) => { fetches.push({ url: String(url), path }) },
  })
  vm.runInContext(sectionsFor(source), context)
  return { context, fetches, diagnostics, windowStub }
}

const shellBridge = loadBridge(bridge, SHELL_LOCATION)
const webBridge = loadBridge(bridge, WEB_LOCATION)

test('shell: every location-derived socket.io websocket takes the tunnel with the socket marker', () => {
  for (const raw of SHELL_SOCKET_CASES) {
    assert.equal(shellBridge.context.routeSocketUrl(raw), TUNNEL_SOCKET, raw)
  }
  assert.equal(
    shellBridge.context.routeSocketUrl(new URL(SHELL_SOCKET_CASES[1])),
    TUNNEL_SOCKET,
    'URL instances route like strings',
  )
})

test('shell: heartbeat and protocol-relative socket.io become root-relative proxy paths', () => {
  assert.equal(
    shellBridge.context.routeUrl('dsh-app://socket.tex.nju.edu.cn/heartbeat?m=1'),
    `${PREFIX}/__dsh_socket__/heartbeat?m=1`,
  )
  assert.equal(
    shellBridge.context.routeUrl('//socket.tex.nju.edu.cn/socket.io/?EIO=4'),
    `${PREFIX}/__dsh_socket__/socket.io/?EIO=4`,
  )
  assert.equal(
    shellBridge.context.routeUrl('https://tex.nju.edu.cn/project/abc'),
    `${PREFIX}/project/abc`,
    'shell page never prefixes output with the shell origin',
  )
  assert.equal(
    shellBridge.context.routeUrl('blob:https://tex.nju.edu.cn/synthetic'),
    'blob:https://tex.nju.edu.cn/synthetic',
    'blob URLs stay intact in the shell as well',
  )
})

test('shell: the shell host in http(s) form counts as the page origin (site API bases)', () => {
  /* The site builds protocol-relative API bases from location.host, so in the
     shell it emits //app/api/... which the fetch/XHR wrappers complete to
     https://app/.... Both forms must land on the proxy, with no double prefix. */
  const cases = [
    ['https://app/api/tag', `${PREFIX}/api/tag`],
    ['https://app/api/project', `${PREFIX}/api/project`],
    ['https://app/api/project/total', `${PREFIX}/api/project/total`],
    ['https://app/api/project/total?t=123', `${PREFIX}/api/project/total?t=123`],
    ['https://app/api/user/invitation', `${PREFIX}/api/user/invitation`],
    ['https://app/api/project/invitation', `${PREFIX}/api/project/invitation`],
    /* The socket.io HTTP forms (polling and the websocket handshake URL) take
       the same proxy path the web context produces for //<loopback>/socket.io;
       the host registers an upgrade route for /overleaf-proxy/socket.io/
       (src/service.ts). The websocket transport itself is handled by
       routeSocketUrl, which keeps its own tunnel form. */
    ['https://app/socket.io/?EIO=4&transport=websocket', `${PREFIX}/socket.io/?EIO=4&transport=websocket`],
    ['https://app/socket.io/?EIO=4&transport=polling', `${PREFIX}/socket.io/?EIO=4&transport=polling`],
    ['//app/api/project', `${PREFIX}/api/project`],
    ['//app/api/tag?scope=all', `${PREFIX}/api/tag?scope=all`],
    ['https://app/api/tag?scope=all#frag', `${PREFIX}/api/tag?scope=all#frag`],
    ['https://app/overleaf-proxy/api', `${PREFIX}/api`],
    ['https://app/overleaf/workbench/bridge.js', '/overleaf/workbench/bridge.js'],
    ['dsh-app://app/api/tag', `${PREFIX}/api/tag`],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(shellBridge.context.routeUrl(raw), expected, raw)
  }
  for (const raw of cases.map(([value]) => value)) {
    assert.ok(
      !String(shellBridge.context.routeUrl(raw)).includes(`${PREFIX}${PREFIX}`),
      `no double proxy prefix for ${raw}`,
    )
  }
})

test('shell: announced output/socket and content-origin branches keep priority', () => {
  assert.equal(
    shellBridge.context.routeUrl(`${TEXPAGE_OUTPUT_ORIGIN}/CompileResult/owner/project/build/output.log?X-Amz-Signature=synthetic`),
    `${PREFIX}/__dsh_texpage_output__/CompileResult/owner/project/build/output.log?X-Amz-Signature=synthetic`,
    'latex-file output origin still uses its isolated marker',
  )
  assert.equal(
    shellBridge.context.routeUrl('https://socket.tex.nju.edu.cn/heartbeat?m=1'),
    `${PREFIX}/__dsh_socket__/heartbeat?m=1`,
    'announced socket host still uses the socket marker',
  )
  assert.equal(
    shellBridge.context.routeUrl('https://socket.tex.nju.edu.cn/socket.io/?EIO=4'),
    `${PREFIX}/__dsh_socket__/socket.io/?EIO=4`,
    'announced socket.io still uses the socket marker',
  )
  assert.equal(
    shellBridge.context.routeUrl('dsh-app://socket.tex.nju.edu.cn/heartbeat?m=1'),
    `${PREFIX}/__dsh_socket__/heartbeat?m=1`,
    'un-poisoned socket host unchanged',
  )
})

test('shell: websockets that are not /socket.io are passed through untouched', () => {
  for (const raw of [
    'ws://app/sidebar/ws/agent-opens',
    'ws://app/sidebar/ws/fs-watch?sessionId=synthetic',
    'ws://dsh-app/sidebar/ws/agent-opens',
  ]) {
    assert.equal(shellBridge.context.routeSocketUrl(raw), raw, `not hijacked: ${raw}`)
  }
})

test('shell: unknown tunnel port never fabricates a ws://app fallback', () => {
  const noPort = loadBridge(bridge, SHELL_LOCATION, 0)
  assert.equal(noPort.context.routeSocketUrl('ws://dsh-app/socket.io/?EIO=4'), 'ws://dsh-app/socket.io/?EIO=4')
  assert.equal(noPort.diagnostics['ws-port'], 'missing')
})

test('shell: no routing path emits dsh-app://, ws://app/ or ws://dsh-app/', () => {
  const outputs = [
    shellBridge.context.routeUrl('https://tex.nju.edu.cn/project/abc'),
    shellBridge.context.routeUrl('//socket.tex.nju.edu.cn/socket.io/?EIO=4'),
    shellBridge.context.routeUrl('dsh-app://socket.tex.nju.edu.cn/heartbeat?m=1'),
    shellBridge.context.routeUrl('dsh-app://app/project/abc'),
    shellBridge.context.routeSocketUrl(SHELL_SOCKET_CASES[0]),
    shellBridge.context.routeSocketUrl(SHELL_SOCKET_CASES[1]),
    shellBridge.context.routeSocketUrl('wss://socket.tex.nju.edu.cn/socket.io/?EIO=4'),
  ]
  for (const value of outputs) {
    assert.ok(!/^dsh-app:\/\//.test(value), `no dsh-app:// leak: ${value}`)
    assert.ok(!/^wss?:\/\/(?:app|dsh-app)(?:[:/]|$)/.test(value), `no shell-host websocket leak: ${value}`)
  }
})

test('shell: paths that already carry a proxy/workbench form are not prefixed twice', () => {
  /* Same guard as the shell-origin branch: an already-proxied pathname keeps
     its path semantics (relative form - the shell host would be a dead URL). */
  const cases = [
    ['https://app/overleaf-proxy/api', `${PREFIX}/api`],
    ['https://app/overleaf-proxy', PREFIX],
    ['https://app/overleaf/workbench/bridge.js', '/overleaf/workbench/bridge.js'],
    ['https://app/overleaf/workbench/api/status?x=1', '/overleaf/workbench/api/status?x=1'],
    ['dsh-app://app/overleaf-proxy/api', `${PREFIX}/api`],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(shellBridge.context.routeUrl(raw), expected, raw)
    assert.ok(
      !String(shellBridge.context.routeUrl(raw)).includes(`${PREFIX}${PREFIX}`),
      `no double proxy prefix for ${raw}`,
    )
  }
})

test('web: the port-0 fallback keeps the old loopback shape', () => {
  const noPort = loadBridge(bridge, WEB_LOCATION, 0)
  assert.equal(
    noPort.context.routeSocketUrl('ws://socket.tex.nju.edu.cn/socket.io/'),
    `ws://127.0.0.1:3080${PREFIX}/__dsh_socket__/socket.io/`,
  )
  assert.equal(
    webBridge.context.routeSocketUrl('ws://socket.tex.nju.edu.cn/socket.io/?EIO=4&transport=websocket'),
    TUNNEL_SOCKET,
  )
  assert.equal(
    webBridge.context.routeSocketUrl('ws://127.0.0.1:3080/socket.io/?EIO=3'),
    `ws://127.0.0.1:${WS_PORT}/socket.io/?EIO=3`,
  )
})

test('web: compile-log URL bases stay pinned to location.protocol/origin (R2-1/R2-2)', () => {
  webBridge.context.captureLogFromOutputPdf('/project/abc/output/output.pdf?editorId=1')
  webBridge.context.captureCompileResponse({
    status: 'success',
    outputFiles: [
      { path: 'output.log', url: '/project/abc/output/output.log' },
      { path: 'output.pdf', editorId: '1' },
    ],
  }, 0)
  assert.equal(webBridge.fetches.length, 2)
  assert.equal(
    webBridge.fetches[0].url,
    `${LOOPBACK}/project/abc/output/output.log?editorId=1`,
    'pdf->log fallback keeps the page origin as its fetch base',
  )
  assert.equal(
    webBridge.fetches[1].url,
    `${LOOPBACK}${PREFIX}/project/abc/output/output.log?editorId=1&enable_pdf_caching=true`,
    'compile-result log keeps the page origin before proxy routing',
  )
})

test('shell: compile-log targets use the upstream, never the shell scheme', () => {
  shellBridge.context.captureLogFromOutputPdf('/project/abc/output/output.pdf?editorId=1')
  shellBridge.context.captureCompileResponse({
    status: 'success',
    outputFiles: [
      { path: 'output.log', url: '/project/abc/output/output.log' },
      { path: 'output.pdf', editorId: '1' },
    ],
  }, 0)
  assert.equal(shellBridge.fetches.length, 2)
  assert.equal(shellBridge.fetches[0].url, `${UPSTREAM}/project/abc/output/output.log?editorId=1`)
  assert.equal(shellBridge.fetches[1].url, `${PREFIX}/project/abc/output/output.log?editorId=1&enable_pdf_caching=true`)
})

test('client: the toolbar new-window button is gated on a non-http(s) origin', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

  const declaration = /desktopShell = (.+?);\n/.exec(bundle)
  assert.ok(declaration, 'the desktop-shell predicate is compiled into the client bundle')
  const predicate = new Function('location', `return (${declaration[1]})`)
  assert.equal(predicate({ protocol: 'dsh-app:' }), true, 'desktop shell must disable the button')
  assert.equal(predicate({ protocol: 'http:' }), false, 'web over http keeps the button usable')
  assert.equal(predicate({ protocol: 'https:' }), false, 'web over https keeps the button usable')

  const anchor = bundle.indexOf('toolbar.openWindowUnavailable')
  assert.ok(anchor > 0, 'the desktop hint is wired into the button title')
  const button = bundle.slice(Math.max(0, anchor - 400), anchor + 200)
  assert.ok(
    /desktopShell \? tt\("toolbar\.openWindowUnavailable"\) : tt\("toolbar\.openWindow"\)/.test(button),
    'title switches to the explanatory copy only on the desktop shell',
  )
  assert.equal((button.match(/disabled:/g) ?? []).length, 1, 'the button has exactly one disabled binding')
  assert.ok(/disabled: desktopShell/.test(button), 'and that binding is the shell predicate itself')

  assert.equal(
    (locales.match(/'toolbar\.openWindowUnavailable':/g) ?? []).length,
    2,
    'both dictionaries define the hint',
  )
  assert.ok(locales.includes('桌面端应用内不支持新窗口：请在系统浏览器中打开站点'), 'zh copy present')
  assert.ok(locales.includes('Not available inside the desktop app: open the site in your system browser'), 'en copy present')
})

test('negative control: neutralising the shell branch turns these cases red', () => {
  const anchor = "if (shellScheme !== '' && "
  const hits = bridge.split(anchor).length - 1
  assert.ok(hits >= 2, 'the shell-branch anchors are still present in the generated bridge (expected 2 gated sites)')
  const mutated = loadBridge(bridge.split(anchor).join('if (false && '), SHELL_LOCATION)

  assert.notEqual(mutated.context.routeSocketUrl(SHELL_SOCKET_CASES[0]), TUNNEL_SOCKET, 'ws://dsh-app case detects the missing branch')
  assert.notEqual(mutated.context.routeSocketUrl(SHELL_SOCKET_CASES[1]), TUNNEL_SOCKET, 'ws://app case detects the missing branch')
  assert.notEqual(
    mutated.context.routeUrl('dsh-app://socket.tex.nju.edu.cn/heartbeat?m=1'),
    `${PREFIX}/__dsh_socket__/heartbeat?m=1`,
    'heartbeat case detects the missing branch',
  )
  assert.notEqual(
    mutated.context.routeSocketUrl('ws://app/sidebar/ws/agent-opens'),
    'ws://app/sidebar/ws/agent-opens',
    'sidebar passthrough case detects the branch that stops third-party hijacking',
  )
})

console.log('desktop scheme smoke passed: shell socket takeover, heartbeat/protocol-relative routing, third-party websocket passthrough, port-0 fallback, R2-1/R2-2 web pins, client button gate and a mutation negative control')
