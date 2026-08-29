export { buildFixCompilePrompt, buildSelectionAgentPrompt, cleanAgentInsertContent, insertFileSignature, parseCompileLog, parseFixEdits, FIX_EDIT_START, FIX_OLD, FIX_NEW, FIX_END, } from './ai-output.ts';
/** Client module display name (shown in diagnostics). */
export declare const name = "dsh-overleaf";
/** Services that must exist before apply() runs. */
export declare const inject: string[];
interface RootLike {
    get(serviceName: string): unknown;
    effect(execute: () => unknown, label?: string): unknown;
    /** Optional declarative service waiting: pending forever when absent. */
    inject?(services: string[], callback: (childCtx: never) => void): unknown;
}
/**
 * Activate the client half:
 *  - register zh/en dictionaries;
 *  - publish the quote-ref trigger source feeding composer chips;
 *  - mount the "Overleaf" conversation view tab (order 30, after chat /
 *    trajectory / context).
 */
export declare function apply(ctx: RootLike): void;
