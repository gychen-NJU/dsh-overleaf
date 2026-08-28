/**
 * Same-origin reverse proxy for one fixed Overleaf origin. The embedded view
 * loads `${PROXY_PREFIX}/<path>` instead of the real site, which sidesteps
 * X-Frame-Options/CSP framing limits and (critically) makes the iframe
 * same-origin with the GUI shell, enabling the selection and cursor bridges.
 *
 * Design notes:
 * - Requests stream both ways without buffering (binary uploads/downloads,
 *   compiled PDFs), EXCEPT text/html responses whose bodies need rebasing.
 * - The target is locked to config.baseUrl (no SSRF surface): every outbound
 *   connection goes to that single origin.
 * - Loopback-only enforcement lives in the service route wrapper; handlers
 *   here assume an already-fenced request.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Prefix under which the upstream site is exposed (disjoint from other plugins). */
export const PROXY_PREFIX = '/overleaf-proxy'

/** Proxied HTML responses larger than this stream through untouched. */
const MAX_REWRITE_BODY_BYTES = 4 * 1024 * 1024

/** Upstream connection timeout for regular proxied requests. */
const REQUEST_TIMEOUT_MS = 60_000

/** Compile is a synchronous long-poll and legitimately outlives asset calls. */
const COMPILE_REQUEST_TIMEOUT_MS = 10 * 60_000

/** Timeout granted to establish the tunneled upstream TCP/TLS connection. */
const UPGRADE_CONNECT_TIMEOUT_MS = 10_000

/** Hop-by-hop headers that must never cross a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Rebase one root-relative reference against the proxy prefix. URLs already
 *  carrying the prefix (double-rebase guard) or pointing at the plugin's own
 *  routes are left untouched. */
function rebaseAttributeUrl(url: string, prefix: string): string {
  if (!url.startsWith('/')) return url
  if (url.startsWith(`${prefix}/`) || url.startsWith('/overleaf/workbench/')) return url
  return `${prefix}${url}`
}

/**
 * Rebase CSS url(...) / @import references inside one stylesheet body.
 * (text/css responses are otherwise passed through untouched - un-rebased
 * `url(/overleaf-logo.svg)`-style references resolve against the shell origin
 * and 404 in a loop.)
 */
export function rewriteCss(css: string, prefix: string): string {
  const rebased = css.replace(/url\(\s*(['"]?)(\/[^)'"]+)(['"]?)\s*\)/gi,
    (_match, quote: string, pathValue: string, tail: string) =>
      `url(${quote}${rebaseAttributeUrl(pathValue, prefix)}${tail})`)
  return rebased.replace(/(@import\s+)(?!url\()(["'])(\/[^"']+)\2/gi,
    (_match, lead: string, quote: string, pathValue: string) =>
      `${lead}${quote}${rebaseAttributeUrl(pathValue, prefix)}${quote}`)
}

/**
 * Extract the script nonce for one response: prefer the `script-src` nonce in
 * the CSP header, fall back to the first `<script nonce="...">` in the HTML.
 * Under `'strict-dynamic'` CSP, 'self'/host allowlists are ignored and ONLY
 * nonce-marked scripts run, so the injected bridge must carry this nonce.
 */
export function extractCspNonce(csp: string | undefined, html: string | undefined): string | undefined {
  if (csp !== undefined && csp !== '') {
    const scriptSrc = /script-src[^;]*/i.exec(csp)?.[0] ?? csp
    const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1]
    if (nonce !== undefined && nonce !== '') return nonce
  }
  if (html !== undefined && html !== '') {
    const nonce = /<script[^>]*\bnonce="([^"]+)"/i.exec(html)?.[1]
    if (nonce !== undefined && nonce !== '') return nonce
  }
  return undefined
}

/**
 * Rewrite one HTML body for same-origin serving:
 *  1. every occurrence of the TARGET ORIGIN string becomes the proxy prefix,
 *     so apps that build internal links/API/socket URLs from an embedded
 *     `siteUrl` (Overleaf does exactly this) stay inside the proxy instead of
 *     navigating the iframe to the real site, where X-Frame-Options blocks
 *     the load and clicks appear dead;
 *  2. root-relative attribute references become proxy-rooted;
 *  3. the bridge script (and via it the runtime URL wrappers) is injected,
 *     carrying the response's CSP nonce when one exists ('strict-dynamic'
 *     pages would otherwise block it).
 */
