/** Product-neutral entry: let the upstream redirect / to its own dashboard. */
export declare const WORKBENCH_HOME = "/overleaf-proxy/";
export declare const WORKBENCH_SETTINGS_CHANGED = "dsh-overleaf:settings-changed";
export declare function workbenchEntry(embedUrl?: string): string;
interface WorkbenchFrame {
    src: string;
    dataset: {
        upstreamOrigin?: string;
    };
}
export declare function navigateToWorkbenchHome(frame: WorkbenchFrame | null, embedUrl?: string): void;
/** Preserve an open project on tab switches, but never on upstream switches. */
export declare function updateFrameUpstream(frame: WorkbenchFrame, origin: string, embedUrl?: string): boolean;
export {};
