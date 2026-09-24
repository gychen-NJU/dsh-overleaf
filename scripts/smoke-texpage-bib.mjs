#!/usr/bin/env node
// Run: node --test --test-reporter=spec scripts/smoke-texpage-bib.mjs
// Actual exported adapter, serialized just like the bridge and run in a VM.
// Synthetic browser/HTTP fixtures only: no network, credentials, dependencies,
// real timers, browser session, build step, or filesystem writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createTexpageBibAdapter, renderTexpageBibAdapter } from '../src/texpage-bib.ts'
import { renderBridgeScript } from '../src/inject-script.ts'

const source = '(' + createTexpageBibAdapter.toString() + ')'
assert.equal(renderTexpageBibAdapter(), source, 'VM executes the same serialized factory as the bridge')
const program = new vm.Script(source + '(env)', { filename: 'generated-texpage-bib-adapter.js' })
const ORIGIN = 'http://127.0.0.1:3080'
const UPSTREAM = 'https://tex.nju.edu.cn'
const PREFIX = '/overleaf-proxy'
const TREE_PATH = PREFIX + '/api/project/fileTree'
// The server owns the authenticated download + credential-free, path-bound
// signed redirect. The browser adapter must only read this same-origin marker.
const FILE_PATH = PREFIX + '/__dsh_texpage_bib__'
// All identifiers are synthetic; 36-character shapes match the observed API.
const CTX = {
  ownerKey: '00000000-0000-4000-8000-000000000001',
  projectKey: '00000000-0000-4000-8000-000000000002',
  versionNo: '00000000-0000-4000-8000-000000000003',
}
const FILE = '00000000-0000-4000-8000-000000000004'
const OLD = '@article{old,\n  title = {Original 文献}\n}\n'
const NEW = '@book{new,\n  title = {Updated 文献},\n  year = {2026}\n}\n'
const MAX_BYTES = 2 * 1024 * 1024
const temporaryFailure = (status = 502, hint) => new Response('upstream unavailable', {
  status, headers: hint ? { 'x-dsh-bib-error': hint } : {},
})
const SNAPSHOT = `dsh-overleaf:bib-snapshot:${UPSTREAM}:${CTX.ownerKey}:${CTX.projectKey}:${CTX.versionNo}:${FILE}`
const copy = value => JSON.parse(JSON.stringify(value))
const row = (extra = {}) => ({
  fileKey: FILE, projectKey: CTX.projectKey, versionNo: CTX.versionNo,
  fileName: 'refs.bib', filePath: 'refs.bib', isDir: false, fileType: 'text/plain', parentKey: '0', ...extra,
})
const payload = (rows = [row()]) => ({ status: { code: 1 }, result: { treeData: rows } })
const treeUrl = (ctx = CTX, path = TREE_PATH) => path + '?' + new URLSearchParams(ctx)
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const textResponse = value => new Response(value, { headers: { 'content-type': 'text/plain; charset=utf-8' } })

class Clock {
  now = 1_700_000_000_000
  nextId = 0
  timers = new Map()
  setTimeout = (callback, delay = 0) => {
    const id = ++this.nextId
    this.timers.set(id, { callback, at: this.now + Math.max(0, Number(delay)) })
    return id
  }
  clearTimeout = id => this.timers.delete(id)
  tick() {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
    assert.ok(next, 'asynchronous adapter has a fake timer to advance')
    this.timers.delete(next[0])
    this.now = next[1].at
    next[1].callback()
  }
}

// Drain promise/stream microtasks before advancing time, so a resolved response
// is never mistaken for an eight-second fetch timeout. No wall-clock sleeps.
async function microtasks() { for (let i = 0; i < 80; i++) await Promise.resolve() }

class Node {
  selectors = new Map()
  clicks = 0
  textContent = ''
  constructor(f, classes = [], attrs = {}) {
    this.f = f
    this.classes = new Set(classes)
    this.attrs = attrs
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
    }
  }
  querySelector(selector) {
    if (!this.selectors.has(selector)) this.f.unknownSelectors.add(`node:${selector}`)
    return this.selectors.get(selector) ?? null
  }
  getAttribute(name) { return this.attrs[name] ?? null }
  click() { this.clicks += 1; this.onClick?.() }
  closest(selector) {
    if (selector !== '.ant-spin-nested-loading') this.f.unknownSelectors.add(`closest:${selector}`)
    return selector === '.ant-spin-nested-loading' ? this.ancestor ?? null : null
  }
}

