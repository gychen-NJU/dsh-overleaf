#!/usr/bin/env node
// Run: node --test --test-reporter=spec scripts/smoke-texpage-bib-proxy.mjs
// Tests the real server module with injected fetch and an in-memory HTTP sink.
// No server, network, real credentials, filesystem writes or external packages.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  BIB_PROXY_PATH, resolveTexpageBibTarget, resolveTexpageBibRedirect, serveTexpageBib,
} from '../src/texpage-bib-proxy.ts'

const SITE = new URL('https://tex.nju.edu.cn')
const OBJECT_ORIGIN = new URL('https://latex-file.texpageusercontent.com')
const IDS = {
  ownerKey: '00000000-0000-4000-8000-000000000001',
  projectKey: '00000000-0000-4000-8000-000000000002',
  versionNo: '00000000-0000-4000-8000-000000000003',
  fileKey: '00000000-0000-4000-8000-000000000004',
}
const path = (ids = IDS) => BIB_PROXY_PATH + '?' + new URLSearchParams(ids)
const target = resolveTexpageBibTarget(path(), SITE, OBJECT_ORIGIN)
assert.ok(target, 'canonical synthetic request resolves')
const signedQuery = '?X-Amz-Algorithm=TEST&X-Amz-Credential=synthetic%2Fscope&X-Amz-Signature=synthetic&same=x+z&same=x%20z&lower=%2f&upper=%2F&empty=&bare'
const signedUrl = OBJECT_ORIGIN.origin + target.objectPath + signedQuery
const TEXT = '@article{fixture,\r\n  title = {Synthetic 文献},\r\n  year = {2026}\r\n}\r\n'
const MAX_BYTES = 2 * 1024 * 1024
const genericError = 'Bibliography readback unavailable'
const plainHeaders = { accept: 'text/plain, application/octet-stream', 'cache-control': 'no-cache' }
const siteHeaders = Object.freeze({
  cookie: 'SESSION=synthetic-only', authorization: 'Bearer synthetic-only', 'user-agent': 'synthetic-agent',
  host: 'evil.test', origin: 'https://private.invalid', referer: 'https://private.invalid/path',
  'proxy-authorization': 'synthetic-proxy-secret', 'x-csrf-token': 'synthetic-csrf',
  'x-forwarded-host': 'evil.test', 'x-forwarded-for': '192.0.2.1',
  connection: 'x-private', 'x-private': 'synthetic-private-header',
  range: 'bytes=0-10', 'if-range': 'synthetic-etag', 'accept-encoding': 'gzip',
  'content-length': '1000', 'content-type': 'application/json',
})

const response = (text = TEXT, type = 'text/plain; charset=utf-8', extra = {}) => new Response(text, {
  headers: { 'content-type': type, ...extra },
})
const redirect = (location = signedUrl, status = 302) => new Response('synthetic redirect body', {
  status, headers: { location, 'set-cookie': 'SHOULD-NOT-LEAVE=synthetic', 'x-private': 'synthetic' },
})

test('target uses the configured site and exact owner/file/version object path', () => {
  assert.equal(BIB_PROXY_PATH, '/__dsh_texpage_bib__')
  assert.equal(target.download.origin, SITE.origin)
  assert.equal(target.download.pathname, '/api/project/file')
  assert.deepEqual(Object.fromEntries(target.download.searchParams), {
    projectKey: IDS.projectKey, versionNo: IDS.versionNo, fileKey: IDS.fileKey,
  })
  assert.equal(target.download.searchParams.has('ownerKey'), false, 'upstream download rejects ownerKey')
  assert.equal(target.objectPath, `/${IDS.ownerKey}/${IDS.fileKey}_${IDS.versionNo}`)
  assert.equal(SITE.href, 'https://tex.nju.edu.cn/')
  assert.equal(OBJECT_ORIGIN.href, 'https://latex-file.texpageusercontent.com/')
})

