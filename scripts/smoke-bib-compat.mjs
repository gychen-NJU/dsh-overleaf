#!/usr/bin/env node
// Run: node --test --test-reporter=spec scripts/smoke-bib-compat.mjs
// Source-only Overleaf regression fixtures: no build, network, credentials,
// dependencies, real timers, browser, or filesystem writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { renderBridgeScript } from '../src/inject-script.ts'

const bridge = renderBridgeScript()
new vm.Script(bridge, { filename: 'generated-bridge.js' })

function extract(startMarker, endMarker) {
  const start = bridge.indexOf(startMarker)
  const end = bridge.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `generated bridge range exists: ${startMarker}`)
  return bridge.slice(start, end)
}

// Execute the actual generated functions, not a copy of their implementation.
// Keep the current-.tex pipeline and unrelated browser/network hooks out of VM.
const bibliography = extract('  function normalizeBibName(value)', '  /* Bidirectional current .tex')
const editorViewProbe = extract('  function asEditorView(candidate)', '  function findCm6()')
const program = new vm.Script(editorViewProbe + bibliography, { filename: 'generated-bibliography.js' })
const ORIGINAL = '@article{old,\n  title = {Original 文献}\n}\n'
const REPLACEMENT = '@book{new,\n  title = {Updated 文献},\n  year = {2026}\n}\n'
const PROJECT = 'synthetic-project'
const DOC = 'synthetic-bib-doc'
const OTHER = 'synthetic-other-doc'
const SNAPSHOT_KEY = `dsh-overleaf:bib-snapshot:${PROJECT}:${DOC}`
const plain = value => JSON.parse(JSON.stringify(value))

class Clock {
  now = 1_700_000_000_000
  sequence = 0
  pending = new Map()
  setTimeout = (fn, delay = 0, ...args) => {
    const id = ++this.sequence
    this.pending.set(id, { at: this.now + Math.max(0, Number(delay)), fn: () => fn(...args) })
    return id
  }
  clearTimeout = id => this.pending.delete(id)
  next() {
    return [...this.pending].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
  }
  advance(ms) {
    const until = this.now + ms
    let steps = 0
    while (this.pending.size) {
      const [id, timer] = this.next()
      if (timer.at > until) break
      assert.ok(++steps <= 10_000, 'bounded fake-timer execution')
      this.pending.delete(id)
      this.now = timer.at
      timer.fn()
    }
    this.now = until
  }
  drain() {
    let steps = 0
    while (this.pending.size) {
      assert.ok(++steps <= 1_000, 'bibliography eventually settles')
      this.advance(this.next()[1].at - this.now)
    }
  }
}

class EventDOM {
  listeners = new Map()
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
  dispatchEvent(event) {
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event)
    if (event.bubbles && this.parentEvents) this.parentEvents.dispatchEvent(event)
    return true
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) }
}

// Deliberately exact, scope-aware selectors. Unknown selectors are recorded even
// if the bridge catches a DOM exception, so a permissive mock cannot hide drift.
const selectors = new Map([
  ['[data-testid="file-tree-list-root"]', node => node.getAttribute('data-testid') === 'file-tree-list-root'],
  ['[role="treeitem"][aria-expanded="false"]', node => node.getAttribute('role') === 'treeitem' && node.getAttribute('aria-expanded') === 'false'],
  ['[role="treeitem"][aria-label]', node => node.getAttribute('role') === 'treeitem' && node.hasAttribute('aria-label')],
  ['.file-tree-entity-button', node => node.hasClass('file-tree-entity-button')],
  ['.entity[data-file-id][data-file-type="doc"]', node => node.hasClass('entity') && node.hasAttribute('data-file-id') && node.getAttribute('data-file-type') === 'doc'],
  ['.CodeMirror', node => node.hasClass('CodeMirror')],
  ['.cm-editor', node => node.hasClass('cm-editor')],
  ['.cm-content[contenteditable="true"]', node => node.hasClass('cm-content') && node.getAttribute('contenteditable') === 'true'],
  ['.cm-scroller', node => node.hasClass('cm-scroller')],
  ['.cm-content, .cm-scroller', node => node.hasClass('cm-content') || node.hasClass('cm-scroller')],
])