/** Rewrite root-relative resource references inside one HTML body. */
export function rewriteHtml(
  html: string,
  prefix: string,
  injectScriptSrc: string | undefined,
  targetOrigin: string | undefined,
  cspNonce: string | undefined,
  wsPort: number,
): string {
  let out = html.replaceAll('"//', '"https://')
  // 1. Root-relative attribute references become proxy-rooted first. (The
  // origin-string replacement below must run AFTER this, otherwise an
  // absolute-origin attribute would be rebased twice.)
  out = out.replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*")(\/[^"']*)(")/gi,
    (_match, lead: string, pathValue: string, tail: string) =>
      `${lead}${rebaseAttributeUrl(pathValue, prefix)}${tail}`)
  out = out.replace(/(srcset\s*=\s*")([^"]*)(")/gi, (_m, lead: string, value: string, tail: string) => {
    const rebuilt = value.split(',').map(part => {
      const trimmed = part.trimStart()
      const leadingWhitespace = part.slice(0, part.length - trimmed.length)
      const [pathPart, descriptor] = trimmed.split(/\s+/, 2)
      const based = rebaseAttributeUrl(pathPart ?? '', prefix)
      return descriptor === undefined ? `${leadingWhitespace}${based}` : `${leadingWhitespace}${based} ${descriptor}`
    }).join(',')
    return `${lead}${rebuilt}${tail}`
  })
  // 2. Any remaining occurrence of the TARGET ORIGIN string (absolute links,
  // embedded siteUrl config values) becomes the proxy prefix. Attributes
  // already rebased above contain no origin substring, so they are untouched.
  if (targetOrigin !== undefined && targetOrigin !== '') {
    out = out.split(targetOrigin).join(prefix)
  }
  // 3. Inline <style> blocks and style="...url(...)" attributes: rebasing
  //    url(/x) inside them (the duplicate-rebase guard in
  //    rebaseAttributeUrl keeps already-prefixed URLs intact).
  out = out.replace(/url\(\s*(['"]?)(\/[^)'"]+)(['"]?)\s*\)/gi,
    (_match, quote: string, pathValue: string, tail: string) =>
      `url(${quote}${rebaseAttributeUrl(pathValue, prefix)}${tail})`)
  // 4. <base href="{prefix}/">: the deployed app assumes it lives at the site
  //    ROOT, so its RELATIVE (no leading slash) requests — `sse?userToken=`,
  //    `users?sessionId=`, bare project ids — must resolve against the proxy
  //    root, not the deep document directory. base restores exactly that.
  //    (Root-relative `/x` references ignore base and are handled by the
  //    attribute rewriting above.)
  if (!/<base\s/i.test(out)) {
    const baseTag = `<base href="${prefix}/">`
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, match => `${match}\n${baseTag}\n`)
    } else if (/<html[^>]*>/i.test(out)) {
      out = out.replace(/<html[^>]*>/i, match => `${match}\n${baseTag}\n`)
    } else {
      out = `${baseTag}\n${out}`
    }
  }
  if (injectScriptSrc !== undefined && !html.includes('dsh-overleaf-bridge')) {
    const nonceAttr = cspNonce !== undefined && cspNonce !== '' ? ` nonce="${cspNonce}"` : ''
    // Bootstrap FIRST: the WS tunnel port the bridge wrappers redirect
    // socket.io connections to (the webserver's upgrade registry is
    // exact-path only and cannot handle socket.io's dynamic paths).
    const bootstrap = wsPort > 0
      ? `<script${nonceAttr}>window.__DSH_OVERLEAF_WS_PORT__=${wsPort};</script>\n`
      : ''
    const tag = `${bootstrap}<script src="${injectScriptSrc}"${nonceAttr} data-dsh-overleaf-bridge></script>`
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, match => `${match}\n${tag}\n`)
    } else if (/<html[^>]*>/i.test(out)) {
      out = out.replace(/<html[^>]*>/i, match => `${match}\n${tag}\n`)
    } else {
      out = `${tag}\n${out}`
    }
  }
  return out
}

/**
 * Rewrite a Content-Security-Policy value so the proxied document can run:
 *  1. drop `frame-ancestors` entirely (the whole point of the proxy);
 *  2. append `'self'` to every resource directive the embedded app needs for
 *     same-origin loads (the bridge script, lazily inserted chunks, editor
 *     data calls, the socket.io tunnel) when that directive exists;
 *  3. when only `default-src` exists, append `'self'` there instead.
 * Everything else — every host allowlist entry — is preserved verbatim, so
 * the policy still blocks everything it blocked before except same-origin.
 */