for (const learned of [
  undefined, new URL('https://evil.test'), new URL('https://latex-file.texpageusercontent.com.evil.test'),
  new URL('http://latex-file.texpageusercontent.com'), new URL('https://latex-file.texpageusercontent.com:444'),
  new URL('https://synthetic@latex-file.texpageusercontent.com'),
  new URL('https://latex-file.texpageusercontent.com/base'),
  new URL('https://latex-file.texpageusercontent.com/?x=1'),
  new URL('https://latex-file.texpageusercontent.com/#fragment'),
]) {
  test(`target refuses absent/non-canonical learned file origin: ${learned?.href ?? 'absent'}`, () => {
    assert.equal(resolveTexpageBibTarget(path(), SITE, learned), undefined)
  })
}

test('target preserves a configured institution site instead of using a client-supplied destination', () => {
  const otherSite = new URL('https://nju.texpage.com')
  const result = resolveTexpageBibTarget(path(), otherSite, OBJECT_ORIGIN)
  assert.equal(result.download.origin, otherSite.origin)
  assert.equal(result.objectPath, target.objectPath)
})

for (const site of [new URL('file:///synthetic'), new URL('ftp://synthetic.invalid')]) {
  test(`target rejects a non-HTTP configured site: ${site.protocol}`, () => {
    assert.equal(resolveTexpageBibTarget(path(), site, OBJECT_ORIGIN), undefined)
  })
}

for (const [label, invalid] of [
  ['empty path', ''], ['missing query', BIB_PROXY_PATH], ['wrong path', '/api/project/file?' + new URLSearchParams(IDS)],
  ['proxy prefix is not the stripped route', '/overleaf-proxy' + path()],
  ['extra path segment', BIB_PROXY_PATH + '/extra?' + new URLSearchParams(IDS)],
  ['lookalike marker', BIB_PROXY_PATH + 'evil?' + new URLSearchParams(IDS)],
  ['foreign absolute URL', 'https://evil.test' + path()],
  ['foreign protocol-relative URL', '//evil.test' + path()],
  ['wrong same-host port', 'https://tex.nju.edu.cn:444' + path()],
  ['fragment', path() + '#fragment'], ['arbitrary URL parameter', path() + '&url=https%3A%2F%2Fevil.test'],
  ['oversized request target', path() + '&extra=' + 'x'.repeat(1025)],
]) {
  test(`target rejects ${label}`, () => {
    assert.equal(resolveTexpageBibTarget(invalid, SITE, OBJECT_ORIGIN), undefined)
  })
}

for (const key of Object.keys(IDS)) {
  test(`target requires one and only one ${key}`, () => {
    const missing = { ...IDS }
    delete missing[key]
    assert.equal(resolveTexpageBibTarget(path(missing), SITE, OBJECT_ORIGIN), undefined)
    assert.equal(resolveTexpageBibTarget(path() + '&' + key + '=' + IDS[key], SITE, OBJECT_ORIGIN), undefined)
    assert.equal(resolveTexpageBibTarget(path() + '&' + encodeURIComponent(key) + '=different', SITE, OBJECT_ORIGIN), undefined)
  })
  for (const value of ['', '..', 'a/b', 'a\\b', 'a_b', 'a b', 'a\n', 'a\u0000', 'a@b', 'x'.repeat(129)]) {
    test(`target validates ${key}: ${JSON.stringify(value.length > 20 ? value.slice(0, 20) + '…' : value)}`, () => {
      assert.equal(resolveTexpageBibTarget(path({ ...IDS, [key]: value }), SITE, OBJECT_ORIGIN), undefined)
    })
  }
}

test('query order is irrelevant, and encoded parameter names still count as duplicates', () => {
  const reversed = Object.fromEntries(Object.entries(IDS).reverse())
  assert.equal(resolveTexpageBibTarget(path(reversed), SITE, OBJECT_ORIGIN).download.href, target.download.href)
  assert.equal(resolveTexpageBibTarget(path() + '&%6fwnerKey=' + IDS.ownerKey, SITE, OBJECT_ORIGIN), undefined)
  assert.equal(resolveTexpageBibTarget(path({ ...IDS, ownerKey: '../owner' }), SITE, OBJECT_ORIGIN), undefined)
})