function fixture(options = {}) {
  const f = {
    clock: new Clock(), messages: [], requests: [], events: [], trace: [], storage: new Map(),
    unknownSelectors: new Set(), violations: [], rows: options.rows ?? [row()], nodes: [],
    value: options.value ?? OLD, writes: [], focuses: 0, fileReads: 0, treeReads: 0,
    remote: options.remote ?? OLD, options,
  }
  const location = new URL(ORIGIN + PREFIX + `/project/user/${CTX.projectKey}/${CTX.versionNo}`)
  f.location = location
  f.footer = new Node(f)
  f.footer.textContent = options.footer ?? 'refs.bib'
  f.secondFooter = new Node(f)
  f.secondFooter.textContent = options.secondFooter ?? 'refs.bib'
  f.container = new Node(f)
  f.spinnerAncestor = new Node(f)
  f.spinnerAncestor.selectors.set('.ant-spin-spinning', options.spinner ? new Node(f) : null)
  f.container.ancestor = f.spinnerAncestor
  f.directory = options.hiddenDirectory ? null : new Node(f)
  f.filesTitle = new Node(f)
  f.filesTitle.textContent = options.filesTitle ?? 'Files'
  f.filesTitle.onClick = () => { f.directory = new Node(f) }
  f.addNode = (spec, nodeOptions = {}) => {
    const node = new Node(f, ['tree-node', ...(nodeOptions.selected === false ? [] : ['selected'])])
    node.fileKey = spec.fileKey
    node.filePath = spec.filePath
    node.visible = nodeOptions.visible !== false
    const title = new Node(f, [], { title: spec.filePath })
    node.selectors.set('.file-name [title]', title)
    node.selectors.set('.node-loading', nodeOptions.loading ? new Node(f) : null)
    const icon = spec.isDir ? new Node(f, nodeOptions.expanded ? ['open'] : []) : null
    node.selectors.set('.expand-icon-wrapper', icon)
    node.onClick = () => {
      if (spec.isDir) {
        icon.classList.add('open')
        for (const child of f.nodes) {
          if (f.rows.find(item => item.fileKey === child.fileKey)?.parentKey === spec.fileKey) child.visible = true
        }
      } else if (options.onOpen) options.onOpen(f, node)
      else f.select(node)
    }
    f.nodes.push(node)
    return node
  }
  f.select = node => {
    for (const item of f.nodes) item.classList.remove('selected')
    node.classList.add('selected')
    f.footer.textContent = node.filePath
  }
  for (const spec of options.domRows ?? f.rows) {
    if (spec && typeof spec.filePath === 'string') f.addNode(spec, {
      selected: options.selected, loading: options.loading,
      visible: options.nested ? spec.parentKey === '0' : true,
    })
  }
  f.document = {
    querySelector(selector) {
      switch (selector) {
        case '.project-directory': return f.directory
        case '.editor-footer-path-item': return f.footer
        case '.editor-container': return f.container
        default: f.unknownSelectors.add(`document:${selector}`); return null
      }
    },
    querySelectorAll(selector) {
      switch (selector) {
        case '.project-directory .tree-node': return f.directory ? f.nodes.filter(node => node.visible) : []
        case '.explorer-tab-title': return [f.filesTitle]
        // A second footer may show another piece of metadata; only the first
        // path item can identify the open document.
        case '.editor-footer-path-item': return [f.footer, f.secondFooter]
        default: f.unknownSelectors.add(`documentAll:${selector}`); return []
      }
    },
    addEventListener(type) { f.events.push(type) },
    removeEventListener() {},
  }
  f.window = {
    location, __DSH_OVERLEAF_UPSTREAM_ORIGIN__: UPSTREAM,
    __DSH_OVERLEAF_SOCKET_ORIGIN__: 'https://socket.tex.nju.edu.cn',
    addEventListener(type) { f.events.push(type) }, removeEventListener() {},
    localStorage: {
      setItem(key, value) {
        f.trace.push('snapshot:set')
        if (options.snapshotFailure === 'set') throw new Error('synthetic-storage-denied')
        if (options.snapshotFailure !== 'discard') f.storage.set(key, value)
      },
      getItem(key) {
        f.trace.push('snapshot:get')
        if (options.snapshotFailure === 'get') throw new Error('synthetic-storage-denied')
        if (options.snapshotFailure === 'mismatch') return 'synthetic-corrupt-snapshot'
        return f.storage.get(key) ?? null
      },
    },
  }
  f.view = {
    state: { doc: { toString: () => f.value } },
    dispatch(transaction) {
      f.trace.push('dispatch')
      f.writes.push(copy(transaction))
      if (options.writeThrows) throw new Error('synthetic-dispatch-failure')
      const { from, to, insert } = transaction.changes
      if (!options.dropWrite) f.value = f.value.slice(0, from) + insert + f.value.slice(to)
      if (options.partialWriteThrows) {
        f.value = insert.slice(0, Math.max(1, Math.floor(insert.length / 2)))
        throw new Error('synthetic-extension-throws-after-partial-update')
      }
      options.afterWrite?.(f)
    },
    focus() { f.focuses += 1 },
  }
  f.env = {
    editor: () => options.editor ? options.editor(f) : { engine: 'cm6', editor: f.view },
    report(message) {
      f.messages.push(copy(message))
      f.trace.push(message.type)
      options.onReport?.(f, message)
    },
    async fetch(rawUrl, init) {
      const url = new URL(rawUrl, location.origin)
      f.requests.push({ url, init })
      // Validate even in expected-error tests: assertions swallowed by the
      // adapter cannot accidentally turn a request-policy regression green.
      try {
        assert.equal(url.origin, ORIGIN, 'all reads remain same-origin')
        assert.equal(url.username + url.password, '', 'no URL credentials')
        assert.ok([TREE_PATH, FILE_PATH].includes(url.pathname), 'only file-tree API and the same-origin bibliography marker')
        assert.equal(url.hash, '', 'no fragment in API reads')
        assert.equal(init.method, 'GET')
        assert.equal(init.credentials, 'same-origin', 'never include credentials cross-origin')
        assert.equal(init.redirect, 'error', 'reject redirect before it can forward credentials')
        assert.equal(init.cache, 'no-store', 'readback bypasses caches')
        assert.ok(init.signal instanceof AbortSignal, 'every read is abortable')
        assert.equal(init.headers, undefined, 'no explicit credentials or copied request headers')
        assert.equal(init.body, undefined, 'reads never become API write requests')
        const keys = [...url.searchParams.keys()].sort()
        const isFile = url.pathname === FILE_PATH
        assert.deepEqual(keys, (isFile ? ['fileKey', ...Object.keys(CTX)] : Object.keys(CTX)).sort())
        for (const [key, value] of Object.entries(CTX)) {
          assert.equal(url.searchParams.get(key), value)
        }
        if (isFile) {
          assert.equal(url.searchParams.get('fileKey'), options.targetKey ?? FILE)
          assert.equal(url.searchParams.get('ownerKey'), CTX.ownerKey, 'marker retains owner for the server-bound signed download')
        }
      } catch (error) {
        f.violations.push(error.message)
        throw error
      }
      if (url.pathname === TREE_PATH) {
        f.treeReads += 1
        f.trace.push('fetch:tree')
        return options.treeResponse ? options.treeResponse(f, init) : jsonResponse(payload(f.rows))
      }
      f.fileReads += 1
      f.trace.push('fetch:file')
      if (options.fileResponse) return options.fileResponse(f, init)
      return textResponse(f.fileReads === 1 ? f.remote : options.persist === false ? f.remote : f.value)
    },
  }
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [f.clock.now])) }
    static now() { return f.clock.now }
  }
  f.context = vm.createContext({
    env: f.env, window: f.window, document: f.document, location,
    URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, Uint8Array,
    Date: FakeDate, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout,
  })
  f.adapter = program.runInContext(f.context, { timeout: 1_000 })
  if (options.observe !== false) f.adapter.observe(treeUrl(), payload(f.rows))
  f.results = () => f.messages.filter(message => message.type === 'bib-sync-done')
  f.settle = async promise => {
    let done = false
    let rejected
    promise.then(() => { done = true }, error => { done = true; rejected = error })
    for (let steps = 0; !done && steps < 1_000; steps++) {
      await microtasks()
      if (!done) f.clock.tick()
    }
    assert.equal(done, true, 'adapter promise settles with bounded fake time')
    assert.equal(rejected, undefined, 'sync reports errors instead of rejecting its promise')
    assert.equal(f.clock.timers.size, 0, 'all request-abort timers are cleaned up')
    assert.deepEqual([...f.unknownSelectors], [], 'all DOM selectors are explicitly modeled')
    assert.deepEqual(f.violations, [], 'every fetch obeys context and credential/redirect policy')
    assert.deepEqual(f.events, [], 'TeXPage must not depend on Overleaf document events')
    return f.results().at(-1)
  }
  f.sync = async (name = 'refs.bib', content = NEW) => {
    const before = f.results().length
    const result = await f.settle(f.adapter.sync(name, content))
    assert.equal(f.results().length, before + 1, 'exactly one completion per sync request')
    return result
  }
  return f
}