const SELF_NEEDED_DIRECTIVES = new Set([
  'script-src', 'style-src', 'img-src', 'font-src', 'connect-src',
  'media-src', 'worker-src', 'child-src',
])

export function allowSelfInCsp(value: string, extraOrigins: string[] = []): { value: string; changed: boolean } {
  let changed = false
  const kept: string[] = []
  let hasScriptSrc = false
  let hasDefaultSrc = false
  const extras = extraOrigins.filter(origin => origin !== '' && !value.includes(origin))
  for (const rawDirective of value.split(';').map(item => item.trim()).filter(Boolean)) {
    if (/^frame-ancestors\b/i.test(rawDirective)) {
      changed = true
      continue
    }
    const match = /^([a-z-]+)(?:\s+([\s\S]*))?$/.exec(rawDirective)
    if (match === null) {
      kept.push(rawDirective)
      continue
    }
    const name = (match[1] ?? '').toLowerCase()
    const values = (match[2] ?? '').trim()
    if (name === 'script-src') hasScriptSrc = true
    if (name === 'default-src') hasDefaultSrc = true
    // base-uri 'none' blocks the injected <base> that gives RELATIVE requests
    // root-relative semantics under the proxy. Relax it to 'self' (the base
    // we inject is same-origin), keeping the directive's guard intent.
    if (name === 'base-uri' && /'none'/i.test(values)) {
      changed = true
      kept.push("base-uri 'self'")
      continue
    }
    if (SELF_NEEDED_DIRECTIVES.has(name) && !/(?:^|\s)'self'(?:\s|$)/i.test(values)) {
      changed = true
      kept.push(values === '' ? `${name} 'self'` : `${name} ${values} 'self'`)
      continue
    }
    if (name === 'connect-src' && extras.length > 0) {
      changed = true
      kept.push(values === '' ? `${name} ${extras.join(' ')}` : `${name} ${values} ${extras.join(' ')}`)
      continue
    }
    kept.push(rawDirective)
  }
  if (!hasScriptSrc && hasDefaultSrc) {
    const index = kept.findIndex(directive => /^default-src\b/i.test(directive))
    const directive = index >= 0 ? kept[index] : undefined
    if (directive !== undefined) {
      const values = directive.replace(/^default-src\b/i, '').trim()
      const additions = [
        ...(!/(?:^|\s)'self'(?:\s|$)/i.test(values) ? ["'self'"] : []),
        ...extras,
      ]
      if (additions.length > 0) {
        changed = true
        kept[index] = values === '' ? `default-src ${additions.join(' ')}` : `default-src ${values} ${additions.join(' ')}`
      }
    }
  }
  return { value: kept.join('; '), changed }
}

/** Remove only the framing directives from a Content-Security-Policy value. */
export function relaxFrameCsp(value: string): { value: string; changed: boolean } {
  const kept: string[] = []
  let changed = false
  for (const directive of value.split(';').map(item => item.trim()).filter(Boolean)) {
    if (/^frame-ancestors\b/i.test(directive)) {
      changed = true
      continue
    }
    kept.push(directive)
  }
  return { value: kept.join('; '), changed }
}

/** Strip Domain= from one Set-Cookie attribute list (cookie lands host-only). */
export function scopeSetCookieToHost(setCookieLine: string): string {
  return setCookieLine.replace(/;\s*domain=[^;]*/gi, '')
}

/**
 * Merge two Cookie header strings without duplicated names; later entries win.
 * NOTE: since v0.1.6 the proxy no longer mixes browser and stored cookies for
 * upstream auth requests — the stored credential is sent verbatim when it
 * exists (a browser-side anonymous twin of the session cookie must never be
 * able to override it). This helper remains for tests and external callers.
 */
export function mergeCookieHeaders(base: string | undefined, extra: string | undefined): string | undefined {
  const entries: string[] = []
  for (const source of [base, extra]) {
    if (source === undefined || source.trim() === '') continue
    for (const pair of source.split(';')) {
      const item = pair.trim()
      if (item === '') continue
      const equals = item.indexOf('=')
      if (equals <= 0) continue
      const name = item.slice(0, equals).trim()
      if (name === '') continue
      const existing = entries.findIndex(entry => entry.startsWith(`${name}=`))
      if (existing >= 0) entries.splice(existing, 1)
      entries.push(item)
    }
  }
  return entries.length > 0 ? entries.join('; ') : undefined
}

