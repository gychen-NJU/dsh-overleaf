/** Strict, data-only routing for TeXPage's separate Socket.IO origin. */
export const SOCKET_PROXY_PATH = '/__dsh_socket__'

const MAX_HTML_CHARS = 4 * 1024 * 1024
const MAX_CONFIG_CHARS = 64 * 1024
const MAX_CONFIG_DEPTH = 64
const ASSIGNMENT = /^window\s*\.\s*_domainConf\s*=\s*/

/** Skip a JS string/template without interpreting escapes or interpolations. */
function quotedEnd(text: string, start: number): number {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return i + 1
  }
  return text.length
}

/** Find the end of a bounded JSON object; JSON.parse validates its contents. */
function jsonObjectEnd(text: string, start: number): number | undefined {
  if (text[start] !== '{') return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  const limit = Math.min(text.length, start + MAX_CONFIG_CHARS)
  for (let i = start; i < limit; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') {
      if (++depth > MAX_CONFIG_DEPTH) return undefined
    } else if (char === '}' || char === ']') {
      if (--depth === 0) return i + 1
    }
  }
  return undefined
}

/**
 * Read one inline window._domainConf = { JSON } assignment, never executing JS.
 * This only parses bounded data; callers must validate the fields they trust.
 * Multiple assignments (including across scripts) fail closed.
 */
export function readTexpageDomainConfig(html: string): Record<string, unknown> | undefined {
  if (html.length > MAX_HTML_CHARS) return undefined
  let found: Record<string, unknown> | undefined

  // Inspect inline scripts only, excluding markup comments and external scripts.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const script of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(script[1] ?? '')) continue
    const body = script[2] ?? ''
    for (let i = 0; i < body.length;) {
      const char = body[i]
      if (char === '"' || char === "'" || char === '`') {
        i = quotedEnd(body, i)
        continue
      }
      if (body.startsWith('//', i)) {
        const end = body.indexOf('\n', i + 2)
        i = end < 0 ? body.length : end + 1
        continue
      }
      if (body.startsWith('/*', i)) {
        const end = body.indexOf('*/', i + 2)
        i = end < 0 ? body.length : end + 2
        continue
      }
      const assignment = body.startsWith('window', i) && !/[\w$./]/.test(body[i - 1] ?? '')
        ? ASSIGNMENT.exec(body.slice(i)) : null
      if (assignment === null) { i++; continue }
      if (found !== undefined) return undefined
      const start = i + assignment[0].length
      const end = jsonObjectEnd(body, start)
      if (end === undefined || !/^\s*(?:;|$)/.test(body.slice(end))) return undefined
      let config: unknown
      try { config = JSON.parse(body.slice(start, end)) } catch { return undefined }
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
      found = config as Record<string, unknown>
      i = end
    }
  }
  return found
}

/** Trust only the exact socket.<page hostname without leading www.> authority. */
export function extractTexpageSocketOrigin(html: string, pageOrigin: string | URL): URL | undefined {
  let page: URL
  try { page = new URL(String(pageOrigin)) } catch { return undefined }
  if (!['http:', 'https:'].includes(page.protocol) || page.username !== '' || page.password !== ''
    || page.port !== '') return undefined
  const config = readTexpageDomainConfig(html)
  if (config === undefined || !Object.prototype.hasOwnProperty.call(config, 'socket')) return undefined
  const expectedHost = `socket.${page.hostname.replace(/^www\./, '')}`
  const defaultPort = page.protocol === 'https:' ? '443' : '80'
  if (config.socket !== expectedHost && config.socket !== `${expectedHost}:${defaultPort}`) return undefined
  try { return new URL(`${page.protocol}//${expectedHost}`) } catch { return undefined }
}

/**
 * Resolve an already prefix-stripped marker path against a validated origin.
 * Only these three literal paths are supported. Queries are copied byte-for-
 * byte; no decoding, path normalization, redirects or caller-chosen authority.
 */
export function resolveTexpageSocketTarget(subPath: string, socketOrigin: URL | undefined): URL | undefined {
  if (socketOrigin === undefined || subPath.length > MAX_CONFIG_CHARS
    || /[\u0000-\u0020\u007f#\\]/.test(subPath)) return undefined
  // Clone and check the origin again so accidental mutation cannot add a base
  // path, credentials, a non-default port, or a non-HTTP transport.
  let origin: URL
  try { origin = new URL(String(socketOrigin)) } catch { return undefined }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username !== '' || origin.password !== ''
    || origin.port !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
    || !origin.hostname.startsWith('socket.')) return undefined
  const queryAt = subPath.indexOf('?')
  const path = queryAt < 0 ? subPath : subPath.slice(0, queryAt)
  if (path !== `${SOCKET_PROXY_PATH}/socket.io` && path !== `${SOCKET_PROXY_PATH}/socket.io/`
    && path !== `${SOCKET_PROXY_PATH}/heartbeat`) return undefined
  const target = new URL(origin.origin)
  target.pathname = path.slice(SOCKET_PROXY_PATH.length)
  target.search = queryAt < 0 ? '' : subPath.slice(queryAt)
  return target
}
