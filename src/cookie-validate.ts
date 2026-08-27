/**
 * Cookie-header validation shared by the paste-cookie route and the CDP
 * capture loop. Tolerant by design: the upstream may be standard Overleaf
 * (where /project answers 200 when authenticated) or a TeXPage-based
 * deployment whose dashboard lives at a different path, so any answer that is
 * NOT an explicit bounce to a login page counts as authenticated.
 */

/** Cookie names that never indicate a real session. */
const PREFERENCE_COOKIES = new Set([
  'lang', 'locale', 'language', 'theme', 'tz', 'timezone',
  'acw_tc', 'cdn_sec_tc', // Aliyun CDN anti-bot cookies
])

/** Whether one cookie plausibly carries a session. */
export function isSessionishCookie(name: string, value: string): boolean {
  const lower = name.toLowerCase()
  if (PREFERENCE_COOKIES.has(lower)) return false
  if (lower.startsWith('csrf') || lower.endsWith('_csrf')) return false
  return value.trim().length >= 8
}

/** Whether a redirect Location points at a login/SSO surface. */
export function locationLooksLikeLogin(location: string): boolean {
  if (location === '') return false
  return /(?:^|[/?.])(?:login|signin|sign-in|sign_in|signon|sign_on|sso|oauth|auth|cas|ids)(?:$|[/?#&])|login\.[a-z]/i.test(location)
}

/**
 * Validate one Cookie header against the upstream. Accepted answers:
 *  - 200 from /project (standard Overleaf authenticated),
 *  - any 3xx whose Location is NOT a login/SSO page (dashboard redirect),
 *  - 404 (route may not exist on this product; unverifiable here).
 * Everything else — especially 3xx to /login — rejects.
 */
export async function validateCookieHeader(cookie: string, baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const response = await fetch(`${baseUrl}/project`, {
    headers: { cookie, accept: 'text/html' },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const location = response.headers.get('location') ?? ''
  if (response.status === 200 || response.status === 404) return
  if (response.status >= 300 && response.status < 400 && !locationLooksLikeLogin(location)) return
  throw new Error(
    `dsh-overleaf: cookie rejected by ${baseUrl} (HTTP ${response.status}`
    + `${location === '' ? '' : ` -> ${location}`}); it must include the live session cookie value from the site's DevTools`,
  )
}