/**
 * Cookies whose value is deliberately rotated by an edge/load-balancer layer.
 *
 * A saved login header is the authority for application session cookies (this
 * prevents an anonymous browser-side `overleaf_session2` from replacing the
 * authenticated value).  Edge-affinity cookies are different: the response to
 * the Socket.IO handshake can rotate them immediately, and the subsequent
 * WebSocket upgrade must echo that latest browser value or it can reach a
 * different backend where the freshly issued socket id does not exist.
 */
function isRuntimeRoutingCookie(name: string): boolean {
  return /^(?:gclb|awsalb(?:cors|app-\d+)?|route|serverid|bigipserver.*|__cf_bm|cf_clearance|ak_bmsc|bm_sv|acw_tc|cdn_sec_tc)$/i.test(name)
    || /^(?:incap_ses_|visid_incap_)/i.test(name)
}

/**
 * Merge the browser's live cookie jar with the stored login credential.
 * Stored values win for normal/session cookies; a live browser value wins for
 * known routing cookies so an HTTP handshake and its WebSocket upgrade stay on
 * the same upstream worker.
 */
export function mergeProxyCookieHeaders(
  browserCookie: string | undefined,
  storedCookie: string | undefined,
): string | undefined {
  if (storedCookie === undefined || storedCookie.trim() === '') return browserCookie
  if (browserCookie === undefined || browserCookie.trim() === '') return storedCookie

  const liveRoutingNames = new Set<string>()
  for (const pair of browserCookie.split(';')) {
    const item = pair.trim()
    const equals = item.indexOf('=')
    if (equals <= 0) continue
    const name = item.slice(0, equals).trim()
    if (isRuntimeRoutingCookie(name)) liveRoutingNames.add(name.toLowerCase())
  }

  const storedWithoutStaleRouting = storedCookie.split(';').map(item => item.trim()).filter(item => {
    const equals = item.indexOf('=')
    if (equals <= 0) return false
    const name = item.slice(0, equals).trim()
    return !(isRuntimeRoutingCookie(name) && liveRoutingNames.has(name.toLowerCase()))
  }).join('; ')

  return mergeCookieHeaders(browserCookie, storedWithoutStaleRouting)
}

/** Compute the upstream sub-path (with query) for one matched request URL. */
export function subPathOf(rawUrl: string | undefined, prefix: string): string {
  const raw = rawUrl ?? '/'
  if (raw === prefix) return '/'
  if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length)
  return raw
}

/** Give synchronous Overleaf compile calls enough time without weakening every route. */
export function requestTimeoutFor(target: URL): number {
  return /\/project\/[^/]+\/compile\/?$/.test(target.pathname)
    ? COMPILE_REQUEST_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS
}

/**
 * A second upstream origin discovered from the site's own content-domain hints
 * (HTML meta `ol-compilesUserContentDomain` / compile JSON `pdfDownloadDomain`
 * + `outputUrlPrefix`). Overleaf serves compiled output files (PDFs, logs)
 * from a separate user-content host; the bridge re-roots absolute URLs on that
 * host back under the proxy, which then MUST forward them to that host (the
 * locked main origin 404s on those paths).
 */
interface ContentOriginRule {
  origin: URL
  /** Path prefix the content origin owns ('' = whole host, guard required). */
  prefix: string
}

/** Does the request path belong to a learned user-content origin? A rule with
 *  a disclosed prefix is exact; the bare-host fallback only accepts paths
 *  shaped like per-user build outputs (zone-scoped or `user/<uid>`), never an
 *  application page. */
function contentPathMatches(subPath: string, rule: ContentOriginRule): boolean {
  if (rule.prefix !== '') {
    return subPath === rule.prefix || subPath.startsWith(`${rule.prefix}/`)
  }
  return /^\/(?:zone\/[^/]+\/|project\/[0-9a-fA-F]{24}\/user\/)/.test(subPath)
}

/**
 * Extract the user-content origin hint from one proxied HTML body (the meta
 * tag shape used by Overleaf shells; attribute order is not guaranteed).
 */
export function extractContentDomainFromHtml(html: string): string | undefined {
  const names = ['ol-compilesUserContentDomain', 'ol-userContentDomain']
  for (const name of names) {
    const forward = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)
    if (forward?.[1] !== undefined && forward[1] !== '') return forward[1]
    const reverse = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, 'i').exec(html)
    if (reverse?.[1] !== undefined && reverse[1] !== '') return reverse[1]
  }
  return undefined
}