test('redirect preserves signed query bytes exactly while binding fixed host and object path', () => {
  assert.equal(resolveTexpageBibRedirect(signedUrl, target)?.href, signedUrl)
  for (const query of ['', '?', '?bare&empty=&x=%2f%2F&x=+&x=%20']) {
    const raw = OBJECT_ORIGIN.origin + target.objectPath + query
    assert.equal(resolveTexpageBibRedirect(raw, target)?.href, raw)
  }
})

for (const [label, raw] of [
  ['other host', 'https://evil.test' + target.objectPath + signedQuery],
  ['lookalike host', OBJECT_ORIGIN.origin + '.evil.test' + target.objectPath + signedQuery],
  ['HTTP object URL', signedUrl.replace('https:', 'http:')],
  ['custom port', signedUrl.replace(OBJECT_ORIGIN.origin, OBJECT_ORIGIN.origin + ':444')],
  ['noncanonical default port', signedUrl.replace(OBJECT_ORIGIN.origin, OBJECT_ORIGIN.origin + ':443')],
  ['username', signedUrl.replace('https://', 'https://synthetic@')],
  ['username and password', signedUrl.replace('https://', 'https://synthetic:synthetic@')],
  ['protocol-relative URL', signedUrl.slice('https:'.length)],
  ['relative URL', target.objectPath + signedQuery],
  ['wrong owner ID', signedUrl.replace(IDS.ownerKey, 'other-owner')],
  ['wrong file ID', signedUrl.replace(IDS.fileKey, 'other-file')],
  ['wrong version ID', signedUrl.replace(IDS.versionNo, 'other-version')],
  ['extra project path', OBJECT_ORIGIN.origin + '/' + IDS.projectKey + target.objectPath + signedQuery],
  ['extra filename extension', OBJECT_ORIGIN.origin + target.objectPath + '.bib' + signedQuery],
  ['path suffix', OBJECT_ORIGIN.origin + target.objectPath + '/extra' + signedQuery],
  ['encoded path ID', signedUrl.replace('/' + IDS.ownerKey, '/%30' + IDS.ownerKey.slice(1))],
  ['fragment', signedUrl + '#fragment'], ['backslash', signedUrl + '\\'],
  ['space', signedUrl + ' '], ['newline', signedUrl + '\n'], ['unicode', signedUrl + '文'],
  ['invalid percent escape', signedUrl + '&x=%GG'], ['incomplete percent escape', signedUrl + '&x=%'],
  ['oversized signed URL', signedUrl + '&padding=' + 'x'.repeat(64 * 1024)],
]) {
  test(`redirect refuses ${label}`, () => {
    assert.equal(resolveTexpageBibRedirect(raw, target), undefined)
  })
}

class Sink extends EventEmitter {
  statusCode = 0
  destroyed = false
  writableEnded = false
  headers = {}
  body = ''
  replies = 0
  writeHead(status, headers) {
    assert.equal(this.writableEnded, false, 'no second response after end')
    this.statusCode = status
    this.headers = headers
    this.replies += 1
    return this
  }
  end(text) { this.body += text ?? ''; this.writableEnded = true; return this }
}

async function microtasks() { for (let i = 0; i < 80; i++) await Promise.resolve() }