class Element extends EventDOM {
  children = []
  style = { display: 'block', visibility: 'visible' }
  rects = [{}]
  clicks = 0
  constructor(fixture, attrs = {}) {
    super()
    this.fixture = fixture
    this.attrs = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]))
  }
  getAttribute(name) { return this.attrs.get(name) ?? null }
  hasAttribute(name) { return this.attrs.has(name) }
  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  hasClass(name) { return (this.getAttribute('class') || '').split(/\s+/).includes(name) }
  append(node) { node.parentNode = this; this.children.push(node); return node }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]) }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  getClientRects() { return this.rects }
  querySelectorAll(selector) {
    this.fixture.queries.push(selector)
    const match = selectors.get(selector)
    if (!match) {
      this.fixture.unknownSelectors.add(selector)
      return []
    }
    return this.descendants().filter(match)
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  click() { this.clicks += 1; this.onClick?.() }
}

function position(text, offset) {
  const lines = text.slice(0, offset).split('\n')
  return { line: lines.length - 1, ch: lines.at(-1).length }
}

function offset(text, pos) {
  const lines = text.split('\n')
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch
}

function editorFixture(f, options = {}) {
  const engine = options.engine || 'cm5'
  const record = { engine, value: options.value ?? ORIGINAL, writes: [], operations: 0, focuses: 0 }
  const holder = new Element(f, { class: engine === 'cm5' ? 'CodeMirror' : 'cm-editor' })
  record.holder = holder
  if (!options.detached) f.document.documentElement.append(holder)
  if (options.hidden) holder.style.display = 'none'
  if (options.invisible) holder.style.visibility = 'hidden'
  if (options.noRects) holder.rects = []
  function write(change) {
    record.writes.push(plain(change))
    f.trace.push('write')
    if (options.writeThrows) throw new Error('synthetic-write-failure')
    if (!options.dropWrite) record.value = record.value.slice(0, change.from) + change.insert + record.value.slice(change.to)
    options.afterWrite?.(f)
  }
  if (engine === 'cm5') {
    const cm = {
      getValue: () => record.value,
      getOption(name) { assert.equal(name, 'readOnly'); return options.readOnly || false },
      posFromIndex: index => position(record.value, index),
      replaceRange(insert, from, to) { write({ from: offset(record.value, from), to: offset(record.value, to), insert }) },
      setCursor(pos) { record.cursor = plain(pos) },
      focus() { record.focuses += 1 },
    }
    if (options.operation !== false) cm.operation = fn => { record.operations += 1; fn() }
    holder.CodeMirror = cm
    record.editor = cm
  } else {
    const scroller = holder.append(new Element(f, { class: 'cm-scroller' }))
    const content = scroller.append(new Element(f, {
      class: 'cm-content', contenteditable: options.readOnly ? 'false' : 'true',
      'aria-label': options.preview ? 'Visual Preview' : 'Source code editor',
    }))
    if (options.hiddenContent) content.style.display = 'none'
    const view = {
      dom: holder, contentDOM: content,
      state: { doc: { toString: () => record.value, get length() { return record.value.length } } },
      dispatch(transaction) { record.transaction = plain(transaction); write(transaction.changes) },
      focus() { record.focuses += 1 },
    }
    // Real CM6 versions use different ContentView/EditorView expando paths.
    switch (options.probe || 'content-root') {
      case 'content-root': content.cmView = { rootView: { view } }; break
      case 'content-view': content.cmView = { view: { view } }; break
      case 'holder-view': holder.cmView = { view }; break
      case 'holder-editor': holder.editor = view; break
      case 'parent': {
        const parent = new Element(f)
        const index = f.document.documentElement.children.indexOf(holder)
        if (index >= 0) f.document.documentElement.children.splice(index, 1)
        f.document.documentElement.append(parent).append(holder)
        parent.__codemirrorView = view
        break
      }
      case 'scroller': scroller.cmView = { view }; break
      case 'descendant': content.syntheticContentView = { rootView: { view } }; break
      case 'store': f.state.view = view; break
      default: throw new Error(`unknown editor probe ${options.probe}`)
    }
    record.editor = view
    record.content = content
  }
  return record
}

