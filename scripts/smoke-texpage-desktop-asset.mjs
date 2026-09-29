import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { texpageAssetUrl, rewriteTexpageScriptTags, rewriteTexpageDesktopSocketScript, serveTexpageConsoleAsset } from '../lib/types/texpage-compat.js'

const client = readFileSync(new URL('./fixtures/socket.io-client-4.7.5/socket.io.min.js', import.meta.url), 'utf8')
const prefix = '/overleaf-proxy'
const name = '6.ef068f5504570adcc17f.js'
const cdn = `https://static.texpage.com/dist/${name}`
const assetPath = `/__dsh_texpage_v1__/${name}`
// Minimal executable fixture preserving both observed private module call sites.
const source = 'var b=n(74896),x=function(e){var r=window._domainConf.socket;'
  + 'var i=(0,b.Ay)(window.location.protocol+"//"+r,{transports:["websocket"],reconnection:false});'
  + 'window.heartbeat=function(){return f().create({baseURL:window.location.protocol+"//"+r}).get("/heartbeat",{})};return i};'
  + 'window.siteSocket=x(function(){});\n//# sourceMappingURL=upstream.map'
const rewritten = rewriteTexpageDesktopSocketScript(source)

function execute(script, protocol = 'dsh-app:', overrides = {}) {
  const sockets = []
  class WebSocket {
    static OPEN = 1
    static CLOSED = 3
    constructor(url) { this.url = url; this.readyState = 1; this.frames = []; sockets.push(this) }
    send(data) { this.frames.push(data) }
    close() { this.readyState = 3 }
    addEventListener() {}
  }
  const sandbox = {
    URL, WebSocket, console,
    setTimeout: () => 1, clearTimeout() {},
    location: { protocol, host: protocol === 'dsh-app:' ? 'app' : '127.0.0.1:3080', hostname: protocol === 'dsh-app:' ? 'app' : '127.0.0.1', port: '' },
    _domainConf: { socket: 'socket.tex.nju.edu.cn' },
    __DSH_OVERLEAF_SOCKET_ORIGIN__: 'https://socket.tex.nju.edu.cn',
    __DSH_OVERLEAF_UPSTREAM_ORIGIN__: 'https://tex.nju.edu.cn',
    ...overrides,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.n = id => { assert.equal(id, 74896); return { Ay: sandbox.io } }
  sandbox.f = () => ({ create: ({ baseURL }) => ({ get: path => baseURL + path }) })
  const context = vm.createContext(sandbox)
  vm.runInContext(client, context)
  vm.runInContext(script, context)
  assert.equal(sockets.length, 1)
  const ws = sockets[0]
  ws.onopen()
  ws.onmessage({ data: '0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}' })
  const result = { namespace: sandbox.siteSocket.nsp, target: ws.url, frames: ws.frames.slice(), heartbeat: sandbox.heartbeat() }
  sandbox.siteSocket.disconnect()
  return result
}

test('real Socket.IO reproduces the custom-scheme namespace failure before the fix', () => {
  const result = execute(source)
  assert.equal(result.namespace, '//dsh-app://socket.tex.nju.edu.cn')
  assert.match(result.target, /^ws:\/\/dsh-app\/socket\.io\//)
  assert.deepEqual(result.frames, ['40//dsh-app://socket.tex.nju.edu.cn,'])
})

test('desktop normalizes before the real parser and sends the default CONNECT namespace', () => {
  const result = execute(rewritten)
  assert.equal(result.namespace, '/')
  assert.match(result.target, /^wss:\/\/socket\.tex\.nju\.edu\.cn(?::443)?\/socket\.io\//)
  assert.deepEqual(result.frames, ['40'])
  assert.equal(result.heartbeat, 'https://socket.tex.nju.edu.cn/heartbeat')
  assert.ok(!rewritten.includes('sourceMappingURL'))
})

for (const protocol of ['http:', 'https:']) {
  test(`${protocol} preserves the original connection and heartbeat even without bootstrap`, () => {
    const overrides = { __DSH_OVERLEAF_SOCKET_ORIGIN__: undefined, __DSH_OVERLEAF_UPSTREAM_ORIGIN__: undefined }
    assert.deepEqual(execute(rewritten, protocol, overrides), execute(source, protocol, overrides))
  })
}

test('desktop rejects missing or untrusted origin bootstrap without a guessed fallback', () => {
  for (const origin of [undefined, '', 'https://evil.test', 'https://socket.tex.nju.edu.cn.evil.test',
    'http://socket.tex.nju.edu.cn', 'https://user@socket.tex.nju.edu.cn',
    'https://socket.tex.nju.edu.cn:444', 'https://socket.tex.nju.edu.cn/path']) {
    assert.throws(() => execute(rewritten, 'dsh-app:', { __DSH_OVERLEAF_SOCKET_ORIGIN__: origin }), /missing or invalid desktop TeXPage socket origin/)
  }
  assert.throws(() => execute(rewritten, 'dsh-app:', { __DSH_OVERLEAF_UPSTREAM_ORIGIN__: undefined }), /missing or invalid/)
})

test('changed, incomplete, duplicated or already transformed modules fail explicitly', () => {
  for (const changed of [source.replace('n(74896)', 'n(123)'), source.replace('transports:["websocket"]', 'transports:["polling"]'),
    source.replace('/heartbeat', '/elsewhere'), source.replace('window._domainConf.socket', 'other.socket'),
    source + source, source + ';window.location.protocol+"//"+r', rewritten, '']) {
    assert.throws(() => rewriteTexpageDesktopSocketScript(changed), /socket module format changed/)
  }
})

test('only the fixed CDN hashed socket asset is rerouted, stripping stale integrity', () => {
  const tag = `<script nonce="safe" defer integrity="sha384-old" src="${cdn}"></script>`
  const html = rewriteTexpageScriptTags(tag, prefix)
  assert.equal(html, `<script nonce="safe" defer src="${prefix}${assetPath}"></script>`)
  assert.equal(rewriteTexpageScriptTags(html, prefix), html)
  assert.equal(texpageAssetUrl(assetPath).href, cdn)
  for (const url of [cdn + '?query=1', cdn + '#hash', cdn.replace('static.texpage.com', 'static.texpage.com.evil.test'),
    cdn.replace('6.', '7.'), cdn.replace('https:', 'http:'), cdn.replace('/dist/', '/other/'), cdn.replace('https://', 'https://user@')]) {
    const untouched = `<script src="${url}"></script>`
    assert.equal(rewriteTexpageScriptTags(untouched, prefix), untouched)
  }
  for (const path of [assetPath + '?query=1', assetPath + '#hash', assetPath.replace('/6.', '/../6.'), assetPath.replace('/6.', '/7.')]) {
    assert.equal(texpageAssetUrl(path), undefined)
  }
})

test('asset serving is bounded, credential-free, non-cacheable and fails closed', async () => {
  const originalFetch = globalThis.fetch
  let mode = 'ok'
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(String(url), cdn)
    assert.deepEqual(options.headers, { accept: 'application/javascript' })
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    if (mode === 'redirect') throw new Error('redirect refused')
    return new Response(mode === 'large' ? 'x'.repeat(4 * 1024 * 1024 + 1) : mode === 'changed' ? 'changed module' : source, {
      headers: { 'content-type': mode === 'html' ? 'text/html' : 'application/javascript', 'set-cookie': 'secret=never-forward', etag: 'stale' },
    })
  }
  const serve = async (method = 'GET', url = cdn) => {
    const result = {}
    await serveTexpageConsoleAsset({ method, headers: { cookie: 'private', authorization: 'private' } }, {
      writeHead(status, headers) { result.status = status; result.headers = headers },
      end(body) { result.body = body },
    }, new URL(url), prefix)
    return result
  }
  try {
    const result = await serve()
    assert.equal(result.status, 200)
    assert.equal(String(result.body), rewritten)
    assert.equal(result.headers['x-dsh-texpage-compat'], 'desktop-socket-origin-v1')
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.headers['set-cookie'], undefined)
    assert.equal(result.headers.etag, undefined)
    assert.equal(result.headers['content-length'], String(Buffer.byteLength(rewritten)))
    assert.equal((await serve('HEAD')).body, undefined)
    for (mode of ['large', 'html', 'changed', 'redirect']) assert.equal((await serve()).status, 502)
    const before = calls
    assert.equal((await serve('POST')).status, 405)
    assert.equal((await serve('GET', 'https://evil.test/dist/' + name)).status, 502)
    assert.equal(calls, before)
  } finally { globalThis.fetch = originalFetch }
})
