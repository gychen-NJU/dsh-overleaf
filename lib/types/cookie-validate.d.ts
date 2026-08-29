/**
 * Cookie-header validation shared by the paste-cookie route and the CDP
 * capture loop. Tolerant by design: the upstream may be standard Overleaf
 * (where /project answers 200 when authenticated) or a TeXPage-based
 * deployment whose dashboard lives at a different path, so any answer that is
 * NOT an explicit bounce to a login page counts as authenticated.
 */
/** Whether one cookie plausibly carries a session. */
export declare function isSessionishCookie(name: string, value: string): boolean;
/** Whether a redirect Location points at a login/SSO surface. */
export declare function locationLooksLikeLogin(location: string): boolean;
/**
 * Validate one Cookie header against the upstream. Accepted answers:
 *  - 200 from /project (standard Overleaf authenticated),
 *  - any 3xx whose Location is NOT a login/SSO page (dashboard redirect),
 *  - 404 (route may not exist on this product; unverifiable here).
 * Everything else — especially 3xx to /login — rejects.
 */
export declare function validateCookieHeader(cookie: string, baseUrl: string, timeoutMs?: number): Promise<void>;
