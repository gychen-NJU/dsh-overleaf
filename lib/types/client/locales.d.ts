/**
 * Locale dictionaries for the dsh-overleaf workbench (zh keys are canonical;
 * en mirrors every key). Registered through ctx.locale.register(NS, {zh, en}).
 */
export type WorkbenchDictionary = Record<string, string>;
export declare const LOCALE_NS = "dsh-overleaf";
export declare const ZH_DICTIONARY: WorkbenchDictionary;
export declare const EN_DICTIONARY: WorkbenchDictionary;
