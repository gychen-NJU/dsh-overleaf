/** Snapshot returned by the fixed workspace handoff-file route. */
export interface InsertFileSnapshot {
    exists: boolean;
    content?: string | undefined;
    mtimeMs?: number | undefined;
}
/**
 * Stable identity for one handoff-file revision. Including mtime lets a new
 * agent run intentionally return the same LaTeX text as an earlier run.
 */
export declare function insertFileSignature(snapshot: InsertFileSnapshot): string;
/**
 * Remove presentation wrappers while preserving the LaTeX payload exactly.
 * The prompt asks for a plain file, but agents occasionally still wrap the
 * whole answer in a Markdown `latex`/`tex` code fence.
 */
export declare function cleanAgentInsertContent(raw: string): string;
export type SelectionAgentMode = 'ask' | 'modify';
/** Build the explicit prompt used by the selected-text assist workflow. */
export declare function buildSelectionAgentPrompt(mode: SelectionAgentMode, instruction: string, selectedText: string): string;
/** One best-effort entry extracted from raw compile output (display only). */
export interface CompileLogItem {
    level: 'error' | 'warning';
    message: string;
    file?: string | undefined;
    line?: string | undefined;
}
/**
 * Best-effort error/warning extraction from raw LaTeX compile output. Used
 * only for the panel summary; the agent always receives the raw log text.
 * Recognised shapes: `! LaTeX Error: ...` (+ following `l.NNN`), `file:line:
 * message`, and warning lines (LaTeX/Package/Class/Module warning, Over/Under
 * full box, undefined Citation/Reference).
 */
export declare function parseCompileLog(text: string): {
    items: CompileLogItem[];
    errors: number;
    warnings: number;
};
/** Markers delimit one edit block inside dsh-overleaf-fix.md. */
export declare const FIX_EDIT_START = "@@DSH-FIX-EDIT@@";
export declare const FIX_OLD = "@@OLD@@";
export declare const FIX_NEW = "@@NEW@@";
export declare const FIX_END = "@@END@@";
export interface FixEdit {
    old: string;
    new: string;
    file?: string | undefined;
}
export interface FixEditParse {
    ok: boolean;
    edits: FixEdit[];
    /** Non-edit payload the agent left behind (REMARK / NO_FIX explanation). */
    remark?: string | undefined;
}
/** Render the documentation block embedded in the fix prompt. */
export declare function fixEditFormatExample(): string;
/**
 * Parse the agent's edit list from dsh-overleaf-fix.md. Every block must
 * carry old/new; a block whose `old` is empty is skipped. A file carrying no
 * recognizable block is returned as ok:false with its trimmed content as
 * remark (typically `REMARK: ...`).
 */
export declare function parseFixEdits(raw: string): FixEditParse;
/** Cap rough prompt payload sizes (conservative for long manuscripts). */
export declare const FIX_MAX_LOG_CHARS = 120000;
export declare const FIX_MAX_DOC_CHARS = 120000;
/** Build the explicit prompt for the compile-error auto-fix workflow. */
export declare function buildFixCompilePrompt(input: {
    logText: string;
    docText: string;
    docName: string;
    errors: number;
    warnings: number;
}): string;
