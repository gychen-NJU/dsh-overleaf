/** Narrow compatibility shim for TeXPage's root-bound console router. */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Only this fixed public CDN's console bundle is proxied, never arbitrary URLs. */
export declare function texpageAssetUrl(subPath: string): URL | undefined;
export declare function rewriteTexpageScriptTags(html: string, prefix: string): string;
/** BrowserRouter otherwise renders null at /overleaf-proxy/console, without errors. */
export declare function rewriteTexpageConsoleScript(script: string, prefix: string): string;
/** Bounded public-asset fetch. Never forward the user's cookies or other headers. */
export declare function serveTexpageConsoleAsset(req: IncomingMessage, res: ServerResponse, url: URL, prefix: string): Promise<void>;
