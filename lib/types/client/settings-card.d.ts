import type { ReactNode } from 'react';
/**
 * Structural face we rely on for the settings binding. Two harness
 * generations feed it:
 *  - pre-0.1.7 `settingsScope.bind({ namespace })` scopes: snapshot + watch();
 *  - 0.1.7+ `ctx.configForms.get(entryId)` ConfigForms: snapshot + subscribe().
 * Both expose value/base/user/revision/writable and set/unset, so the card
 * only has to bridge the notification method (watch vs subscribe).
 */
export interface ScopeFace {
    getSnapshot(): {
        status?: string | undefined;
        value?: Record<string, unknown> | undefined;
        base?: Record<string, unknown> | undefined;
        user?: Record<string, unknown> | undefined;
        revision?: number | undefined;
        writable?: boolean | undefined;
        mode?: unknown;
    };
    get?(field: string): unknown;
    watch?(listener: () => void): () => void;
    /** ConfigForms (0.1.7+) notification method. */
    subscribe?(listener: () => void): () => void;
    set(field: string, value: unknown): Promise<unknown>;
    unset?(field: string): Promise<unknown>;
}
export interface OverleafSettingsCardProps {
    /** Bound scope supplied by the slot inject() closure. */
    scope?: ScopeFace | undefined;
    /** Translate helper injected through the slot locale seat. */
    t?: (key: string, params?: Record<string, string>) => string;
}
/** Minimal staged-form settings card. */
export declare function OverleafSettingsCard(props: OverleafSettingsCardProps): ReactNode;
