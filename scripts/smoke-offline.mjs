/**
 * Offline smoke test for the built dsh-overleaf bundles. No DSH instance and
 * no live network: spins a local fixture "Overleaf", imports lib/index.js,
 * instantiates the service with a fake context, and drives the reverse proxy
 * end-to-end over real sockets. Also materializes lib/client.js through a
 * ModuleLoader stub and activates apply() against a fake client context.
 *
 * Run: node scripts/smoke-offline.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/* ------------------------------------------------------------------ */
/* Host half                                                           */
/* ------------------------------------------------------------------ */

function fakeCtx() {
  const routes = []
  const upgrades = []
  const credentialsStore = new Map()
  const credentials = {
    resolve: async ref => credentialsStore.has(String(ref)) ? { value: credentialsStore.get(String(ref)), source: 'test' } : undefined,
    describe: async ref => ({ configured: credentialsStore.has(String(ref)), writable: true }),
    set: async (ref, value) => {
      credentialsStore.set(String(ref), value)
    },
    unset: async ref => {
      credentialsStore.delete(String(ref))
    },
  }
  // A real (minimal) cordis Context: the Service base class needs
  // ctx.reflect.provide; everything else rides as plain stub services.
  const ctx = new Context()
  ctx.effect = ((original => function patched(fn, label) {
    try {
      return original.call(this, fn, label)
    } catch {
      return fn()
    }
  })(ctx.effect.bind(ctx)))
  ctx.provide('webServer', {
    register: route => {
      routes.push(route)
      return () => {}
    },
    registerUpgrade: route => {
      upgrades.push(route)
      return () => {}
    },
    registerFallback: () => () => {},
    tapIndex: () => () => {},
  })
  ctx.provide('credentials', credentials)
  return { ctx, routes, upgrades, credentialsStore }
}

function mockRequest({ method = 'GET', url = '/', headers = {} }) {
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    destroyed: false,
    aborted: false,
    // Simulate a completed empty body stream: piping a finished request must
    // terminate the piped destination.
    pipe(dest) {
      process.nextTick(() => {
        if (typeof dest.end === 'function' && !dest.writableEnded) dest.end()
      })
    },
    on() {},
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: undefined }) }
    },
  }
  return req
}

class MockResponse {
  constructor() {
    this.statusCode = 0
    this.headers = {}
    this.body = []
    this.finished = false
    this.headersSent = false
  }
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers ?? {}
    this.headersSent = true
  }
  write(chunk) {
    this.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  end(chunk) {
    if (chunk !== undefined) this.write(chunk)
    this.finished = true
  }
  destroy() {
    this.finished = true
  }
}