function noWrite(f, { snapshot = false } = {}) {
  assert.deepEqual(f.writes, [], 'no CodeMirror transaction')
  if (!snapshot) assert.ok(!f.trace.includes('snapshot:set'), 'no pre-write snapshot')
  assert.equal(f.focuses, 0)
}

for (const phase of ['tree', 'baseline', 'save']) {
  test(`transient ${phase} HTTP failure is retried once without duplicate writes`, async () => {
    const f = fixture({
      treeResponse: phase === 'tree' ? current => current.treeReads === 1 ? temporaryFailure(503) : jsonResponse(payload()) : undefined,
      fileResponse: phase === 'tree' ? undefined : current => {
        if (phase === 'baseline') return current.fileReads === 1 ? temporaryFailure(502, 'object-network') : textResponse(current.value)
        return current.fileReads === 2 ? temporaryFailure(502, 'object-http-503') : textResponse(current.value)
      },
    })
    assert.equal((await f.sync()).ok, true)
    assert.equal(f.writes.length, 1)
    assert.equal(f.value, NEW)
    assert.equal(f.treeReads, phase === 'tree' ? 2 : 1)
    assert.equal(f.fileReads, phase === 'tree' ? 2 : 3)
  })

  test(`persistent ${phase} failure reports stage and bounded attempts`, async () => {
    const f = fixture({
      treeResponse: phase === 'tree' ? () => temporaryFailure(503) : undefined,
      fileResponse: phase === 'tree' ? undefined : current => phase === 'baseline' || current.fileReads > 1 ? temporaryFailure(502, 'object-network') : textResponse(OLD),
    })
    const r = await f.sync()
    assert.equal(r.ok, false)
    assert.equal(r.diagnostic.phase, phase)
    assert.equal(r.diagnostic.attempts, 2)
    assert.equal(r.diagnostic.status, phase === 'tree' ? 503 : 502)
    assert.equal(f.treeReads, phase === 'tree' ? 2 : 1)
    assert.equal(f.fileReads, phase === 'tree' ? 0 : phase === 'baseline' ? 2 : 3)
    if (phase === 'save') { assert.equal(r.written, true); assert.equal(f.writes.length, 1) } else noWrite(f)
  })
}

for (const hint of ['site-http-401', 'site-http-403', 'object-http-403', 'redirect-target', 'object-mime', 'body-size', 'body-utf8']) {
  test(`nontransient proxy rejection ${hint} is never retried`, async () => {
    const f = fixture({ fileResponse: () => temporaryFailure(502, hint) })
    const r = await f.sync()
    assert.equal(r.ok, false)
    assert.equal(r.diagnostic.code, hint)
    assert.equal(r.diagnostic.attempts, 1)
    assert.equal(f.fileReads, 1)
    noWrite(f)
  })
}

test('transport failure recovery retries reads, not the CM6 transaction', async () => {
  const f = fixture({ fileResponse(current) {
    if (current.fileReads === 1 || current.fileReads === 3) throw new TypeError('synthetic temporary network failure')
    return textResponse(current.value)
  } })
  assert.equal((await f.sync()).ok, true)
  assert.equal(f.fileReads, 4)
  assert.equal(f.writes.length, 1)
})

test('unknown remote diagnostics cannot leak URLs or secrets', async () => {
  const f = fixture({ fileResponse: () => temporaryFailure(403, 'https://evil.test/?signature=private') })
  const r = await f.sync()
  assert.deepEqual(r.diagnostic, { phase: 'baseline', status: 403, code: 'http', attempts: 1 })
  assert.equal(f.fileReads, 1)
  noWrite(f)
})

test('retry shares the first read deadline rather than extending it', async () => {
  const f = fixture({ fileResponse(current, init) {
    if (current.fileReads === 1) return temporaryFailure()
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic timeout'))))
  } })
  const r = await f.sync()
  assert.equal(r.diagnostic.code, 'timeout')
  assert.equal(r.diagnostic.attempts, 2)
  assert.equal(f.fileReads, 2)
  const requests = f.requests.filter(r => r.url.pathname === FILE_PATH)
  assert.equal(requests[0].init.signal, requests[1].init.signal, 'same total budget and abort signal')
  noWrite(f)
})

async function rejected(f, error, name = 'refs.bib', content = NEW) {
  const result = await f.sync(name, content)
  assert.equal(result.ok, false)
  assert.equal(result.error, error)
  noWrite(f)
  return result
}

test('factory exposes the planned API and recognizes the announced TeXPage page', () => {
  const f = fixture()
  assert.deepEqual(Object.keys(f.adapter).sort(), ['enabled', 'observe', 'sync'])
  assert.equal(f.adapter.enabled(), true)
  assert.equal(f.requests.length, 0, 'observe only captures context; it does not fetch or write')
})

for (const [label, upstream, socket, pathname] of [
  ['Overleaf without TeXPage metadata', 'https://www.overleaf.com', undefined],
  ['Overleaf with TeXPage socket metadata', 'https://www.overleaf.com', 'https://socket.tex.nju.edu.cn'],
  ['missing socket', UPSTREAM, undefined],
  ['missing upstream', undefined, 'https://socket.tex.nju.edu.cn'],
  ['wrong socket host', UPSTREAM, 'https://socket.evil.test'],
  ['lookalike socket host', UPSTREAM, 'https://socket.tex.nju.edu.cn.evil.test'],
  ['socket protocol mismatch', UPSTREAM, 'http://socket.tex.nju.edu.cn'],
  ['custom upstream port', UPSTREAM + ':444', 'https://socket.tex.nju.edu.cn'],
  ['custom socket port', UPSTREAM, 'https://socket.tex.nju.edu.cn:444'],
  ['non-HTTP upstream', 'file:///tmp', 'file:///tmp'],
  ['non-project page', UPSTREAM, 'https://socket.tex.nju.edu.cn', '/overleaf-proxy/console'],
]) {
  test(`enabled gate rejects ${label}`, async () => {
    const f = fixture({ observe: false })
    f.window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ = upstream
    f.window.__DSH_OVERLEAF_SOCKET_ORIGIN__ = socket
    if (pathname) f.location.pathname = pathname
    assert.equal(f.adapter.enabled(), false)
    f.adapter.observe(treeUrl(), payload())
    await rejected(f, 'bib-texpage-context-unavailable')
    assert.equal(f.requests.length, 0)
  })
}

for (const path of [TREE_PATH, '/api/project/fileTree', ORIGIN + TREE_PATH]) {
  test(`observe accepts authentic same-origin fileTree URL: ${path}`, async () => {
    const f = fixture({ observe: false })
    f.adapter.observe(treeUrl(CTX, path), payload())
    assert.equal((await f.sync()).ok, true)
  })
}

