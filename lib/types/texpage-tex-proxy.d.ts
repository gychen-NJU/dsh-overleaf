/** Bounded TeX source readback, isolated from authenticated site forwarding. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
export declare const TEX_PROXY_PATH = "/__dsh_texpage_tex__";
type TexTarget = {
    download: URL;
    objectPath: string;
};
/** No arbitrary URL, path or header supplied by the client crosses origins. */
export declare function resolveTexpageTexTarget(subPath: string, site: URL, fileOrigin?: URL): TexTarget | undefined;
export declare function resolveTexpageTexRedirect(raw: string, target: TexTarget): URL | undefined;
/** One authenticated request to the configured site, then at most one
 * credential-free signed-object read. Redirects and signed URLs never escape. */
export declare function serveTexpageTex(req: IncomingMessage, res: ServerResponse, target: TexTarget, siteHeaders: OutgoingHttpHeaders, request?: typeof fetch): Promise<void>;
export {};
