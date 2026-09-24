/** Fixture-only login verification regressions. Build first; never starts DSH. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { isSessionishCookie, validateCookieHeader } from '../lib/types/cookie-validate.js'

const SYNTHETIC_COOKIE = 'SESSIONID=fixture-session-only'
const PASSWORD_FORM = '<form action="/login"><input name="password" TYPE = password></form>'
const AUTH_PAGE = '<html><title>主页 - TeXPage</title><body>Fixture dashboard</body></html>'
let externalHits = 0
const requests = []
let scenario = 'nju'

function respond(res, status, body = '', location) {
  res.writeHead(status, { 'content-type': 'text/html', ...(location ? { location } : {}) })
  res.end(body)
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await closed
}

const external = createServer((_req, res) => {
  externalHits++
  respond(res, 200, AUTH_PAGE)
})
const externalOrigin = await listen(external)
const upstream = createServer((req, res) => {
  const authenticated = req.headers.cookie === SYNTHETIC_COOKIE
  requests.push({ path: req.url, authenticated, hasCookie: req.headers.cookie !== undefined })
  switch (scenario) {
    case 'nju':
      if (req.url === '/project') return respond(res, 404, 'Not Found')
      if (req.url === '/') return respond(res, 302, '', '/console')
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 302, '', '/login')
    case 'false404': return respond(res, 404, 'Not Found')
    case 'public200': return respond(res, 200, '<h1>Public welcome page</h1>')
    case 'login200': return respond(res, 200, PASSWORD_FORM)
    case 'password-proof': return respond(res, 200, authenticated ? AUTH_PAGE : PASSWORD_FORM)
    case '401-proof': return respond(res, authenticated ? 200 : 401, authenticated ? AUTH_PAGE : '')
    case '403-proof': return respond(res, authenticated ? 200 : 403, authenticated ? AUTH_PAGE : '')
    case 'anonymous404': return respond(res, authenticated ? 200 : 404, authenticated ? AUTH_PAGE : 'Not Found')
    case 'anonymous-public-redirect':
      return authenticated || req.url === '/welcome'
        ? respond(res, 200, AUTH_PAGE) : respond(res, 302, '', '/welcome')
    case 'loop': return respond(res, 302, '', req.url === '/project' ? '/other' : '/project')
    case 'redirect-limit': return respond(res, 302, '', `/hop/${requests.length}`)
    case 'five-redirects': {
      const hop = req.url === '/project' ? 0 : Number(req.url.slice('/hop/'.length))
      if (hop < 5) return respond(res, 302, '', `/hop/${hop + 1}`)
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 401)
    }
    case 'slow-redirects': {
      const timer = setTimeout(() => respond(res, 302, '', `/hop/${requests.length}`), 60)
      res.once('close', () => clearTimeout(timer))
      return
    }
    case 'external': return respond(res, 302, '', `${externalOrigin}/authorize`)
    case 'protocol-relative-external': return respond(res, 302, '', `${externalOrigin.replace('http:', '')}/console`)
    case 'anonymous-external':
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 302, '', `${externalOrigin}/sso`)
    case 'unsafe-scheme': return respond(res, 302, '', 'javascript:alert(1)')
    case 'missing-location': return respond(res, 302)
    case '304': return respond(res, 304)
    case 'login-redirect': return respond(res, 302, '', '/login')
    case 'sso-redirect': return respond(res, 302, '', '/oauth2/authorize')
    case 'authenticated401': return respond(res, 401)
    case 'authenticated403': return respond(res, 403)
    case 'server-error': return respond(res, 500)
    case 'anonymous-sso':
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 302, '', '/cas/login')
    case 'anonymous-loop':
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 302, '', '/project')
    case 'relative-redirect':
      if (req.url === '/nested/start') return respond(res, 307, '', '../console?view=all')
      return authenticated ? respond(res, 200, AUTH_PAGE) : respond(res, 403)
    case 'slow': return // The client deadline must abort the pending response.
    case 'oversize': return respond(res, 200, 'x'.repeat(1024 * 1024 + 1))
    case 'inert-password-template':
      return respond(res, 200, authenticated ? `<script>${PASSWORD_FORM}</script>${AUTH_PAGE}` : PASSWORD_FORM)
    default: throw new Error(`Unknown fixture scenario: ${scenario}`)
  }
})

try {
  const origin = await listen(upstream)
  const reset = name => { scenario = name; requests.length = 0 }
  let checks = 0
  async function accepts(name, landingUrl) {
    reset(name)
    await validateCookieHeader(SYNTHETIC_COOKIE, origin, 2_000, landingUrl)
    assert.ok(requests.some(request => request.authenticated), `${name}: authenticated request missing`)
    assert.ok(requests.some(request => !request.hasCookie), `${name}: anonymous request must omit Cookie`)
    checks++
  }
  async function rejects(name, landingUrl) {
    reset(name)
    await assert.rejects(validateCookieHeader(SYNTHETIC_COOKIE, origin, 2_000, landingUrl), undefined, name)
    checks++
  }

  await accepts('nju')
  assert.deepEqual(requests.map(({ path, hasCookie }) => [path, hasCookie]), [
    ['/project', true], ['/', true], ['/console', true], ['/console', false],
  ], 'NJU fallback must compare the final /console URL anonymously without fetching login')
  await accepts('nju', `${origin}/console`)
  assert.deepEqual(requests.map(request => request.path), ['/console', '/console'], 'observed landing bypasses /project')
  await accepts('relative-redirect', `${origin}/nested/start`)
  assert.deepEqual(requests.map(request => request.path), ['/nested/start', '/console?view=all', '/console?view=all'])

  for (const name of ['password-proof', '401-proof', '403-proof', 'inert-password-template', 'anonymous-sso']) await accepts(name)
  for (const name of [
    'false404', 'public200', 'login200', 'anonymous404', 'anonymous-public-redirect',
    'loop', 'external', 'protocol-relative-external', 'anonymous-external', 'unsafe-scheme',
    'missing-location', '304', 'login-redirect', 'sso-redirect', 'oversize',
    'authenticated401', 'authenticated403', 'server-error', 'anonymous-loop',
  ]) await rejects(name)

  await accepts('five-redirects')
  assert.equal(requests.length, 7, 'five redirects, terminal page and same-URL anonymous comparison are allowed')
  await rejects('redirect-limit')
  assert.equal(requests.length, 6, 'at most five redirects may be followed')
  await rejects('nju', `${externalOrigin}/console`)
  assert.equal(requests.length, 0, 'external landing must be rejected before any request')
  await rejects('nju', `${origin.replace('://', '://user:secret@')}/console`)
  assert.equal(requests.length, 0, 'URL userinfo must be rejected before any request')
  assert.equal(externalHits, 0, 'neither authenticated nor anonymous probes may contact an external origin')

  reset('slow')
  const started = Date.now()
  await assert.rejects(validateCookieHeader(SYNTHETIC_COOKIE, origin, 100))
  assert.ok(Date.now() - started < 2_000, 'deadline bounds stalled responses')
  checks++

  reset('slow-redirects')
  await assert.rejects(validateCookieHeader(SYNTHETIC_COOKIE, origin, 100), error => error.name === 'TimeoutError')
  assert.ok(requests.length <= 2, 'the deadline is shared across redirects, not reset per request')
  checks++

  reset('nju')
  await assert.rejects(validateCookieHeader('', origin))
  assert.equal(requests.length, 0, 'empty headers cannot trigger verification')
  checks++

  for (const name of [
    '_ga', '_ga_EXAMPLE', '_gid', '_gat_test', '_hjSessionUser_123', '_clck', '_fbp',
    '__utmz', 'GCLB', 'AWSALB', 'visitor_id', 'csrf', '_csrf', 'XSRF-TOKEN',
    'OptanonConsent', 'lang', 'theme', 'cf_clearance',
  ]) assert.equal(isSessionishCookie(name, 'synthetic-long-value'), false, `${name}: noise is not a session candidate`)
  for (const name of ['SESSIONID', 'overleaf_session2']) {
    assert.equal(isSessionishCookie(name, 'short'), true, `${name}: known session cookie is retained`)
    assert.equal(isSessionishCookie(name, ''), false)
  }
  for (const name of ['custom_auth', '__Host-auth', 'access_token', 'connect.sid']) {
    assert.equal(isSessionishCookie(name, 'synthetic-long-value'), true, `${name}: generic auth candidates remain supported`)
  }
  checks++
  console.log(`smoke-login: ${checks} fixture checks passed; no external requests`)
} finally {
  await Promise.all([close(upstream), close(external)])
}