for (const [label, url, json] of [
  ['unobserved context', null, null],
  ['external URL', treeUrl(CTX, 'https://evil.test' + TREE_PATH), payload()],
  ['upstream origin is not the proxy origin', treeUrl(CTX, UPSTREAM + '/api/project/fileTree'), payload()],
  ['protocol-relative external URL', treeUrl(CTX, '//evil.test' + TREE_PATH), payload()],
  ['different port', treeUrl(CTX, 'http://127.0.0.1:3081' + TREE_PATH), payload()],
  ['bibliography marker is not an observed tree', treeUrl(CTX, FILE_PATH), payload()],
  ['direct file API is not an observed tree', treeUrl(CTX, PREFIX + '/api/project/file'), payload()],
  ['lookalike path', treeUrl(CTX, TREE_PATH + '/extra'), payload()],
  ['missing owner', treeUrl({ projectKey: CTX.projectKey, versionNo: CTX.versionNo }), payload()],
  ['unsafe owner', treeUrl({ ...CTX, ownerKey: '../owner' }), payload()],
  ['different project', treeUrl({ ...CTX, projectKey: 'other-project' }), payload()],
  ['different version', treeUrl({ ...CTX, versionNo: 'other-version' }), payload()],
  ['missing version', treeUrl({ ownerKey: CTX.ownerKey, projectKey: CTX.projectKey }), payload()],
  ['unsafe version', treeUrl({ ...CTX, versionNo: '../version' }), payload()],
  ['empty version', treeUrl({ ...CTX, versionNo: '' }), payload()],
  ['overlong version', treeUrl({ ...CTX, versionNo: 'v'.repeat(129) }), payload()],
  ['non-success payload', treeUrl(), { status: { code: 0 }, result: { treeData: [] } }],
  ['string success code', treeUrl(), { status: { code: '1' }, result: { treeData: [] } }],
  ['malformed treeData', treeUrl(), { status: { code: 1 }, result: { treeData: {} } }],
  ['null JSON', treeUrl(), null],
]) {
  test(`context rejects ${label} without fetching`, async () => {
    const f = fixture({ observe: false })
    if (url !== null) f.adapter.observe(url, json)
    await rejected(f, 'bib-texpage-context-unavailable')
    assert.equal(f.requests.length, 0)
  })
}

test('unrelated observation cannot replace an already valid context', async () => {
  const f = fixture()
  f.adapter.observe(treeUrl({ ...CTX, projectKey: 'other-project' }), payload())
  f.adapter.observe(treeUrl(CTX, 'https://evil.test' + TREE_PATH), payload())
  assert.equal((await f.sync()).ok, true)
})

test('project/version route does not infer owner; tree and bibliography marker retain observed ownerKey', async () => {
  const f = fixture()
  assert.equal(f.adapter.enabled(), true)
  assert.equal(f.location.pathname, PREFIX + `/project/user/${CTX.projectKey}/${CTX.versionNo}`)
  assert.equal(f.location.pathname.includes(CTX.ownerKey), false)
  assert.equal((await f.sync()).ok, true)
  for (const { url } of f.requests) {
    assert.equal(url.searchParams.get('ownerKey'), CTX.ownerKey)
  }
  assert.deepEqual(f.requests.map(({ url }) => url.pathname), [TREE_PATH, FILE_PATH, FILE_PATH])
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).ownerKey, CTX.ownerKey)
})

test('changed CM6 content snapshots before one transaction and confirms via remote readback', async () => {
  const f = fixture({ selected: false })
  const result = await f.sync()
  assert.deepEqual(result, { type: 'bib-sync-done', ok: true, target: 'refs.bib', chars: NEW.length })
  assert.equal(f.value, NEW)
  assert.equal(f.nodes[0].clicks, 1)
  assert.equal(f.focuses, 1)
  assert.equal(f.treeReads, 1)
  assert.equal(f.fileReads, 2, 'baseline and persistence are separate requests')
  assert.deepEqual(f.writes, [{ changes: { from: 0, to: OLD.length, insert: NEW }, selection: { anchor: NEW.length } }])
  const snapshot = JSON.parse(f.storage.get(SNAPSHOT))
  assert.equal(typeof snapshot.time, 'number')
  const { time, ...rest } = snapshot
  assert.deepEqual(rest, { ...CTX, docId: FILE, path: 'refs.bib', engine: 'cm6', doc: OLD })
  assert.deepEqual(f.trace, ['fetch:tree', 'fetch:file', 'snapshot:set', 'snapshot:get', 'snapshot-saved', 'dispatch', 'fetch:file', 'bib-sync-done'])
})

test('unchanged content verifies the remote baseline but makes no snapshot or transaction', async () => {
  const f = fixture({ value: NEW, remote: NEW, snapshotFailure: 'set' })
  assert.deepEqual(await f.sync(), { type: 'bib-sync-done', ok: true, target: 'refs.bib', chars: NEW.length, unchanged: true })
  noWrite(f)
  assert.equal(f.fileReads, 1)
  assert.equal(f.nodes[0].clicks, 0)
})

for (const [label, value, remote, content, unchanged] of [
  ['CRLF local input', OLD, OLD, NEW.replaceAll('\n', '\r\n'), false],
  ['CR-only local input', OLD, OLD, NEW.replaceAll('\n', '\r'), false],
  ['CRLF remote baseline', OLD, OLD.replaceAll('\n', '\r\n'), NEW, false],
  ['CRLF editor baseline', OLD.replaceAll('\n', '\r\n'), OLD, NEW, false],
  ['normalized no-op', NEW, NEW.replaceAll('\n', '\r\n'), NEW.replaceAll('\n', '\r\n'), true],
]) {
  test(`${label} uses normalized content and preserves original snapshot bytes`, async () => {
    const f = fixture({ value, remote })
    const result = await f.sync('refs.bib', content)
    assert.equal(result.ok, true)
    assert.equal(result.unchanged, unchanged ? true : undefined)
    assert.equal(result.chars, NEW.length)
    if (unchanged) noWrite(f)
    else {
      assert.equal(f.value, NEW)
      assert.equal(f.writes[0].changes.to, value.length)
      assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, value)
    }
  })
}

test('CRLF remote readback confirms persistence of normalized text', async () => {
  const f = fixture({ fileResponse: current => textResponse(current.fileReads === 1 ? OLD : NEW.replaceAll('\n', '\r\n')) })
  assert.equal((await f.sync()).ok, true)
})