// Top-level node:test cases run serially. Scope fake timers to one injected
// request, restore globals even after failure, and never replace global fetch.
async function run(options = {}) {
  const req = Object.assign(new EventEmitter(), {
    method: options.method ?? 'GET', aborted: options.aborted ?? false,
    headers: { ...siteHeaders, cookie: 'INCOMING=must-not-be-copied', authorization: 'Incoming synthetic' },
    body: 'synthetic client payload must not be forwarded',
  })
  const res = new Sink()
  if (options.destroyed) res.destroyed = true
  const f = { req, res, calls: [], bodies: [], timers: new Set(), createdTimers: [], violations: [] }
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay !== 18_000) return originalSetTimeout(fn, delay, ...args)
    const timer = { delay, fired: false, unreferenced: false,
      callback: () => fn(...args), unref() { this.unreferenced = true; return this },
    }
    f.createdTimers.push(timer)
    f.timers.add(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (f.createdTimers.includes(timer)) f.timers.delete(timer)
    else originalClearTimeout(timer)
  }
  function recordBody(result) {
    const record = { response: result, cancellations: 0 }
    f.bodies.push(record)
    if (result.body) {
      const cancel = result.body.cancel.bind(result.body)
      result.body.cancel = reason => { record.cancellations += 1; return cancel(reason) }
    }
    return result
  }
  const injectedFetch = async (url, init) => {
    const index = f.calls.length
    f.calls.push({ url: new URL(url), init })
    try {
      assert.ok(index < 2, 'at most one authenticated hop and one signed-object read')
      assert.equal(new URL(url).href, index === 0 ? target.download.href : signedUrl, 'destination and signed query are exactly bound')
      assert.equal(init.method ?? 'GET', 'GET', 'never forward the client method/body')
      assert.equal(init.body, undefined)
      assert.equal(init.redirect, 'manual', 'fetch never follows redirects automatically')
      assert.ok(init.signal instanceof AbortSignal)
      assert.equal(init.signal.aborted, false)
      if (index === 0) {
        const source = options.siteHeaders ?? siteHeaders
        const expected = { ...plainHeaders }
        for (const key of ['cookie', 'authorization', 'user-agent']) {
          if (typeof source[key] === 'string') expected[key] = source[key]
        }
        assert.deepEqual(init.headers, expected, 'same-site hop rebuilds only the permitted headers')
      } else {
        assert.equal(init.credentials, 'omit')
        assert.deepEqual(init.headers, plainHeaders, 'no cookie, authorization, user-agent, origin or proxy headers cross origins')
        assert.equal(init.signal, f.calls[0].init.signal, 'both hops share the total deadline')
      }
    } catch (error) { f.violations.push(error.message); throw error }
    const result = options.fetch
      ? await options.fetch(f, index, init)
      : index === 0 ? redirect() : response()
    return recordBody(result)
  }
  const originalTarget = { download: target.download.href, objectPath: target.objectPath }
  try {
    let done = false
    let failure
    const pending = serveTexpageBib(req, res, target, options.siteHeaders ?? siteHeaders, injectedFetch)
    pending.then(() => { done = true }, error => { done = true; failure = error })
    for (let i = 0; !done && i < 10; i++) {
      await microtasks()
      if (!done) {
        const timer = [...f.timers].find(entry => !entry.fired)
        assert.ok(timer, 'service must finish or have an active fake deadline')
        timer.fired = true
        timer.callback()
      }
    }
    assert.equal(done, true, 'service settles without wall-clock waiting')
    assert.equal(failure, undefined, 'service handles read failures through its HTTP response')
    await pending
    assert.equal(f.timers.size, 0, 'total timeout is always cleared')
    assert.ok(f.createdTimers.every(timer => timer.unreferenced), 'deadline timer does not keep Node alive')
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
    assert.deepEqual(f.violations, [], 'request policy holds even in expected-failure tests')
    assert.deepEqual({ download: target.download.href, objectPath: target.objectPath }, originalTarget)
    if (res.statusCode) {
      assert.equal(res.replies, 1)
      const diagnostic = res.headers['x-dsh-bib-error']
      if ([502, 504].includes(res.statusCode)) {
        assert.match(diagnostic, /^(site|redirect|object|body)-(network|target|mime|size|utf8|stream|timeout|http-[1-5][0-9]{2})$/, 'only a locally-generated, bounded error category may escape')
      } else assert.equal(diagnostic, undefined)
      assert.deepEqual(res.headers, {
        'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', ...(res.statusCode === 405 ? { allow: 'GET' } : {}),
        ...(diagnostic ? { 'x-dsh-bib-error': diagnostic } : {}),
      }, 'upstream headers, cookies, signed locations and content metadata never escape')
    }
    return f
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
}

