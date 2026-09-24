// Source-only: synthetic identifiers/signatures, mocked HTTPS, no servers or files.
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { readTexpageDomainConfig, extractTexpageSocketOrigin } from '../src/texpage-socket.ts'
import {
  OUTPUT_PROXY_PATH, extractTexpageOutputOrigin, resolveTexpageOutputTarget, serveTexpageOutput,
} from '../src/texpage-output.ts'

const pageOrigin = 'https://tex.nju.edu.cn'
const outputHost = 'latex-file.texpageusercontent.com'
const origin = new URL(`https://${outputHost}`)
const config = { socket: 'socket.tex.nju.edu.cn', latexFile: outputHost }
const html = value => `<script>window._domainConf=${JSON.stringify(value)};</script>`
const validHtml = html(config)
assert.equal(OUTPUT_PROXY_PATH, '/__dsh_texpage_output__')
assert.deepEqual(readTexpageDomainConfig(validHtml), config)
assert.deepEqual(readTexpageDomainConfig(html({})), {})
assert.equal(extractTexpageOutputOrigin(validHtml, pageOrigin)?.href, origin.href)
assert.equal(extractTexpageOutputOrigin(validHtml, new URL(pageOrigin))?.href, origin.href)
assert.equal(extractTexpageOutputOrigin(validHtml, 'https://www.tex.nju.edu.cn')?.href, origin.href)
assert.equal(extractTexpageOutputOrigin(html({ ...config, socket: 'socket.tex.nju.edu.cn:443' }), pageOrigin)?.href, origin.href)
assert.equal(extractTexpageOutputOrigin(html({ ...config, socket: 'socket.nju.texpage.com' }), 'https://nju.texpage.com')?.href, origin.href)
assert.equal(extractTexpageSocketOrigin(validHtml, pageOrigin)?.origin, 'https://socket.tex.nju.edu.cn')
for (const latexFile of [undefined, null, {}, [], 1, true, origin.href, origin.origin,
  `//${outputHost}`, `${outputHost}:443`, `${outputHost}.`, outputHost.toUpperCase(),
  ` ${outputHost}`, `${outputHost}\n`, `${outputHost}/`, `${outputHost}.evil.test`,
  `user@${outputHost}`, `${outputHost}@evil.test`, '127.0.0.1', '[::1]', 'localhost']) {
  assert.equal(extractTexpageOutputOrigin(html({ ...config, latexFile }), pageOrigin), undefined)
}
for (const socket of [undefined, null, [], 'socket.evil.test', 'socket.tex.nju.edu.cn.evil.test',
  'https://socket.tex.nju.edu.cn', 'socket.tex.nju.edu.cn:444']) {
  assert.equal(extractTexpageOutputOrigin(html({ ...config, socket }), pageOrigin), undefined)
}
for (const page of ['https://evil.test', 'https://user@tex.nju.edu.cn',
  'https://tex.nju.edu.cn:444', 'file:///example', '//tex.nju.edu.cn', 'invalid']) {
  assert.equal(extractTexpageOutputOrigin(validHtml, page), undefined)
}
for (const invalid of [
  '', validHtml + validHtml, validHtml + html({}),
  `<!--${validHtml}-->`, `<script src="https://static.texpage.com/public.js">window._domainConf=${JSON.stringify(config)};</script>`,
  `<script>window._domainConf=${JSON.stringify(config)} || doNotExecute();</script>`,
  `<script>window._domainConf={socket:'socket.tex.nju.edu.cn'};</script>`,
  `<script>/* window._domainConf=${JSON.stringify(config)}; */</script>`,
  `<script>var text=${JSON.stringify(`window._domainConf=${JSON.stringify(config)};`)};</script>`,
  ' '.repeat(4 * 1024 * 1024 + 1) + validHtml,
  html({ ...config, large: 'x'.repeat(65536) }),
]) {
  assert.equal(readTexpageDomainConfig(invalid), undefined)
  assert.equal(extractTexpageOutputOrigin(invalid, pageOrigin), undefined)
}

