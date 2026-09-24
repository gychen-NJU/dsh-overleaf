#!/usr/bin/env node
// Run: node --test --test-reporter=spec scripts/smoke-texpage-tex-sync.mjs
// Source/VM-only current-.tex identity fixtures: no network, credentials,
// real files, browser, build output, or editor writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { renderBridgeScript } from '../src/inject-script.ts'
import { createTexpageTexAdapter, renderTexpageTexAdapter } from '../src/texpage-tex.ts'

const bridge = renderBridgeScript()
const adapterSource = '(' + createTexpageTexAdapter.toString() + ')'
assert.equal(renderTexpageTexAdapter(), adapterSource, 'VM uses the adapter serialized into the bridge')
new vm.Script(bridge, { filename: 'generated-bridge.js' })

function extract(startMarker, endMarker) {
  const start = bridge.indexOf(startMarker)
  const end = bridge.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `generated bridge range exists: ${startMarker}`)
  return bridge.slice(start, end)
}

// Execute the generated Overleaf helpers around the real serialized TeXPage
// adapter. This keeps unrelated routing/socket hooks out of the VM while still
// proving the production dispatch branch and legacy currentTexIdentity path.
const program = new vm.Script([
  extract('  function currentFileTreeDocument()', '  function currentDocName()'),
  extract('  function asEditorView(candidate)', '  function findCm6()'),
  extract('  function elementIsUsable(element)', '  function bibEventDocId(event)'),
  `  var texpageTex = ${adapterSource}({
    fetch: function () { throw new Error('synthetic-network-disabled') },
    editor: function () { return currentEditableBibEditor() },
    report: sendToParent,
    revision: texRevision,
    size: utf8TextSize,
  })\n`,
  extract('  function utf8TextSize(value)', '  function rememberTexSnapshot(identity'),
].join('\n'), { filename: 'generated-tex-identity.js' })

const LOCAL_ORIGIN = 'http://127.0.0.1:3080'
const UPSTREAM = 'https://tex.nju.edu.cn'
const SOCKET = 'https://socket.tex.nju.edu.cn'
const PROJECT = 'synthetic-project'
const VERSION = 'synthetic-version'
const OWNER = 'synthetic-owner'
const DOC = String.raw`\documentclass{article}
\begin{document}
TeXPage source
\end{document}
`
const plain = value => JSON.parse(JSON.stringify(value))

class Classes {
  constructor(names = []) { this.names = new Set(names) }
  contains(name) { return this.names.has(name) }
  add(name) { this.names.add(name) }
  remove(name) { this.names.delete(name) }
}

class Element {
  children = []
  parentNode = null
  style = { display: 'block', visibility: 'visible' }
  rects = [{}]
  attrs = new Map()
  selectors = new Map()
  classList
  textContent = ''
  constructor(classes = [], attrs = {}) {
    this.classList = new Classes(classes)
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, String(value))
  }
  append(child) { child.parentNode = this; this.children.push(child); return child }
  contains(candidate) { return this === candidate || this.children.some(child => child.contains(candidate)) }
  getAttribute(name) { return this.attrs.get(name) ?? null }
  hasAttribute(name) { return this.attrs.has(name) }
  getClientRects() { return this.rects }
  closest(selector) {
    for (let current = this; current; current = current.parentNode) {
      if (selector === '.ant-spin-nested-loading' && current.classList.contains('ant-spin-nested-loading')) return current
    }
    return null
  }
  querySelectorAll(selector) { return this.selectors.get(selector) ?? [] }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}

