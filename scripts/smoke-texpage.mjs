import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { texpageAssetUrl, rewriteTexpageScriptTags, rewriteTexpageConsoleScript } from '../lib/types/texpage-compat.js'
import { ReverseProxy, rewriteHtml } from '../lib/types/proxy.js'
import { renderBridgeScript } from '../lib/types/inject-script.js'

const prefix = '/overleaf-proxy'
const cdn = 'https://static.texpage.com/dist/console.0123456789abcdef.js'
const assetPath = '/__dsh_texpage_v1__/console.0123456789abcdef.js'
const fixture = 'globalThis.router={basename:"/console"};globalThis.other="/console";'
assert.equal(rewriteTexpageConsoleScript(fixture, prefix), 'globalThis.router={basename:"/overleaf-proxy/console"};globalThis.other="/console";')
assert.throws(() => rewriteTexpageConsoleScript('const x="/console"', prefix), /format changed/)
assert.throws(() => rewriteTexpageConsoleScript(fixture + fixture, prefix), /format changed/)
new vm.Script(rewriteTexpageConsoleScript(fixture, prefix))
const html = `<script defer nonce="nonce" integrity="sha384-old" src="${cdn}"></script>`
const patched = rewriteTexpageScriptTags(html, prefix)
assert.ok(patched.includes(`src="${prefix}${assetPath}"`))
assert.ok(patched.includes('defer nonce="nonce"'))
assert.ok(!patched.includes('integrity='))
assert.equal(rewriteTexpageScriptTags(patched, prefix), patched)
for (const source of [
  'https://static.texpage.com.evil.test/dist/console.0123456789abcdef.js',
  'https://user@static.texpage.com/dist/console.0123456789abcdef.js',
  'https://static.texpage.com/dist/runtime.0123456789abcdef.js',
  'https://static.texpage.com/dist/console.0123456789abcdef.js?external=1',
  '/dist/console.0123456789abcdef.js',
]) {
  const tag = `<script src="${source}"></script>`
  assert.equal(rewriteTexpageScriptTags(tag, prefix), tag)
}
assert.equal(texpageAssetUrl(assetPath).href, cdn)
for (const path of ['/__dsh_texpage_v1__/../secret', assetPath + '?url=https://evil.test', '/__dsh_texpage_v1__/https://evil.test']) {
  assert.equal(texpageAssetUrl(path), undefined)
}
const fullHtml = rewriteHtml(`<html><head></head><body>${html}</body></html>`, prefix, '/overleaf/workbench/bridge.js', 'https://tex.nju.edu.cn', undefined, 0)
assert.ok(fullHtml.includes('window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__="https://tex.nju.edu.cn"'))
assert.ok(fullHtml.includes(`${prefix}${assetPath}`))

// Execute the routing helper from the generated (escaped TS template) bridge.
const bridge = renderBridgeScript()
const helperStart = bridge.indexOf('  function routeUrl(raw) {')
const helperEnd = bridge.indexOf('\n  /* ---------------------------------------------------------------- */', helperStart)
assert.ok(helperStart > 0 && helperEnd > helperStart)
const location = {origin:'http://127.0.0.1:3080',hostname:'127.0.0.1',protocol:'http:'}
const routingContext = {URL, location, window:{location, __DSH_OVERLEAF_UPSTREAM_ORIGIN__:'https://tex.nju.edu.cn'}, PREFIX:prefix, contentOrigin:()=>'', isProxyUrl:v=>v.startsWith(prefix+'/')}
vm.createContext(routingContext)
vm.runInContext(bridge.slice(helperStart, helperEnd), routingContext)
const route = routingContext.routeUrl
assert.equal(route('//127.0.0.1/api/project'), 'http://127.0.0.1:3080/overleaf-proxy/api/project')
assert.equal(route('//tex.nju.edu.cn/api/tag'), 'http://127.0.0.1:3080/overleaf-proxy/api/tag')
assert.equal(route('https://tex.nju.edu.cn/api/tag'), 'http://127.0.0.1:3080/overleaf-proxy/api/tag')
assert.equal(route('//static.texpage.com/dist/chunk.js'), 'https://static.texpage.com/dist/chunk.js')
assert.equal(route('//latex-static.texpage.com/logo'), 'https://latex-static.texpage.com/logo')
assert.equal(route('//127.0.0.1:9000/api'), 'https://127.0.0.1:9000/api')
assert.equal(route('/api/project'), prefix + '/api/project')
assert.equal(route(prefix + '/api/project'), prefix + '/api/project')
assert.equal(route('/overleaf/workbench/bridge.js'), '/overleaf/workbench/bridge.js')

// Fixed-origin public asset transport; test with fake fetch, never contact a CDN.
const originalFetch = globalThis.fetch
let mode = 'ok'
let outbound
globalThis.fetch = async (url, options) => {
  outbound = {url:String(url), options}
  if (mode === 'redirect') throw new TypeError('fetch failed: redirect')
  if (mode === 'large') return new Response('x'.repeat(4*1024*1024+1), {headers:{'content-type':'application/javascript'}})
  if (mode === 'html') return new Response('<html>Error</html>', {headers:{'content-type':'text/html'}})
  return new Response(fixture, {headers:{'content-type':'application/javascript','set-cookie':'must-not-be-forwarded=1','etag':'old'}})
}
const proxy = new ReverseProxy('https://tex.nju.edu.cn')
proxy.extraCookie = 'SESSIONID=synthetic-private-token'
const server = createServer((req,res) => void proxy.handle(req,res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}${prefix}${assetPath}`
try {
  const response = await originalFetch(url, {headers:{cookie:'browser=synthetic',authorization:'Bearer synthetic',referer:'http://private.test/'}})
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.equal(outbound.url, cdn)
  assert.deepEqual(outbound.options.headers, {accept:'application/javascript'})
  assert.equal(outbound.options.credentials, 'omit')
  assert.equal(outbound.options.redirect, 'error')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('etag'), null)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text))
  assert.ok(text.includes('basename:"/overleaf-proxy/console"'))
  for (const testMode of ['redirect','large','html']) {
    mode = testMode
    const failed = await originalFetch(url)
    assert.equal(failed.status, 502)
    await failed.body.cancel()
  }
  const post = await originalFetch(url, {method:'POST'})
  assert.equal(post.status, 405)
  await post.body.cancel()
} finally {
  globalThis.fetch = originalFetch
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await closed
}
console.log('TeXPage smoke passed: router basename, generated URL routing, scoped assets, credential isolation')