test('explicit empty content clears the document only after snapshot and remote confirmation', async () => {
  const f = fixture()
  const result = await f.sync('refs.bib', '')
  assert.equal(result.ok, true)
  assert.equal(result.chars, 0)
  assert.equal(f.value, '')
  assert.deepEqual(f.writes, [{ changes: { from: 0, to: OLD.length, insert: '' }, selection: { anchor: 0 } }])
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
  assert.equal(f.fileReads, 2)
})

for (const snapshotFailure of ['set', 'get', 'discard', 'mismatch']) {
  test(`snapshot ${snapshotFailure} failure prevents every write`, async () => {
    const f = fixture({ snapshotFailure })
    const result = await f.sync()
    assert.equal(result.error, 'bib-snapshot-failed')
    assert.equal(result.ok, false)
    assert.equal(result.written, false)
    noWrite(f, { snapshot: true })
    assert.equal(f.value, OLD)
    assert.equal(f.fileReads, 1)
    assert.equal(f.messages.some(message => message.type === 'snapshot-saved'), false)
  })
}

for (const [label, rows, name, target] of [
  ['unique same name', [row(), row({ fileKey: 'other', fileName: 'other.bib', filePath: 'other.bib' })], 'refs.bib', 'refs.bib'],
  ['exact-case precedence', [row(), row({ fileKey: 'other', fileName: 'REFS.BIB', filePath: 'REFS.BIB' })], 'refs.bib', 'refs.bib'],
  ['case-insensitive fallback', [row({ fileName: 'REFS.BIB', filePath: 'REFS.BIB' })], 'refs.bib', 'REFS.BIB'],
  ['trimmed requested name', [row()], ' refs.bib ', 'refs.bib'],
]) {
  test(`target selection: ${label}`, async () => {
    const f = fixture({ rows, selected: false })
    const result = await f.sync(name)
    assert.equal(result.ok, true)
    assert.equal(result.target, target)
    assert.equal(f.nodes[0].clicks, 1)
    assert.ok(f.nodes.slice(1).every(node => node.clicks === 0))
  })
}

for (const [label, rows, name, error] of [
  ['duplicate basenames across folders', [row({ filePath: 'one/refs.bib' }), row({ fileKey: 'other', filePath: 'two/refs.bib' })], 'refs.bib', 'bib-target-ambiguous'],
  ['case-insensitive ambiguity', [row({ fileName: 'Refs.bib', filePath: 'Refs.bib' }), row({ fileKey: 'other', fileName: 'refs.BIB', filePath: 'refs.BIB' })], 'REFS.BIB', 'bib-target-ambiguous'],
  ['different name despite sole bib', [row()], 'missing.bib', 'bib-target-missing'],
  ['empty tree', [], 'refs.bib', 'bib-target-missing'],
  ['directory named bib', [row({ isDir: true })], 'refs.bib', 'bib-target-missing'],
  ['binary file named bib', [row({ fileType: 'application/octet-stream' })], 'refs.bib', 'bib-target-missing'],
  ['non-bibliography file', [row({ fileName: 'main.tex', filePath: 'main.tex' })], 'refs.bib', 'bib-target-missing'],
]) {
  test(`${label} rejects without opening a node`, async () => {
    const f = fixture({ rows })
    await rejected(f, error, name)
    assert.equal(f.fileReads, 0)
    assert.ok(f.nodes.every(node => node.clicks === 0))
  })
}

test('sync refreshes the tree instead of trusting the observed response as a file cache', async () => {
  const f = fixture({ rows: [] })
  f.adapter.observe(treeUrl(), payload([row()]))
  await rejected(f, 'bib-target-missing')
  assert.equal(f.treeReads, 1)
})

for (const name of ['', 'refs.tex', '../refs.bib', '/refs.bib', 'folder/refs.bib', 'folder\\refs.bib', 'bad\u0000refs.bib']) {
  test(`unsafe/non-bib requested name rejects: ${JSON.stringify(name)}`, async () => {
    const f = fixture()
    await rejected(f, 'bib-invalid-name', name)
    assert.equal(f.requests.length, 0)
  })
}

for (const [label, change] of [
  ['different project', { projectKey: 'other-project' }],
  ['different version', { versionNo: '2' }],
  ['numeric instead of string version', { versionNo: 1 }],
  ['unsafe file key', { fileKey: '../file' }],
  ['missing file key', { fileKey: undefined }],
  ['null file key', { fileKey: null }],
  ['non-string file key', { fileKey: 17 }],
  ['empty file key', { fileKey: '' }],
  ['overlong file key', { fileKey: 'f'.repeat(129) }],
  ['absolute path', { filePath: '/refs.bib' }],
  ['empty segment', { filePath: 'folder//refs.bib' }],
  ['parent traversal', { filePath: '../refs.bib' }],
  ['dot segment', { filePath: './refs.bib' }],
  ['backslash path', { filePath: 'folder\\refs.bib' }],
  ['control character', { filePath: 'folder\u0000/refs.bib' }],
  ['overlong path', { filePath: 'p'.repeat(2048) + '/refs.bib' }],
  ['basename/path mismatch', { filePath: 'folder/other.bib' }],
]) {
  test(`refreshed tree rejects ${label}`, async () => {
    const f = fixture({ rows: [row(change)] })
    await rejected(f, 'bib-target-ambiguous')
    assert.equal(f.fileReads, 0)
  })
}

test('duplicate file keys reject even when filenames differ', async () => {
  const f = fixture({ rows: [row(), row({ fileName: 'other.bib', filePath: 'other.bib' })] })
  await rejected(f, 'bib-target-ambiguous')
})

test('folder ancestors expand from root to leaf using full path titles', async () => {
  const folder = row({ fileKey: 'folder', fileName: 'references', filePath: 'references', isDir: true })
  const subfolder = row({ fileKey: 'subfolder', fileName: 'nested', filePath: 'references/nested', parentKey: 'folder', isDir: true })
  const target = row({ filePath: 'references/nested/refs.bib', parentKey: 'subfolder' })
  const f = fixture({ rows: [folder, subfolder, target], nested: true, selected: false })
  assert.equal((await f.sync()).ok, true)
  assert.deepEqual(f.nodes.map(node => node.clicks), [1, 1, 1])
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).path, target.filePath)
})

test('collapsed Files section is reopened through its labelled title', async () => {
  const f = fixture({ hiddenDirectory: true })
  assert.equal((await f.sync()).ok, true)
  assert.equal(f.filesTitle.clicks, 1)
})

for (const [label, rows, error] of [
  ['missing parent', [row({ parentKey: 'missing' })], 'bib-target-missing'],
  ['parent cycle', [row({ parentKey: 'folder' }), row({ fileKey: 'folder', fileName: 'folder', filePath: 'folder', isDir: true, parentKey: 'folder' })], 'bib-target-ambiguous'],
]) {
  test(`${label} in folder hierarchy refuses opening`, async () => {
    const f = fixture({ rows })
    await rejected(f, error)
  })
}