function unavailable(f, status = 502) {
  assert.equal(f.res.statusCode, status)
  assert.equal(f.res.body, genericError, 'no upstream payload, signed URL, credential or exception text leaks')
  assert.ok(f.bodies.every(body => !body.response.body || body.cancellations > 0), 'all received response bodies are released')
}

test('GET performs one authorized site hop and one credential-free bound object read', async () => {
  const f = await run()
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body, TEXT, 'UTF-8 and CRLF content are preserved')
  assert.equal(f.calls.length, 2)
  assert.equal(f.createdTimers.length, 1)
  assert.equal(f.createdTimers[0].delay, 18_000)
  assert.equal(f.createdTimers[0].fired, false)
  assert.ok(f.bodies.every(body => body.cancellations === 1))
})

test('authenticated site can return valid inline bibliography without a signed hop', async () => {
  const f = await run({ fetch: () => response() })
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body, TEXT)
  assert.equal(f.calls.length, 1)
})

for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
  test(`only GET is allowed: ${method} makes no upstream request`, async () => {
    const f = await run({ method })
    assert.equal(f.res.statusCode, 405)
    assert.equal(f.res.headers.allow, 'GET')
    assert.equal(f.calls.length, 0)
    assert.equal(f.createdTimers.length, 0)
  })
}

for (const [label, options] of [['aborted request', { aborted: true }], ['destroyed response', { destroyed: true }]]) {
  test(`${label} is ignored before any upstream work`, async () => {
    const f = await run(options)
    assert.equal(f.res.replies, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.createdTimers.length, 0)
  })
}

test('header arrays, unknown/case-variant headers and raw incoming credentials are not forwarded', async () => {
  const f = await run({ siteHeaders: {
    cookie: ['synthetic-array-cookie'], authorization: ['synthetic-array-auth'], 'user-agent': ['array-agent'],
    Cookie: 'synthetic-upper-cookie', Authorization: 'synthetic-upper-auth', 'x-api-key': 'synthetic-api-key',
  } })
  assert.equal(f.res.statusCode, 200)
  assert.deepEqual(f.calls[0].init.headers, plainHeaders)
  assert.deepEqual(f.calls[1].init.headers, plainHeaders)
})

test('response header secrets and signed URLs are not returned to the browser', async () => {
  const f = await run({ fetch: (_f, index) => index === 0 ? redirect() : response(TEXT, 'text/plain', {
    'set-cookie': 'synthetic-secret', location: signedUrl, authorization: 'synthetic-token',
    etag: 'synthetic-id', 'cache-control': 'public', 'access-control-allow-origin': '*',
    'content-disposition': 'attachment; filename="synthetic.bib"', 'x-private': 'synthetic',
  }) })
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body, TEXT)
  assert.equal(Object.keys(f.res.headers).length, 3)
})

for (const status of [302, 303, 307]) {
  test(`one valid ${status} redirect is accepted`, async () => {
    const f = await run({ fetch: (_f, index) => index === 0 ? redirect(signedUrl, status) : response() })
    assert.equal(f.res.statusCode, 200)
    assert.equal(f.calls.length, 2)
  })
}

for (const status of [301, 308, 204, 206, 401, 403, 404, 500]) {
  test(`unexpected same-site HTTP ${status} fails without a signed follow-up`, async () => {
    const f = await run({ fetch: () => new Response(status === 204 ? null : 'synthetic upstream body', {
      status, headers: { location: signedUrl, 'content-type': 'text/plain' },
    }) })
    unavailable(f)
    assert.equal(f.calls.length, 1)
  })
}