const path = '/CompileResult/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003/output.pdf'
// Intentionally synthetic, never derived from a browser or user project.
const query = '?X-Amz-Algorithm=TEST&X-Amz-Credential=synthetic%2Fscope&X-Amz-Signature=synthetic&x=%2f%2F&x=two+words&empty=&next=https%3A%2F%2Fexample.test%2Fa&bare'
const target = resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + path + query, origin)
const logTargets = ['log', 'blg'].map(extension => {
  const logPath = path.replace(/\.pdf$/, '.' + extension)
  const logTarget = resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + logPath + query, origin)
  assert.ok(logTarget instanceof URL)
  assert.equal(logTarget.href, origin.origin + logPath + query, 'log signed query preserved exactly')
  for (const suffix of ['', '?', '?x=%2f%2F&x=two+words']) {
    assert.equal(resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + logPath + suffix, origin)?.href, origin.origin + logPath + suffix)
  }
  for (const invalid of [
    logPath + '/extra', logPath.replace('/CompileResult/', '/CompileResult/../'),
    logPath.replace('output.', '%6futput.'), logPath.replace('output.', 'other.'),
    logPath.replace('.' + extension, '.' + extension.toUpperCase()),
    logPath.replace('output.', 'output.pdf.'),
  ]) assert.equal(resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + invalid, origin), undefined)
  return logTarget
})
assert.ok(target instanceof URL)
assert.equal(target.href, origin.origin + path + query)
assert.equal(origin.href, `https://${outputHost}/`, 'origin is not mutated')
for (const suffix of ['', '?', '?a=1&a=2', '?a=%00%0d%0A&x=%25&x=+&y=%20']) {
  assert.equal(resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + path + suffix, origin)?.href, origin.origin + path + suffix)
}
assert.ok(resolveTexpageOutputTarget(`${OUTPUT_PROXY_PATH}/CompileResult/a/B_2/c-3/output.pdf`, origin))
assert.equal(resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + path, undefined), undefined)
for (const badPath of ['', '/', OUTPUT_PROXY_PATH, path, '/overleaf-proxy' + OUTPUT_PROXY_PATH + path,
  OUTPUT_PROXY_PATH + 'evil' + path, '/' + OUTPUT_PROXY_PATH + path,
  OUTPUT_PROXY_PATH + '/https://evil.test' + path, 'https://evil.test' + OUTPUT_PROXY_PATH + path,
  OUTPUT_PROXY_PATH + '//evil.test' + path, OUTPUT_PROXY_PATH + path + '/extra',
  OUTPUT_PROXY_PATH + path.replace('CompileResult', 'compileresult'),
  OUTPUT_PROXY_PATH + path.replace('output.pdf', 'output.txt'),
  OUTPUT_PROXY_PATH + path.replace('output.pdf', 'output.xml'),
  OUTPUT_PROXY_PATH + path.replace('output.pdf', 'OUTPUT.PDF'),
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/c/d/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/../c/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/%2e%2e/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/c%2fextra/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/c%5cextra/output.pdf`,
  `${OUTPUT_PROXY_PATH}/CompileResult/a/b/${'a'.repeat(129)}/output.pdf`,
  OUTPUT_PROXY_PATH + path + '#fragment', OUTPUT_PROXY_PATH + path + '?x=has space',
  OUTPUT_PROXY_PATH + path + '?x=\r\nHeader:injected', OUTPUT_PROXY_PATH + path + '?x=\u007f',
  OUTPUT_PROXY_PATH + path + '?x=\\host', OUTPUT_PROXY_PATH + path + '?x=é',
  OUTPUT_PROXY_PATH + path + "?x='normalizes'", OUTPUT_PROXY_PATH + path + '?x=%GG',
  OUTPUT_PROXY_PATH + path + '?x=%', OUTPUT_PROXY_PATH + path + '?x=' + 'x'.repeat(65536),
]) assert.equal(resolveTexpageOutputTarget(badPath, origin), undefined, 'invalid path/query rejected')
for (const badOrigin of ['http://' + outputHost, 'https://evil.test', `https://${outputHost}.evil.test`,
  `https://${outputHost}:444`, `https://user:password@${outputHost}`, origin.origin + '/base',
  origin.origin + '/?q=1', origin.origin + '/#fragment']) {
  assert.equal(resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + path, new URL(badOrigin)), undefined)
}