for (const [label, options, error] of [
  ['no target DOM row', { domRows: [] }, 'bib-target-missing'],
  ['duplicate target DOM rows', { domRows: [row(), row()] }, 'bib-target-ambiguous'],
  ['selected row without matching footer', { footer: 'other.bib', secondFooter: 'refs.bib' }, 'bib-editor-timeout'],
  ['footer without selected row', { selected: false, onOpen() {} }, 'bib-editor-timeout'],
  ['node-loading marker', { loading: true }, 'bib-editor-timeout'],
  ['editor loading spinner', { spinner: true }, 'bib-editor-timeout'],
]) {
  test(`identity guard rejects ${label}`, async () => {
    const f = fixture(options)
    await rejected(f, error)
    assert.equal(f.fileReads, 0)
  })
}

test('loading row and spinner must both clear before the remote baseline is read', async () => {
  const f = fixture({ loading: true, spinner: true })
  f.clock.setTimeout(() => f.nodes[0].selectors.set('.node-loading', null), 300)
  f.clock.setTimeout(() => {
    assert.equal(f.fileReads, 0)
    f.spinnerAncestor.selectors.set('.ant-spin-spinning', null)
  }, 600)
  assert.equal((await f.sync()).ok, true)
})

for (const [label, editor, error] of [
  ['CM5', f => ({ engine: 'cm5', editor: f.view }), 'bib-editor-unavailable'],
  ['missing EditorView', () => ({ engine: 'cm6' }), 'bib-editor-unavailable'],
  ['read-only/unavailable', () => ({ error: 'bib-editor-unavailable' }), 'bib-editor-unavailable'],
  ['multiple editable views', () => ({ error: 'bib-editor-ambiguous' }), 'bib-editor-ambiguous'],
]) {
  test(`editor resolver rejects ${label}`, async () => {
    const f = fixture({ editor })
    await rejected(f, error)
  })
}

test('remote baseline mismatch preserves unsaved local editor content', async () => {
  const f = fixture({ remote: '@article{concurrent-remote-change}\n' })
  await rejected(f, 'bib-remote-changed')
  assert.equal(f.value, OLD)
})

test('matching requested text is not a no-op when remote baseline differs', async () => {
  const f = fixture({ value: NEW, remote: OLD })
  await rejected(f, 'bib-remote-changed')
})

const switchers = [
  ['selected document', f => { f.nodes[0].classList.remove('selected') }],
  ['footer path', f => { f.footer.textContent = 'other.bib' }],
  ['editor instance', f => { f.view = { ...f.view } }],
  ['editor content', f => { f.value = '@article{user-edit}\n' }],
  ['node-loading barrier', f => { f.nodes[0].selectors.set('.node-loading', new Node(f)) }],
  ['editor spinner barrier', f => { f.spinnerAncestor.selectors.set('.ant-spin-spinning', new Node(f)) }],
  ['page project', f => { f.location.pathname = PREFIX + `/project/user/other-project/${CTX.versionNo}` }],
  ['page version', f => { f.location.pathname = PREFIX + `/project/user/${CTX.projectKey}/other-version` }],
  ['observed owner', f => { f.adapter.observe(treeUrl({ ...CTX, ownerKey: 'other-owner' }), payload()) }],
]

test('project navigation during tree refresh refuses opening or reading a file', async () => {
  const f = fixture({ treeResponse(current) {
    current.location.pathname = PREFIX + `/project/user/other-project/${CTX.versionNo}`
    return jsonResponse(payload())
  } })
  await rejected(f, 'bib-document-changed')
  assert.equal(f.fileReads, 0)
  assert.ok(f.nodes.every(node => node.clicks === 0))
})

for (const [label, change] of switchers) {
  test(`changing ${label} during baseline read refuses mutation`, async () => {
    const f = fixture({ fileResponse(current) { change(current); return textResponse(OLD) } })
    await rejected(f, 'bib-document-changed')
  })

  test(`changing ${label} after snapshot refuses mutation`, async () => {
    const f = fixture({ onReport(current, message) { if (message.type === 'snapshot-saved') change(current) } })
    const result = await f.sync()
    assert.equal(result.error, 'bib-document-changed')
    assert.equal(result.written, false)
    noWrite(f, { snapshot: true })
    assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
  })

  test(`changing ${label} during remote readback never claims saved success`, async () => {
    const f = fixture({ fileResponse(current) {
      if (current.fileReads > 1) change(current)
      return textResponse(current.fileReads === 1 ? OLD : NEW)
    } })
    const result = await f.sync()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'bib-document-changed')
    assert.equal(result.written, true)
    assert.equal(f.writes.length, 1, 'never auto-rollback or write twice')
  })
}

test('drop/ignore CM6 dispatch fails verification with recoverable snapshot', async () => {
  const f = fixture({ dropWrite: true })
  const result = await f.sync()
  assert.equal(result.error, 'bib-write-verification-failed')
  assert.equal(result.ok, false)
  assert.equal(result.written, true)
  assert.equal(f.value, OLD)
  assert.equal(f.writes.length, 1)
  assert.equal(f.fileReads, 1)
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
})

test('CM6 dispatch exception reports failure and retains snapshot', async () => {
  const f = fixture({ writeThrows: true })
  const result = await f.sync()
  assert.equal(result.ok, false)
  assert.equal(result.written, true, 'dispatch may mutate before throwing; never claim no changes')
  assert.equal(f.value, OLD)
  assert.equal(f.writes.length, 1)
  assert.equal(f.fileReads, 1)
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
})

test('partially applied CM6 transaction that throws reports written and never auto-rolls back', async () => {
  const f = fixture({ partialWriteThrows: true })
  const result = await f.sync()
  assert.equal(result.ok, false)
  assert.equal(result.written, true)
  assert.notEqual(f.value, OLD, 'fixture models an extension throwing after mutation')
  assert.notEqual(f.value, NEW, 'fixture leaves only a partially applied update')
  assert.equal(f.writes.length, 1, 'no blind retry or automatic rollback after partial change')
  assert.equal(f.fileReads, 1, 'no false remote-save confirmation after dispatch failure')
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
})

test('remote readback may lag, but success waits for exact expected text', async () => {
  const f = fixture({ fileResponse(current) {
    assert.equal(current.results().length, 0, 'no premature success before confirmed remote bytes')
    return textResponse(current.fileReads < 4 ? OLD : NEW)
  } })
  assert.equal((await f.sync()).ok, true)
  assert.equal(f.fileReads, 4)
  assert.equal(f.writes.length, 1)
})