function fixture(options = {}) {
  const f = {
    clock: new Clock(), messages: [], trace: [], queries: [], unknownSelectors: new Set(),
    state: { openDocId: options.openDocId ?? DOC }, storage: new Map(), rows: [],
  }
  f.document = new EventDOM()
  f.document.documentElement = new Element(f)
  f.document.querySelector = selector => f.document.documentElement.querySelector(selector)
  f.document.querySelectorAll = selector => f.document.documentElement.querySelectorAll(selector)
  f.document.getElementById = id => f.document.documentElement.descendants().find(node => node.getAttribute('id') === id) || null
  f.window = new EventDOM()
  f.document.parentEvents = f.window
  const location = new URL(`https://www.overleaf.com/project/${PROJECT}`)
  f.window.location = location
  f.window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ = 'https://www.overleaf.com'
  f.window.getComputedStyle = element => element.style
  f.window.localStorage = {
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
  }
  if (options.store !== 'absent') {
    f.window.overleaf = { unstable: { store: options.store === 'no-get' ? {} : {
      get(key) {
        assert.ok(['editor.open_doc_id', 'editor.view'].includes(key), `known Overleaf store key: ${key}`)
        if (options.store === 'throw') throw new Error('synthetic-store-unavailable')
        return key === 'editor.open_doc_id' ? f.state.openDocId : f.state.view
      },
    } } }
  }
  f.rail = f.document.documentElement.append(new Element(f, {
    id: 'ide-rail-tabs-tab-file-tree', 'aria-selected': options.railSelected === false ? 'false' : 'true',
  }))
  f.rail.onClick = () => f.rail.setAttribute('aria-selected', 'true')
  f.root = new Element(f, { 'data-testid': 'file-tree-list-root' })
  if (!options.missingRoot) f.document.documentElement.append(f.root)
  function addRow(parent, spec) {
    const item = parent.append(new Element(f, {
      role: 'treeitem', 'aria-label': spec.name, 'aria-selected': spec.selected === false ? 'false' : 'true',
    }))
    const attrs = { class: 'entity', 'data-file-type': spec.type || 'doc' }
    if (spec.id !== null) attrs['data-file-id'] = spec.id ?? DOC
    const entity = item.append(new Element(f, attrs))
    const row = { item, entity, name: spec.name, id: attrs['data-file-id'] }
    f.rows.push(row)
    entity.onClick = () => {
      if (options.onOpen) return options.onOpen(f, row)
      f.select(row)
      f.state.openDocId = row.id
    }
    return row
  }
  f.select = row => {
    for (const entry of f.rows) entry.item.setAttribute('aria-selected', entry === row ? 'true' : 'false')
  }
  f.addRow = spec => addRow(f.root, spec)
  for (const spec of options.rows ?? [{ name: 'refs.bib', id: DOC, selected: options.selected }]) f.addRow(spec)
  // A bibliography-looking entity outside the actual tree must never match.
  addRow(f.document.documentElement, { name: 'outside.bib', id: 'outside-doc', selected: false })
  if (options.folder) {
    f.folder = f.root.append(new Element(f, { role: 'treeitem', 'aria-expanded': 'false', 'aria-label': 'references' }))
    f.folderButton = f.folder.append(new Element(f, { class: 'file-tree-entity-button' }))
    f.folderButton.onClick = () => {
      f.folder.setAttribute('aria-expanded', 'true')
      addRow(f.folder, options.folder)
    }
  }
  f.editors = (options.editors ?? [{ engine: 'cm5' }]).map(spec => editorFixture(f, spec))
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [f.clock.now])) }
    static now() { return f.clock.now }
  }
  const context = vm.createContext({
    window: f.window, document: f.document, location, URL, Date: FakeDate,
    setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout,
    DEBUG: false, log() {},
    sendToParent(message) { f.messages.push(plain(message)); f.trace.push(message.type) },
  })
  program.runInContext(context, { timeout: 1_000 })
  f.api = context
  f.emit = (type, detail, surface = 'document', bubbles = false) => f[surface].dispatchEvent({ type, detail, bubbles })
  f.sync = (name = 'refs.bib', content = REPLACEMENT) => context.syncBibFile(name, content)
  f.results = () => f.messages.filter(message => message.type === 'bib-sync-done')
  f.start = (name = 'refs.bib', content = REPLACEMENT) => { f.sync(name, content); f.clock.advance(80) }
  f.finish = () => {
    f.clock.drain()
    assert.deepEqual([...f.unknownSelectors], [], 'DOM selectors remain explicitly mocked')
    assert.equal(f.window.listenerCount() + f.document.listenerCount(), 0, 'open/save listeners are cleaned up')
    assert.equal(f.results().length, 1, 'exactly one completion response')
    return f.results()[0]
  }
  return f
}

