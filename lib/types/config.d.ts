/**
 * Host plugin configuration schema. Every field is deployment-overridable from
 * the profile row (cordis.patch.yml / plugin settings page); credentials never
 * appear here.
 */
import z from '@deepseek-ai/schemastery';
/** Browser choices for the direct-CDP login window. */
export type OverleafBrowserChannel = 'auto' | 'default' | 'msedge' | 'chrome' | 'real';
/** How the login browser profile persists between login attempts. */
export type LoginProfileMode = 'persistent' | 'temporary';
/** Declared config shape; every field optional so defaults apply. */
export interface WorkbenchConfig {
    /** Upstream Overleaf origin (public cloud or self-hosted such as tex.nju.edu.cn). */
    baseUrl?: string;
    /** Browser selection for the CDP login window. */
    browserChannel?: OverleafBrowserChannel;
    /** Explicit Chromium-family executable tried first (third-party browsers). */
    browserPath?: string;
    /** Proxy for the CDP login browser (e.g. Clash: http://127.0.0.1:7890); empty = system default. */
    loginProxyServer?: string;
    /** Login wait timeout in milliseconds before falling back to manual paste. */
    loginTimeoutMs?: number;
    /** Login profile persistence mode. */
    loginProfile?: LoginProfileMode;
    /** Show the floating selection-quote toolbar over the embedded editor (R5). */
    selectionQuoteEnabled?: boolean;
    /** Accept cursor-insert commands inside the embedded editor (R6). */
    cursorInsertEnabled?: boolean;
    /** Inject the bridge script into proxied HTML pages. */
    injectScriptEnabled?: boolean;
    /** Show the assist panel (insert templates, outline, status) in the view (R7). */
    assistPanelEnabled?: boolean;
}
export declare const Config: z<WorkbenchConfig>;
/** Parsed config with every default applied. */
export interface ResolvedConfig {
    baseUrl: string;
    browserChannel: OverleafBrowserChannel;
    browserPath?: string;
    loginProxyServer?: string;
    loginTimeoutMs: number;
    loginProfile: LoginProfileMode;
    selectionQuoteEnabled: boolean;
    cursorInsertEnabled: boolean;
    injectScriptEnabled: boolean;
    assistPanelEnabled: boolean;
}
/** Apply defaults in the owning implementation, never hidden inside methods. */
export declare function resolveConfig(config: WorkbenchConfig): ResolvedConfig;
/**
 * Normalize a user-supplied proxy server string into the form Chromium's
 * --proxy-server flag accepts (mirrors the dsh-browser helper): a bare port
 * becomes a loopback HTTP proxy, scheme-less host:port gains http://, and
 * full scheme URLs pass through. Empty/invalid yields undefined so the flag
 * is omitted entirely (system VPN / direct).
 */
export declare function normalizeProxyServer(raw: string | undefined): string | undefined;
/**
 * Normalize one configured origin: add https:// when scheme-less, trim
 * trailing slashes, reject anything carrying a path/query/hash. Used instead
 * of URL parsing failures to keep a bad entry from blocking service startup —
 * falls back to the default upstream.
 */
export declare function normalizeOrigin(raw: string): string;
