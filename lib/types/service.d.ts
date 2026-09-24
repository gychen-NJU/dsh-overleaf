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
/** Discover UTF-8 BibTeX candidates inside one trusted DSH workspace. */
export declare function discoverWorkspaceBibFiles(cwd: string): Promise<string[]>;
/** Resolve and read one explicit .bib, refusing traversal and symlink escapes. */
export declare function readLocalBibFile(cwd: string, requestedPath: string): Promise<{
    path: string;
    name: string;
    content: string;
    mtimeMs: number;
    size: number;
}>;
/** Discover local LaTeX sources without following directory symlinks. */
export declare function discoverWorkspaceTexFiles(cwd: string): Promise<string[]>;
/** Read one workspace .tex for the explicitly confirmed reverse direction. */
export declare function readLocalTexFile(cwd: string, requestedPath: string, fallbackName?: string): Promise<{
    path: string;
    name: string;
    content: string;
    mtimeMs: number;
    size: number;
}>;
/**
 * Write an Overleaf source snapshot into the workspace and verify the exact
 * UTF-8 content. On a failed write/readback, restore the previous file (or
 * remove the newly-created partial file) before reporting failure.
 */
export declare function writeLocalTexFile(cwd: string, requestedPath: string, fallbackName: string, content: string): Promise<{
    path: string;
    name: string;
    mtimeMs: number;
    size: number;
    created: boolean;
    unchanged: boolean;
}>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Embedded Overleaf workbench service provided by this host plugin. */
        overleafWorkbench: OverleafWorkbenchService;
    }
}
/** The `ctx.overleafWorkbench` service. */
export declare class OverleafWorkbenchService extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        baseUrl: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        browserChannel: import("@deepseek-ai/schemastery").default<"auto" | "default" | "msedge" | "chrome" | "real", "auto" | "default" | "msedge" | "chrome" | "real", "volatile-defined">;
        browserPath: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        loginProxyServer: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        loginTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        loginProfile: import("@deepseek-ai/schemastery").default<"persistent" | "temporary", "persistent" | "temporary", "volatile-defined">;
        selectionQuoteEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        cursorInsertEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        injectScriptEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        assistPanelEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        baseUrl: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        browserChannel: import("@deepseek-ai/schemastery").default<"auto" | "default" | "msedge" | "chrome" | "real", "auto" | "default" | "msedge" | "chrome" | "real", "volatile-defined">;
        browserPath: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        loginProxyServer: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        loginTimeoutMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        loginProfile: import("@deepseek-ai/schemastery").default<"persistent" | "temporary", "persistent" | "temporary", "volatile-defined">;
        selectionQuoteEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        cursorInsertEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        injectScriptEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        assistPanelEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    }>>, "plain">;
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
    /** Resolve the workspace from server-owned session metadata, never client input. */
    private workspaceForPayload;
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
    /**
     * The loader-resolved config container. Its `.volatile()` fields are live
     * references (`{ get() }`) that the Loader mutates in place, so re-resolving
     * this same object always yields the current values.
     */
    private readonly rawConfig;
    /**
     * DSH 0.1.7+ settings integration.
     *
     * The Loader projects a plugin's Config into the settings forms, but ONLY its
     * `.volatile()` fields: `dsh-settings`' `volatileForm()` returns undefined for
     * a schema without one, after which `describe()` omits the entry entirely and
     * no client page or transport write can address it. With volatile fields
     * present, a save commits those references in place and the Loader emits
     * `loader/volatile-update` on this fiber instead of remounting the plugin —
     * that event is the cue to re-resolve and hot-swap the proxy, so baseUrl and
     * feature edits apply without a restart.
     *
     * `configure({ auto: false })` declares that this plugin ships its own page
     * (the client half registers into the Plugins page's keyed seats), which
     * suppresses any schema-generated page. Everything here degrades silently on
     * harness generations without these services.
     */
    private registerSettingsIntegration;
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
