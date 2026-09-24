/**
 * dsh-overleaf host half: the Cordis Service mounted as the `overleaf-workbench`
 * row of a web profile. Owns:
 *  - `/overleaf-proxy/*` same-origin reverse proxy (HTTP prefix route) plus
 *    exact WebSocket upgrade routes for socket.io;
 *  - `/overleaf/workbench/*` JSON routes (status, login, cookie, logout,
 *    projects) and the bridge script asset;
 *  - the stored session-cookie credential feeding both.
 *
 * Route prefixes are deliberately disjoint from dsh-better-overleaf's
 * `/overleaf/*` surface so the two plugins can coexist in one profile.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import http from 'node:http'
import { readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import {
  basename, dirname, extname, isAbsolute, join as joinPath, relative as relativePath,
  resolve as resolvePath, sep as pathSeparator,
} from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig, WorkbenchConfig } from './config.ts'
import { OVERLEAF_WORKBENCH_COOKIE } from './credentials.ts'
import { loginViaCdp } from './login-cdp.ts'
import { validateCookieHeader } from './cookie-validate.ts'
import { ReverseProxy, PROXY_PREFIX } from './proxy.ts'
import { renderBridgeScript } from './inject-script.ts'
import type {
  WorkbenchLoginResult, WorkbenchProject, WorkbenchStatus, WorkbenchWireResponse,
} from './types.ts'

/** Stable Cordis plugin name (the patch row `name:` must match package.json). */
export const name = 'overleaf-workbench'

/**
 * Fixed workspace filename the agent is asked to write its final insert
 * content into (see the AI-write flow). MUST match the constant in
 * src/client/view.tsx. Reads are restricted to exactly this filename.
 */
export const INSERT_FILE_NAME = 'dsh-overleaf-insert.md'

/**
 * Fixed workspace filename the agent writes its compile-fix edit list into
 * (see the compile-fix panel flow). MUST match the constant in
 * src/client/view.tsx; reads are restricted to exactly this filename.
 */
export const FIX_FILE_NAME = 'dsh-overleaf-fix.md'

/** Services required before the host plugin can mount. */
export const inject = ['webServer', 'credentials', 'sessions']

export { Config }

