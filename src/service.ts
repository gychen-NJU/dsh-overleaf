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
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
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

/** Services required before the host plugin can mount. */
export const inject = ['webServer', 'credentials']

export { Config }

const MAX_REQUEST_BYTES = 64 * 1024

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req: IncomingMessage): boolean {
  return req.socket.remoteAddress === undefined || LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw new Error('dsh-overleaf: request body too large')
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

/** Minimal structural face of the optional settings service we consume. */
interface SettingsScopeFace {
  /** Current resolved value for the namespace (no snapshot wrapper). */
  get(): Record<string, unknown> | undefined
  /** Observe changes; listeners receive `(next, prev)` resolved values. */
  watch(listener: (next: unknown, prev: unknown) => void): () => void
}

/** The `ctx.overleafWorkbench` service. */
export class OverleafWorkbenchService extends Service {
  static inject = ['webServer', 'credentials', 'settings']
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
    this.config = resolveConfig(config)
    this.mountBaseConfig = { ...config }
    this.proxy = new ReverseProxy(this.config.baseUrl)
    this.bridgeScript = renderBridgeScript()
    this.proxy.injectScriptSrc = this.config.injectScriptEnabled ? '/overleaf/workbench/bridge.js' : undefined
    void this.refreshCredential()
      .catch(error => ctx.logger?.warn?.(`dsh-overleaf: credential probe failed: ${error instanceof Error ? error.message : String(error)}`))
    this.registerRoutes()
    this.registerSettingsNamespace()
  }

  /** Base layer handed to the settings service (the composed mount config). */
  private readonly mountBaseConfig: WorkbenchConfig | undefined

  /**
   * Publish the `dsh-overleaf` settings namespace so the Plugins settings page
   * can own baseUrl/feature toggles without hand-editing the profile row.
   * Composed patch values become the namespace `base`; user edits layer above
   * them. Live changes hot-swap the proxy target — no restart required. The
   * whole feature degrades silently when the profile runs no settings service.
   */
  private registerSettingsNamespace(): void {
    const settings = (this.ctx as { settings?: { register(ns: string, schema: unknown, options?: { base?: WorkbenchConfig }): SettingsScopeFace } }).settings
    if (settings?.register === undefined) return
    try {
      const scope = settings.register('dsh-overleaf', Config, {
        base: this.mountBaseConfig ?? {},
      })
      this.ctx.effect(() => scope.watch((next) => {
        try {
          if (next !== undefined) {
            this.applyRuntimeConfig(resolveConfig(next as WorkbenchConfig))
          }
        } catch (error) {
          console.warn('[dsh-overleaf] settings application failed:', error instanceof Error ? error.message : error)
        }
      }), 'dsh-overleaf: settings watcher')
      // Seed from a possibly pre-existing user section (saved on an earlier
      // run); without it the freshly mounted service would ignore prior edits.
      const seeded = scope.get()
      if (seeded !== undefined) {
        this.applyRuntimeConfig(resolveConfig(seeded as WorkbenchConfig))
      }
    } catch (error) {
      // A rejected registration must never fail the plugin mount.
      console.warn('[dsh-overleaf] settings namespace skipped:', error instanceof Error ? error.message : error)
    }
  }

  /** Swap runtime behavior after a settings commit (hot reload of the proxy). */
  private applyRuntimeConfig(next: ResolvedConfig): void {
    const staleCookie = this.proxy.extraCookie
    this.config = next
    this.proxy = new ReverseProxy(next.baseUrl)
    this.proxy.extraCookie = staleCookie
    this.proxy.injectScriptSrc = next.injectScriptEnabled ? '/overleaf/workbench/bridge.js' : undefined
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
  private route(path: string, run: (payload: Record<string, unknown>) => Promise<unknown>): void {
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
          const payload = await readJsonBody(req)
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

    for (const wsPath of ['/overleaf-proxy/socket.io/', '/overleaf-proxy/socket.io']) {
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
