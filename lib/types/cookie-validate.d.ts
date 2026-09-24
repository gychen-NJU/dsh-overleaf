/**
 * Cookie-header validation shared by the paste-cookie route and the CDP
 * capture loop. A missing Overleaf /project route can fall back to the root
 * (for example, TeXPage redirects it to /console), but only an authenticated
 * page that is demonstrably protected from anonymous access proves login.
 */
/** Whether one cookie plausibly carries a session. */
export declare function isSessionishCookie(name: string, value: string): boolean;
/** Whether a redirect Location points at a login/SSO surface. */
export declare function locationLooksLikeLogin(location: string): boolean;
/**
 * Verify /project or an observed same-origin landing URL, falling back to the
 * origin root only when the first route is missing. The final authenticated
 * response must be 200 and not a login form; the same URL without cookies must
 * redirect to login/SSO, deny access (401/403), or show a password form.
 * Public HTML, arbitrary 404s and external redirects never prove authentication.
 * One timeout bounds all requests, including redirects and the anonymous probe.
 */
export declare function validateCookieHeader(cookie: string, baseUrl: string, timeoutMs?: number, landingUrl?: string): Promise<void>;
