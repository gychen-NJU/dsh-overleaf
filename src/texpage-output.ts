/** Credential-free, fixed-origin transport for TeXPage's signed PDF/log artifacts. */
import https from 'node:https'
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { extractTexpageSocketOrigin, readTexpageDomainConfig } from './texpage-socket.ts'

export const OUTPUT_PROXY_PATH = '/__dsh_texpage_output__'
const OUTPUT_HOST = 'latex-file.texpageusercontent.com'
const OUTPUT_ORIGIN = `https://${OUTPUT_HOST}`
const MAX_URL_CHARS = 64 * 1024
// IDs are opaque, bounded ASCII segments, not filenames or encoded paths.
const OUTPUT_PATH = /^\/CompileResult\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/){3}output\.(?:pdf|log|blg)$/
const IDLE_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 60_000

/** The fixed latexFile host is trusted only alongside validated same-site socket metadata. */
export function extractTexpageOutputOrigin(html: string, pageOrigin: string | URL): URL | undefined {
  if (extractTexpageSocketOrigin(html, pageOrigin) === undefined) return undefined
  const config = readTexpageDomainConfig(html)
  if (config === undefined || !Object.prototype.hasOwnProperty.call(config, 'latexFile')
    || config.latexFile !== OUTPUT_HOST) return undefined
  return new URL(OUTPUT_ORIGIN)
}

/** Resolve ONLY the marker + literal PDF/log path; never decode/rebuild a signed query. */
export function resolveTexpageOutputTarget(subPath: string, outputOrigin: URL | undefined): URL | undefined {
  if (outputOrigin === undefined || subPath.length > MAX_URL_CHARS
    || /[^\x21-\x7e]|[#\\]/.test(subPath) || /%(?![0-9a-f]{2})/i.test(subPath)) return undefined
  let origin: URL
  try { origin = new URL(String(outputOrigin)) } catch { return undefined }
  if (origin.href !== `${OUTPUT_ORIGIN}/` || !subPath.startsWith(`${OUTPUT_PROXY_PATH}/`)) return undefined
  const suffix = subPath.slice(OUTPUT_PROXY_PATH.length)
  const queryAt = suffix.indexOf('?')
  if (!OUTPUT_PATH.test(queryAt < 0 ? suffix : suffix.slice(0, queryAt))) return undefined
  const expected = OUTPUT_ORIGIN + suffix
  let target: URL
  try { target = new URL(expected) } catch { return undefined }
  // Reject anything the URL parser would normalize (including query encoding).
  return target.href === expected ? target : undefined
}

function validTarget(target: URL): boolean {
  if (target.origin !== OUTPUT_ORIGIN || target.username !== '' || target.password !== ''
    || target.hash !== '') return false
  const resolved = resolveTexpageOutputTarget(
    OUTPUT_PROXY_PATH + target.href.slice(OUTPUT_ORIGIN.length), new URL(OUTPUT_ORIGIN),
  )
  return resolved !== undefined && resolved.href === target.href
}

/** Only a single byte range and a strong ETag / HTTP-date validator are accepted. */
function outputRequestHeaders(req: IncomingMessage): OutgoingHttpHeaders | undefined {
  const headers: OutgoingHttpHeaders = {}
  const range = req.headers.range
  if (range !== undefined) {
    if (typeof range !== 'string' || !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range)) return undefined
    const [first, last] = range.slice(6).split('-')
    if (first && last && BigInt(first) > BigInt(last)) return undefined
    headers.range = range
  }
  const validator = req.headers['if-range']
  if (validator !== undefined) {
    if (typeof validator !== 'string' || validator.length > 256
      || (!/^"[\x21\x23-\x7e]*"$/.test(validator)
        && !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(validator))) return undefined
    headers['if-range'] = validator
  }
  return headers
}

function outputResponseHeaders(upstream: IncomingMessage, isLog: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const connectionFields = new Set(String(upstream.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()))
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges',
    'content-encoding', 'etag', 'last-modified', 'content-disposition']) {
    const value = upstream.headers[name]
    if (typeof value === 'string' && !connectionFields.has(name)) headers[name] = value
  }
  // Logs and range-error bodies must not become executable same-origin markup.
  if (upstream.statusCode === 416 || (isLog && (upstream.statusCode === 200 || upstream.statusCode === 206))) {
    headers['content-type'] = 'text/plain; charset=utf-8'
  }
  return headers
}