test('remote readback timeout retains local edit/snapshot without retries or rollback', async () => {
  const f = fixture({ persist: false })
  const result = await f.sync()
  assert.equal(result.error, 'bib-save-timeout')
  assert.equal(result.ok, false)
  assert.equal(result.written, true)
  assert.equal(f.value, NEW)
  assert.equal(f.writes.length, 1)
  assert.ok(f.fileReads > 1 && f.fileReads <= 110, 'bounded persistence polling')
  assert.ok(f.clock.now >= 1_700_000_015_000, 'save deadline advanced by fake time')
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).doc, OLD)
})

for (const stage of ['tree', 'baseline', 'readback']) {
  for (const [label, response] of [
    ['non-OK response', () => new Response('denied', { status: 403 })],
    ['HTML login response', () => new Response('<html>synthetic login</html>', { headers: { 'content-type': 'text/html' } })],
    ['missing response body', () => new Response(null, { headers: { 'content-type': stage === 'tree' ? 'application/json' : 'text/plain' } })],
    ['redirect refused by transport', () => { throw new TypeError('synthetic redirect blocked') }],
  ]) {
    test(`${stage}: ${label} cannot report successful sync`, async () => {
      const f = fixture({
        treeResponse: stage === 'tree' ? response : undefined,
        fileResponse: stage === 'tree' ? undefined : current => {
          if (stage === 'baseline' || current.fileReads > 1) return response()
          return textResponse(OLD)
        },
      })
      const result = await f.sync()
      assert.equal(result.ok, false)
      assert.equal(result.error, 'bib-remote-read-failed')
      assert.equal(result.written, stage === 'readback')
      if (stage === 'readback') assert.equal(f.writes.length, 1)
      else noWrite(f)
    })
  }
}

for (const stage of ['baseline', 'readback']) {
  for (const code of [1001, 1]) {
    test(`${stage}: HTTP-200 JSON status ${code} is never bibliography text`, async () => {
      const f = fixture({ fileResponse(current) {
        if (stage === 'baseline' || current.fileReads > 1) {
          return jsonResponse({ status: { code }, result: [{ fileKey: FILE }] })
        }
        return textResponse(OLD)
      } })
      const result = await f.sync()
      assert.equal(result.ok, false)
      assert.equal(result.error, 'bib-remote-read-failed')
      assert.equal(result.written, stage === 'readback')
      if (stage === 'baseline') noWrite(f)
      else assert.equal(f.writes.length, 1)
    })
  }
}

for (const stage of ['baseline', 'readback']) {
  test(`${stage}: signed download redirect must never be followed by the browser adapter`, async () => {
    const signedUrl = `https://latex-file.texpageusercontent.com/${CTX.ownerKey}/${FILE}_${CTX.versionNo}?synthetic-signature=test`
    const f = fixture({ fileResponse(current) {
      if (stage === 'baseline' || current.fileReads > 1) {
        return new Response(null, { status: 302, headers: { location: signedUrl } })
      }
      return textResponse(OLD)
    } })
    const result = await f.sync()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'bib-remote-read-failed')
    assert.equal(result.written, stage === 'readback')
    assert.ok(f.requests.every(({ url }) => url.origin === ORIGIN))
    assert.ok(f.requests.every(({ init }) => init.redirect === 'error'))
    if (stage === 'baseline') noWrite(f)
    else assert.equal(f.writes.length, 1)
  })
}

test('hung transport is aborted by fake deadline without credentials or a write', async () => {
  let aborted = false
  const f = fixture({ treeResponse(_current, init) {
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('synthetic aborted request'))
    }, { once: true }))
  } })
  await rejected(f, 'bib-remote-read-failed')
  assert.equal(aborted, true)
  assert.equal(f.clock.now, 1_700_000_008_000)
})

test('hung bibliography marker read has a bounded 20-second fake deadline', async () => {
  let aborted = false
  const f = fixture({ fileResponse(_current, init) {
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('synthetic marker request aborted'))
    }, { once: true }))
  } })
  await rejected(f, 'bib-remote-read-failed')
  assert.equal(aborted, true)
  assert.equal(f.clock.now, 1_700_000_020_000)
  assert.equal(f.requests.at(-1).url.pathname, FILE_PATH)
})

for (const type of ['application/octet-stream', 'application/x-bibtex', 'text/x-bibtex']) {
  test(`legitimate bibliography MIME ${type} is accepted`, async () => {
    const f = fixture({ fileResponse: current => new Response(current.fileReads === 1 ? OLD : NEW, { headers: { 'content-type': type } }) })
    assert.equal((await f.sync()).ok, true)
  })
}

test('malformed UTF-8 remote content rejects without replacement', async () => {
  const f = fixture({ fileResponse: () => textResponse(new Uint8Array([0xc3, 0x28])) })
  await rejected(f, 'bib-remote-read-failed')
})

test('UTF-8 split across streamed chunks decodes to the exact baseline and saved text', async () => {
  const f = fixture({ fileResponse(current) {
    const bytes = new TextEncoder().encode(current.fileReads === 1 ? OLD : NEW)
    const firstMultibyte = bytes.findIndex(value => value > 127)
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, firstMultibyte + 1))
      controller.enqueue(bytes.slice(firstMultibyte + 1, firstMultibyte + 2))
      controller.enqueue(bytes.slice(firstMultibyte + 2))
      controller.close()
    } })
    return new Response(body, { headers: { 'content-type': 'text/plain' } })
  } })
  assert.equal((await f.sync()).ok, true)
  assert.equal(f.value, NEW)
})

for (const declared of [true, false]) {
  test(`remote byte bound rejects ${declared ? 'declared' : 'streamed'} oversized file`, async () => {
    const f = fixture({ fileResponse: () => new Response(declared ? 'small body' : 'x'.repeat(MAX_BYTES + 1), {
      headers: { 'content-type': 'text/plain', ...(declared ? { 'content-length': String(MAX_BYTES + 1) } : {}) },
    }) })
    await rejected(f, 'bib-file-too-large')
  })
}

test('local UTF-8 byte bound rejects oversized input before any read', async () => {
  const f = fixture()
  const oversized = '文'.repeat(Math.floor(MAX_BYTES / 3) + 1)
  assert.ok(oversized.length < MAX_BYTES, 'byte bound differs from JavaScript string length')
  await rejected(f, 'bib-file-too-large', 'refs.bib', oversized)
  assert.equal(f.requests.length, 0)
})

test('refresh with malformed JSON rejects without write', async () => {
  const f = fixture({ treeResponse: () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }) })
  await rejected(f, 'bib-remote-read-failed')
})

for (const data of [
  { status: { code: 0 }, result: { treeData: [row()] } },
  { status: { code: 1 }, result: { treeData: null } },
  payload(Array.from({ length: 10_001 }, () => row())),
]) {
  test(`unsuccessful/malformed/oversized refreshed tree (${data.result.treeData?.length ?? 'null'} rows) refuses write`, async () => {
    const f = fixture({ treeResponse: () => jsonResponse(data) })
    await rejected(f, 'bib-target-missing')
    assert.equal(f.fileReads, 0)
  })
}