for (const [label, location] of [
  ['missing Location', ''], ['foreign host', 'https://evil.test' + target.objectPath],
  ['wrong owner', signedUrl.replace(IDS.ownerKey, 'other-owner')],
  ['wrong file', signedUrl.replace(IDS.fileKey, 'other-file')],
  ['wrong version', signedUrl.replace(IDS.versionNo, 'other-version')],
  ['credentialed URL', signedUrl.replace('https://', 'https://synthetic:synthetic@')],
]) {
  test(`invalid signed redirect (${label}) stops after the authenticated hop`, async () => {
    const f = await run({ fetch: () => redirect(location) })
    unavailable(f)
    assert.equal(f.calls.length, 1)
    assert.equal(f.bodies[0].cancellations, 1)
  })
}

for (const status of [302, 303, 307, 308]) {
  test(`object HTTP ${status} cannot start a second redirect chain`, async () => {
    const f = await run({ fetch: (_f, index) => index === 0 ? redirect() : redirect('https://evil.test/never-fetch', status) })
    unavailable(f)
    assert.equal(f.calls.length, 2)
  })
}

for (const type of ['text/plain', 'application/octet-stream', 'application/x-bibtex', 'text/x-bibtex', 'Text/Plain; charset=UTF-8']) {
  test(`accepted bibliography MIME: ${type}`, async () => {
    const f = await run({ fetch: () => response(TEXT, type) })
    assert.equal(f.res.statusCode, 200)
    assert.equal(f.res.body, TEXT)
  })
}

for (const type of ['text/html', 'application/json', 'application/problem+json', 'application/pdf', 'application/xml', '']) {
  for (const hop of ['site', 'object']) {
    test(`${hop} rejects non-bibliography MIME ${JSON.stringify(type)}`, async () => {
      const f = await run({ fetch: (_f, index) => hop === 'object' && index === 0 ? redirect()
        : response('{"status":{"code":1001},"result":["synthetic"]}', type) })
      unavailable(f)
      assert.equal(f.calls.length, hop === 'site' ? 1 : 2)
    })
  }
}

for (const html of ['<!doctype html><html>synthetic login</html>', ' \r\n<HTML>synthetic login</HTML>', '\ufeff<html>synthetic login</html>']) {
  test('HTML login/error content is rejected even when labelled text/plain', async () => {
    const f = await run({ fetch: () => response(html) })
    unavailable(f)
  })
}

test('empty bibliography has a real empty stream and is returned successfully', async () => {
  const f = await run({ fetch: () => response('') })
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body, '')
})

test('missing response body is not silently treated as an empty bibliography', async () => {
  const f = await run({ fetch: () => response(null) })
  unavailable(f)
})

test('fatal UTF-8 decode errors return a generic failure, never replacement characters', async () => {
  const f = await run({ fetch: () => response(new Uint8Array([0xc3, 0x28])) })
  unavailable(f)
})

test('multibyte UTF-8 split across chunks is decoded after collecting the full content', async () => {
  const bytes = new TextEncoder().encode(TEXT)
  const offset = bytes.findIndex(byte => byte > 127)
  const f = await run({ fetch: () => response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, offset + 1))
    controller.enqueue(bytes.slice(offset + 1, offset + 2))
    controller.enqueue(bytes.slice(offset + 2))
    controller.close()
  } })) })
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body, TEXT)
})

test('exact two-MiB body is accepted', async () => {
  const text = 'a'.repeat(MAX_BYTES)
  const f = await run({ fetch: () => response(text, 'text/plain', { 'content-length': String(MAX_BYTES) }) })
  assert.equal(f.res.statusCode, 200)
  assert.equal(f.res.body.length, MAX_BYTES)
})

for (const [label, factory] of [
  ['declared length', () => response('small', 'text/plain', { 'content-length': String(MAX_BYTES + 1) })],
  ['actual streamed bytes', () => response('x'.repeat(MAX_BYTES + 1))],
  ['misleading short header', () => response('x'.repeat(MAX_BYTES + 1), 'text/plain', { 'content-length': '1' })],
  ['multibyte UTF-8 length', () => response('文'.repeat(Math.floor(MAX_BYTES / 3) + 1))],
]) {
  test(`size limit rejects ${label} without returning a partial body`, async () => {
    const f = await run({ fetch: factory })
    unavailable(f)
  })
}

