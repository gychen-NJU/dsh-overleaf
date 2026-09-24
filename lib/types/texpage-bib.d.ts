/** TeXPage bibliography adapter; legacy Overleaf keeps its own lifecycle. */
type BibView = {
    state: {
        doc: {
            toString(): string;
        };
    };
    dispatch(spec: {
        changes: {
            from: number;
            to: number;
            insert: string;
        };
        selection: {
            anchor: number;
        };
    }): void;
    focus(): void;
};
type BibEnvironment = {
    fetch: typeof fetch;
    editor(): {
        engine?: string;
        editor?: BibView;
        error?: string;
    };
    report(message: Record<string, unknown>): void;
};
/** Self-contained: serialized into the bridge after TypeScript compilation. */
export declare function createTexpageBibAdapter(env: BibEnvironment): {
    enabled: () => boolean;
    observe: (rawUrl: string, json: unknown) => void;
    sync: (name: string, content: string) => Promise<void>;
};
export declare function renderTexpageBibAdapter(): string;
export {};
