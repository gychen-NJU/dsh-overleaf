/** Strict, data-only routing for TeXPage's separate Socket.IO origin. */
export declare const SOCKET_PROXY_PATH = "/__dsh_socket__";
/**
 * Read one inline window._domainConf = { JSON } assignment, never executing JS.
 * This only parses bounded data; callers must validate the fields they trust.
 * Multiple assignments (including across scripts) fail closed.
 */
export declare function readTexpageDomainConfig(html: string): Record<string, unknown> | undefined;
/** Trust only the exact socket.<page hostname without leading www.> authority. */
export declare function extractTexpageSocketOrigin(html: string, pageOrigin: string | URL): URL | undefined;
/**
 * Resolve an already prefix-stripped marker path against a validated origin.
 * Only these three literal paths are supported. Queries are copied byte-for-
 * byte; no decoding, path normalization, redirects or caller-chosen authority.
 */
export declare function resolveTexpageSocketTarget(subPath: string, socketOrigin: URL | undefined): URL | undefined;