/**
 * Extract user-content origin hints from proxied JSON bodies (compile result
 * `pdfDownloadDomain`/`outputUrlPrefix`, cached-output `downloadURL`). Each
 * returned value is a full base URL the frontend prepends to output-file
 * paths, e.g. `https://compiles.overleafusercontent.com/zone/c`.
 */
export function extractContentHintsFromJson(jsonText: string): string[] {
  const hints: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    try {
      const parsed = new URL(value)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') hints.push(value)
    } catch {
      /* malformed - ignore */
    }
  }
  add(/"pdfDownloadDomain"\s*:\s*"([^"]+)"/.exec(jsonText)?.[1])
  const prefix = /"outputUrlPrefix"\s*:\s*"([^"]+)"/.exec(jsonText)?.[1]
  if (prefix !== undefined && prefix.trim() !== '') {
    const download = /"downloadURL"\s*:\s*"((?:https?:\/\/)[^"]+)"/.exec(jsonText)?.[1]
    if (download !== undefined) {
      try {
        const parsed = new URL(download)
        add(`${parsed.origin}${prefix.startsWith('/') ? '' : '/'}${prefix.replace(/\/+$/, '')}`)
      } catch {
        /* malformed - ignore */
      }
    }
  }
  // Full downloadURL entries contribute their ORIGIN only - a file path
  // (…/build/b1/output/output.pdf) must never become the zone prefix.
  for (const match of jsonText.matchAll(/"downloadURL"\s*:\s*"((?:https?:\/\/)[^"]+)"/g)) {
    const rawUrl = match[1]
    if (rawUrl === undefined) continue
    try {
      add(new URL(rawUrl).origin)
    } catch {
      /* malformed - ignore */
    }
  }
  return [...new Set(hints)]
}

/** Forward selection of inbound request headers toward one upstream request. */
export function buildUpstreamHeaders(
  req: IncomingMessage,
  target: URL,
  extraCookie: string | undefined,
): http.OutgoingHttpHeaders {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host' || lower === 'cookie' || lower === 'accept-encoding') continue
    headers[name] = Array.isArray(value) ? [...value] : value
  }
  // Delegated identity: any inbound Origin becomes the upstream origin; the
  // Referer keeps its path but loses the proxy prefix (root-relative URLs).
  headers['origin'] = target.origin
  const referer = headers['referer']
  if (typeof referer === 'string') headers['referer'] = referer.replaceAll('/overleaf-proxy', '')
  headers['host'] = target.host
  // Identity encoding keeps textual bodies rewritable end to end.
  headers['accept-encoding'] = 'identity'
  // Keep saved application-session values authoritative while retaining live
  // routing cookies (notably GCLB) issued by an immediately preceding request.
  // Socket.IO binds its handshake id to one backend; dropping the rotated
  // affinity value makes the WebSocket upgrade hit another backend and return
  // 502, leaving the editor on Loading forever.
  const browserCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined
  const mergedCookie = mergeProxyCookieHeaders(browserCookie, extraCookie)
  if (mergedCookie !== undefined && mergedCookie !== '') headers['cookie'] = mergedCookie
  return headers
}

/** Copy upstream response headers onto the outbound response, adjusted. */
function buildResponseHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  prefix: string,
  target: URL,
  wsAllowOrigin: string | undefined,
): { headers: Record<string, string | string[]>; hadFrameCsp: boolean } {
  const headers: Record<string, string | string[]> = {}
  let hadFrameCsp = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'x-frame-options') continue
    if (lower === 'content-security-policy') continue
    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [value]
      const scoped = cookies.filter((item): item is string => typeof item === 'string').map(scopeSetCookieToHost)
      if (scoped.length > 0) headers[name] = scoped
      continue
    }
    if (value === undefined) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        // Relative redirects are relative to the actual upstream request URL,
        // not merely its origin (important for project-scoped PDF downloads).
        const resolved = new URL(value, target)
        headers[name] = resolved.origin === target.origin
          ? `${prefix}${resolved.pathname}${resolved.search}${resolved.hash}`
          : value
      } catch {
        headers[name] = value
      }
      continue
    }
    headers[name] = value
  }
  const csp = upstreamHeaders['content-security-policy']
  if (csp !== undefined) {
    const joined = Array.isArray(csp) ? csp.join('; ') : csp
    const adjusted = allowSelfInCsp(joined, wsAllowOrigin !== undefined ? [wsAllowOrigin] : [])
    hadFrameCsp = adjusted.changed
    if (adjusted.value !== '') headers['content-security-policy'] = adjusted.value
  }
  return { headers, hadFrameCsp }
}

