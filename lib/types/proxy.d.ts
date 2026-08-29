/**
 * Same-origin reverse proxy for one fixed Overleaf origin. The embedded view
 * loads `${PROXY_PREFIX}/<path>` instead of the real site, which sidesteps
 * X-Frame-Options/CSP framing limits and (critically) makes the iframe
 * same-origin with the GUI shell, enabling the selection and cursor bridges.
 *
 * Design notes:
 * - Requests stream both ways without buffering (binary uploads/downloads,
 *   compiled PDFs), EXCEPT text/html responses whose bodies need rebasing.
 * - The target is locked to config.baseUrl (no SSRF surface): every outbound
 *   connection goes to that single origin.
 * - Loopback-only enforcement lives in the service route wrapper; handlers
 *   here assume an already-fenced request.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** Prefix under which the upstream site is exposed (disjoint from other plugins). */
export declare const PROXY_PREFIX = "/overleaf-proxy";
/**
 * Rebase CSS url(...) / @import references inside one stylesheet body.
 * (text/css responses are otherwise passed through untouched - un-rebased
 * `url(/overleaf-logo.svg)`-style references resolve against the shell origin
 * and 404 in a loop.)
 */
export declare function rewriteCss(css: string, prefix: string): string;
/**
 * Extract the script nonce for one response: prefer the `script-src` nonce in
 * the CSP header, fall back to the first `<script nonce="...">` in the HTML.
 * Under `'strict-dynamic'` CSP, 'self'/host allowlists are ignored and ONLY
 * nonce-marked scripts run, so the injected bridge must carry this nonce.
 */
export declare function extractCspNonce(csp: string | undefined, html: string | undefined): string | undefined;
/**
 * Rewrite one HTML body for same-origin serving:
 *  1. every occurrence of the TARGET ORIGIN string becomes the proxy prefix,
 *     so apps that build internal links/API/socket URLs from an embedded
 *     `siteUrl` (Overleaf does exactly this) stay inside the proxy instead of
 *     navigating the iframe to the real site, where X-Frame-Options blocks
 *     the load and clicks appear dead;
 *  2. root-relative attribute references become proxy-rooted;
 *  3. the bridge script (and via it the runtime URL wrappers) is injected,
 *     carrying the response's CSP nonce when one exists ('strict-dynamic'
 *     pages would otherwise block it).
 */
/** Rewrite root-relative resource references inside one HTML body. */
export declare function rewriteHtml(html: string, prefix: string, injectScriptSrc: string | undefined, targetOrigin: string | undefined, cspNonce: string | undefined, wsPort: number): string;
export declare function allowSelfInCsp(value: string, extraOrigins?: string[]): {
    value: string;
    changed: boolean;
};
/** Remove only the framing directives from a Content-Security-Policy value. */
export declare function relaxFrameCsp(value: string): {
    value: string;
    changed: boolean;
};
/** Strip Domain= from one Set-Cookie attribute list (cookie lands host-only). */
export declare function scopeSetCookieToHost(setCookieLine: string): string;
/**
 * Merge two Cookie header strings without duplicated names; later entries win.
 * NOTE: since v0.1.6 the proxy no longer mixes browser and stored cookies for
 * upstream auth requests — the stored credential is sent verbatim when it
 * exists (a browser-side anonymous twin of the session cookie must never be
 * able to override it). This helper remains for tests and external callers.
 */
export declare function mergeCookieHeaders(base: string | undefined, extra: string | undefined): string | undefined;
/**
 * Merge the browser's live cookie jar with the stored login credential.
 * Stored values win for normal/session cookies; a live browser value wins for
 * known routing cookies so an HTTP handshake and its WebSocket upgrade stay on
 * the same upstream worker.
 */
export declare function mergeProxyCookieHeaders(browserCookie: string | undefined, storedCookie: string | undefined): string | undefined;
/** Compute the upstream sub-path (with query) for one matched request URL. */
export declare function subPathOf(rawUrl: string | undefined, prefix: string): string;
/** Give synchronous Overleaf compile calls enough time without weakening every route. */
export declare function requestTimeoutFor(target: URL): number;
/**
 * Extract the user-content origin hint from one proxied HTML body (the meta
 * tag shape used by Overleaf shells; attribute order is not guaranteed).
 */
export declare function extractContentDomainFromHtml(html: string): string | undefined;
/**
 * Extract user-content origin hints from proxied JSON bodies (compile result
 * `pdfDownloadDomain`/`outputUrlPrefix`, cached-output `downloadURL`). Each
 * returned value is a full base URL the frontend prepends to output-file
 * paths, e.g. `https://compiles.overleafusercontent.com/zone/c`.
 */
export declare function extractContentHintsFromJson(jsonText: string): string[];
/** Forward selection of inbound request headers toward one upstream request. */
export declare function buildUpstreamHeaders(req: IncomingMessage, target: URL, extraCookie: string | undefined): http.OutgoingHttpHeaders;
/**
 * One streaming reverse proxy bound to a single upstream origin. Instances are
 * cheap; update the stored credential by assigning `extraCookie`.
 */
export declare class ReverseProxy {
    private readonly target;
    constructor(origin: string);
    /** Cookie header injected into every upstream request (may be undefined). */
    extraCookie: string | undefined;
    /** Bridge script src injected into rewritten HTML bodies (undefined disables). */
    injectScriptSrc: string | undefined;
    /** Loopback origin of the companion WS tunnel port (ws://127.0.0.1:port). */
    wsAllowOrigin: string | undefined;
    /** Port of the companion WS tunnel server (0 until it starts listening). */
    wsPort: number;
    /** User-content output-file origin learned from the site's own hints. */
    private contentRule;
    /**
     * Register a user-content origin hint (e.g. `https://compiles
     * .overleafusercontent.com/zone/c`). The hint with the most specific path
     * prefix learned so far wins, so the zone-precise compile JSON hint
     * survives later origin-only meta tags.
     */
    learnContentHint(value: string): void;
    /**
     * Upstream target for one matched sub-path: the locked main origin, or the
     * learned user-content origin when the path belongs to its zone.
     */
    private targetFor;
    /** Whether the given raw request URL belongs to this proxy. */
    matches(rawUrl: string | undefined): boolean;
    /** Handle one matched proxied HTTP request end-to-end. */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /**
     * Tunnel an upgraded socket (WebSocket) to the same upstream origin. Called
     * through `webServer.registerUpgrade` for the exact pathname(s) the embedded
     * site uses; the handler owns protocol negotiation from here on.
     */
    tunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}