for (const hop of ['site', 'object']) {
  test(`${hop} network exception is redacted and cleans up deadline/listeners`, async () => {
    const f = await run({ fetch: (_f, index) => {
      if (hop === 'object' && index === 0) return redirect()
      throw new Error('synthetic private exception ' + signedUrl + ' SESSION=synthetic')
    } })
    unavailable(f)
    assert.equal(f.calls.length, hop === 'site' ? 1 : 2)
  })
}

test('stream read failure after a partial chunk never returns the partial content', async () => {
  let reads = 0
  const f = await run({ fetch: () => response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode('synthetic partial bibliography'))
    else controller.error(new Error('synthetic private read failure ' + signedUrl))
  } })) })
  unavailable(f)
})

for (const hop of ['site', 'object']) {
  test(`${hop} hung fetch is aborted by the one total 18-second fake deadline`, async () => {
    const f = await run({ fetch: (_f, index, init) => {
      if (hop === 'object' && index === 0) return redirect()
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic aborted')), { once: true }))
    } })
    unavailable(f, 504)
    assert.equal(f.createdTimers.length, 1)
    assert.equal(f.createdTimers[0].delay, 18_000)
    assert.equal(f.createdTimers[0].fired, true)
    assert.ok(f.calls.every(call => call.init.signal.aborted))
  })
}

test('hanging response stream is also covered by the total deadline', async () => {
  const f = await run({ fetch: (_f, _index, init) => response(new ReadableStream({ start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new Error('synthetic stream aborted')), { once: true })
  } })) })
  unavailable(f, 504)
  assert.equal(f.createdTimers[0].fired, true)
})

test('incoming request abort cancels the upstream request without exposing upstream error details', async () => {
  const f = await run({ fetch: (current, _index, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic incoming abort')), { once: true })
    queueMicrotask(() => { current.req.aborted = true; current.req.emit('aborted') })
  }) })
  unavailable(f, 504)
  assert.equal(f.createdTimers[0].fired, false)
})

test('closed downstream aborts upstream work and receives no late response', async () => {
  const f = await run({ fetch: (current, _index, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic closed response')), { once: true })
    queueMicrotask(() => { current.res.destroyed = true; current.res.emit('close') })
  }) })
  assert.equal(f.res.replies, 0)
  assert.equal(f.res.body, '')
  assert.equal(f.calls[0].init.signal.aborted, true)
  assert.equal(f.createdTimers[0].fired, false)
})

for (const [expected, fetch] of [
  ['site-network', () => { throw new Error('private URL and credentials must not escape') }],
  ['site-http-403', () => new Response('private access-denied payload', { status: 403 })],
  ['redirect-target', () => redirect('https://evil.test/?secret=private')],
  ['object-network', (_f, i) => { if (i === 0) return redirect(); throw new Error('private signed URL') }],
  ['object-http-503', (_f, i) => i === 0 ? redirect() : new Response('busy', { status: 503 })],
  ['object-mime', (_f, i) => i === 0 ? redirect() : response('private login html', 'text/html')],
  ['body-utf8', () => response(new Uint8Array([0xff]))],
]) {
  test(`safe failure diagnostic identifies ${expected}`, async () => {
    const f = await run({ fetch })
    unavailable(f)
    assert.equal(f.res.headers['x-dsh-bib-error'], expected)
  })
}

test('upstream cannot spoof the local error diagnostic header', async () => {
  const f = await run({ fetch: () => new Response('denied', { status: 403, headers: { 'x-dsh-bib-error': signedUrl } }) })
  assert.equal(f.res.headers['x-dsh-bib-error'], 'site-http-403')
})