const MAX_TEX_FILE_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_BYTES = 64 * 1024
// JSON can escape each source character into several bytes. Only the local
// .tex write route receives this larger bound; ordinary control routes remain
// capped at 64 KiB.
const MAX_TEX_REQUEST_BYTES = MAX_TEX_FILE_BYTES * 6 + 64 * 1024
const MAX_BIB_FILE_BYTES = 2 * 1024 * 1024
const MAX_BIB_RESULTS = 50
const MAX_BIB_SCAN_DEPTH = 8
const MAX_TEX_RESULTS = 100
const MAX_TEX_SCAN_DEPTH = 8
const BIB_SCAN_IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.dsh-meow', '.tmp', 'node_modules', 'dist', 'build', 'coverage', 'fixtures',
])

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req: IncomingMessage): boolean {
  return req.socket.remoteAddress === undefined || LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new Error('dsh-overleaf: request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(res: ServerResponse, status: number, body: WorkbenchWireResponse<unknown>): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && error.name !== 'Error' ? error.name : 'dsh-overleaf-route-error'
  sendJson(res, 500, { ok: false, error: { code, message } })
}

function isWithinWorkspace(root: string, target: string): boolean {
  const relative = relativePath(root, target)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathSeparator}`) && !isAbsolute(relative))
}

async function canonicalWorkspaceRoot(cwd: string): Promise<string> {
  const rawRoot = cwd.trim()
  if (rawRoot === '' || !isAbsolute(rawRoot)) {
    throw new Error('dsh-overleaf: bibliography sync requires an absolute session workspace')
  }
  const root = await realpath(rawRoot).catch(() => undefined)
  if (root === undefined) throw new Error('dsh-overleaf: session workspace does not exist')
  const rootStats = await stat(root).catch(() => undefined)
  if (rootStats === undefined || !rootStats.isDirectory()) {
    throw new Error('dsh-overleaf: session workspace is not a directory')
  }
  return root
}

/** Discover UTF-8 BibTeX candidates inside one trusted DSH workspace. */
export async function discoverWorkspaceBibFiles(cwd: string): Promise<string[]> {
  const root = await canonicalWorkspaceRoot(cwd)
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < MAX_BIB_RESULTS) {
    const current = queue.shift()
    if (current === undefined) break
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (found.length >= MAX_BIB_RESULTS) break
      const fullPath = joinPath(current.dir, entry.name)
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.bib') {
        found.push(fullPath)
      } else if (entry.isDirectory() && current.depth < MAX_BIB_SCAN_DEPTH
        && !BIB_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) {
        queue.push({ dir: fullPath, depth: current.depth + 1 })
      }
    }
  }
  return found
}

/** Resolve and read one explicit .bib, refusing traversal and symlink escapes. */
export async function readLocalBibFile(cwd: string, requestedPath: string): Promise<{
  path: string
  name: string
  content: string
  mtimeMs: number
  size: number
}> {
  const rawPath = requestedPath.trim()
  if (rawPath === '' || rawPath.includes('\u0000')) throw new Error('dsh-overleaf: a .bib path is required')
  const root = await canonicalWorkspaceRoot(cwd)
  const requestedTarget = resolvePath(isAbsolute(rawPath) ? rawPath : joinPath(root, rawPath))
  if (!isWithinWorkspace(root, requestedTarget)) {
    throw new Error('dsh-overleaf: the .bib file must be inside the current session workspace')
  }
  if (extname(requestedTarget).toLowerCase() !== '.bib') {
    throw new Error('dsh-overleaf: only .bib files can be synchronized')
  }
  const target = await realpath(requestedTarget).catch(() => undefined)
  if (target === undefined) throw new Error(`dsh-overleaf: .bib file not found: ${requestedTarget}`)
  if (!isWithinWorkspace(root, target)) {
    throw new Error('dsh-overleaf: the .bib file resolves outside the current session workspace')
  }
  if (extname(target).toLowerCase() !== '.bib') {
    throw new Error('dsh-overleaf: only .bib files can be synchronized')
  }
  const stats = await stat(target).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) throw new Error(`dsh-overleaf: .bib file not found: ${target}`)
  if (stats.size > MAX_BIB_FILE_BYTES) throw new Error('dsh-overleaf: .bib file exceeds the 2 MiB safety limit')
  const content = await readFile(target, 'utf8')
  return { path: target, name: basename(target), content, mtimeMs: stats.mtimeMs, size: stats.size }
}

/** Discover local LaTeX sources without following directory symlinks. */
export async function discoverWorkspaceTexFiles(cwd: string): Promise<string[]> {
  const root = await canonicalWorkspaceRoot(cwd)
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < MAX_TEX_RESULTS) {
    const current = queue.shift()
    if (current === undefined) break
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (found.length >= MAX_TEX_RESULTS) break
      const fullPath = joinPath(current.dir, entry.name)
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') {
        found.push(fullPath)
      } else if (entry.isDirectory() && current.depth < MAX_TEX_SCAN_DEPTH
        && !BIB_SCAN_IGNORED_DIRS.has(entry.name.toLowerCase())) {
        queue.push({ dir: fullPath, depth: current.depth + 1 })
      }
    }
  }
  return found
}

function safeTexFallbackName(value: string): string {
  const name = basename(value.replace(/[\u200e\u200f]/g, '').trim())
  if (name === '' || name === '.' || name === '..' || extname(name).toLowerCase() !== '.tex') {
    throw new Error('dsh-overleaf: the current Overleaf document must have a valid .tex filename')
  }
  return name
}

/** Resolve one local .tex target; an empty path uses safe auto-selection. */
async function resolveWorkspaceTexPath(cwd: string, requestedPath: string, fallbackName: string, createWhenMissing: boolean): Promise<{
  root: string
  target: string
}> {
  const root = await canonicalWorkspaceRoot(cwd)
  const rawPath = requestedPath.trim()
  let target: string
  if (rawPath !== '') {
    if (rawPath.includes('\u0000')) throw new Error('dsh-overleaf: invalid .tex path')
    target = resolvePath(isAbsolute(rawPath) ? rawPath : joinPath(root, rawPath))
  } else {
    const safeName = safeTexFallbackName(fallbackName)
    const candidates = await discoverWorkspaceTexFiles(root)
    const exact = candidates.filter(path => basename(path) === safeName)
    const insensitive = candidates.filter(path => basename(path).toLowerCase() === safeName.toLowerCase())
    const matches = exact.length > 0 ? exact : insensitive
    if (matches.length === 1) target = matches[0]!
    else if (matches.length > 1) throw new Error('dsh-overleaf: multiple local .tex files have the same name; choose a path explicitly')
    else if (candidates.length > 0) throw new Error('dsh-overleaf: no same-named local .tex file was found; choose a path explicitly')
    else if (createWhenMissing) target = joinPath(root, safeName)
    else throw new Error('dsh-overleaf: no local .tex file was detected; choose a path or provide manual content')
  }
  if (!isWithinWorkspace(root, target)) {
    throw new Error('dsh-overleaf: the .tex file must be inside the current session workspace')
  }
  if (extname(target).toLowerCase() !== '.tex') {
    throw new Error('dsh-overleaf: only .tex files can be synchronized')
  }
  return { root, target }
}

/** Read one workspace .tex for the explicitly confirmed reverse direction. */
export async function readLocalTexFile(cwd: string, requestedPath: string, fallbackName = 'current.tex'): Promise<{
  path: string
  name: string
  content: string
  mtimeMs: number
  size: number
}> {
  const resolved = await resolveWorkspaceTexPath(cwd, requestedPath, fallbackName, false)
  const target = await realpath(resolved.target).catch(() => undefined)
  if (target === undefined) throw new Error(`dsh-overleaf: .tex file not found: ${resolved.target}`)
  if (!isWithinWorkspace(resolved.root, target)) {
    throw new Error('dsh-overleaf: the .tex file resolves outside the current session workspace')
  }
  if (extname(target).toLowerCase() !== '.tex') {
    throw new Error('dsh-overleaf: the .tex file resolves to a non-.tex target')
  }
  const stats = await stat(target).catch(() => undefined)
  if (stats === undefined || !stats.isFile()) throw new Error(`dsh-overleaf: .tex file not found: ${target}`)
  if (stats.size > MAX_TEX_FILE_BYTES) throw new Error('dsh-overleaf: .tex file exceeds the 4 MiB safety limit')
  const content = await readFile(target, 'utf8')
  return { path: target, name: basename(target), content, mtimeMs: stats.mtimeMs, size: stats.size }
}

/**
 * Write an Overleaf source snapshot into the workspace and verify the exact
 * UTF-8 content. On a failed write/readback, restore the previous file (or
 * remove the newly-created partial file) before reporting failure.
 */
export async function writeLocalTexFile(cwd: string, requestedPath: string, fallbackName: string, content: string): Promise<{
  path: string
  name: string
  mtimeMs: number
  size: number
  created: boolean
  unchanged: boolean
}> {
  const contentBytes = Buffer.byteLength(content, 'utf8')
  if (contentBytes > MAX_TEX_FILE_BYTES) throw new Error('dsh-overleaf: .tex content exceeds the 4 MiB safety limit')
  const resolved = await resolveWorkspaceTexPath(cwd, requestedPath, fallbackName, true)
  const existingReal = await realpath(resolved.target).catch(() => undefined)
  if (existingReal !== undefined && !isWithinWorkspace(resolved.root, existingReal)) {
    throw new Error('dsh-overleaf: the .tex file resolves outside the current session workspace')
  }
  const target = existingReal ?? resolved.target
  if (extname(target).toLowerCase() !== '.tex') {
    throw new Error('dsh-overleaf: the .tex file resolves to a non-.tex target')
  }
  const parent = await realpath(dirname(target)).catch(() => undefined)
  if (parent === undefined || !isWithinWorkspace(resolved.root, parent)) {
    throw new Error('dsh-overleaf: the .tex parent directory must already exist inside the workspace')
  }
  const previousStats = await stat(target).catch(() => undefined)
  if (previousStats !== undefined && !previousStats.isFile()) {
    throw new Error('dsh-overleaf: the selected .tex target is not a regular file')
  }
  if (previousStats !== undefined && previousStats.size > MAX_TEX_FILE_BYTES) {
    throw new Error('dsh-overleaf: existing .tex file exceeds the 4 MiB safety limit')
  }
  const previous = previousStats === undefined ? undefined : await readFile(target, 'utf8')
  if (previous === content) {
    return {
      path: target, name: basename(target), mtimeMs: previousStats!.mtimeMs,
      size: previousStats!.size, created: false, unchanged: true,
    }
  }
  try {
    await writeFile(target, content, 'utf8')
    if (await readFile(target, 'utf8') !== content) throw new Error('write verification failed')
  } catch (error) {
    if (previous !== undefined) await writeFile(target, previous, 'utf8').catch(() => undefined)
    else await unlink(target).catch(() => undefined)
    throw new Error(`dsh-overleaf: local .tex write failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`)
  }
  const nextStats = await stat(target)
  return {
    path: target, name: basename(target), mtimeMs: nextStats.mtimeMs,
    size: nextStats.size, created: previousStats === undefined, unchanged: false,
  }
}

function stringField(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Embedded Overleaf workbench service provided by this host plugin. */
    overleafWorkbench: OverleafWorkbenchService
  }
}

/** The `ctx.overleafWorkbench` service. */
export class OverleafWorkbenchService extends Service {
  static inject = ['webServer', 'credentials', 'settings', 'sessions']
  static Config = Config

  /** Mutable because live settings updates swap it wholesale. */
  private config: ResolvedConfig
  private proxy: ReverseProxy
  private readonly bridgeScript: string

  /** Background CDP login bookkeeping (client polls /login-status). */
  private loginRunning = false
  private loginStartedAt = 0
  private loginResult: WorkbenchLoginResult | undefined
  private loginError: string | undefined

  constructor(ctx: Context, config: WorkbenchConfig) {
    super(ctx, 'overleaf-workbench')
    // Keep the loader-resolved container: its `.volatile()` fields are live
    // references the Loader mutates in place, so later samples read new values.
    this.rawConfig = config
    this.config = resolveConfig(config)
    this.proxy = new ReverseProxy(this.config.baseUrl)
    this.bridgeScript = renderBridgeScript()
    this.proxy.injectScriptSrc = this.config.injectScriptEnabled ? '/overleaf/workbench/bridge.js' : undefined
    void this.refreshCredential()
      .catch(error => ctx.logger?.warn?.(`dsh-overleaf: credential probe failed: ${error instanceof Error ? error.message : String(error)}`))
    this.registerRoutes()
    this.registerSettingsIntegration()
    this.startWsTunnel()
  }

  /** Resolve the workspace from server-owned session metadata, never client input. */
  private workspaceForPayload(payload: unknown): string {
    const sessionId = stringField(payload, 'sessionId')
    if (sessionId === undefined || sessionId.trim() === '') {
      throw new Error('dsh-overleaf: workspace synchronization requires a sessionId')
    }
    const session = this.ctx.sessions.get(sessionId as SessionId)
    const cwd = session?.header.cwd
    if (cwd === undefined || cwd.trim() === '') {
      throw new Error('dsh-overleaf: the active session has no workspace')
    }
    return cwd
  }

  /**
   * Companion WS tunnel on its OWN loopback port. The DSH webserver's upgrade
   * registry is exact-path-only and socket.io's upgrade paths carry dynamic
   * session ids (`/socket.io/<sid>/websocket/<t>`), which can never match.
   * The bridge redirects the embedded site's WebSocket connections to this
   * port, where every upgrade path is tunneled verbatim to the upstream.
   */
  private startWsTunnel(): void {
    const server = http.createServer((_request, response) => {
      // HTTP on this port is not a supported surface; upgrades only.
      this.destroySafely(response)
    })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!isLoopback(req)) {
        socket.destroy()
        return
      }
      this.proxy.tunnelUpgrade(req, socket, head)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port > 0) {
        this.proxy.wsPort = port
        this.proxy.wsAllowOrigin = `ws://127.0.0.1:${port} wss://127.0.0.1:${port}`
      }
    })
    this.ctx.effect(() => () => {
      server.close()
      server.closeAllConnections?.()
    }, 'dsh-overleaf: ws tunnel server')
  }

  /** Port of the companion WS tunnel (0 until listening; tests may read it). */
  get wsTunnelPort(): number {
    return this.proxy.wsPort
  }

  private destroySafely(response: ServerResponse): void {
    try {
      response.writeHead(404)
      response.end()
    } catch {
      /* already gone */
    }
  }

  /**
   * The loader-resolved config container. Its `.volatile()` fields are live
   * references (`{ get() }`) that the Loader mutates in place, so re-resolving
   * this same object always yields the current values.
   */
  private readonly rawConfig: WorkbenchConfig

  /**
   * DSH 0.1.7+ settings integration.
   *
   * The Loader projects a plugin's Config into the settings forms, but ONLY its
   * `.volatile()` fields: `dsh-settings`' `volatileForm()` returns undefined for
   * a schema without one, after which `describe()` omits the entry entirely and
   * no client page or transport write can address it. With volatile fields
   * present, a save commits those references in place and the Loader emits
   * `loader/volatile-update` on this fiber instead of remounting the plugin —
   * that event is the cue to re-resolve and hot-swap the proxy, so baseUrl and
   * feature edits apply without a restart.
   *
   * `configure({ auto: false })` declares that this plugin ships its own page
   * (the client half registers into the Plugins page's keyed seats), which
   * suppresses any schema-generated page. Everything here degrades silently on
   * harness generations without these services.
   */
  private registerSettingsIntegration(): void {
    if (typeof this.ctx.inject === 'function') {
      try {
        this.ctx.inject(['settings'], (child: Context) => {
          try {
            const settings = (child as unknown as {
              settings?: { configure?(presentation: { auto?: boolean }, owner?: unknown): () => void }
            }).settings
            if (settings?.configure === undefined) return
            const configure = settings.configure.bind(settings)
            child.effect(
              () => configure({ auto: false }, this.ctx.fiber),
              'dsh-overleaf: settings page policy',
            )
          } catch (error) {
            console.warn('[dsh-overleaf] settings page policy skipped:', error instanceof Error ? error.message : error)
          }
        })
      } catch (error) {
        console.warn('[dsh-overleaf] settings service unavailable:', error instanceof Error ? error.message : error)
      }
    }

    // Live edits arrive as a fiber-scoped event once the references changed;
    // re-resolving the container reads the committed values.
    try {
      const events = this.ctx as unknown as {
        on?(name: string, listener: (...args: unknown[]) => void): unknown
      }
      events.on?.('loader/volatile-update', () => {
        try {
          this.applyRuntimeConfig(resolveConfig(this.rawConfig))
        } catch (error) {
          console.warn('[dsh-overleaf] live settings application failed:', error instanceof Error ? error.message : error)
        }
      })
    } catch (error) {
      console.warn('[dsh-overleaf] volatile-update subscription skipped:', error instanceof Error ? error.message : error)
    }
  }

  /** Swap runtime behavior after a settings commit (hot reload of the proxy). */
  private applyRuntimeConfig(next: ResolvedConfig): void {
    const staleCookie = this.proxy.extraCookie
    const wsPort = this.proxy.wsPort
    const wsAllowOrigin = this.proxy.wsAllowOrigin
    this.config = next
    this.proxy = new ReverseProxy(next.baseUrl)
    this.proxy.extraCookie = staleCookie
    this.proxy.injectScriptSrc = next.injectScriptEnabled ? '/overleaf/workbench/bridge.js' : undefined
    // The companion server remains alive across settings commits. Preserve its
    // published endpoint on the replacement proxy or editor pages loaded after
    // any settings save silently lose their only dynamic WebSocket route.
    this.proxy.wsPort = wsPort
    this.proxy.wsAllowOrigin = wsAllowOrigin
  }

  /** Push the latest stored cookie into the proxy (re-read on every change). */
  private async refreshCredential(): Promise<void> {
    try {
      const resolved = await this.ctx.credentials.resolve(OVERLEAF_WORKBENCH_COOKIE)
      this.proxy.extraCookie = resolved?.value
    } catch {
      this.proxy.extraCookie = undefined
    }
  }

  /** Register one exact JSON route with the shared envelope contract. */
  private route(path: string, run: (payload: Record<string, unknown>) => Promise<unknown>, maxRequestBytes = MAX_REQUEST_BYTES): void {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'dsh-overleaf-loopback-only', message: 'workbench routes are loopback-only' },
          })
          return
        }
        try {
          const payload = await readJsonBody(req, maxRequestBytes)
          sendJson(res, 200, { ok: true, value: await run((payload ?? {}) as Record<string, unknown>) })
        } catch (error) {
          sendError(res, error)
        }
      },
    }), `dsh-overleaf: route ${path}`)
  }

  private registerRoutes(): void {
    // JSON API routes.
    this.route('/overleaf/workbench/status', () => this.status())
    // Login runs in the background: the route returns immediately and the
    // client polls /login-status, so a page refresh or slow CDP wait never
    // wedges the toolbar button for minutes.
    this.route('/overleaf/workbench/login', async (payload) => {
      if (this.loginRunning) return { kind: 'pending' as const }
      const browserChannel = stringField(payload, 'browserChannel')
      const channel = browserChannel !== undefined && ['auto', 'default', 'msedge', 'chrome', 'real'].includes(browserChannel)
        ? browserChannel as ResolvedConfig['browserChannel']
        : undefined
      const browserPath = stringField(payload, 'browserPath')
      this.loginRunning = true
      this.loginStartedAt = Date.now()
      this.loginResult = undefined
      this.loginError = undefined
      void this.login(channel, browserPath)
        .then(async result => {
          this.loginResult = result
          await this.refreshCredential()
        })
        .catch((error: unknown) => {
          this.loginError = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          this.loginRunning = false
          void this.refreshCredential().catch(() => undefined)
        })
      return { kind: 'started' as const }
    })
    this.route('/overleaf/workbench/login-status', async () => ({
      running: this.loginRunning,
      elapsedMs: this.loginRunning ? Date.now() - this.loginStartedAt : 0,
      ...(this.loginResult !== undefined ? { result: this.loginResult } : {}),
      ...(this.loginError !== undefined ? { error: this.loginError } : {}),
    }))
    this.route('/overleaf/workbench/cookie', async (payload) => {
      const cookie = stringField(payload, 'cookie')
      if (cookie === undefined || cookie.trim() === '') throw new Error('dsh-overleaf: cookie route requires a non-empty cookie header line')
      await this.saveCookie(cookie.trim())
      await this.refreshCredential()
      return { saved: true }
    })
    this.route('/overleaf/workbench/logout', async () => {
      await this.ctx.credentials.unset(OVERLEAF_WORKBENCH_COOKIE)
      await this.refreshCredential()
      return { cleared: true }
    })
    this.route('/overleaf/workbench/projects', () => this.listProjects())
    this.route('/overleaf/workbench/embed-info', async () => ({
      baseUrl: this.config.baseUrl,
      embedUrl: `${PROXY_PREFIX}/`,
      selectionQuoteEnabled: this.config.selectionQuoteEnabled,
      cursorInsertEnabled: this.config.cursorInsertEnabled,
      assistPanelEnabled: this.config.assistPanelEnabled,
    }))
    // Local bibliography sync. The workspace comes from server-owned session
    // metadata; user paths may be relative or absolute but cannot escape it.
    this.route('/overleaf/workbench/bib-files', async payload => {
      return { files: await discoverWorkspaceBibFiles(this.workspaceForPayload(payload)) }
    })
    this.route('/overleaf/workbench/read-bib-file', async payload => {
      const path = stringField(payload, 'path')
      if (path === undefined) throw new Error('dsh-overleaf: read-bib-file requires a path')
      return await readLocalBibFile(this.workspaceForPayload(payload), path)
    })
    // Bidirectional current-document .tex sync. Every path is resolved from
    // trusted session metadata and remains confined to that workspace.
    this.route('/overleaf/workbench/tex-files', async payload => {
      return { files: await discoverWorkspaceTexFiles(this.workspaceForPayload(payload)) }
    })
    this.route('/overleaf/workbench/read-tex-file', async payload => {
      const path = stringField(payload, 'path') ?? ''
      const fallbackName = stringField(payload, 'fallbackName') ?? 'current.tex'
      return await readLocalTexFile(this.workspaceForPayload(payload), path, fallbackName)
    })
    this.route('/overleaf/workbench/write-tex-file', async payload => {
      const path = stringField(payload, 'path') ?? ''
      const fallbackName = stringField(payload, 'fallbackName')
      const content = stringField(payload, 'content')
      if (fallbackName === undefined) throw new Error('dsh-overleaf: write-tex-file requires a fallbackName')
      if (content === undefined) throw new Error('dsh-overleaf: write-tex-file requires text content')
      return await writeLocalTexFile(this.workspaceForPayload(payload), path, fallbackName, content)
    }, MAX_TEX_REQUEST_BYTES)
    // Agent-output handoff: the assistant is asked (in its prompt) to write
    // the final content into dsh-overleaf-insert.md inside the workspace; the
    // panel polls this route and fills its reviewable custom-content box with
    // a new stable revision. Reads are limited to that single fixed filename
    // inside the workspace directory.
    this.route('/overleaf/workbench/read-insert-file', async payload => {
      const cwd = stringField(payload, 'cwd')
      if (cwd === undefined || cwd.trim() === '' || !isAbsolute(cwd.trim())) {
        throw new Error('dsh-overleaf: read-insert-file requires an absolute cwd')
      }
      const target = joinPath(cwd.trim(), INSERT_FILE_NAME)
      const stats = await stat(target).catch(() => undefined)
      if (stats === undefined || !stats.isFile()) return { exists: false }
      const content = await readFile(target, 'utf8')
      return { exists: true, content, mtimeMs: stats.mtimeMs }
    })
    // Compile-fix handoff: same stable-revision contract as read-insert-file,
    // but for the edit list the agent writes into dsh-overleaf-fix.md.
    this.route('/overleaf/workbench/read-fix-file', async payload => {
      const cwd = stringField(payload, 'cwd')
      if (cwd === undefined || cwd.trim() === '' || !isAbsolute(cwd.trim())) {
        throw new Error('dsh-overleaf: read-fix-file requires an absolute cwd')
      }
      const target = joinPath(cwd.trim(), FIX_FILE_NAME)
      const stats = await stat(target).catch(() => undefined)
      if (stats === undefined || !stats.isFile()) return { exists: false }
      const content = await readFile(target, 'utf8')
      return { exists: true, content, mtimeMs: stats.mtimeMs }
    })

    // Bridge script asset (served from its own exact route; loopback-fenced).
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: '/overleaf/workbench/bridge.js',
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden: loopback-only')
          return
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(this.bridgeScript)
      },
    }), 'dsh-overleaf: bridge script')

    // Reverse proxy: one prefix HTTP route + socket.io upgrade tunnels.
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: PROXY_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'dsh-overleaf-loopback-only', message: 'proxy routes are loopback-only' },
          })
          return
        }
        await this.proxy.handle(req, res)
      },
    }), 'dsh-overleaf: reverse proxy')

    for (const wsPath of ['/overleaf-proxy/socket.io/', '/overleaf-proxy/socket.io', '/socket.io/', '/socket.io',
      '/overleaf-proxy/__dsh_socket__/socket.io/', '/overleaf-proxy/__dsh_socket__/socket.io']) {
      this.ctx.effect(() => this.ctx.webServer.registerUpgrade({
        path: wsPath,
        handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (!isLoopback(req)) {
            socket.destroy()
            return
          }
          this.proxy.tunnelUpgrade(req, socket, head)
        },
      }), `dsh-overleaf: upgrade ${wsPath}`)
    }

    // Classic socket.io clients (Overleaf's editor ships the 0.x/1.x client)
    // connect to the CURRENT origin at the un-prefixed resource path
    // `/socket.io/` - polling requests and the WebSocket upgrade both. DSH
    // core and every known plugin leave that path unclaimed, so the proxy
    // claims it as an alias of the prefixed channel (same loopback fence).
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: '/socket.io',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'dsh-overleaf-loopback-only', message: 'proxy routes are loopback-only' },
          })
          return
        }
        await this.proxy.handle(req, res)
      },
    }), 'dsh-overleaf: socket.io polling alias')
  }

  /** Read current account state plus embed descriptors for the toolbar. */
  async status(): Promise<WorkbenchStatus & { assistPanelEnabled?: boolean }> {
    let loggedIn = false
    try {
      const described = await this.ctx.credentials.describe(OVERLEAF_WORKBENCH_COOKIE)
      loggedIn = described.configured
    } catch {
      loggedIn = false
    }
    return {
      loggedIn,
      baseUrl: this.config.baseUrl,
      embedUrl: `${PROXY_PREFIX}/`,
      proxyReady: true,
      assistPanelEnabled: this.config.assistPanelEnabled,
    }
  }

  /** Log in through direct CDP against the configured upstream origin. */
  async login(browserChannel?: ResolvedConfig['browserChannel'], browserPath?: string): Promise<WorkbenchLoginResult> {
    const target = new URL(this.config.baseUrl)
    return await loginViaCdp(this.ctx.credentials, {
      loginUrl: `${this.config.baseUrl}/login`,
      targetHost: target.hostname,
      baseUrl: this.config.baseUrl,
      projectUrlPrefix: `${this.config.baseUrl}/project`,
      browserChannel: browserChannel ?? this.config.browserChannel,
      ...(browserPath !== undefined && browserPath.trim() !== ''
        ? { browserPath: browserPath.trim() }
        : this.config.browserPath !== undefined
          ? { browserPath: this.config.browserPath }
          : {}),
      ...(this.config.loginProxyServer !== undefined
        ? { loginProxyServer: this.config.loginProxyServer }
        : {}),
      timeoutMs: this.config.loginTimeoutMs,
      profileMode: this.config.loginProfile,
    })
  }

  /**
   * Store a cookie header line after a tolerant upstream check. The check
   * accepts standard Overleaf (200 on /project) and TeXPage-style deployments
   * (dashboard redirect away from /login); see cookie-validate.ts.
   */
  async saveCookie(cookie: string): Promise<void> {
    await validateCookieHeader(cookie, this.config.baseUrl)
    await this.ctx.credentials.set(OVERLEAF_WORKBENCH_COOKIE, cookie)
  }

  /** List projects through dashboard JSON APIs, falling back to HTML scraping. */
  async listProjects(signal?: AbortSignal): Promise<WorkbenchProject[]> {
    const cookieResolves = await this.ctx.credentials.resolve(OVERLEAF_WORKBENCH_COOKIE).catch(() => undefined)
    if (cookieResolves === undefined) {
      throw new Error('dsh-overleaf: OVERLEAF_WORKBENCH_COOKIE is not configured; log in first')
    }
    const failures: string[] = []
    for (const path of ['/api/project', '/api/projects', '/api/v2/projects'] as const) {
      try {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          headers: {
            cookie: cookieResolves.value,
            accept: 'application/json',
            referer: `${this.config.baseUrl}/project`,
          },
          ...(signal !== undefined ? { signal } : {}),
        })
        if (!response.ok) {
          failures.push(`${path}: HTTP ${response.status}`)
          continue
        }
        const projects = projectsFromUnknown(await response.json())
        if (projects.length > 0) return projects
        failures.push(`${path}: no recognizable entries`)
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const html = await fetch(`${this.config.baseUrl}/project`, {
        headers: { cookie: cookieResolves.value, accept: 'text/html' },
        ...(signal !== undefined ? { signal } : {}),
      }).then(response => response.text())
      const scraped = projectsFromDashboardHtml(html)
      if (scraped.length > 0) return scraped
      failures.push('/project: dashboard contained no project links')
    } catch (error) {
      failures.push(`/project: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`dsh-overleaf: could not list projects (${failures.join('; ')})`)
  }
}

interface RawProjectLike {
  _id?: unknown
  id?: unknown
  name?: unknown
  lastUpdated?: unknown
}

/** Normalize heterogeneous project JSON shapes into wire rows. */
function projectsFromUnknown(value: unknown): WorkbenchProject[] {
  const array = Array.isArray(value) ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { projects?: unknown[] }).projects)
      ? (value as { projects: unknown[] }).projects
      : []
  const out: WorkbenchProject[] = []
  for (const item of array) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as RawProjectLike
    const id = typeof raw._id === 'string' ? raw._id : typeof raw.id === 'string' ? raw.id : undefined
    if (id === undefined) continue
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : id
    const lastUpdated = typeof raw.lastUpdated === 'string' ? raw.lastUpdated : undefined
    out.push({ id, name, ...(lastUpdated !== undefined ? { lastUpdated } : {}) })
  }
  return out
}

/** Scrape `<a href="/project/<24hex>">` rows out of a dashboard HTML page. */
export function projectsFromDashboardHtml(html: string): WorkbenchProject[] {
  const out: WorkbenchProject[] = []
  const seen = new Set<string>()
  const pattern = /<a\b[^>]*\bhref=["']\/project\/([0-9a-fA-F]{24})["'][^>]*>([\s\S]*?)<\/a>/gi
  let match = pattern.exec(html)
  while (match !== null) {
    const id = match[1]
    const inner = match[2] ?? ''
    if (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const text = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      out.push({ id, name: text !== '' ? text : id })
    }
    match = pattern.exec(html)
  }
  return out
}

export default OverleafWorkbenchService