/** A single-part 206 must describe exactly the representation bytes it sends. */
function partialBodyLength(headers: OutgoingHttpHeaders): bigint | undefined {
  const range = headers['content-range']
  if (typeof range !== 'string') return undefined
  const match = /^bytes (\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(range)
  if (match === null) return undefined
  const first = BigInt(match[1]!)
  const last = BigInt(match[2]!)
  if (last < first || (match[3] !== '*' && last >= BigInt(match[3]!))) return undefined
  const length = last - first + 1n
  const declared = headers['content-length']
  if (declared !== undefined && (typeof declared !== 'string' || !/^\d{1,20}$/.test(declared)
    || BigInt(declared) !== length)) return undefined
  return length
}

/**
 * Stream without fetch's decompression or the generic authenticated proxy helpers.
 * No input body, cookies, auth, Origin or Referer cross this boundary. Redirects
 * are rejected, never followed or returned. Errors never include the signed URL.
 */
export async function serveTexpageOutput(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
  const reply = (status: number, message: string): void => {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : message)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { reply(405, 'Method not allowed'); return }
  if (!validTarget(target)) { reply(400, 'Invalid output target'); return }
  const isLog = /\/output\.(?:log|blg)$/.test(target.pathname)
  const headers = outputRequestHeaders(req)
  if (headers === undefined) { reply(400, 'Invalid output range headers'); return }
  if (req.aborted || res.destroyed || res.writableEnded) return

  await new Promise<void>(resolve => {
    let settled = false
    let outbound: ClientRequest | undefined
    let upstream: IncomingMessage | undefined
    let upstreamEnded = false
    const totalTimer = setTimeout(() => fail(504), TOTAL_TIMEOUT_MS)
    totalTimer.unref()
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(totalTimer)
      req.off('aborted', cancel)
      res.off('close', cancel)
      res.off('error', cancel)
      res.off('finish', finish)
      outbound?.off('timeout', timeout)
      // Destroy without an error argument; existing error listeners safely absorb
      // late transport errors. No downstream listener or timer survives completion.
      upstream?.unpipe(res)
      upstream?.destroy()
      outbound?.destroy()
      resolve()
    }
    const cancel = (): void => { res.destroy(); finish() }
    const fail = (status = 502): void => {
      if (settled) return
      reply(status, status === 504 ? 'Output upstream timeout' : 'Output upstream unavailable')
      finish()
    }
    const timeout = (): void => { fail(504) }
    req.once('aborted', cancel)
    res.once('close', cancel)
    res.once('error', cancel)
    res.once('finish', finish)
    try {
      outbound = https.request(target, {
        method: req.method, headers, timeout: IDLE_TIMEOUT_MS,
        // URL.search drops a bare '?'; href preserves the exact request target.
        path: target.href.slice(OUTPUT_ORIGIN.length),
      }, response => {
        if (settled) { response.destroy(); return }
        upstream = response
        let receivedBytes = 0n
        const responseHeaders = outputResponseHeaders(response, isLog)
        const expectedBytes = response.statusCode === 206 ? partialBodyLength(responseHeaders) : undefined
        response.once('error', () => fail())
        response.once('aborted', () => fail())
        response.once('end', () => {
          upstreamEnded = true
          if (response.complete === false || (expectedBytes !== undefined && receivedBytes !== expectedBytes)) fail()
        })
        response.once('close', () => { if (!upstreamEnded && !settled) fail() })
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400 && status !== 304) { fail(); return }
        if (status === 206 && expectedBytes === undefined) { fail(); return }
        if (![200, 206, 304, 416].includes(status)) {
          fail(status >= 400 && status <= 599 ? status : 502)
          return
        }
        const type = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if ((req.method !== 'HEAD' || isLog) && (status === 200 || status === 206)
          && type !== (isLog ? 'text/plain' : 'application/pdf')
          && type !== 'application/octet-stream') { fail(); return }
        try {
          res.writeHead(status, responseHeaders)
          if (req.method === 'HEAD' || status === 304) {
            res.end()
            finish()
          } else {
            if (expectedBytes !== undefined) response.on('data', (chunk: Buffer) => {
              receivedBytes += BigInt(chunk.byteLength)
              if (receivedBytes > expectedBytes) fail()
            })
            response.pipe(res)
          }
        } catch { fail() }
      })
      outbound.once('timeout', timeout)
      outbound.once('error', () => fail())
      if (settled) { outbound.off('timeout', timeout); outbound.destroy(); return }
      outbound.end()
    } catch { fail() }
  })
}