/**
 * One streaming reverse proxy bound to a single upstream origin. Instances are
 * cheap; update the stored credential by assigning `extraCookie`.
 */
export class ReverseProxy {
  private readonly target: URL

  constructor(origin: string) {
    this.target = new URL(origin)
  }

  /** Cookie header injected into every upstream request (may be undefined). */
  public extraCookie: string | undefined = undefined

  /** Bridge script src injected into rewritten HTML bodies (undefined disables). */
  public injectScriptSrc: string | undefined = undefined

  /** Loopback origin of the companion WS tunnel port (ws://127.0.0.1:port). */
  public wsAllowOrigin: string | undefined = undefined

  /** Port of the companion WS tunnel server (0 until it starts listening). */
  public wsPort = 0

  /** User-content output-file origin learned from the site's own hints. */
  private contentRule: ContentOriginRule | undefined = undefined

  /**
   * Register a user-content origin hint (e.g. `https://compiles
   * .overleafusercontent.com/zone/c`). The hint with the most specific path
   * prefix learned so far wins, so the zone-precise compile JSON hint
   * survives later origin-only meta tags.
   */
  learnContentHint(value: string): void {
    try {
      const parsed = new URL(value)
      const prefix = parsed.pathname === '/' || parsed.pathname === ''
        ? ''
        : parsed.pathname.replace(/\/+$/, '')
      if (this.contentRule === undefined || prefix.length > this.contentRule.prefix.length) {
        this.contentRule = { origin: new URL(parsed.origin), prefix }
      }
    } catch {
      /* malformed hint - ignore */
    }
  }

  /**
   * Upstream target for one matched sub-path: the locked main origin, or the
   * learned user-content origin when the path belongs to its zone.
   */
  private targetFor(subPath: string): URL {
    const rule = this.contentRule
    if (rule !== undefined && contentPathMatches(subPath, rule)) {
      return new URL(subPath, rule.origin)
    }
    return new URL(subPath, this.target)
  }

  /** Whether the given raw request URL belongs to this proxy. */
  matches(rawUrl: string | undefined): boolean {
    if (rawUrl === undefined) return false
    return rawUrl === PROXY_PREFIX || rawUrl.startsWith(`${PROXY_PREFIX}/`)
  }

  /** Handle one matched proxied HTTP request end-to-end. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const subPath = subPathOf(req.url, PROXY_PREFIX)
    const target = this.targetFor(subPath)
    const upstreamHeaders = buildUpstreamHeaders(req, target, this.extraCookie)
    await new Promise<void>((resolveProxy) => {
      let settled = false
      const settle = (): void => {
        if (!settled) {
          settled = true
          resolveProxy()
        }
      }
      const requestlib = target.protocol === 'https:' ? https : http
      let upstream: http.ClientRequest
      try {
        upstream = requestlib.request(target, {
          method: req.method,
          headers: upstreamHeaders,
          timeout: requestTimeoutFor(target),
        }, upstreamRes => {
          void deliverResponse(res, upstreamRes, target, this.injectScriptSrc, this.wsAllowOrigin, this.wsPort,
            hint => { this.learnContentHint(hint) }, settle)
        })
      } catch (error) {
        respondBadGateway(res, error)
        settle()
        return
      }
      upstream.on('timeout', () => upstream.destroy(new Error('dsh-overleaf: upstream request timeout')))
      upstream.on('error', error => {
        respondBadGateway(res, error)
        settle()
      })
      req.on('aborted', () => {
        upstream.destroy()
        settle()
      })
      req.pipe(upstream)
    })
  }

  /**
   * Tunnel an upgraded socket (WebSocket) to the same upstream origin. Called
   * through `webServer.registerUpgrade` for the exact pathname(s) the embedded
   * site uses; the handler owns protocol negotiation from here on.
   */
  tunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const subPath = subPathOf(req.url, PROXY_PREFIX)
    const isTls = this.target.protocol === 'https:'
    const port = Number(this.target.port) || (isTls ? 443 : 80)

    let upstreamSocket!: Duplex
    const destroyBoth = (): void => {
      socket.destroy()
      upstreamSocket?.destroy()
    }

