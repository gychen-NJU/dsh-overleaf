import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { ReverseProxy, rewriteHtml } from '../lib/types/proxy.js'
import { renderBridgeScript } from '../lib/types/inject-script.js'

const prefix = '/overleaf-proxy'
const marker = '/__dsh_texpage_output__'
const origin = 'https://latex-file.texpageusercontent.com'
const path = '/CompileResult/owner-id/project-id/build-id/output.pdf'
const query = '?X-Amz-Signature=synthetic&X-Amz-Credential=a%2fb%2FC&repeat=x+z&repeat=x%20z'
const html = '<html><head><script>window._domainConf={"socket":"socket.tex.nju.edu.cn","latexFile":"latex-file.texpageusercontent.com"};</script></head></html>'
const rewritten = rewriteHtml(html,prefix,'/overleaf/workbench/bridge.js','https://tex.nju.edu.cn',undefined,50999)
assert.ok(rewritten.includes('__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__="'+origin+'"'))
assert.ok(!rewriteHtml(html,prefix,'/overleaf/workbench/bridge.js','https://other.test',undefined,0).includes('__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__='))

const bridge = renderBridgeScript()
new vm.Script(bridge)
const start = bridge.indexOf('  function routeUrl(raw) {')
const end = bridge.indexOf('\n  /* ---------------------------------------------------------------- */',start)
const location = {origin:'http://127.0.0.1:3080',hostname:'127.0.0.1',protocol:'http:'}
const window = {location,__DSH_OVERLEAF_UPSTREAM_ORIGIN__:'https://tex.nju.edu.cn',__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__:origin}
const diagnostics = {}
const context = vm.createContext({URL,location,window,PREFIX:prefix,contentOrigin:()=>'',isProxyUrl:v=>v.startsWith(prefix+'/'),markDiagnostic:(key,value)=>{diagnostics[key]=value}})
vm.runInContext(bridge.slice(start,end),context)
const route = context.routeUrl
const local = location.origin+prefix+marker+path+query
assert.equal(route(origin+path+query),local)
assert.equal(route(new URL(origin+path+query)),local)
assert.equal(route('//latex-file.texpageusercontent.com'+path+query),local)
assert.equal(route(local),local,'already proxied URLs stay unchanged')
assert.equal(route(prefix+marker+path+query),prefix+marker+path+query)
assert.deepEqual(diagnostics,{'pdf-route':'texpage-same-origin'},'no signed queries or identifiers in diagnostics')
for (const extension of ['log','blg']) {
  assert.equal(route(origin+path.replace('output.pdf','output.'+extension)+query), local.replace('output.pdf','output.'+extension))
}
assert.equal(diagnostics['log-route'],'texpage-same-origin')
for(const raw of [
  origin+'.evil.test'+path+query, 'https://user@latex-file.texpageusercontent.com'+path+query,
  origin+':444'+path+query, 'http://latex-file.texpageusercontent.com'+path+query,
  origin+'/private.pdf', origin+path.replace('output.pdf','output.html'),
  'https://static.texpage.com/dist/pdf.worker.js','blob:https://tex.nju.edu.cn/synthetic',
]) assert.equal(route(raw),raw,'unrelated destinations are not routed')
delete window.__DSH_OVERLEAF_TEXPAGE_OUTPUT_ORIGIN__
assert.equal(route(origin+path+query),origin+path+query,'no unannounced host')
assert.equal(route('/api/project'),prefix+'/api/project','main-site routing unchanged')

// End-to-end guard: output markers cannot fall through to the site (with its
// cookies), arbitrary URLs, or the WebSocket tunnel. No external I/O here.
const proxy = new ReverseProxy('https://tex.nju.edu.cn')
const server = createServer((req,res)=>void proxy.handle(req,res))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base = `http://127.0.0.1:${server.address().port}${prefix}`
try {
  const unregistered = await fetch(base+marker+path+query)
  assert.equal(unregistered.status,400)
  await unregistered.body.cancel()
  proxy.learnTexpageOutput(html)
  for(const suffix of ['/private','//evil.test','/CompileResult/a/b/c/output.html','evil/CompileResult/a/b/c/output.pdf']){
    const rejected = await fetch(base+marker+suffix)
    assert.equal(rejected.status,400)
    await rejected.body.cancel()
  }
  const post = await fetch(base+marker+path+query,{method:'POST'})
  assert.equal(post.status,405)
  await post.body.cancel()
  let destroyed = false
  proxy.tunnelUpgrade({url:prefix+marker+path,headers:{}},{destroy(){destroyed=true}},Buffer.alloc(0))
  assert.ok(destroyed,'output host never becomes a WebSocket target')
} finally {
  const closed = new Promise(resolve=>server.close(resolve))
  server.closeAllConnections()
  await closed
}
console.log('PDF routing smoke passed: generated bridge syntax/routing, signed query preservation, announcement gates and isolated HTTP-only marker')