function noWrite(f) {
  assert.ok(f.editors.every(editor => editor.writes.length === 0), 'no editor mutation')
  assert.ok(!f.trace.includes('snapshot:set'), 'no snapshot attempted for rejected/unchanged edit')
}

function reject(f, error) {
  assert.equal(f.finish().ok, false)
  assert.equal(f.results()[0].error, error)
  noWrite(f)
}

function save(f, id = DOC, surface = 'document', field = 'id') {
  f.emit('doc:saved', { [field]: id }, surface)
  const result = f.finish()
  assert.equal(result.ok, true)
  assert.equal(result.unchanged, undefined)
  assert.equal(result.chars, REPLACEMENT.length)
  return result
}

test('generated bibliography normalizes whitespace/direction marks, not unrelated names', () => {
  const f = fixture()
  assert.equal(f.api.normalizeBibName(' \u200erefs.bib\u200f '), 'refs.bib')
  assert.equal(f.api.normalizeBibName(null), '')
  assert.equal(f.api.normalizeBibName('folder/refs.bib'), 'folder/refs.bib')
  assert.equal(f.api.overleafOpenDocState(DOC), 'match')
  assert.equal(f.api.overleafOpenDocState(OTHER), 'mismatch')
})

for (const engine of ['cm5', 'cm6']) {
  test(`${engine}: changed content snapshots before one whole-document transaction and correlated save`, () => {
    const f = fixture({ editors: [{ engine }] })
    f.start()
    const editor = f.editors[0]
    assert.equal(f.results().length, 0, 'writing alone is not saved confirmation')
    assert.equal(editor.value, REPLACEMENT)
    assert.deepEqual(editor.writes, [{ from: 0, to: ORIGINAL.length, insert: REPLACEMENT }])
    assert.equal(editor.focuses, 1)
    assert.deepEqual(JSON.parse(f.storage.get(SNAPSHOT_KEY)), {
      time: f.clock.now, projectId: PROJECT, docId: DOC, path: 'refs.bib', engine, doc: ORIGINAL,
    })
    assert.deepEqual(f.trace.slice(0, 4), ['snapshot:set', 'snapshot:get', 'snapshot-saved', 'write'])
    assert.equal(f.messages.filter(message => message.type === 'snapshot-saved').length, 1)
    if (engine === 'cm5') {
      assert.equal(editor.operations, 1)
      assert.deepEqual(editor.cursor, position(REPLACEMENT, REPLACEMENT.length))
    } else {
      assert.deepEqual(editor.transaction, {
        changes: { from: 0, to: ORIGINAL.length, insert: REPLACEMENT }, selection: { anchor: REPLACEMENT.length },
      })
    }
    f.emit('doc:saved', { id: OTHER })
    f.clock.advance(500)
    assert.equal(f.results().length, 0, 'another document save cannot acknowledge this edit')
    assert.equal(save(f).target, 'refs.bib')
    assert.equal(f.rows[0].entity.clicks, 0, 'initially selected target is not clicked')
  })

  test(`${engine}: unchanged content needs neither snapshot, transaction nor save event`, () => {
    const f = fixture({ editors: [{ engine, value: REPLACEMENT }], snapshotFailure: 'set' })
    f.start()
    assert.deepEqual(f.finish(), { type: 'bib-sync-done', ok: true, target: 'refs.bib', chars: REPLACEMENT.length, unchanged: true })
    noWrite(f)
    assert.equal(f.editors[0].focuses, 0)
    assert.equal(f.editors[0].operations, 0)
  })

  for (const snapshotFailure of ['set', 'get', 'discard', 'mismatch']) {
    test(`${engine}: snapshot ${snapshotFailure} failure prevents every write`, () => {
      const f = fixture({ editors: [{ engine }], snapshotFailure })
      f.start()
      assert.equal(f.finish().error, 'bib-snapshot-failed')
      assert.equal(f.results()[0].ok, false)
      assert.equal(f.editors[0].value, ORIGINAL)
      assert.equal(f.editors[0].writes.length, 0)
      assert.equal(f.editors[0].operations, 0)
      assert.equal(f.messages.filter(message => message.type === 'snapshot-saved').length, 0)
    })
  }

  test(`${engine}: read-only editor refuses replacement`, () => {
    const f = fixture({ editors: [{ engine, readOnly: true }] })
    f.start()
    reject(f, 'bib-editor-unavailable')
  })

  test(`${engine}: two editable instances refuse replacement`, () => {
    const f = fixture({ editors: [{ engine }, { engine }] })
    f.start()
    reject(f, 'bib-editor-ambiguous')
  })

  for (const failure of ['dropWrite', 'writeThrows']) {
    test(`${engine}: ${failure} cannot report successful synchronization`, () => {
      const f = fixture({ editors: [{ engine, [failure]: true }] })
      f.start()
      assert.equal(f.finish().error, failure === 'dropWrite' ? 'bib-write-verification-failed' : 'synthetic-write-failure')
      assert.equal(f.results()[0].ok, false)
      assert.equal(f.editors[0].value, ORIGINAL)
      assert.equal(JSON.parse(f.storage.get(SNAPSHOT_KEY)).doc, ORIGINAL)
      assert.equal(f.editors[0].writes.length, 1)
    })
  }

  test(`${engine}: save emitted synchronously by the transaction is observed`, () => {
    const f = fixture({ editors: [{ engine, afterWrite: current => current.emit('doc:saved', { id: DOC }, 'window') }] })
    f.start()
    assert.equal(f.finish().ok, true)
  })

  test(`${engine}: missing or wrong-document save event times out without a second write`, () => {
    const f = fixture({ editors: [{ engine }] })
    f.start()
    f.emit('doc:saved', { id: OTHER }, 'window')
    assert.equal(f.finish().error, 'bib-save-timeout')
    assert.equal(f.results()[0].ok, false)
    assert.equal(f.editors[0].writes.length, 1)
    f.emit('doc:saved', { id: DOC })
    assert.equal(f.results().length, 1, 'late save does not resurrect timed-out request')
  })
}

