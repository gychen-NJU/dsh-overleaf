import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const OUTPUT_PROXY_PATH = "/__dsh_texpage_output__";
/** The fixed latexFile host is trusted only alongside validated same-site socket metadata. */
export declare function extractTexpageOutputOrigin(html: string, pageOrigin: string | URL): URL | undefined;
/** Resolve ONLY the marker + literal PDF/log path; never decode/rebuild a signed query. */
export declare function resolveTexpageOutputTarget(subPath: string, outputOrigin: URL | undefined): URL | undefined;
/**
 * Stream without fetch's decompression or the generic authenticated proxy helpers.
 * No input body, cookies, auth, Origin or Referer cross this boundary. Redirects
 * are rejected, never followed or returned. Errors never include the signed URL.
 */
export declare function serveTexpageOutput(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void>;