    const connectCallback = (): void => {
      try {
        writeUpgradeRequest(req, subPath, this.target, this.extraCookie, upstreamSocket, head)
        spliceSockets(socket, upstreamSocket, destroyBoth)
      } catch {
        destroyBoth()
      }
    }

    upstreamSocket = isTls
      ? tlsConnect({ host: this.target.hostname, port, servername: this.target.hostname }, connectCallback)
      : net.connect({ host: this.target.hostname, port }, connectCallback)

    // Duplex typing does not expose socket timeout controls; both concrete
    // shapes here do.
    type SocketWithTimeout = typeof upstreamSocket & { setTimeout(ms: number): unknown }
    ;(upstreamSocket as SocketWithTimeout).setTimeout(UPGRADE_CONNECT_TIMEOUT_MS)
    upstreamSocket.once('timeout', () => destroyBoth())
    upstreamSocket.once('error', destroyBoth)
    socket.once('error', destroyBoth)
  }
}

/** Stream one upstream HTTP response to the client, rewriting small HTML bodies. */
async function deliverResponse(
  res: ServerResponse,
  upstreamRes: http.IncomingMessage,
  target: URL,
  injectScriptSrc: string | undefined,
  wsAllowOrigin: string | undefined,
  wsPort: number,
  learnContent: (hint: string) => void,
  settle: () => void,
): Promise<void> {
  const contentTypeHeader = upstreamRes.headers['content-type']
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.toLowerCase() : ''
  const isHtml = contentType.includes('text/html')
  const isCss = contentType.includes('text/css')
  // Project-scoped JSON (compile result / cached output index) discloses the
  // user-content origin; buffer bounded bodies to LEARN it while forwarding
  // the payload verbatim.
  const isProjectJson = contentType.includes('application/json')
    && /^\/project\/[^/]+\//.test(target.pathname)
  const { headers, hadFrameCsp } = buildResponseHeaders(upstreamRes.headers, PROXY_PREFIX, target, wsAllowOrigin)
  if (hadFrameCsp && process.env.DSH_OVERLEAF_DEBUG === '1') {
    console.warn('[dsh-overleaf] stripped frame-ancestors CSP for', target.pathname)
  }

  if (isCss) {
    // Stylesheets carry url(/x) and @import "/x" references that resolve
    // against the SHELL origin unless rebased - the editor logo loop-404
    // was exactly this. Bounded bodies get rebased; huge ones stream raw.
    const chunksCss: Buffer[] = []
    let sizeCss = 0
    let overflowCss = false
    upstreamRes.on('data', (chunk: Buffer) => {
      if (overflowCss) return
      sizeCss += chunk.byteLength
      if (sizeCss > MAX_REWRITE_BODY_BYTES) {
        overflowCss = true
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : []
        for (const buffered of [...chunksCss, ...remaining.filter(item => item !== null)]) res.write(buffered)
        upstreamRes.pipe(res)
        return
      }
      chunksCss.push(chunk)
    })
    upstreamRes.on('close', settle)
    upstreamRes.on('end', () => {
      if (overflowCss) {
        settle()
        return
      }
      try {
        const body = rewriteCss(Buffer.concat(chunksCss).toString('utf8'), PROXY_PREFIX)
        const payload = Buffer.from(body, 'utf8')
        const finalHeaders: Record<string, string | string[]> = { ...headers }
        finalHeaders['content-length'] = String(payload.byteLength)
        res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders)
        res.end(payload)
      } catch {
        res.destroy()
      }
      settle()
    })
    return
  }

  if (!isHtml && !isProjectJson) {
    res.writeHead(upstreamRes.statusCode ?? 502, headers)
    upstreamRes.pipe(res)
    upstreamRes.on('close', settle)
    return
  }

  if (isProjectJson) {
    // Buffer bounded project JSON only to learn the content origin; the body
    // bytes themselves are forwarded untouched (length stays valid).
    const chunksJson: Buffer[] = []
    let sizeJson = 0
    let overflowJson = false
    upstreamRes.on('data', (chunk: Buffer) => {
      if (overflowJson) return
      sizeJson += chunk.byteLength
      if (sizeJson > MAX_REWRITE_BODY_BYTES) {
        overflowJson = true
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : []
        for (const buffered of [...chunksJson, ...remaining.filter(item => item !== null)]) res.write(buffered)
        upstreamRes.pipe(res)
        return
      }
      chunksJson.push(chunk)
    })
    upstreamRes.on('close', settle)
    upstreamRes.on('end', () => {
      if (overflowJson) {
        settle()
        return
      }
      const jsonText = Buffer.concat(chunksJson).toString('utf8')
      for (const hint of extractContentHintsFromJson(jsonText)) learnContent(hint)
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      res.end(Buffer.concat(chunksJson))
      settle()
    })
    return
  }

  // Buffer bounded HTML bodies so links/assets can be rebased once. Bodies
  // larger than the cap fall back to plain streaming mid-flight.
  const chunks: Buffer[] = []
  let size = 0
  let overflowed = false
  upstreamRes.on('data', (chunk: Buffer) => {
    if (overflowed) return
    size += chunk.byteLength
    if (size > MAX_REWRITE_BODY_BYTES) {
      // Too large to rewrite: flush what is buffered raw, then stream the rest.
      overflowed = true
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      const remaining = upstreamRes.readableLength > 0 ? [upstreamRes.read()] : []
      for (const buffered of [...chunks, ...remaining.filter(item => item !== null)]) res.write(buffered)
      upstreamRes.pipe(res)
      return
    }
    chunks.push(chunk)
  })
  upstreamRes.on('close', settle)
  upstreamRes.on('end', () => {
    if (overflowed) {
      settle()
      return
    }
    try {
      const htmlString = Buffer.concat(chunks).toString('utf8')
      // Learn the user-content origin from the shell's meta tag BEFORE the
      // origin rebasing (the meta value belongs to the content host, not the
      // locked target origin, so it survives rewriteHtml untouched).
      const metaHint = extractContentDomainFromHtml(htmlString)
      if (metaHint !== undefined) learnContent(metaHint)
      const cspHeader = upstreamRes.headers['content-security-policy']
      const cspJoined = Array.isArray(cspHeader) ? cspHeader.join('; ') : cspHeader
      const cspNonce = extractCspNonce(cspJoined, htmlString)
      const body = rewriteHtml(htmlString, PROXY_PREFIX, injectScriptSrc, target.origin, cspNonce, wsPort)
      const payload = Buffer.from(body, 'utf8')
      const finalHeaders: Record<string, string | string[]> = { ...headers }
      finalHeaders['content-length'] = String(payload.byteLength)
      res.writeHead(upstreamRes.statusCode ?? 502, finalHeaders)
      res.end(payload)
    } catch {
      res.destroy()
    }
    settle()
  })
}

