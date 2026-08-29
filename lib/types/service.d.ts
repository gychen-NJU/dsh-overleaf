/**
 * dsh-overleaf host half: the Cordis Service mounted as the `overleaf-workbench`
 * row of a web profile. Owns:
 *  - `/overleaf-proxy/*` same-origin reverse proxy (HTTP prefix route) plus
 *    exact WebSocket upgrade routes for socket.io;
 *  - `/overleaf/workbench/*` JSON routes (status, login, cookie, logout,
 *    projects) and the bridge script asset;
 *  - the stored session-cookie credential feeding both.
 *
 * Route prefixes are deliberately disjoint from dsh-better-overleaf's
 * `/overleaf/*` surface so the two plugins can coexist in one profile.
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
import type { ResolvedConfig, WorkbenchConfig } from './config.ts';
import type { WorkbenchLoginResult, WorkbenchProject, WorkbenchStatus } from './types.ts';
/** Stable Cordis plugin name (the patch row `name:` must match package.json). */
export declare const name = "overleaf-workbench";
/**
 * Fixed workspace filename the agent is asked to write its final insert
 * content into (see the AI-write flow). MUST match the constant in
 * src/client/view.tsx. Reads are restricted to exactly this filename.
 */
export declare const INSERT_FILE_NAME = "dsh-overleaf-insert.md";
/**
 * Fixed workspace filename the agent writes its compile-fix edit list into
 * (see the compile-fix panel flow). MUST match the constant in
 * src/client/view.tsx; reads are restricted to exactly this filename.
 */
export declare const FIX_FILE_NAME = "dsh-overleaf-fix.md";
/** Services required before the host plugin can mount. */
export declare const inject: string[];
export { Config };
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Embedded Overleaf workbench service provided by this host plugin. */
        overleafWorkbench: OverleafWorkbenchService;
    }
}
/** The `ctx.overleafWorkbench` service. */
export declare class OverleafWorkbenchService extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<WorkbenchConfig>;
    /** Mutable because live settings updates swap it wholesale. */
    private config;
    private proxy;
    private readonly bridgeScript;
    /** Background CDP login bookkeeping (client polls /login-status). */
    private loginRunning;
    private loginStartedAt;
    private loginResult;
    private loginError;
    constructor(ctx: Context, config: WorkbenchConfig);
    /**
     * Companion WS tunnel on its OWN loopback port. The DSH webserver's upgrade
     * registry is exact-path-only and socket.io's upgrade paths carry dynamic
     * session ids (`/socket.io/<sid>/websocket/<t>`), which can never match.
     * The bridge redirects the embedded site's WebSocket connections to this
     * port, where every upgrade path is tunneled verbatim to the upstream.
     */
    private startWsTunnel;
    /** Port of the companion WS tunnel (0 until listening; tests may read it). */
    get wsTunnelPort(): number;
    private destroySafely;
    /** Base layer handed to the settings service (the composed mount config). */
    private readonly mountBaseConfig;
    /**
     * Publish the `dsh-overleaf` settings namespace so the Plugins settings page
     * can own baseUrl/feature toggles without hand-editing the profile row.
     * Composed patch values become the namespace `base`; user edits layer above
     * them. Live changes hot-swap the proxy target — no restart required. The
     * whole feature degrades silently when the profile runs no settings service.
     */
    private registerSettingsNamespace;
    /** Swap runtime behavior after a settings commit (hot reload of the proxy). */
    private applyRuntimeConfig;
    /** Push the latest stored cookie into the proxy (re-read on every change). */
    private refreshCredential;
    /** Register one exact JSON route with the shared envelope contract. */
    private route;
    private registerRoutes;
    /** Read current account state plus embed descriptors for the toolbar. */
    status(): Promise<WorkbenchStatus & {
        assistPanelEnabled?: boolean;
    }>;
    /** Log in through direct CDP against the configured upstream origin. */
    login(browserChannel?: ResolvedConfig['browserChannel'], browserPath?: string): Promise<WorkbenchLoginResult>;
    /**
     * Store a cookie header line after a tolerant upstream check. The check
     * accepts standard Overleaf (200 on /project) and TeXPage-style deployments
     * (dashboard redirect away from /login); see cookie-validate.ts.
     */
    saveCookie(cookie: string): Promise<void>;
    /** List projects through dashboard JSON APIs, falling back to HTML scraping. */
    listProjects(signal?: AbortSignal): Promise<WorkbenchProject[]>;
}
/** Scrape `<a href="/project/<24hex>">` rows out of a dashboard HTML page. */
export declare function projectsFromDashboardHtml(html: string): WorkbenchProject[];
export default OverleafWorkbenchService;