test('CM5 without operation still uses one full-range replacement', () => {
  const f = fixture({ editors: [{ operation: false }] })
  f.start()
  save(f)
  assert.equal(f.editors[0].operations, 0)
  assert.deepEqual(f.editors[0].writes, [{ from: 0, to: ORIGINAL.length, insert: REPLACEMENT }])
})

for (const probe of ['content-root', 'content-view', 'holder-view', 'holder-editor', 'parent', 'scroller', 'descendant', 'store']) {
  test(`CM6 discovers the existing ${probe} EditorView path`, () => {
    const f = fixture({ editors: [{ engine: 'cm6', probe }] })
    f.start()
    save(f)
    assert.equal(f.editors[0].writes.length, 1)
  })
}

test('mixed CM5/CM6 editable instances refuse ambiguous replacement', () => {
  const f = fixture({ editors: [{ engine: 'cm5' }, { engine: 'cm6' }] })
  f.start()
  reject(f, 'bib-editor-ambiguous')
})

test('no editable source editor refuses replacement', () => {
  const f = fixture({ editors: [] })
  f.start()
  reject(f, 'bib-editor-unavailable')
})

for (const engine of ['cm5', 'cm6']) {
  for (const exclusion of ['hidden', 'invisible', 'noRects', 'detached', ...(engine === 'cm6' ? ['hiddenContent', 'preview'] : [])]) {
    test(`${engine}: ${exclusion} editor is not a replacement destination`, () => {
      const f = fixture({ editors: [{ engine, [exclusion]: true }] })
      f.start()
      reject(f, 'bib-editor-unavailable')
    })
  }
}

