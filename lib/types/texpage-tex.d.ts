/** TeXPage current-document adapter; public/self-hosted Overleaf keeps its legacy path. */
type TexView = {
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
type TexEnvironment = {
    fetch: typeof fetch;
    editor(): {
        engine?: string;
        editor?: TexView;
        error?: string;
    };
    report(message: Record<string, unknown>): void;
};
/** Self-contained: serialized into the document-start bridge. */
export declare function createTexpageTexAdapter(env: TexEnvironment): {
    enabled: () => boolean;
    observe: (rawUrl: string, json: unknown) => void;
    emit: (requestId: string) => void;
    sync: (content: string, confirmed: boolean, requestId: string, expectedDocId: string, expectedRevision: string) => Promise<void>;
};
export declare function renderTexpageTexAdapter(): string;
export {};
