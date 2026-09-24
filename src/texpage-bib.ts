/** TeXPage bibliography adapter; legacy Overleaf keeps its own lifecycle. */
type BibView = {
  state: { doc: { toString(): string } }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void
  focus(): void
}
type BibEnvironment = {
  fetch: typeof fetch
  editor(): { engine?: string; editor?: BibView; error?: string }
  report(message: Record<string, unknown>): void
}

/** Self-contained: serialized into the bridge after TypeScript compilation. */
export function createTexpageBibAdapter(env: BibEnvironment) {
  const pageWindow = window as Window & {
    __DSH_OVERLEAF_UPSTREAM_ORIGIN__?: string
    __DSH_OVERLEAF_SOCKET_ORIGIN__?: string
  }
  type Context = { ownerKey: string; projectKey: string; versionNo: string }
  type File = { fileKey: string; fileName: string; filePath: string; parentKey: string; isDir: boolean; fileType: string }
  const prefix = '/overleaf-proxy'
  const maxBytes = 2 * 1024 * 1024
  const idPattern = /^[A-Za-z0-9_-]{1,128}$/
  let context: Context | undefined
  let busy = false
  let readDiagnostic: { phase: string; status?: number; code: string; attempts: number } | undefined
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
  const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 150))
  function fail(code: string): never { throw new Error(code) }
  const result = (message: Record<string, unknown>) => env.report({ type: 'bib-sync-done', ...message })

  function enabled(): boolean {
    try {
      const upstream = new URL(pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ ?? '')
      const socket = new URL(pageWindow.__DSH_OVERLEAF_SOCKET_ORIGIN__ ?? '')
      return /^https?:$/.test(upstream.protocol) && socket.protocol === upstream.protocol
        && socket.host === 'socket.' + upstream.hostname.replace(/^www\./, '')
        && upstream.port === '' && socket.port === ''
        && /\/project\/user\/[^/]+\/[^/]+/.test(location.pathname)
    } catch { return false }
  }

  function pageMatches(candidate: Context): boolean {
    const match = /\/project\/user\/([^/]+)\/([^/?#]+)/.exec(location.pathname)
    // TeXPage's /project/user/<projectKey>/<versionNo> route contains neither
    // the logged-in user nor ownerKey. Owner comes from the authenticated tree.
    return !!match && candidate.projectKey === match[1] && candidate.versionNo === match[2]
      && Object.values(candidate).every(value => idPattern.test(value))
  }

  /** Observe only the same-origin, successful file-tree read, never arbitrary JSON. */
  function observe(rawUrl: string, json: unknown): void {
    if (!enabled()) return
    try {
      const url = new URL(rawUrl, location.origin)
      if (url.origin !== location.origin || ![prefix + '/api/project/fileTree', '/api/project/fileTree'].includes(url.pathname)) return
      const payload = json as { status?: { code?: number }; result?: { treeData?: unknown } }
      if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData)) return
      const candidate = {
        ownerKey: url.searchParams.get('ownerKey') ?? '', projectKey: url.searchParams.get('projectKey') ?? '',
        versionNo: url.searchParams.get('versionNo') ?? '',
      }
      if (pageMatches(candidate)) context = candidate
    } catch { /* unrelated/malformed traffic cannot select a project */ }
  }

  function apiUrl(path: string, ctx: Context, fileKey?: string): string {
    const query = new URLSearchParams(ctx)
    if (fileKey !== undefined) query.set('fileKey', fileKey)
    return prefix + path + '?' + query.toString()
  }

  /** Bounded, uncached same-origin GETs; reject redirects/login pages. */
  async function read(url: string, json = false, phase = json ? 'tree' : 'baseline'): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), json ? 8000 : 20000)
    try {
      // Retry only idempotent reads, once, within the ORIGINAL total deadline.
      // Auth, identity, content validation and write transactions are not retried.
      for (let attempt = 1; attempt <= 2; attempt++) {
        let response: Response | undefined
        let retryable = true // a transport failure before headers is transient
        readDiagnostic = { phase, code: 'network', attempts: attempt }
        try {
          response = await env.fetch(url, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          })
          retryable = false
          if (!response.ok) {
            const hint = response.headers.get('x-dsh-bib-error') ?? ''
            const safeHint = /^(site|redirect|object|body)-(network|target|mime|size|utf8|stream|timeout|http-[1-5][0-9]{2})$/.test(hint) ? hint : undefined
            readDiagnostic = { phase, status: response.status, code: safeHint ?? 'http', attempts: attempt }
            // The proxy maps validation and transport failures to 502; hints
            // prevent retrying denied/invalid content as a network failure.
            retryable = safeHint !== undefined
              ? /-(network|stream|timeout|http-(408|429|500|502|503|504))$/.test(safeHint)
              : [408, 429, 500, 502, 503, 504].includes(response.status)
            fail('bib-remote-read-failed')
          }
          const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
          if (json ? type !== 'application/json' : !['text/plain', 'application/octet-stream', 'application/x-bibtex', 'text/x-bibtex'].includes(type ?? '')) {
            readDiagnostic = { phase, status: response.status, code: 'mime', attempts: attempt }
            fail('bib-remote-read-failed')
          }
          const limit = json ? 4 * maxBytes : maxBytes
          const length = Number(response.headers.get('content-length'))
          readDiagnostic = { phase, code: 'size', attempts: attempt }
          if (length > limit) fail('bib-file-too-large')
          readDiagnostic = { phase, code: 'stream', attempts: attempt }
          const reader = response.body?.getReader()
          if (!reader) fail('bib-remote-read-failed')
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            while (true) {
              retryable = true
              const part = await reader.read()
              retryable = false
              if (part.done) break
              size += part.value.byteLength
              if (size > limit) {
                readDiagnostic = { phase, code: 'size', attempts: attempt }
                fail('bib-file-too-large')
              }
              chunks.push(part.value)
            }
          } finally { reader.releaseLock() }
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
          readDiagnostic = { phase, code: 'utf8', attempts: attempt }
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          readDiagnostic = undefined
          return decoded
        } catch (error) {
          if (attempt < 2 && retryable && !controller.signal.aborted) {
            await response?.body?.cancel().catch(() => {})
            await sleep()
            if (!controller.signal.aborted) continue
          }
          if (controller.signal.aborted) readDiagnostic = { phase, code: 'timeout', attempts: attempt }
          if (error instanceof Error && error.message.startsWith('bib-')) throw error
          fail('bib-remote-read-failed')
        } finally { await response?.body?.cancel().catch(() => {}) }
      }
      return fail('bib-remote-read-failed')
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('bib-')) throw error
      return fail('bib-remote-read-failed')
    } finally { clearTimeout(timer) }
  }

  async function files(ctx: Context): Promise<File[]> {
    const payload = JSON.parse(await read(apiUrl('/api/project/fileTree', ctx), true))
    if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData)
      || payload.result.treeData.length > 10000) fail('bib-target-missing')
    const found: File[] = []
    const seen = new Set<string>()
    for (const item of payload.result.treeData) {
      if (!item || item.projectKey !== ctx.projectKey || item.versionNo !== ctx.versionNo
        || typeof item.fileKey !== 'string' || !idPattern.test(item.fileKey) || typeof item.fileName !== 'string' || typeof item.filePath !== 'string'
        || item.filePath.length > 2048 || /[\x00-\x1f\\]/.test(item.filePath)
        || item.filePath.split('/').some((s: string) => !s || s === '.' || s === '..')
        || item.fileName !== item.filePath.split('/').pop() || seen.has(item.fileKey)) fail('bib-target-ambiguous')
      seen.add(item.fileKey)
      found.push({ fileKey: item.fileKey, fileName: item.fileName, filePath: item.filePath,
        parentKey: String(item.parentKey), isDir: item.isDir === true, fileType: String(item.fileType) })
    }
    return found
  }

  function nodes(path: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.project-directory .tree-node'))
      .filter(node => node.querySelector('.file-name [title]')?.getAttribute('title') === path)
  }

  async function open(target: File, all: File[]): Promise<void> {
    const deadline = Date.now() + 12000
    const parents: File[] = []
    let parent = target.parentKey
    const seen = new Set<string>()
    while (parent !== '0' && parent !== '' && parent !== 'null' && parent !== 'undefined') {
      if (seen.has(parent) || parents.length >= 16) fail('bib-target-ambiguous')
      seen.add(parent)
      const folder = all.find(f => f.fileKey === parent && f.isDir)
      if (!folder) fail('bib-target-missing')
      parents.unshift(folder)
      parent = folder.parentKey
    }
    // TeXPage keeps the directory DOM even when its side pane is hidden. If
    // its own section is collapsed, reopen only the labelled Files section.
    if (!document.querySelector('.project-directory')) {
      const title = Array.from(document.querySelectorAll<HTMLElement>('.explorer-tab-title'))
        .find(el => /^(文件目录|Files|File Tree)$/i.test((el.textContent ?? '').trim()))
      title?.click()
    }
    for (const folder of parents) {
      while (nodes(folder.filePath).length === 0 && Date.now() < deadline) await sleep()
      const matches = nodes(folder.filePath)
      if (matches.length !== 1) fail('bib-target-ambiguous')
      const icon = matches[0]!.querySelector('.expand-icon-wrapper')
      if (!icon) fail('bib-target-missing')
      if (!icon.classList.contains('open')) { matches[0]!.click(); await sleep() }
    }
    while (nodes(target.filePath).length === 0 && Date.now() < deadline) await sleep()
    const matches = nodes(target.filePath)
    if (matches.length !== 1) fail(matches.length > 1 ? 'bib-target-ambiguous' : 'bib-target-missing')
    if (!matches[0]!.classList.contains('selected')) matches[0]!.click()
    while (!identity(target)) {
      if (Date.now() >= deadline) fail('bib-editor-timeout')
      await sleep()
    }
  }

  /** The footer is derived from currentFile, not the prematurely selected row.
   * node-loading / ant-spin-spinning persist until the CRDT editor is mounted. */
  function identity(target: File): boolean {
    const matches = nodes(target.filePath)
    const footer = document.querySelector('.editor-footer-path-item')
    const editorContainer = document.querySelector('.editor-container')
    const spinner = editorContainer?.closest('.ant-spin-nested-loading')?.querySelector('.ant-spin-spinning')
    return matches.length === 1 && matches[0]!.classList.contains('selected')
      && !matches[0]!.querySelector('.node-loading') && !spinner
      && (footer?.textContent ?? '').trim() === target.filePath
  }

  function editor(target: File): BibView {
    if (!identity(target)) fail('bib-document-changed')
    const selected = env.editor()
    if (selected.error) fail(selected.error)
    if (selected.engine !== 'cm6' || !selected.editor) fail('bib-editor-unavailable')
    return selected.editor
  }

  async function sync(name: string, content: string): Promise<void> {
    if (busy) { result({ ok: false, error: 'bib-sync-busy' }); return }
    busy = true
    readDiagnostic = undefined
    let wrote = false
    try {
      if (!enabled() || !context || !pageMatches(context)) fail('bib-texpage-context-unavailable')
      const ctx = { ...context }
      const checkContext = () => {
        if (!pageMatches(ctx) || JSON.stringify(context) !== JSON.stringify(ctx)) fail('bib-document-changed')
      }
      const requested = String(name).trim()
      if (!/\.bib$/i.test(requested) || /[\\/\x00-\x1f]/.test(requested)) fail('bib-invalid-name')
      const text = normalize(String(content))
      if (new TextEncoder().encode(text).length > maxBytes) fail('bib-file-too-large')
      const all = await files(ctx)
      checkContext()
      const bibs = all.filter(f => !f.isDir && /^text\//.test(f.fileType) && /\.bib$/i.test(f.fileName))
      const exact = bibs.filter(f => f.fileName === requested)
      const candidates = exact.length ? exact : bibs.filter(f => f.fileName.toLowerCase() === requested.toLowerCase())
      if (candidates.length !== 1) {
        result({ ok: false, error: candidates.length ? 'bib-target-ambiguous' : 'bib-target-missing', available: bibs.map(f => f.fileName).join(', ') })
        return
      }
      const target = candidates[0]!
      await open(target, all)
      checkContext()
      const view = editor(target)
      const before = view.state.doc.toString()
      const remote = normalize(await read(apiUrl('/__dsh_texpage_bib__', ctx, target.fileKey)))
      checkContext()
      if (editor(target) !== view || view.state.doc.toString() !== before) fail('bib-document-changed')
      // Preserve unsaved user edits instead of overwriting a still-pending CRDT
      // state. This also binds the displayed editor to the selected remote file.
      if (normalize(before) !== remote) fail('bib-remote-changed')
      if (remote === text) {
        result({ ok: true, target: target.fileName, chars: text.length, unchanged: true })
        return
      }
      try {
        const key = 'dsh-overleaf:bib-snapshot:' + pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ + ':'
          + ctx.ownerKey + ':' + ctx.projectKey + ':' + ctx.versionNo + ':' + target.fileKey
        const snapshot = JSON.stringify({ time: Date.now(), ...ctx, docId: target.fileKey, path: target.filePath, engine: 'cm6', doc: before })
        window.localStorage.setItem(key, snapshot)
        if (window.localStorage.getItem(key) !== snapshot) fail('bib-snapshot-failed')
        env.report({ type: 'snapshot-saved' })
      } catch { fail('bib-snapshot-failed') }
      checkContext()
      if (editor(target) !== view || view.state.doc.toString() !== before) fail('bib-document-changed')
      // An editor extension may throw after partially applying a transaction.
      // Treat every attempted dispatch as potentially written for recovery UI.
      wrote = true
      view.dispatch({ changes: { from: 0, to: before.length, insert: text }, selection: { anchor: text.length } })
      if (view.state.doc.toString() !== text) fail('bib-write-verification-failed')
      view.focus()
      const deadline = Date.now() + 15000
      // TeXPage does not emit Overleaf's doc:saved event. Confirm persistence
      // through its own file-download endpoint; local text or a timer is not a
      // save acknowledgement. Never retry writes or auto-rollback user edits.
      do {
        await sleep()
        checkContext()
        if (editor(target) !== view || view.state.doc.toString() !== text) fail('bib-document-changed')
        const saved = normalize(await read(apiUrl('/__dsh_texpage_bib__', ctx, target.fileKey), false, 'save'))
        checkContext()
        if (editor(target) !== view || view.state.doc.toString() !== text) fail('bib-document-changed')
        if (saved === text) { result({ ok: true, target: target.fileName, chars: text.length }); return }
      } while (Date.now() < deadline)
      fail('bib-save-timeout')
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith('bib-') ? error.message : 'bib-remote-read-failed'
      result({ ok: false, error: code, written: wrote, ...(readDiagnostic ? { diagnostic: readDiagnostic } : {}) })
    } finally { busy = false }
  }

  return { enabled, observe, sync }
}

export function renderTexpageBibAdapter(): string {
  return '(' + createTexpageBibAdapter.toString() + ')'
}