test('tree response has a separate bounded byte budget', async () => {
  const f = fixture({ treeResponse: () => new Response('{}', {
    headers: { 'content-type': 'application/json', 'content-length': String(4 * MAX_BYTES + 1) },
  }) })
  await rejected(f, 'bib-file-too-large')
})

test('busy synchronization rejects a second request and releases its lock afterward', async () => {
  const f = fixture()
  const first = f.adapter.sync('refs.bib', NEW)
  await f.adapter.sync('refs.bib', '@book{must-not-write}\n')
  assert.equal(f.results()[0].error, 'bib-sync-busy')
  const result = await f.settle(first)
  assert.equal(result.ok, true)
  assert.equal(f.results().length, 2)
  assert.equal(f.writes.length, 1)
  f.remote = NEW
  assert.equal((await f.sync()).unchanged, true)
  assert.equal(f.writes.length, 1)
})

// Exercise the actual generated fetch/XHR observers, in addition to the factory
// in isolation. This catches routing/observation gaps behind context-unavailable.
const bridge = renderBridgeScript()
function bridgeSection(startMarker, endMarker) {
  const start = bridge.indexOf(startMarker)
  const end = bridge.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `generated integration range exists: ${startMarker}`)
  return bridge.slice(start, end)
}
const observerProgram = new vm.Script(
  bridgeSection('  function routeUrl(raw)', '  /* ---------------------------------------------------------------- */')
  + bridgeSection('  function pathnameOf(rawUrl)', '  function isCompilePost(rawUrl)')
  + bridgeSection('  var texpageBib = ', '  /* EventSource wrapper.'),
  { filename: 'generated-texpage-bib-observers.js' },
)

function observerFixture() {
  const f = fixture({ observe: false })
  f.bootstrapping = true
  f.bootstrapRequests = []
  f.window.fetch = async (input, init) => {
    if (!f.bootstrapping) return f.env.fetch(input, init)
    const url = new URL(input instanceof Request ? input.url : input, ORIGIN)
    assert.equal(url.origin, ORIGIN)
    assert.equal(url.pathname, TREE_PATH)
    f.bootstrapRequests.push(url)
    return f.bootstrapResponse ? f.bootstrapResponse() : jsonResponse(payload())
  }
  class XHR {
    listeners = new Map()
    open(method, url) { this.method = method; this.url = url }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    }
    respond(status, body) {
      this.status = status
      this.responseText = JSON.stringify(body)
      this.readyState = 4
      for (const fn of this.listeners.get('readystatechange') ?? []) fn()
    }
  }
  f.window.XMLHttpRequest = XHR
  Object.assign(f.context, {
    Request, PREFIX, DEBUG: false, log() {}, markDiagnostic() {},
    safe: fn => fn, compileGeneration: 0,
    isProxyUrl: value => typeof value === 'string' && value.startsWith(PREFIX + '/'),
    contentOrigin: () => '',
    isCompilePost: () => false, isCachedCompileResponse: () => false,
    isCompileLog: () => false, isOutputPdf: () => false,
    currentEditableBibEditor: f.env.editor, sendToParent: f.env.report,
  })
  observerProgram.runInContext(f.context, { timeout: 1_000 })
  f.adapter = f.context.texpageBib
  return f
}

for (const [label, input] of [
  ['root-relative string', () => treeUrl(CTX, '/api/project/fileTree')],
  ['already-proxied string', () => treeUrl()],
  ['absolute upstream string', () => treeUrl(CTX, UPSTREAM + '/api/project/fileTree')],
  ['Request object', () => new Request(treeUrl(CTX, UPSTREAM + '/api/project/fileTree'))],
  ['URL object', () => new URL(treeUrl(CTX, UPSTREAM + '/api/project/fileTree'))],
]) {
  test(`generated fetch observer captures context from ${label}`, async () => {
    const f = observerFixture()
    await f.window.fetch(input())
    await microtasks()
    f.bootstrapping = false
    const result = await f.sync()
    assert.equal(result.ok, true, `observer must supply usable context: ${JSON.stringify(result)}`)
    assert.equal(f.bootstrapRequests.length, 1)
    assert.equal(f.treeReads, 1, 'sync refresh uses original fetch, not its own observer wrapper')
  })
}

for (const path of ['/api/project/fileTree', TREE_PATH]) {
  test(`generated XHR observer captures context from ${path}`, async () => {
    const f = observerFixture()
    const xhr = new f.window.XMLHttpRequest()
    xhr.open('GET', treeUrl(CTX, path))
    assert.equal(new URL(xhr.url, ORIGIN).pathname, TREE_PATH)
    xhr.respond(200, payload())
    f.bootstrapping = false
    assert.equal((await f.sync()).ok, true)
  })
}

test('generated fetch observer ignores an unsuccessful HTTP response even with status.code 1 JSON', async () => {
  const f = observerFixture()
  f.bootstrapResponse = () => new Response(JSON.stringify(payload()), {
    status: 503, headers: { 'content-type': 'application/json' },
  })
  await f.window.fetch(treeUrl())
  await microtasks()
  f.bootstrapping = false
  await rejected(f, 'bib-texpage-context-unavailable')
  assert.equal(f.requests.length, 0)
})

test('generated XHR observer ignores failed HTTP responses with success-looking JSON', async () => {
  const f = observerFixture()
  const xhr = new f.window.XMLHttpRequest()
  xhr.open('GET', treeUrl())
  xhr.respond(503, payload())
  f.bootstrapping = false
  await rejected(f, 'bib-texpage-context-unavailable')
  assert.equal(f.requests.length, 0)
})

test('failed observed tree response racing a baseline read cannot poison active owner context', async () => {
  const f = observerFixture()
  await f.window.fetch(treeUrl())
  await microtasks()
  f.bootstrapping = false
  f.options.fileResponse = async current => {
    if (current.fileReads === 1) {
      f.bootstrapResponse = () => new Response(JSON.stringify(payload()), {
        status: 503, headers: { 'content-type': 'application/json' },
      })
      f.bootstrapping = true
      try {
        await f.window.fetch(treeUrl({ ...CTX, ownerKey: 'other-owner' }))
        await microtasks()
      } finally { f.bootstrapping = false }
      return textResponse(OLD)
    }
    return textResponse(NEW)
  }
  const result = await f.sync()
  assert.equal(result.ok, true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.bootstrapRequests.length, 2)
  assert.equal(JSON.parse(f.storage.get(SNAPSHOT)).ownerKey, CTX.ownerKey)
})
