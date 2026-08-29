/** Client-half shared helpers: route POSTs with the shared wire envelope. */
export interface WireEnvelope<T> {
    ok: boolean;
    value?: T;
    error?: {
        code: string;
        message: string;
    };
}
/** POST one bounded JSON payload to a workbench host route. */
export declare function postWorkbench<T>(path: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
export interface WorkbenchStatusWire {
    loggedIn: boolean;
    baseUrl: string;
    embedUrl: string;
    proxyReady: boolean;
    assistPanelEnabled?: boolean | undefined;
}
export interface LoginResultWire {
    kind: 'automatic' | 'manual';
    loginUrl?: string | undefined;
    instructions?: string | undefined;
}
/** Response of /overleaf/workbench/login-status. */
export interface LoginStatusWire {
    running: boolean;
    elapsedMs: number;
    result?: LoginResultWire | undefined;
    error?: string | undefined;
}
export interface EmbedInfo {
    baseUrl: string;
    embedUrl: string;
    selectionQuoteEnabled: boolean;
    cursorInsertEnabled: boolean;
    assistPanelEnabled: boolean;
}
