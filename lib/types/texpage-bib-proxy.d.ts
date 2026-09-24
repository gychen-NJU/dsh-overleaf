/** Bounded bibliography readback, separate from authenticated site forwarding. */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
export declare const BIB_PROXY_PATH = "/__dsh_texpage_bib__";
type BibTarget = {
    download: URL;
    objectPath: string;
};
/** No arbitrary URL, path or header supplied by the client crosses origins. */
export declare function resolveTexpageBibTarget(subPath: string, site: URL, fileOrigin?: URL): BibTarget | undefined;
export declare function resolveTexpageBibRedirect(raw: string, target: BibTarget): URL | undefined;
/** One authenticated request to the configured site, at most one credential-free
 * signed-object read. No redirects, cookies or signed URLs are returned/logged. */
export declare function serveTexpageBib(req: IncomingMessage, res: ServerResponse, target: BibTarget, siteHeaders: OutgoingHttpHeaders, request?: typeof fetch): Promise<void>;
export {};
