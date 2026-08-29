import type { ReactNode } from 'react';
/** Structural face we rely on from settingsScope.bind({namespace}). */
export interface ScopeFace {
    getSnapshot(): {
        value?: Record<string, unknown>;
        base?: Record<string, unknown>;
        user?: Record<string, unknown>;
        revision?: number;
        writable?: boolean;
        mode?: unknown;
    };
    get?(field: string): unknown;
    watch?(listener: () => void): () => void;
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
