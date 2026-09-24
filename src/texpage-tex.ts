/** TeXPage current-document adapter; public/self-hosted Overleaf keeps its legacy path. */
type TexView = {
  state: { doc: { toString(): string } }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void
  focus(): void
}
type TexEnvironment = {
  fetch: typeof fetch
  editor(): { engine?: string; editor?: TexView; error?: string }
  report(message: Record<string, unknown>): void
}

/** Self-contained: serialized into the document-start bridge. */
export function createTexpageTexAdapter(env: TexEnvironment) {
  const pageWindow = window as Window & {
    __DSH_OVERLEAF_UPSTREAM_ORIGIN__?: string
    __DSH_OVERLEAF_SOCKET_ORIGIN__?: string
  }
  type Context = { ownerKey: string; projectKey: string; versionNo: string }
  type File = { fileKey: string; fileName: string; filePath: string; isDir: boolean; fileType: string }
  const prefix = '/overleaf-proxy'
  const maxBytes = 4 * 1024 * 1024
  const idPattern = /^[A-Za-z0-9_-]{1,128}$/
  let context: Context | undefined
  let files: File[] = []
  let busy = false
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n')
  const size = (text: string) => {
    try { return new TextEncoder().encode(text).length } catch { return text.length }
  }
  const revision = (text: string) => {
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) }
    return text.length + '-' + (hash >>> 0).toString(16)
  }
  const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 150))
  function fail(code: string): never { throw new Error(code) }

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
    return !!match && candidate.projectKey === match[1] && candidate.versionNo === match[2]
      && Object.values(candidate).every(value => idPattern.test(value))
  }

  /** Cache only a successful, same-origin tree belonging to the visible route. */
  function observe(rawUrl: string, json: unknown): void {
    if (!enabled()) return
    try {
      const url = new URL(rawUrl, location.origin)
      if (url.origin !== location.origin || ![prefix + '/api/project/fileTree', '/api/project/fileTree'].includes(url.pathname)) return
      const payload = json as { status?: { code?: number }; result?: { treeData?: unknown[] } }
      if (payload?.status?.code !== 1 || !Array.isArray(payload.result?.treeData) || payload.result.treeData.length > 10000) return
      const candidate = {
        ownerKey: url.searchParams.get('ownerKey') ?? '', projectKey: url.searchParams.get('projectKey') ?? '',
        versionNo: url.searchParams.get('versionNo') ?? '',
      }
      if (!pageMatches(candidate)) return
      const next: File[] = []
      const seen = new Set<string>()
      for (const raw of payload.result.treeData) {
        const item = raw as Record<string, unknown>
        if (!item || item.projectKey !== candidate.projectKey || item.versionNo !== candidate.versionNo
          || typeof item.fileKey !== 'string' || !idPattern.test(item.fileKey) || seen.has(item.fileKey)
          || typeof item.fileName !== 'string' || typeof item.filePath !== 'string' || item.filePath.length > 2048
          || /[\x00-\x1f\\]/.test(item.filePath) || item.filePath.split('/').some(part => !part || part === '.' || part === '..')
          || item.fileName !== item.filePath.split('/').pop()) return
        seen.add(item.fileKey)
        next.push({ fileKey: item.fileKey, fileName: item.fileName, filePath: item.filePath,
          isDir: item.isDir === true, fileType: String(item.fileType ?? '') })
      }
      context = candidate
      files = next
    } catch { /* malformed or unrelated traffic cannot establish identity */ }
  }

  function selectedPath(): string {
    const selected = Array.from(document.querySelectorAll<HTMLElement>('.project-directory .tree-node.selected'))
    if (selected.length !== 1 || selected[0]!.querySelector('.node-loading')) fail('tex-document-identity-unavailable')
    const titles = selected[0]!.querySelectorAll<HTMLElement>('.file-name [title]')
    if (titles.length !== 1) fail('tex-document-identity-unavailable')
    const path = (titles[0]!.getAttribute('title') ?? '').trim()
    if (path === '' || path.length > 2048 || /[\x00-\x1f\\]/.test(path)) fail('tex-document-identity-unavailable')
    const footer = document.querySelector('.editor-footer-path-item')
    const container = document.querySelector('.editor-container')
    const spinner = container?.closest('.ant-spin-nested-loading')?.querySelector('.ant-spin-spinning')
    if (spinner || (footer?.textContent ?? '').trim() !== path) fail('tex-document-identity-mismatch')
    return path
  }

  function identity(): { ctx: Context; file: File; view: TexView; text: string } {
    if (!enabled() || !context || !pageMatches(context) || files.length === 0) fail('tex-document-identity-unavailable')
    const path = selectedPath()
    const matches = files.filter(file => !file.isDir && file.filePath === path)
    if (matches.length !== 1) fail('tex-document-identity-unavailable')
    const file = matches[0]!
    if (!/\.tex$/i.test(file.fileName)) fail('tex-current-document-not-tex')
    if (!/^text\//.test(file.fileType)) fail('tex-document-identity-unavailable')
    const selected = env.editor()
    if (selected.error) fail(selected.error.replace(/^bib-/, 'tex-'))
    if (selected.engine !== 'cm6' || !selected.editor) fail('tex-editor-unavailable')
    const text = selected.editor.state.doc.toString()
    if (size(text) > maxBytes) fail('tex-document-too-large')
    return { ctx: { ...context }, file, view: selected.editor, text }
  }

  function emit(requestId: string): void {
    try {
      const current = identity()
      env.report({ type: 'tex-document', requestId, ok: true, id: current.file.fileKey,
        name: current.file.fileName, text: current.text, revision: revision(current.text) })
    } catch (error) {
      env.report({ type: 'tex-document', requestId, ok: false,
        error: error instanceof Error ? error.message : String(error) })
    }
  }

  function apiUrl(ctx: Context, fileKey: string): string {
    const query = new URLSearchParams({ ...ctx, fileKey })
    return prefix + '/__dsh_texpage_tex__?' + query.toString()
  }

  async function read(ctx: Context, fileKey: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    let response: Response | undefined
    try {
      response = await env.fetch(apiUrl(ctx, fileKey), { method: 'GET', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: controller.signal })
      if (!response.ok) fail('tex-remote-read-failed')
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
      if (!['text/plain', 'application/octet-stream', 'application/x-tex', 'text/x-tex'].includes(type ?? '')) fail('tex-remote-read-failed')
      const length = Number(response.headers.get('content-length'))
      if (length > maxBytes) fail('tex-document-too-large')
      const reader = response.body?.getReader()
      if (!reader) fail('tex-remote-read-failed')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > maxBytes) fail('tex-document-too-large')
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('tex-')) throw error
      return fail('tex-remote-read-failed')
    } finally {
      clearTimeout(timer)
      await response?.body?.cancel().catch(() => {})
    }
  }

  function sameIdentity(expected: { ctx: Context; file: File; view: TexView }, expectedText: string): void {
    const current = identity()
    if (JSON.stringify(current.ctx) !== JSON.stringify(expected.ctx) || current.file.fileKey !== expected.file.fileKey
      || current.view !== expected.view || current.text !== expectedText) fail('tex-remote-changed')
  }

  async function sync(content: string, confirmed: boolean, requestId: string, expectedDocId: string, expectedRevision: string): Promise<void> {
    if (busy) { env.report({ type: 'tex-overleaf-sync-done', requestId, ok: false, error: 'tex-sync-busy' }); return }
    busy = true
    let wrote = false
    try {
      if (confirmed !== true) fail('tex-reverse-confirmation-required')
      const text = normalize(String(content))
      if (size(text) > maxBytes) fail('tex-document-too-large')
      const current = identity()
      if (expectedDocId !== current.file.fileKey || expectedRevision !== revision(current.text)) fail('tex-remote-changed')
      const baseline = await read(current.ctx, current.file.fileKey)
      sameIdentity(current, current.text)
      if (normalize(baseline) !== normalize(current.text)) fail('tex-remote-changed')
      if (current.text === text) {
        env.report({ type: 'tex-overleaf-sync-done', requestId, ok: true, target: current.file.fileName,
          chars: text.length, unchanged: true })
        return
      }
      const key = 'dsh-overleaf:tex-snapshot:' + (pageWindow.__DSH_OVERLEAF_UPSTREAM_ORIGIN__ ?? '') + ':'
        + current.ctx.ownerKey + ':' + current.ctx.projectKey + ':' + current.ctx.versionNo + ':' + current.file.fileKey
      const snapshot = JSON.stringify({ time: Date.now(), ...current.ctx, docId: current.file.fileKey,
        path: current.file.filePath, engine: 'cm6', doc: current.text })
      window.localStorage.setItem(key, snapshot)
      if (window.localStorage.getItem(key) !== snapshot) fail('tex-snapshot-failed')
      env.report({ type: 'snapshot-saved' })
      sameIdentity(current, current.text)
      wrote = true
      current.view.dispatch({ changes: { from: 0, to: current.text.length, insert: text }, selection: { anchor: text.length } })
      if (current.view.state.doc.toString() !== text) fail('tex-write-verification-failed')
      current.view.focus()
      const deadline = Date.now() + 15000
      do {
        await sleep()
        sameIdentity(current, text)
        const saved = await read(current.ctx, current.file.fileKey)
        sameIdentity(current, text)
        if (normalize(saved) === text) {
          env.report({ type: 'tex-overleaf-sync-done', requestId, ok: true, target: current.file.fileName, chars: text.length })
          return
        }
      } while (Date.now() < deadline)
      fail('tex-save-timeout')
    } catch (error) {
      env.report({ type: 'tex-overleaf-sync-done', requestId, ok: false,
        error: error instanceof Error && error.message.startsWith('tex-') ? error.message : 'tex-remote-read-failed', wrote })
    } finally { busy = false }
  }

  return { enabled, observe, emit, sync }
}

export function renderTexpageTexAdapter(): string {
  return '(' + createTexpageTexAdapter.toString() + ')'
}
