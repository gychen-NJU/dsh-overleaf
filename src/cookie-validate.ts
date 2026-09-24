/**
 * Cookie-header validation shared by the paste-cookie route and the CDP
 * capture loop. A missing Overleaf /project route can fall back to the root
 * (for example, TeXPage redirects it to /console), but only an authenticated
 * page that is demonstrably protected from anonymous access proves login.
 */

/** Cookie names that never indicate a real session. */
const PREFERENCE_COOKIES = new Set([
  'lang', 'locale', 'language', 'theme', 'tz', 'timezone',
  'acw_tc', 'cdn_sec_tc', // Aliyun CDN anti-bot cookies
  'gclb', 'route', 'serverid', // Load-balancer affinity, not authentication
  'visitor_id', 'visitorid', 'visitor', 'tracking_id',
  'cookieconsent', 'cookie_consent', 'optanonconsent', 'optanonalertboxclosed',
])

/** Whether one cookie plausibly carries a session. */
export function isSessionishCookie(name: string, value: string): boolean {
  const lower = name.toLowerCase()
  if (PREFERENCE_COOKIES.has(lower)) return false
  if (/^_?(?:csrf|xsrf)|(?:^|[_-])(?:csrf|xsrf)(?:$|[_-])/.test(lower)) return false
  if (/^_(?:ga(?:_|$)|gid$|gat|gcl_|hj|clck$|clsk$|fbp$|fbc$)|^(?:__utm|__cf|cf_clearance$|awsalb|amplitude_|amp_|mp_)/.test(lower)) return false
  if (lower === 'sessionid' || lower === 'overleaf_session2') return value.trim() !== ''
  return value.trim().length >= 8
}

/** Whether a redirect Location points at a login/SSO surface. */
export function locationLooksLikeLogin(location: string): boolean {
  if (location === '') return false
  return /(?:^|[/?.])(?:login|signin|sign-in|sign_in|signon|sign-on|sign_on|sso|oauth2?|oidc|saml|authorize|auth|cas|ids)(?:$|[/?#&])|login\.[a-z]/i.test(location)
}

const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type ProbeResult =
  | { kind: 'page'; url: URL; html: string }
  | { kind: 'missing' | 'denied' | 'login' }

/** Validate before fetching: manual redirects must never disclose the header. */
function sameOriginUrl(value: string, relativeTo: URL, origin: string): URL {
  const url = new URL(value, relativeTo)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username !== '' || url.password !== '') {
    throw new Error('dsh-overleaf: cookie verification refused an external or unsafe URL')
  }
  url.hash = ''
  return url
}

/** Bound response size as well as the shared request deadline. */
async function readHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let bytes = 0
  let html = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return html + decoder.decode()
      bytes += value.byteLength
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel()
        throw new Error('dsh-overleaf: cookie verification page exceeded the size limit')
      }
      html += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** Ignore inert templates in comments/scripts when looking for login forms. */
function formsIn(html: string): string[] {
  return html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .match(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi) ?? []
}

function hasPasswordForm(html: string): boolean {
  return formsIn(html).some(form => /<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password(?=[\s/>]))/i.test(form))
}

function isLoginPage(html: string): boolean {
  return hasPasswordForm(html) || formsIn(html).some(form => {
    const action = /^<form\b[^>]*\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(form)
    return action !== null && locationLooksLikeLogin(action[1] ?? action[2] ?? action[3] ?? '')
  })
}

/** Walk only same-origin redirects; callers interpret login/denial by context. */
async function probe(start: URL, origin: string, cookie: string | undefined, signal: AbortSignal): Promise<ProbeResult> {
  let url = start
  const seen = new Set<string>()
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (seen.has(url.href)) throw new Error('dsh-overleaf: cookie verification redirect loop')
    seen.add(url.href)
    if (locationLooksLikeLogin(url.pathname)) return { kind: 'login' }
    const response = await fetch(url, {
      headers: { ...(cookie === undefined ? {} : { cookie }), accept: 'text/html' },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (response.status === 200) return { kind: 'page', url, html: await readHtml(response) }
    await response.body?.cancel()
    if (response.status === 404) return { kind: 'missing' }
    if (response.status === 401 || response.status === 403) return { kind: 'denied' }
    if (!REDIRECT_STATUSES.has(response.status)) {
      throw new Error(`dsh-overleaf: cookie verification received HTTP ${response.status}`)
    }
    const location = response.headers.get('location')
    if (location === null || location.trim() === '') {
      throw new Error('dsh-overleaf: cookie verification redirect has no Location')
    }
    url = sameOriginUrl(location, url, origin)
  }
  throw new Error('dsh-overleaf: cookie verification exceeded the redirect limit')
}

/**
 * Verify /project or an observed same-origin landing URL, falling back to the
 * origin root only when the first route is missing. The final authenticated
 * response must be 200 and not a login form; the same URL without cookies must
 * redirect to login/SSO, deny access (401/403), or show a password form.
 * Public HTML, arbitrary 404s and external redirects never prove authentication.
 * One timeout bounds all requests, including redirects and the anonymous probe.
 */
export async function validateCookieHeader(cookie: string, baseUrl: string, timeoutMs = 15_000, landingUrl?: string): Promise<void> {
  if (cookie.trim() === '') throw new Error('dsh-overleaf: cookie verification requires a nonempty header')
  const base = new URL(baseUrl)
  const root = sameOriginUrl('/', base, base.origin)
  const first = sameOriginUrl(landingUrl ?? '/project', root, base.origin)
  const signal = AbortSignal.timeout(timeoutMs)
  let authenticated = await probe(first, base.origin, cookie, signal)
  if (authenticated.kind === 'missing' && first.href !== root.href) {
    authenticated = await probe(root, base.origin, cookie, signal)
  }
  if (authenticated.kind !== 'page' || isLoginPage(authenticated.html)) {
    throw new Error('dsh-overleaf: cookie verification did not reach an authenticated page (missing route, login, or access denied)')
  }
  const anonymous = await probe(authenticated.url, base.origin, undefined, signal)
  if (anonymous.kind === 'denied' || anonymous.kind === 'login'
    || (anonymous.kind === 'page' && hasPasswordForm(anonymous.html))) return
  throw new Error('dsh-overleaf: cookie verification found no protected-page evidence; public or unverifiable pages do not prove login')
}