test('hidden/preview/read-only editors do not make a single source editor ambiguous', () => {
  const f = fixture({ editors: [
    { engine: 'cm6' }, { engine: 'cm6', preview: true },
    { engine: 'cm5', hidden: true }, { engine: 'cm5', readOnly: 'nocursor' },
  ] })
  f.start()
  save(f)
  assert.deepEqual(f.editors.map(editor => editor.writes.length), [1, 0, 0, 0])
})

test('tree candidates require exact root, bibliography name and doc entity attributes', () => {
  const f = fixture({ rows: [
    { name: 'refs.bib', id: DOC }, { name: 'main.tex', id: OTHER },
    { name: 'binary.bib', id: 'binary', type: 'file' }, { name: 'folder.bib', type: 'folder' },
    { name: 'no-id.bib', id: null },
  ] })
  assert.deepEqual(Array.from(f.api.bibTreeCandidates(), target => ({ name: target.name, id: target.id })), [{ name: 'refs.bib', id: DOC }])
  f.start()
  save(f)
})

test('file-tree rail opens and collapsed folders reveal the requested unique bibliography', () => {
  const f = fixture({ rows: [], railSelected: false, folder: { name: 'refs.bib', id: DOC, selected: false } })
  f.sync()
  f.clock.advance(80)
  assert.equal(f.rail.clicks, 1)
  assert.equal(f.folderButton.clicks, 1)
  noWrite(f)
  f.clock.advance(100)
  save(f)
  assert.equal(f.rows.find(row => row.id === DOC).entity.clicks, 1)
})

for (const [name, rows, requested, expected] of [
  ['same-name unique match among other bib files', [{ name: 'other.bib', id: OTHER }, { name: 'refs.bib', id: DOC }], 'refs.bib', 'refs.bib'],
  ['exact spelling takes precedence over case-insensitive match', [{ name: 'REFS.BIB', id: OTHER }, { name: 'refs.bib', id: DOC }], 'refs.bib', 'refs.bib'],
  ['unique case-insensitive fallback', [{ name: 'REFS.BIB', id: DOC }], 'refs.bib', 'REFS.BIB'],
  ['direction marks and whitespace normalized on both sides', [{ name: ' \u200erefs.bib\u200f ', id: DOC }], '\u200f refs.bib \u200e', 'refs.bib'],
]) {
  test(name, () => {
    const f = fixture({ rows })
    f.start(requested)
    assert.equal(save(f).target, expected)
    assert.equal(JSON.parse(f.storage.get(SNAPSHOT_KEY)).path, expected)
  })
}

for (const [name, options, requested, error] of [
  ['duplicate exact names', { rows: [{ name: 'refs.bib', id: DOC }, { name: 'refs.bib', id: OTHER }] }, 'refs.bib', 'bib-target-ambiguous'],
  ['duplicate case-insensitive names', { rows: [{ name: 'REFS.bib', id: DOC }, { name: 'refs.BIB', id: OTHER }] }, 'Refs.Bib', 'bib-target-ambiguous'],
  ['mismatching name despite a single bibliography', {}, 'missing.bib', 'bib-target-missing'],
  ['bibliography outside root', {}, 'outside.bib', 'bib-target-missing'],
  ['empty tree', { rows: [] }, 'refs.bib', 'bib-target-missing'],
  ['missing testid root', { missingRoot: true }, 'refs.bib', 'bib-target-missing'],
  ['non-doc bibliography', { rows: [{ name: 'refs.bib', type: 'file' }] }, 'refs.bib', 'bib-target-missing'],
  ['invalid extension', {}, 'refs.tex', 'bib-invalid-name'],
  ['empty filename', {}, '', 'bib-invalid-name'],
]) {
  test(`${name} rejects without clicking or writing`, () => {
    const f = fixture(options)
    f.start(requested)
    reject(f, error)
    assert.ok(f.rows.every(row => row.entity.clicks === 0))
  })
}