function cm6(value, options = {}) {
  const holder = new Element(['cm-editor'])
  const scroller = holder.append(new Element(['cm-scroller']))
  const content = scroller.append(new Element(['cm-content'], {
    contenteditable: 'true', 'aria-label': options.preview ? 'Visual Preview' : 'Source code editor',
  }))
  if (options.hidden) holder.style.display = 'none'
  if (options.invisible) holder.style.visibility = 'hidden'
  if (options.detached) holder.detached = true
  const view = {
    dom: holder,
    contentDOM: content,
    state: { doc: { toString: () => value } },
    dispatch() { throw new Error('pull-only fixture must never write') },
    focus() { throw new Error('pull-only fixture must never focus') },
  }
  content.cmView = { rootView: { view } }
  holder.selectors.set('.cm-content[contenteditable="true"]', [content])
  holder.selectors.set('.cm-scroller', [scroller])
  holder.selectors.set('.cm-content, .cm-scroller', [content, scroller])
  return { holder, content, view }
}

function cm5(value) {
  const holder = new Element(['CodeMirror'])
  holder.CodeMirror = {
    getOption(name) { assert.equal(name, 'readOnly'); return false },
    getValue() { return value },
  }
  return { holder }
}

function texRow(path, options = {}) {
  const row = new Element(['tree-node', ...(options.selected === false ? [] : ['selected'])])
  const titles = Array.from({ length: options.titleCount ?? 1 }, () => new Element([], { title: path }))
  row.selectors.set('.file-name [title]', titles)
  row.selectors.set('.node-loading', options.loading ? [new Element(['node-loading'])] : [])
  return row
}

function overleafRow(name, id, selected = true) {
  const item = new Element([], { role: 'treeitem', 'aria-selected': selected ? 'true' : 'false', 'aria-label': name })
  const entity = new Element(['entity'], { 'data-file-id': id, 'data-file-type': 'doc' })
  item.selectors.set('.entity[data-file-id][data-file-type="doc"]', [entity])
  return item
}

function treePayload(files) {
  return {
    status: { code: 1 },
    result: { treeData: files.map(file => ({
      projectKey: PROJECT,
      versionNo: VERSION,
      fileKey: file.fileKey,
      fileName: file.fileName ?? file.filePath.split('/').at(-1),
      filePath: file.filePath,
      isDir: file.isDir === true,
      fileType: file.fileType ?? 'text/x-tex',
    })) },
  }
}

