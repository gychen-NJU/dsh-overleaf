/** Narrow compatibility shim for TeXPage's root-bound console router. */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Only the fixed public CDN's console and socket bundles are proxied. */
export declare function texpageAssetUrl(subPath: string): URL | undefined;
export declare function rewriteTexpageScriptTags(html: string, prefix: string): string;
/** BrowserRouter otherwise renders null at /overleaf-proxy/console, without errors. */
export declare function rewriteTexpageConsoleScript(script: string, prefix: string): string;
/**
 * Repair the URL before Socket.IO parses it into an origin AND a namespace.
 * Rewriting only the eventual WebSocket URL leaves a poisoned namespace in
 * CONNECT frames. Match the observed private webpack module, never arbitrary
 * uses of location.protocol or Socket.IO's protocol implementation.
 */
export declare function rewriteTexpageDesktopSocketScript(script: string): string;
/** Bounded public-asset fetch. Never forward the user's cookies or other headers. */
export declare function serveTexpageConsoleAsset(req: IncomingMessage, res: ServerResponse, url: URL, prefix: string): Promise<void>;
