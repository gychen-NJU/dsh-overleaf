/** Bounded TeX source readback, isolated from authenticated site forwarding. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

export const TEX_PROXY_PATH = '/__dsh_texpage_tex__'
const FILE_ORIGIN = 'https://latex-file.texpageusercontent.com'
const MAX_BYTES = 4 * 1024 * 1024
type TexTarget = { download: URL; objectPath: string }

/** No arbitrary URL, path or header supplied by the client crosses origins. */
export function resolveTexpageTexTarget(subPath: string, site: URL, fileOrigin?: URL): TexTarget | undefined {
  if (fileOrigin?.href !== FILE_ORIGIN + '/' || subPath.length > 1024 || !/^https?:$/.test(site.protocol)) return undefined
  let url: URL
  try { url = new URL(subPath, site) } catch { return undefined }
  if (url.origin !== site.origin || url.pathname !== TEX_PROXY_PATH || url.hash !== '') return undefined
  const keys = ['ownerKey', 'projectKey', 'versionNo', 'fileKey']
  if (Array.from(url.searchParams.keys()).length !== keys.length) return undefined
  for (const key of keys) {
    if (url.searchParams.getAll(key).length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get(key) ?? '')) return undefined
  }
  const download = new URL('/api/project/file', site)
  for (const key of ['projectKey', 'versionNo', 'fileKey']) download.searchParams.set(key, url.searchParams.get(key)!)
  return { download, objectPath: '/' + url.searchParams.get('ownerKey') + '/' + url.searchParams.get('fileKey') + '_' + url.searchParams.get('versionNo') }
}

export function resolveTexpageTexRedirect(raw: string, target: TexTarget): URL | undefined {
  if (raw.length > 64 * 1024 || /[^\x21-\x7e]|[#\\]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return undefined
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  return url.origin === FILE_ORIGIN && url.username === '' && url.password === ''
    && url.pathname === target.objectPath && url.href === raw ? url : undefined
}

/** One authenticated request to the configured site, then at most one
 * credential-free signed-object read. Redirects and signed URLs never escape. */
export async function serveTexpageTex(
  req: IncomingMessage, res: ServerResponse, target: TexTarget, siteHeaders: OutgoingHttpHeaders,
  request: typeof fetch = fetch,
): Promise<void> {
  let stage = 'site'
  let failure = 'site-network'
  const reply = (status: number, text: string): void => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(status === 405 ? { allow: 'GET' } : {}),
      ...(status === 502 || status === 504 ? { 'x-dsh-tex-error': failure } : {}) })
    res.end(text)
  }
  if (req.method !== 'GET') { reply(405, 'Method not allowed'); return }
  if (req.aborted || res.destroyed) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 18000)
  timer.unref()
  const cancel = (): void => controller.abort()
  req.once('aborted', cancel)
  res.once('close', cancel)
  let response: Response | undefined
  try {
    const headers: Record<string, string> = { accept: 'text/plain, application/octet-stream', 'cache-control': 'no-cache' }
    for (const key of ['cookie', 'authorization', 'user-agent']) {
      if (typeof siteHeaders[key] === 'string') headers[key] = siteHeaders[key]
    }
    response = await request(target.download, { headers, redirect: 'manual', signal: controller.signal })
    if (response.status === 302 || response.status === 303 || response.status === 307) {
      stage = 'redirect'
      failure = 'redirect-target'
      const signed = resolveTexpageTexRedirect(response.headers.get('location') ?? '', target)
      await response.body?.cancel()
      response = undefined
      if (!signed) throw new Error('invalid-target')
      stage = 'object'
      failure = 'object-network'
      response = await request(signed, { redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/plain, application/octet-stream', 'cache-control': 'no-cache' }, signal: controller.signal })
    }
    failure = stage + '-http-' + response.status
    if (response.status !== 200) throw new Error('read-failed')
    failure = stage + '-mime'
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    if (!['text/plain', 'application/octet-stream', 'application/x-tex', 'text/x-tex'].includes(type ?? '')) throw new Error('invalid-type')
    stage = 'body'
    failure = 'body-size'
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('too-large')
    failure = 'body-stream'
    const reader = response.body?.getReader()
    if (!reader) throw new Error('empty-body')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > MAX_BYTES) { failure = 'body-size'; throw new Error('too-large') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const bytes = Buffer.concat(chunks)
    failure = 'body-utf8'
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    failure = 'body-mime'
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('invalid-type')
    reply(200, text)
  } catch {
    if (controller.signal.aborted) failure = stage + '-timeout'
    reply(controller.signal.aborted ? 504 : 502, 'TeX readback unavailable')
  } finally {
    await response?.body?.cancel().catch(() => {})
    clearTimeout(timer)
    req.off('aborted', cancel)
    res.off('close', cancel)
  }
}