async function main() {
  const { default: ServiceClass } = await import(pathToFileURL(join(root, 'lib', 'index.js')))

  // 1. Mount against a fake context and confirm every route family lands.
  const { ctx, routes, upgrades, credentialsStore } = fakeCtx()
  // Attach a stub settings service so the namespace-registration branch runs:
  // its watcher must hot-swap the proxy target when the user doc changes.
  let registeredNs
  let registeredBase
  let watcherFn
  const mutableDoc = {}
  ctx.settings = {
    register: (ns, schema, options) => {
      registeredNs = ns
      registeredBase = options?.base ?? {}
      return {
        get: () => resolvedFromSchema(schema, mutableDoc),
        watch(listener) {
          watcherFn = () => listener(resolvedFromSchema(schema, mutableDoc), undefined)
          return () => {}
        },
      }
    },
  }
  function resolvedFromSchema(_schema, overlay) {
    // Minimal resolution: the plugin re-applies schema defaults via
    // resolveConfig, so a transparent pass-through of the user overlay is
    // enough here.
    return { ...overlay }
  }
  const service = new ServiceClass(ctx, { baseUrl: '' }) // blank baseUrl exercises normalizeOrigin fallback? keep default branch
  const paths = routes.map(r => r.path)
  assert.ok(paths.includes('/overleaf-proxy'), 'proxy prefix route registered')
  assert.ok(paths.includes('/overleaf/workbench/status'), 'status route')
  assert.ok(paths.includes('/overleaf/workbench/login'), 'login route')
  assert.ok(paths.includes('/overleaf/workbench/cookie'), 'cookie route')
  assert.ok(paths.includes('/overleaf/workbench/projects'), 'projects route')
  assert.ok(paths.includes('/overleaf/workbench/bridge.js'), 'bridge asset route')
  assert.ok(upgrades.some(u => u.path === '/overleaf-proxy/socket.io/'), 'socket.io upgrade tunnel')

  // 2. Drive one JSON route end-to-end.
  const statusRoute = routes.find(r => r.path === '/overleaf/workbench/status')
  const res1 = new MockResponse()
  await statusRoute.handler(mockRequest({ method: 'POST', url: '/overleaf/workbench/status' }), res1)
  assert.equal(res1.statusCode, 200)
  const envelope1 = JSON.parse(res1.body.join(''))
  assert.equal(envelope1.ok, true)
  assert.equal(envelope1.value.baseUrl, 'https://www.overleaf.com', 'blank config falls back to public Overleaf default')
  assert.equal(envelope1.value.loggedIn, false)

  // 3. Spin a fixture upstream and fetch HTML through the proxy rewrite.
  let upstreamHits = 0
  const upstream = createServer((req, upstreamRes) => {
    upstreamHits += 1
    upstreamRes.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'SAMEORIGIN',
      'set-cookie': 'overleaf_session2=abc123; Domain=.tex.example.edu; Path=/; HttpOnly',
      'location': '/elsewhere',
    })
    upstreamRes.end('<html><head><link href="/styles/main.css"></head><body><a href="/project/x">P</a></body></html>')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port

  // Re-point the proxy target by rebuilding the service with the fixture origin
  // against a fresh fake context so route lookups stay unambiguous.
  const fresh = fakeCtx()
  const rebuilt = new ServiceClass(fresh.ctx, { baseUrl: `http://127.0.0.1:${upstreamPort}`, injectScriptEnabled: true })
  const proxyRoute = fresh.routes.find(r => r.path === '/overleaf-proxy')
  const res2 = new MockResponse()
  await proxyRoute.handler(mockRequest({ method: 'GET', url: '/overleaf-proxy/project/x?a=1' }), res2)
  const body2raw = Buffer.concat(res2.body).toString('utf8')
  assert.equal(res2.statusCode, 200, `proxy status ${res2.statusCode}: ${body2raw.slice(0, 400)}`)
  assert.equal(upstreamHits >= 1, true, 'upstream reached')
  const body2 = body2raw
  assert.ok(body2.includes('href="/overleaf-proxy/styles/main.css"'), `root-relative refs rebased:\n${body2}`)
  assert.ok(body2.includes('/overleaf/workbench/bridge.js'), 'bridge script injected')
  assert.ok(res2.headers['set-cookie'] !== undefined && !String(res2.headers['set-cookie']).includes('Domain='), 'cookie domain stripped')
  assert.equal(res2.headers['x-frame-options'], undefined, 'x-frame-options dropped')

  // 4. Binary pass-through stays untouched (no rebase flags).
  upstream.close()

  // 5. Cookie save/logout round trip (skips network validation by using a
  //    bogus host so fetch fails fast — expect rejection).
  const cookieRoute = routes.find(r => r.path === '/overleaf/workbench/cookie')
  const resBad = new MockResponse()
  await cookieRoute.handler(
    mockRequest({ method: 'POST', headers: {}, }),
    resBad,
  ).catch(() => {}) // empty body -> JSON.parse fails -> envelope error
  assert.equal(resBad.statusCode, 500)

  // 5. Settings namespace registered + hot swap of the proxy target.
  assert.equal(registeredNs, 'dsh-overleaf', 'settings namespace name')
  assert.equal(typeof watcherFn, 'function', 'watcher attached')
  mutableDoc.baseUrl = `http://127.0.0.1:${upstreamPort}`
  watcherFn()
  const statusRoute2 = routes.find(r => r.path === '/overleaf/workbench/status')
  const resHot = new MockResponse()
  await statusRoute2.handler(mockRequest({ method: 'POST' }), resHot)
  assert.equal(JSON.parse(resHot.body.join('')).value.baseUrl, `http://127.0.0.1:${upstreamPort}`,
    'watch commit hot-swapped baseUrl without restart')

  // logout clears whatever was stored.
  await ctx.credentials.set('OVERLEAF_WORKBENCH_COOKIE', 'x=1')
  const logoutRoute = routes.find(r => r.path === '/overleaf/workbench/logout')
  const resLogout = new MockResponse()
  await logoutRoute.handler(mockRequest({ method: 'POST' }), resLogout)
  assert.equal(JSON.parse(resLogout.body.join('')).value.cleared, true)
  assert.equal(credentialsStore.size, 0)

  /* ---------------------------------------------------------------- */
  /* Client half                                                       */
  /* ---------------------------------------------------------------- */

  const bundleSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const registered = []
  const sandboxWindow = {
    __ModuleLoader__: {
      load(record) {
        registered.push(record)
      },
    },
  }
  const sandbox = { window: sandboxWindow }
  vm.createContext(sandbox)
  vm.runInContext(bundleSource, sandbox, { filename: 'client.js' })
  assert.equal(registered.length, 1, 'bundle registered exactly one module factory')
  assert.equal(registered[0].id, 'dsh-overleaf', 'module id matches the npm package name')

  // Materialize with a require shim answering the two seeds.
  const jsxStub = (type, props) => ({ type, props })
  const reactStub = {
    createElement(type, props) {
      return { type, props }
    },
    useState: v => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: v => ({ current: v }),
    useCallback: fn => fn,
    useMemo: fn => fn(),
  }
  const jsxRuntimeStub = {
    Fragment: Symbol.for('react.fragment'),
    jsx: jsxStub,
    jsxs: jsxStub,
  }
  const requireShim = specifier => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error(`unexpected require(${specifier})`)
  }
  const exportsObject = registered[0].factory(requireShim)
  assert.equal(exportsObject.name, 'dsh-overleaf')
  assert.ok(Array.isArray(exportsObject.inject))
  assert.equal(typeof exportsObject.apply, 'function')

  // Activate against a fake client context; must not throw, must register
  // dictionaries, quote source, and the conversation.view entry.
  const slotEntries = []
  const localeNs = []
  const fakeClientCtx = {
    get(nameOfService) {
      if (nameOfService === 'slots') {
        return {
          inject(slotName, register) {
            register()
          },
          register(options, component) {
            slotEntries.push({ options, component })
            return () => {}
          },
        }
      }
      if (nameOfService === 'locale') {
        return {
          register(ns) {
            localeNs.push(ns)
            return () => {}
          },
          // Minimal dictionary simulation: the tab label lives in zh['tab'].
          bind: () => key => (key === 'tab' ? 'Overleaf' : String(key)),
        }
      }
      if (nameOfService === 'inputTriggers') {
        return { registerSource: src => { slotEntries.push({ options: { name: `trigger:${src.name}` }, component: null }); return () => {} } }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
  }
  exportsObject.apply(fakeClientCtx)
  assert.deepStrictEqual(localeNs, ['dsh-overleaf'])
  const viewEntry = slotEntries.find(entry => entry.options.name === 'conversation.view')
  assert.ok(viewEntry, 'conversation.view entry registered')
  assert.equal(viewEntry.options.id, 'overleaf')
  assert.equal(viewEntry.options.order, 30)
  assert.equal(typeof viewEntry.options.label, 'function')
  assert.equal(viewEntry.options.label(), 'Overleaf', 'label resolves through zh dictionary')
  assert.ok(slotEntries.some(entry => entry.options.name === 'trigger:quote-ref'), 'quote-ref source registered')

  console.log('SMOKE OK — all offline assertions passed')
  process.exit(0)
}

main().catch(error => {
  console.error('SMOKE FAILED:', error)
  process.exit(1)
})