test('available bibliography names accompany missing-target response', () => {
  const f = fixture({ rows: [{ name: 'a.bib' }, { name: 'b.bib' }, { name: 'main.tex' }] })
  f.start('refs.bib')
  reject(f, 'bib-target-missing')
  assert.equal(f.results()[0].available, 'a.bib, b.bib')
})

test('store identity match permits an edit while tree selection has not caught up', () => {
  const f = fixture({ selected: false, onOpen() {} })
  f.start()
  assert.equal(f.rows[0].item.getAttribute('aria-selected'), 'false')
  save(f)
  assert.equal(f.rows[0].entity.clicks, 1)
})

test('explicit store mismatch overrides selected tree and matching opened event', () => {
  const f = fixture({ openDocId: OTHER })
  f.start()
  f.emit('doc:after-opened', { id: DOC })
  reject(f, 'bib-editor-timeout')
})

test('store match arriving after file-tree click unlocks the target editor', () => {
  const f = fixture({ selected: false, openDocId: OTHER, onOpen(current, row) { current.select(row) } })
  f.start()
  f.emit('doc:after-opened', { id: DOC })
  f.clock.advance(500)
  noWrite(f)
  f.state.openDocId = DOC
  f.clock.advance(100)
  save(f)
  assert.equal(f.rows[0].entity.clicks, 1)
})

for (const store of ['absent', 'throw', 'no-get']) {
  test(`${store} store retains initially selected tree fallback`, () => {
    const f = fixture({ store })
    assert.equal(f.api.overleafOpenDocState(DOC), 'unavailable')
    f.start()
    save(f)
  })
}

for (const surface of ['window', 'document']) {
  for (const field of ['id', 'docId', 'doc_id']) {
    test(`${surface} ${field}: opened and saved events must correlate to target doc ID`, () => {
      const f = fixture({ store: 'absent', selected: false, onOpen(current, row) { current.select(row) } })
      f.start()
      f.emit('doc:after-opened', { [field]: OTHER }, surface)
      f.emit('doc:after-opened', {}, surface)
      f.clock.advance(200)
      noWrite(f)
      assert.equal(f.results().length, 0)
      f.emit('doc:after-opened', { [field]: DOC }, surface, surface === 'document')
      f.clock.advance(100)
      assert.equal(f.editors[0].writes.length, 1)
      for (const detail of [undefined, {}, { [field]: OTHER }]) f.emit('doc:saved', detail, surface)
      f.clock.advance(200)
      assert.equal(f.results().length, 0)
      save(f, DOC, surface, field)
    })
  }
}

test('tree click alone is not opened-document evidence when store is absent', () => {
  const f = fixture({ store: 'absent', selected: false, onOpen(current, row) { current.select(row) } })
  f.start()
  reject(f, 'bib-editor-timeout')
})

test('opened event without selected target cannot authorize unavailable-store fallback', () => {
  const f = fixture({ store: 'absent', selected: false, onOpen() {} })
  f.start()
  f.emit('doc:after-opened', { id: DOC })
  reject(f, 'bib-editor-timeout')
})

test('synchronous opened event during click is observed before write', () => {
  const f = fixture({ store: 'absent', selected: false, onOpen(current, row) {
    current.select(row)
    current.emit('doc:after-opened', { id: row.id }, 'document', true)
  } })
  f.start()
  save(f)
})

test('save event before replacement cannot acknowledge a later transaction', () => {
  const f = fixture()
  f.emit('doc:saved', { id: DOC })
  f.start()
  assert.equal(f.finish().error, 'bib-save-timeout')
  assert.equal(f.results()[0].ok, false)
})

test('late source editor mount can recover within the editor deadline', () => {
  const f = fixture({ editors: [] })
  f.start()
  f.clock.advance(500)
  noWrite(f)
  f.editors.push(editorFixture(f, { engine: 'cm6' }))
  f.clock.advance(100)
  save(f)
})