/** Answer with the shared JSON 502 envelope when the upstream call fails. */
function respondBadGateway(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    ok: false,
    error: {
      code: 'dsh-overleaf-upstream-error',
      message: error instanceof Error ? error.message : String(error),
    },
  }))
}

/** Write the synthetic GET-upgrade request down the freshly opened socket. */
function writeUpgradeRequest(
  req: IncomingMessage,
  subPath: string,
  target: URL,
  extraCookie: string | undefined,
  upstreamSocket: Duplex,
  head: Buffer,
): void {
  const lines: string[] = [`GET ${subPath} HTTP/1.1`, `Host: ${target.host}`]
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    // Unlike plain proxies, an upgrade tunnel MUST carry Connection/Upgrade
    // plus the WebSocket security fields across the hop; only identity
    // routing headers are rewritten below.
    if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
    if (lower === 'te' || lower === 'trailer' || lower === 'proxy-authenticate' || lower === 'proxy-authorization') continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== '') lines.push(`${name}: ${item}`)
    }
  }
  if (typeof req.headers.origin === 'string') lines.push(`Origin: ${target.origin}`)
  // Same session-authority/routing-freshness rule as the HTTP handshake.
  const browserCookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined
  const mergedCookie = mergeProxyCookieHeaders(browserCookie, extraCookie)
  if (mergedCookie !== undefined && mergedCookie !== '') lines.push(`Cookie: ${mergedCookie}`)
  lines.push('', '')
  upstreamSocket.write(lines.join('\r\n'))
  if (head.length > 0) upstreamSocket.write(head)
}

/** Pipe both directions between client and upgraded upstream sockets. */
function spliceSockets(clientSocket: Duplex, upstreamSocket: Duplex, teardown: () => void): void {
  upstreamSocket.pipe(clientSocket)
  clientSocket.pipe(upstreamSocket)
  clientSocket.on('close', teardown)
  upstreamSocket.on('close', teardown)
}