class Response extends Writable {
  statusCode = 0
  headersSent = false
  headers = {}
  chunks = []
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback() }
  get body() { return Buffer.concat(this.chunks) }
}
class UpstreamResponse extends Readable {
  complete = false
  constructor(status, headers) { super(); this.statusCode = status; this.headers = headers }
  _read() {}
}
const pdf = Buffer.from('%PDF-1.7\nsynthetic\x00\xff\n%%EOF')
const realRequest = https.request
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const timers = new Set()
const calls = []
let scenario
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 60_000) return realSetTimeout(callback, delay, ...args)
  const handle = { unref() { return this } }
  timers.add(handle)
  if (scenario.spec.mode === 'total-timeout') queueMicrotask(callback)
  return handle
}
globalThis.clearTimeout = handle => {
  if (timers.delete(handle)) return
  realClearTimeout(handle)
}
https.request = (url, options, callback) => {
  const current = scenario
  const outbound = new EventEmitter()
  outbound.destroyed = false
  outbound.destroy = () => { outbound.destroyed = true; return outbound }
  const call = { url, options, outbound, endCalls: 0 }
  calls.push(call)
  if (current.spec.mode === 'throw') throw new Error('synthetic signed URL must not appear in errors')
  outbound.end = (...body) => {
    call.endCalls++
    assert.deepEqual(body, [], 'never forwards an incoming body')
    queueMicrotask(() => {
      if (current.spec.mode === 'total-timeout') return
      if (current.spec.mode === 'idle-timeout') { outbound.emit('timeout'); return }
      if (current.spec.mode === 'request-error') { outbound.emit('error', new Error('synthetic-private-query')); return }
      if (current.spec.mode === 'abort-before-response') { current.req.emit('aborted'); return }
      const response = new UpstreamResponse(current.spec.status ?? 200, current.spec.headers ?? {
        'content-type': 'application/pdf', 'content-length': String(pdf.length), 'accept-ranges': 'bytes',
      })
      call.response = response
      callback(response)
      if (response.destroyed) return
      if (current.spec.mode === 'response-error') { response.emit('error', new Error('synthetic-private-query')); return }
      if (current.spec.mode === 'response-aborted') { response.emit('aborted'); return }
      if (current.spec.mode === 'response-close') { response.destroy(); return }
      if (current.spec.mode === 'client-close') { current.res.destroy(); return }
      if (current.spec.mode === 'client-error') { current.res.emit('error', new Error('closed')); return }
      if (current.spec.mode === 'client-abort') { current.req.emit('aborted'); return }
      response.push(current.spec.body ?? pdf)
      response.complete = current.spec.mode !== 'truncated'
      response.push(null)
    })
  }
  return outbound
}
async function run(spec = {}, request = {}, destination = target) {
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, aborted: false }, request)
  const res = new Response()
  scenario = { spec, req, res }
  const count = calls.length
  await serveTexpageOutput(req, res, destination)
  await new Promise(setImmediate)
  assert.equal(timers.size, 0, 'total deadline cleaned up')
  assert.equal(req.listenerCount('aborted'), 0, 'incoming abort listener removed')
  assert.equal(res.listenerCount('close'), 0, 'downstream close listeners removed')
  assert.equal(res.listenerCount('error'), 0, 'downstream error listeners removed')
  const call = calls.length > count ? calls.at(-1) : undefined
  if (call) {
    if (spec.mode !== 'throw') assert.equal(call.outbound.destroyed, true, 'upstream request released')
    assert.equal(call.outbound.listenerCount('timeout'), 0, 'idle deadline listener removed')
    if (call.response) assert.equal(call.response.destroyed, true, 'upstream body released')
  }
  return { req, res, call }
}
try {
  const result = await run({}, { headers: {
    range: 'bytes=0-122463', 'if-range': '"synthetic-etag"',
    cookie: 'SESSION=synthetic', authorization: 'Bearer synthetic', 'proxy-authorization': 'synthetic',
    origin: 'http://127.0.0.1:3080', referer: 'http://private.invalid/project',
    host: 'evil.test', 'x-forwarded-host': 'evil.test', 'accept-encoding': 'gzip',
    'x-csrf-token': 'synthetic', connection: 'keep-alive', 'content-length': '99',
  } })
  assert.equal(result.res.statusCode, 200, 'upstream may ignore Range and send the full PDF')
  assert.deepEqual(result.res.body, pdf)
  assert.equal(result.call.url.href, target.href)
  assert.equal(result.call.options.path, path + query)
  assert.deepEqual(result.call.options.headers, { range: 'bytes=0-122463', 'if-range': '"synthetic-etag"' })
  assert.equal(result.call.options.method, 'GET')
  assert.equal(result.call.options.timeout, 30_000)
  assert.equal(result.call.endCalls, 1)

  const partial = await run({ status: 206, body: pdf.subarray(0, 8), headers: {
    'content-type': 'application/pdf', 'content-length': '8', 'content-range': `bytes 0-7/${pdf.length}`,
    'accept-ranges': 'bytes', etag: '"fixture"', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT',
    'set-cookie': ['never=forward'], location: 'https://evil.test/secret', 'x-private': 'strip',
    'access-control-allow-origin': '*', 'content-security-policy': 'unsafe',
    'transfer-encoding': 'chunked', connection: 'x-private', 'cache-control': 'public',
  } }, { headers: { range: 'bytes=0-7' } })
  assert.equal(partial.res.statusCode, 206)
  assert.deepEqual(partial.res.body, pdf.subarray(0, 8))
  assert.equal(partial.res.headers['content-length'], '8')
  assert.equal(partial.res.headers['content-range'], `bytes 0-7/${pdf.length}`)
  assert.equal(partial.res.headers['accept-ranges'], 'bytes')
  assert.equal(partial.res.headers.etag, '"fixture"')
  for (const header of ['set-cookie', 'location', 'connection', 'transfer-encoding', 'x-private', 'access-control-allow-origin']) {
    assert.equal(partial.res.headers[header], undefined)
  }
  assert.equal(partial.res.headers['cache-control'], 'no-store')
  assert.equal(partial.res.headers['x-content-type-options'], 'nosniff')

  for (const headers of [
    {}, { 'content-range': 'bytes 0-7/7' }, { 'content-range': 'bytes 8-7/20' },
    { 'content-range': 'bytes */20' }, { 'content-range': 'bytes 0-7/20', 'content-length': '9' },
    { 'content-range': 'bytes 0-7/20', connection: 'content-range' },
  ]) {
    const outcome = await run({ status: 206, headers: { 'content-type': 'application/pdf', ...headers } })
    assert.equal(outcome.res.statusCode, 502, 'malformed/inconsistent 206 rejected before headers')
  }
  for (const body of [pdf.subarray(0, 7), pdf.subarray(0, 9)]) {
    const outcome = await run({ status: 206, body, headers: {
      'content-type': 'application/pdf', 'content-range': `bytes 0-7/${pdf.length}`,
    } })
    assert.equal(outcome.res.destroyed, true, 'short/overlong 206 destroys the incomplete response')
    assert.equal(outcome.res.writableFinished, false, 'invalid range cannot report a complete response')
  }
  const unknownTotal = await run({ status: 206, body: pdf.subarray(0, 8), headers: {
    'content-type': 'application/pdf', 'content-range': 'bytes 0-7/*',
  } })
  assert.equal(unknownTotal.res.statusCode, 206)
  assert.deepEqual(unknownTotal.res.body, pdf.subarray(0, 8))

  const rangeError = await run({ status: 416, body: Buffer.from('range'), headers: {
    'content-type': 'application/xml', 'content-range': `bytes */${pdf.length}`, 'content-length': '5',
  } }, { headers: { range: 'bytes=999-' } })
  assert.equal(rangeError.res.statusCode, 416)
  assert.equal(rangeError.res.headers['content-range'], `bytes */${pdf.length}`)
  assert.equal(rangeError.res.headers['content-length'], '5')
  assert.equal(rangeError.res.body.toString(), 'range')

  const head = await run({}, { method: 'HEAD' })
  assert.equal(head.call.options.method, 'HEAD')
  assert.equal(head.res.statusCode, 200)
  assert.equal(head.res.body.length, 0)
  assert.equal(head.res.headers['content-length'], String(pdf.length))
  const notModified = await run({ status: 304, headers: { etag: '"fixture"' } })
  assert.equal(notModified.res.statusCode, 304)
  assert.equal(notModified.res.body.length, 0)
  const bareQuery = await run({}, {}, resolveTexpageOutputTarget(OUTPUT_PROXY_PATH + path + '?', origin))
  assert.equal(bareQuery.call.options.path, path + '?')
  for (const range of ['bytes=0-', 'bytes=-8']) {
    const outcome = await run({}, { headers: { range, 'if-range': 'Tue, 01 Sep 2026 00:00:00 GMT' } })
    assert.equal(outcome.call.options.headers.range, range)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const outcome = await run({}, { method })
    assert.equal(outcome.res.statusCode, 405)
    assert.equal(outcome.res.headers.allow, 'GET, HEAD')
    assert.equal(outcome.call, undefined)
  }
  for (const headers of [
    { range: 'bytes=0-1,4-5' }, { range: 'bytes=8-1' }, { range: 'items=0-1' },
    { range: ['bytes=0-1'] }, { range: 'bytes=0-1\r\nInjected: yes' }, { range: 'bytes=99999999999999999-' },
    { 'if-range': ['"x"'] }, { 'if-range': 'W/"weak"' }, { 'if-range': 'not-a-validator' },
    { 'if-range': '"x\r\ny"' }, { 'if-range': '"' + 'x'.repeat(257) + '"' },
  ]) {
    const outcome = await run({}, { headers })
    assert.equal(outcome.res.statusCode, 400)
    assert.equal(outcome.call, undefined)
  }
  for (const bad of [new URL('https://evil.test' + path), new URL(origin.origin + '/admin'),
    new URL(`https://user:password@${outputHost}${path}`), new URL(origin.origin + path + '#fragment')]) {
    const outcome = await run({}, {}, bad)
    assert.equal(outcome.res.statusCode, 400)
    assert.equal(outcome.call, undefined)
  }
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of ['output.pdf', target.href, 'https://evil.test/', 'http://127.0.0.1/private']) {
      const count = calls.length
      const outcome = await run({ status, headers: { location } })
      assert.equal(outcome.res.statusCode, 502)
      assert.equal(outcome.res.headers.location, undefined)
      assert.equal(calls.length, count + 1, 'zero redirect hops')
      assert.ok(!outcome.res.body.toString().includes('X-Amz-'))
    }
  }
  for (const type of ['text/html', 'application/javascript', 'image/svg+xml', '']) {
    const outcome = await run({ headers: { 'content-type': type } })
    assert.equal(outcome.res.statusCode, 502, 'active/non-PDF success content rejected')
  }
  const opaque = await run({ headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'identity' } })
  assert.deepEqual(opaque.res.body, pdf)
  assert.equal(opaque.res.headers['content-encoding'], 'identity')
  for (const status of [403, 404, 500]) {
    const outcome = await run({ status, body: Buffer.from('synthetic-private-query') })
    assert.equal(outcome.res.statusCode, status)
    assert.equal(outcome.res.body.toString(), 'Output upstream unavailable')
  }
  for (const mode of ['throw', 'request-error', 'idle-timeout', 'total-timeout']) {
    const outcome = await run({ mode })
    assert.equal(outcome.res.statusCode, mode.endsWith('timeout') ? 504 : 502)
    assert.ok(!outcome.res.body.toString().includes('synthetic-private-query'))
  }
  for (const mode of ['response-error', 'response-aborted', 'response-close', 'truncated',
    'client-close', 'client-error', 'client-abort', 'abort-before-response']) {
    const outcome = await run({ mode })
    assert.equal(outcome.res.destroyed, true, 'broken streams release both sides')
  }
  const alreadyAborted = await run({}, { aborted: true })
  assert.equal(alreadyAborted.call, undefined)

  const logBody = Buffer.from('synthetic compiler log\n<script>inert text</script>\n\u4e2d\u6587\n')
  for (const logTarget of logTargets) {
    for (const status of [200, 206]) {
      for (const type of ['text/plain', 'text/plain; charset=iso-8859-1', 'application/octet-stream']) {
        const body = status === 206 ? logBody.subarray(0, 8) : logBody
        const spec = { status, body, headers: {
          'content-type': type, 'content-length': String(body.length), 'accept-ranges': 'bytes',
          ...(status === 206 ? { 'content-range': `bytes 0-7/${logBody.length}` } : {}),
          'set-cookie': ['never=forward'], location: 'https://evil.test/secret',
        } }
        const requestHeaders = {
          cookie: 'SESSION=synthetic', authorization: 'Bearer synthetic',
          origin: 'http://127.0.0.1:3080', referer: 'http://private.invalid/project',
          range: 'bytes=0-7', 'if-range': '"synthetic-log-etag"',
        }
        const outcome = await run(spec, { headers: requestHeaders }, logTarget)
        assert.equal(outcome.res.statusCode, status)
        assert.equal(outcome.res.headers['content-type'], 'text/plain; charset=utf-8')
        assert.equal(outcome.res.headers['x-content-type-options'], 'nosniff')
        assert.equal(outcome.res.headers['content-length'], String(body.length))
        assert.equal(outcome.res.headers['content-range'], spec.headers['content-range'])
        assert.deepEqual(outcome.res.body, body, 'log bytes are never decoded or transformed')
        assert.equal(outcome.call.options.path, logTarget.pathname + query)
        assert.deepEqual(outcome.call.options.headers, { range: 'bytes=0-7', 'if-range': '"synthetic-log-etag"' })
        assert.equal(outcome.res.headers['set-cookie'], undefined)
        assert.equal(outcome.res.headers.location, undefined)
        const headOutcome = await run(spec, { method: 'HEAD' }, logTarget)
        assert.equal(headOutcome.res.statusCode, status)
        assert.equal(headOutcome.res.headers['content-type'], 'text/plain; charset=utf-8')
        assert.equal(headOutcome.res.headers['content-length'], String(body.length))
        assert.equal(headOutcome.res.body.length, 0)
      }
      for (const type of ['text/html', 'text/html; charset=utf-8', 'text/xml', 'application/xml',
        'application/xhtml+xml', 'application/javascript', 'image/svg+xml', 'application/pdf', '']) {
        for (const method of ['GET', 'HEAD']) {
          const outcome = await run({ status, headers: {
            'content-type': type,
            ...(status === 206 ? { 'content-range': `bytes 0-7/${logBody.length}`, 'content-length': '8' } : {}),
          } }, { method }, logTarget)
          assert.equal(outcome.res.statusCode, 502, 'non-text log successes rejected, not relabeled')
          assert.equal(outcome.res.headers['x-content-type-options'], 'nosniff')
        }
      }
    }
    for (const status of [301, 302, 303, 307, 308]) {
      const count = calls.length
      const outcome = await run({ status, headers: { location: logTarget.href } }, {}, logTarget)
      assert.equal(outcome.res.statusCode, 502)
      assert.equal(outcome.res.headers.location, undefined)
      assert.equal(calls.length, count + 1, 'log redirects never followed')
    }
    const rejected = await run({}, { method: 'POST' }, logTarget)
    assert.equal(rejected.res.statusCode, 405)
    assert.equal(rejected.call, undefined)
    const log416 = await run({ status: 416, body: Buffer.from('range'), headers: {
      'content-type': 'application/xml', 'content-range': `bytes */${logBody.length}`, 'content-length': '5',
    } }, {}, logTarget)
    assert.equal(log416.res.statusCode, 416)
    assert.equal(log416.res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(log416.res.headers['content-range'], `bytes */${logBody.length}`)
    for (const body of [logBody.subarray(0, 7), logBody.subarray(0, 9)]) {
      const outcome = await run({ status: 206, body, headers: {
        'content-type': 'text/plain', 'content-range': `bytes 0-7/${logBody.length}`,
      } }, {}, logTarget)
      assert.equal(outcome.res.destroyed, true, 'incomplete log ranges terminate the response')
      assert.equal(outcome.res.writableFinished, false)
    }
  }
} finally {
  https.request = realRequest
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
console.log('TeXPage output smoke passed: strict metadata/PDF/log paths, opaque signed queries, credential isolation, safe log MIME, Range/HEAD/416, zero redirects, streaming cleanup; mocked HTTPS only')