function fixture(options = {}) {
  const texRows = options.texRows ?? []
  const overleafRows = options.overleafRows ?? []
  const editors = options.editors ?? [cm6(DOC)]
  const footer = new Element()
  footer.textContent = options.footer ?? texRows[0]?.querySelector('.file-name [title]')?.getAttribute('title') ?? ''
  const secondFooter = new Element()
  secondFooter.textContent = options.secondFooter ?? 'unrelated/metadata.tex'
  const spinnerRoot = new Element(['ant-spin-nested-loading'])
  const container = spinnerRoot.append(new Element(['editor-container']))
  spinnerRoot.selectors.set('.ant-spin-spinning', options.spinner ? [new Element(['ant-spin-spinning'])] : [])
  const overleafRoot = options.overleafRoot === false ? null : new Element()
  overleafRoot?.selectors.set('[role="treeitem"][aria-selected="true"][aria-label]', overleafRows.filter(row => row.getAttribute('aria-selected') === 'true'))
  const documentElement = new Element()
  for (const editor of editors) if (!editor.holder.detached) documentElement.append(editor.holder)
  const unknownSelectors = new Set()
  const document = {
    documentElement,
    querySelector(selector) {
      switch (selector) {
        case '[data-testid="file-tree-list-root"]': return overleafRoot
        case '.editor-footer-path-item': return footer
        case '.editor-container': return container
        default: unknownSelectors.add(`one:${selector}`); return null
      }
    },
    querySelectorAll(selector) {
      switch (selector) {
        case '.project-directory .tree-node.selected': return texRows.filter(row => row.classList.contains('selected'))
        case '.editor-footer-path-item': return [footer, secondFooter]
        case '.CodeMirror': return editors.filter(editor => editor.holder.classList.contains('CodeMirror')).map(editor => editor.holder)
        case '.cm-editor': return editors.filter(editor => editor.holder.classList.contains('cm-editor')).map(editor => editor.holder)
        default: unknownSelectors.add(`all:${selector}`); return []
      }
    },
  }
  const pathname = options.pathname ?? `/overleaf-proxy/project/user/${PROJECT}/${VERSION}`
  const location = new URL(LOCAL_ORIGIN + pathname)
  const messages = []
  const window = {
    location,
    __DSH_OVERLEAF_UPSTREAM_ORIGIN__: options.upstream ?? UPSTREAM,
    __DSH_OVERLEAF_SOCKET_ORIGIN__: options.socket ?? SOCKET,
    getComputedStyle: element => element.style,
  }
  if (options.openDocId !== undefined) {
    window.overleaf = { unstable: { store: { get(key) {
      assert.ok(['editor.open_doc_id', 'editor.view'].includes(key), `known Overleaf store key: ${key}`)
      return key === 'editor.open_doc_id' ? options.openDocId : undefined
    } } } }
  }
  const context = vm.createContext({
    window, document, location, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    setTimeout() { throw new Error('pull identity must not schedule timers') },
    clearTimeout() {}, DEBUG: false, log() {},
    sendToParent(message) { messages.push(plain(message)) },
  })
  program.runInContext(context, { timeout: 1_000 })
  const files = options.files ?? []
  if (files.length) {
    const query = new URLSearchParams({ ownerKey: OWNER, projectKey: PROJECT, versionNo: VERSION })
    context.texpageTex.observe(`${LOCAL_ORIGIN}/overleaf-proxy/api/project/fileTree?${query}`, treePayload(files))
  }
  return {
    context, messages, unknownSelectors,
    emit(requestId = 'request-1') {
      context.emitCurrentTexDocument(requestId)
      assert.deepEqual([...unknownSelectors], [], 'identity selectors remain explicitly mocked')
      assert.equal(messages.length, 1, 'exactly one correlated pull response')
      return messages[0]
    },
  }
}

function failure(options, error) {
  const result = fixture(options).emit()
  assert.deepEqual(result, { type: 'tex-document', requestId: 'request-1', ok: false, error })
}

test('source adapter is embedded and current-document dispatch is additive', () => {
  assert.ok(bridge.includes(`var texpageTex = ${adapterSource}`))
  const dispatch = extract('  function emitCurrentTexDocument(requestId)', '  function rememberTexSnapshot(identity')
  assert.ok(dispatch.indexOf('texpageTex.enabled()') < dispatch.indexOf('var identity = currentTexIdentity()'))
  assert.ok(dispatch.includes('texpageTex.emit(requestId)'))
})

test('TeXPage pulls the uniquely selected current .tex through the generated bridge', () => {
  const f = fixture({
    texRows: [texRow('main.tex')],
    files: [{ fileKey: 'tex-main', filePath: 'main.tex' }],
  })
  const result = f.emit('pull-main')
  assert.deepEqual(result, {
    type: 'tex-document', requestId: 'pull-main', ok: true,
    id: 'tex-main', name: 'main.tex', text: DOC, revision: f.context.texRevision(DOC),
  })
})

test('TeXPage binds a subfolder path and uses only the first footer path item', () => {
  const path = 'chapters/introduction.tex'
  const f = fixture({
    texRows: [texRow(path)], footer: `  ${path}  `, secondFooter: 'wrong/path.tex',
    files: [
      { fileKey: 'folder', filePath: 'chapters', fileName: 'chapters', isDir: true, fileType: 'folder' },
      { fileKey: 'tex-intro', filePath: path },
    ],
  })
  assert.equal(f.emit().id, 'tex-intro')
  assert.equal(f.messages[0].name, 'introduction.tex')
})

test('TeXPage refuses a selected current document that is not .tex', () => {
  failure({
    texRows: [texRow('notes/readme.md')], footer: 'notes/readme.md',
    files: [{ fileKey: 'markdown', filePath: 'notes/readme.md', fileType: 'text/markdown' }],
  }, 'tex-current-document-not-tex')
})

