/**
 * Service-side helpers for the client half: the root client context captured
 * at apply(), the quote-ref codec registry backing composer chips, and the
 * insert-into-composer routine shared by the selection bridge and panels.
 */
import type { WorkbenchDictionary } from './locales.ts';
/** Anything (weakly typed) the official client runtime exposes on ctx.get(). */
export interface RootClientContext {
    get(name: string): unknown;
    effect(fn: () => unknown, label?: string): unknown;
}
/** Capture the root client ctx once, at apply() time. */
export declare function bindRootContext(ctx: RootClientContext): void;
export declare function getRootContext(): RootClientContext | undefined;
/**
 * The `inputTriggers` source descriptor for our quote reference family.
 * Registered with an empty candidate list so it never pollutes menus; only
 * its codec participates in submit-time serialization of occurrences we
 * inserted ourselves through `input.insertReference`.
 */
export declare function quoteRefSourceDescriptor(): Record<string, unknown>;
/** True when the inputTriggers reference pipeline is present. */
export declare function quotePipelineAvailable(): boolean;
export interface InsertQuoteResult {
    ok: boolean;
    kind: 'chip' | 'text' | 'failed';
    refLabel?: string | undefined;
    message: string;
}
/**
 * Insert one quoted selection into a session's composer draft. Prefers the
 * official occurrence pipeline (`conversation.input.for(actx).insertReference`)
 * and falls back to plain block-quote text otherwise. Mirrors the flow proven
 * by dsh-quote-annotate (MIT).
 */
export declare function insertQuoteIntoComposer(sessionId: string, rawText: string): InsertQuoteResult;
/** Resolve the most recent assistant reply text (for cursor-insert assist). */
export declare function latestAssistantText(sessionId: string): string | undefined;
/** Best-effort workspace path of a session (shown as a toolbar hint). */
export declare function sessionWorkspaceHint(sessionId: string): string | undefined;
/** Localized translate function alias (bound at apply time). */
export type Translate = ((key: keyof WorkbenchDictionary | string, params?: Record<string, string>) => string);
/** Install the locale-bound translate helper. */
export declare function bindTranslate(t: Translate): void;
export declare function t(): Translate;
