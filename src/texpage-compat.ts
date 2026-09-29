/** Narrow compatibility shim for TeXPage's root-bound console router. */
import type { IncomingMessage, ServerResponse } from 'node:http'

const ASSET_PATH = '/__dsh_texpage_v1__/'
const ASSET_FILE = /^(?:console|6)\.[a-f0-9]{8,64}\.js$/i
const SOCKET_ASSET_FILE = /^6\.[a-f0-9]{8,64}\.js$/i
const CDN = 'https://static.texpage.com'
const MAX_ASSET_BYTES = 4 * 1024 * 1024

/** Only the fixed public CDN's console and socket bundles are proxied. */
export function texpageAssetUrl(subPath: string): URL | undefined {
  if (!subPath.startsWith(ASSET_PATH)) return undefined
  const file = subPath.slice(ASSET_PATH.length)
  return ASSET_FILE.test(file) ? new URL(`/dist/${file}`, CDN) : undefined
}

export function rewriteTexpageScriptTags(html: string, prefix: string): string {
  return html.replace(/<script\b[^>]*>/gi, tag => {
    const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag)
    if (src === null) return tag
    let url: URL
    if (!/^(?:https:\/\/|\/\/)static\.texpage\.com\//i.test(src[2] ?? '')) return tag
    try { url = new URL(src[2] ?? '', CDN) } catch { return tag }
    const file = url.pathname.slice('/dist/'.length)
    if (url.origin !== CDN || !url.pathname.startsWith('/dist/') || !ASSET_FILE.test(file)
      || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return tag
    // Do not keep an upstream integrity hash for deliberately transformed bytes.
    return tag.replace(src[0], `src="${prefix}${ASSET_PATH}${file}"`)
      .replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
  })
}

/** BrowserRouter otherwise renders null at /overleaf-proxy/console, without errors. */
export function rewriteTexpageConsoleScript(script: string, prefix: string): string {
  let count = 0
  const rewritten = script.replace(/\bbasename\s*:\s*(["'])\/console\1/g, () => {
    count++
    return `basename:${JSON.stringify(`${prefix}/console`)}`
  })
  if (count !== 1) throw new Error('dsh-overleaf: TeXPage console router format changed; compatibility update required')
  return rewritten.replace(/\/\/# sourceMappingURL=[^\r\n]*/g, '')
}

/**
 * Repair the URL before Socket.IO parses it into an origin AND a namespace.
 * Rewriting only the eventual WebSocket URL leaves a poisoned namespace in
 * CONNECT frames. Match the observed private webpack module, never arbitrary
 * uses of location.protocol or Socket.IO's protocol implementation.
 */
export function rewriteTexpageDesktopSocketScript(script: string): string {
  const original = 'window.location.protocol+"//"+r'
  const moduleSignature = 'b=n(74896),x=function(e){var r=window._domainConf.socket;'
  const connectSignature = `(0,b.Ay)(${original},{transports:["websocket"],`
  const heartbeatSignature = `baseURL:${original}}).get("/heartbeat",`
  if (script.split(moduleSignature).length !== 2 || script.split(connectSignature).length !== 2
    || script.split(heartbeatSignature).length !== 2 || script.split(original).length !== 3) {
    throw new Error('dsh-overleaf: TeXPage socket module format changed; compatibility update required')
  }
  // HTTP(S) executes the original expression without touching bootstrap data.
  // Desktop requires the server-validated sibling socket origin; no speculative
  // host or protocol fallback should hide an absent/invalid bootstrap.
  const desktopOrigin = '(function(){var o=window.__DSH_OVERLEAF_SOCKET_ORIGIN__,p=window.__DSH_OVERLEAF_UPSTREAM_ORIGIN__;'
    + 'try{var s=new URL(o),u=new URL(p);if(typeof o==="string"&&typeof p==="string"&&/^https?:$/.test(u.protocol)'
    + '&&u.username===""&&u.password===""&&u.port===""&&s.origin===o&&s.protocol===u.protocol'
    + '&&s.username===""&&s.password===""&&s.port===""&&s.host===r'
    + '&&s.hostname==="socket."+u.hostname.replace(/^www\\./,""))return o}catch(e){}'
    + 'throw new Error("dsh-overleaf: missing or invalid desktop TeXPage socket origin")})()'
  const replacement = `(window.location.protocol==="dsh-app:"?${desktopOrigin}:${original})`
  return script.replaceAll(original, replacement).replace(/\/\/# sourceMappingURL=[^\r\n]*/g, '')
}

/** Bounded public-asset fetch. Never forward the user's cookies or other headers. */
export async function serveTexpageConsoleAsset(req: IncomingMessage, res: ServerResponse, url: URL, prefix: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  try {
    const file = url.pathname.slice('/dist/'.length)
    if (url.origin !== CDN || url.pathname !== `/dist/${file}` || !ASSET_FILE.test(file)
      || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new Error('dsh-overleaf: invalid TeXPage compatibility asset')
    }
    const socketAsset = SOCKET_ASSET_FILE.test(file)
    const response = await fetch(url, {
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/javascript' },
    })
    if (!response.ok || !/(?:java|ecma)script/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel()
      throw new Error(`dsh-overleaf: TeXPage console asset unavailable (HTTP ${response.status})`)
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('dsh-overleaf: empty TeXPage console asset')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_ASSET_BYTES) {
          await reader.cancel()
          throw new Error('dsh-overleaf: TeXPage console asset exceeds size limit')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const source = Buffer.concat(chunks).toString('utf8')
    const payload = Buffer.from(socketAsset ? rewriteTexpageDesktopSocketScript(source) : rewriteTexpageConsoleScript(source, prefix))
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': String(payload.byteLength), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'x-dsh-texpage-compat': socketAsset ? 'desktop-socket-origin-v1' : 'console-basename-v1',
    })
    res.end(req.method === 'HEAD' ? undefined : payload)
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(error instanceof Error ? error.message : 'dsh-overleaf: TeXPage compatibility asset failed')
  }
}
