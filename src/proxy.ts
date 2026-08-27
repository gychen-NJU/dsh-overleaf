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

/** Timeout granted to establish the tunneled upstream TCP/TLS connection. */
const UPGRADE_CONNECT_TIMEOUT_MS = 10_000

/** Hop-by-hop headers that must never cross a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Rebase one root-relative reference against the proxy prefix. */
function rebaseAttributeUrl(url: string, prefix: string): string {
  return url.startsWith('/') ? `${prefix}${url}` : url
}

/** Rewrite root-relative resource references inside one HTML body. */
export function rewriteHtml(html: string, prefix: string, injectScriptSrc: string | undefined): string {
  let out = html.replaceAll('"//', '"https://')
  // Root-relative attribute references become proxy-rooted so assets issued by
  // static markup resolve back through this plugin instead of hitting the DSH
  // shell's own fallback routes.
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
  if (injectScriptSrc !== undefined && !html.includes('dsh-overleaf-bridge')) {
    const tag = `<script src="${injectScriptSrc}" data-dsh-overleaf-bridge></script>`
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

/** Compute the upstream sub-path (with query) for one matched request URL. */
export function subPathOf(rawUrl: string | undefined, prefix: string): string {
  const raw = rawUrl ?? '/'
  if (raw === prefix) return '/'
  if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length)
  return raw
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
  // The stored credential is authoritative: when present it is sent VERBATIM
  // and never mixed with the browser's own jar. A stale or anonymous twin of
  // the session cookie in the browser jar (upstream Set-Cookie passthrough
  // creates one on every anonymous visit) must never override the login.
  if (extraCookie !== undefined && extraCookie !== '') {
    headers['cookie'] = extraCookie
  } else if (typeof req.headers.cookie === 'string' && req.headers.cookie !== '') {
    headers['cookie'] = req.headers.cookie
  }
  return headers
}

/** Copy upstream response headers onto the outbound response, adjusted. */
function buildResponseHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  prefix: string,
  target: URL,
): { headers: Record<string, string | string[]>; hadFrameCsp: boolean } {
  const headers: Record<string, string | string[]> = {}
  let hadFrameCsp = false
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'content-length' || lower === 'x-frame-options') continue
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
        const resolved = new URL(value, target.origin)
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
    const relaxed = relaxFrameCsp(joined)
    hadFrameCsp = relaxed.changed
    if (relaxed.value !== '') headers['content-security-policy'] = relaxed.value
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

  /** Whether the given raw request URL belongs to this proxy. */
  matches(rawUrl: string | undefined): boolean {
    if (rawUrl === undefined) return false
    return rawUrl === PROXY_PREFIX || rawUrl.startsWith(`${PROXY_PREFIX}/`)
  }

  /** Handle one matched proxied HTTP request end-to-end. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const subPath = subPathOf(req.url, PROXY_PREFIX)
    const target = new URL(subPath, this.target)
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
          timeout: REQUEST_TIMEOUT_MS,
        }, upstreamRes => {
          void deliverResponse(res, upstreamRes, target, this.injectScriptSrc, settle)
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
  settle: () => void,
): Promise<void> {
  const contentTypeHeader = upstreamRes.headers['content-type']
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.toLowerCase() : ''
  const isHtml = contentType.includes('text/html')
  const { headers, hadFrameCsp } = buildResponseHeaders(upstreamRes.headers, PROXY_PREFIX, target)
  if (hadFrameCsp && process.env.DSH_OVERLEAF_DEBUG === '1') {
    console.warn('[dsh-overleaf] stripped frame-ancestors CSP for', target.pathname)
  }

  if (!isHtml) {
    res.writeHead(upstreamRes.statusCode ?? 502, headers)
    upstreamRes.pipe(res)
    upstreamRes.on('close', settle)
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
      const body = rewriteHtml(Buffer.concat(chunks).toString('utf8'), PROXY_PREFIX, injectScriptSrc)
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
  // Same authoritative-credential rule as the plain HTTP path (see
  // buildUpstreamHeaders): the stored cookie rides verbatim, never mixed.
  if (extraCookie !== undefined && extraCookie !== '') {
    lines.push(`Cookie: ${extraCookie}`)
  } else if (typeof req.headers.cookie === 'string' && req.headers.cookie !== '') {
    lines.push(`Cookie: ${req.headers.cookie}`)
  }
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