for (const [label, options, error] of [
  ['footer mismatch', { footer: 'other.tex' }, 'tex-document-identity-mismatch'],
  ['selected node loading', { texRows: [texRow('main.tex', { loading: true })] }, 'tex-document-identity-unavailable'],
  ['editor spinner', { spinner: true }, 'tex-document-identity-mismatch'],
]) {
  test(`TeXPage identity rejects ${label}`, () => {
    failure({
      texRows: [texRow('main.tex')], files: [{ fileKey: 'tex-main', filePath: 'main.tex' }],
      ...options,
    }, error)
  })
}

test('TeXPage identity rejects multiple selected DOM targets and duplicate tree paths', () => {
  failure({
    texRows: [texRow('main.tex'), texRow('other.tex')],
    files: [{ fileKey: 'tex-main', filePath: 'main.tex' }, { fileKey: 'tex-other', filePath: 'other.tex' }],
  }, 'tex-document-identity-unavailable')
  failure({
    texRows: [texRow('main.tex')],
    files: [{ fileKey: 'tex-a', filePath: 'main.tex' }, { fileKey: 'tex-b', filePath: 'main.tex' }],
  }, 'tex-document-identity-unavailable')
})

test('TeXPage requires one visible editable CM6 and ignores hidden/preview instances', () => {
  failure({
    texRows: [texRow('main.tex')], files: [{ fileKey: 'tex-main', filePath: 'main.tex' }],
    editors: [cm6(DOC), cm6('second visible editor')],
  }, 'tex-editor-ambiguous')
  const visible = cm6(DOC)
  const result = fixture({
    texRows: [texRow('main.tex')], files: [{ fileKey: 'tex-main', filePath: 'main.tex' }],
    editors: [visible, cm6('hidden', { hidden: true }), cm6('preview', { preview: true })],
  }).emit()
  assert.equal(result.ok, true)
  assert.equal(result.text, DOC)
})

test('overleaf.com keeps currentTexIdentity/open_doc_id behavior and CM5 pull', () => {
  const row = overleafRow('main.tex', 'overleaf-doc')
  const f = fixture({
    upstream: 'https://www.overleaf.com', socket: 'https://socket.overleaf.com',
    pathname: '/overleaf-proxy/project/overleaf-project',
    overleafRows: [row], texRows: [texRow('wrong.tex', { loading: true })],
    editors: [cm5(DOC)], openDocId: 'overleaf-doc', footer: 'wrong-footer.tex',
  })
  assert.equal(f.context.texpageTex.enabled(), false)
  assert.deepEqual(f.emit('overleaf-pull'), {
    type: 'tex-document', requestId: 'overleaf-pull', ok: true,
    id: 'overleaf-doc', name: 'main.tex', text: DOC, revision: f.context.texRevision(DOC),
  })

  failure({
    upstream: 'https://www.overleaf.com', socket: 'https://socket.overleaf.com',
    pathname: '/overleaf-proxy/project/overleaf-project',
    overleafRows: [overleafRow('main.tex', 'overleaf-doc')], editors: [cm5(DOC)], openDocId: 'another-doc',
  }, 'tex-document-identity-mismatch')
})

test('overleaf.com routes never activate TeXPage tree identity', () => {
  const f = fixture({
    upstream: 'https://www.overleaf.com', socket: 'https://socket.overleaf.com',
    pathname: '/overleaf-proxy/project/overleaf-project', overleafRoot: false,
    texRows: [texRow('main.tex')], files: [{ fileKey: 'tex-main', filePath: 'main.tex' }],
  })
  assert.equal(f.context.texpageTex.enabled(), false)
  assert.deepEqual(f.emit(), {
    type: 'tex-document', requestId: 'request-1', ok: false, error: 'tex-document-identity-unavailable',
  })
})
