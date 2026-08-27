/**
 * Service-side helpers for the client half: the root client context captured
 * at apply(), the quote-ref codec registry backing composer chips, and the
 * insert-into-composer routine shared by the selection bridge and panels.
 */
import type { WorkbenchDictionary } from './locales.ts'

/* ------------------------------------------------------------------ */
/* Root context capture                                                */
/* ------------------------------------------------------------------ */

/** Anything (weakly typed) the official client runtime exposes on ctx.get(). */
export interface RootClientContext {
  get(name: string): unknown
  effect(fn: () => unknown, label?: string): unknown
}

let rootCtx: RootClientContext | undefined

/** Capture the root client ctx once, at apply() time. */
export function bindRootContext(ctx: RootClientContext): void {
  rootCtx = ctx
}

export function getRootContext(): RootClientContext | undefined {
  return rootCtx
}

function service<T>(name: string): T | undefined {
  try {
    return rootCtx?.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Quote chip registry (quote-ref trigger source)                      */
/* ------------------------------------------------------------------ */

interface QuoteCodecEntry {
  /** Serialized block pushed to the model on submit. */
  body: string
  /** Clipboard fallback text when the pipeline degrades. */
  clipboardText: string
  /** Raw quoted text for reveal/jump-back. */
  query: string
  /** Which iframe session this quote came from. */
  sessionId: string
  /** Human label shown in the tooltip. */
  label: string
}

const quoteEntries = new Map<string, QuoteCodecEntry>()
let quoteSequence = 0

/**
 * The `inputTriggers` source descriptor for our quote reference family.
 * Registered with an empty candidate list so it never pollutes menus; only
 * its codec participates in submit-time serialization of occurrences we
 * inserted ourselves through `input.insertReference`.
 */
export function quoteRefSourceDescriptor(): Record<string, unknown> {
  return {
    trigger: '@',
    name: 'quote-ref',
    order: 120,
    candidates: async () => [],
    onPick: () => undefined,
    codec: {
      clipboardText: (ref: string) => quoteEntries.get(ref)?.clipboardText ?? '',
      serialize: async (ref: string) => quoteEntries.get(ref)?.body ?? '',
    },
  } satisfies Record<string, unknown>
}

/** True when the inputTriggers reference pipeline is present. */
export function quotePipelineAvailable(): boolean {
  const triggers = service<{ registerSource?: unknown }>('inputTriggers')
  return triggers !== undefined && typeof triggers.registerSource === 'function'
}

/* ------------------------------------------------------------------ */
/* Composer insertion                                                  */
/* ------------------------------------------------------------------ */

export interface InsertQuoteResult {
  ok: boolean
  kind: 'chip' | 'text' | 'failed'
  refLabel?: string | undefined
  message: string
}

/**
 * Insert one quoted selection into a session's composer draft. Prefers the
 * official occurrence pipeline (`conversation.input.for(actx).insertReference`)
 * and falls back to plain block-quote text otherwise. Mirrors the flow proven
 * by dsh-quote-annotate (MIT).
 */
export function insertQuoteIntoComposer(sessionId: string, rawText: string): InsertQuoteResult {
  try {
    const trimmed = rawText.trim()
    if (trimmed === '') {
      return { ok: false, kind: 'failed', message: 'empty selection' }
    }
    const conversation = service<{
      input?: { for(actx: unknown): InputFaceLike }
    }>('conversation') as { input?: { for(actx: unknown): InputFaceLike } } | undefined
    const sessions = service<{
      binding?(sessionId: string): { ctx?: unknown } | undefined
      scope?(sessionId: string): unknown
    }>('sessions') as {
      binding?(sessionId: string): { ctx?: unknown } | undefined
      scope?(sessionId: string): unknown
    } | undefined
    if (conversation === undefined || sessions === undefined) {
      return { ok: false, kind: 'failed', message: 'conversation/sessions services unavailable' }
    }
    const bindingCtx = sessions.binding !== undefined ? sessions.binding(sessionId)?.ctx : undefined
    const actx = bindingCtx !== undefined && bindingCtx !== null ? bindingCtx : sessions.scope?.(sessionId)
    if (actx === undefined || actx === null || conversation.input === undefined) {
      return { ok: false, kind: 'failed', message: 'session scope unavailable' }
    }
    const input = conversation.input.for(actx)
    const state = input.state.getSnapshot()
    const rawDraft = typeof state.draft === 'string' ? state.draft : ''
    const baseDraft = rawDraft.replace(/[\s\u00A0]+$/, '')
    const quotedBody = trimmed.split('\n').map(line => `> ${line}`).join('\n')
    const tail = ''

    const triggers = service<{ registerSource?: unknown }>('inputTriggers')
    const insertReference = typeof (input as InputFaceLike).insertReference === 'function'
      ? (input as InputFaceLike & { insertReference: NonNullable<InputFaceLike['insertReference']> }).insertReference
      : undefined
    const canChip = triggers !== undefined
      && typeof triggers.registerSource === 'function'
      && insertReference !== undefined
    if (canChip && insertReference !== undefined) {
      quoteSequence += 1
      const ref = `ow${quoteSequence}`
      const label = `引用#${quoteSequence}`
      quoteEntries.set(ref, {
        body: quotedBody,
        clipboardText: quotedBody,
        query: trimmed,
        sessionId,
        label,
      })
      if (quoteEntries.size > 200) {
        const oldest = quoteEntries.keys().next().value
        if (oldest !== undefined) quoteEntries.delete(oldest)
      }
      const span = { start: rawDraft.length, end: rawDraft.length, draftRev: state.draftRev }
      const applied = insertReference.call(
        input,
        { source: 'quote-ref', ref, label, clipboardText: quotedBody },
        span,
      )
      if (applied !== false && applied !== undefined) {
        return { ok: true, kind: 'chip', refLabel: label, message: 'inserted via reference pipeline' }
      }
      quoteEntries.delete(ref)
    }
    // Plain-text fallback replaces the whole draft with the composed message.
    const nextDraft = baseDraft === '' ? `${quotedBody}${tail}` : `${baseDraft}\n\n${quotedBody}${tail}`
    input.setDraft(nextDraft)
    return { ok: true, kind: 'text', message: 'inserted as plain-text quote' }
  } catch (error) {
    return {
      ok: false,
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

interface InputStateSnapshotLike {
  draft: unknown
  draftRev?: unknown
}

interface InputFaceLike {
  state: { getSnapshot(): InputStateSnapshotLike }
  setDraft(draft: string): unknown
  insertReference?(
    payload: { source: string; ref: string; label: string; clipboardText: string },
    span: { start: number; end: number; draftRev: unknown },
  ): unknown
}

/** Resolve the most recent assistant reply text (for cursor-insert assist). */
export function latestAssistantText(sessionId: string): string | undefined {
  try {
    const sessions = service<{ list?: { getSnapshot(): { byId?: Record<string, SessionRowLike> } } }>('sessions')
    // Fallback-free path: read from DOM-less store shapes is unreliable; leave
    // to future versions once the chat projection contract is public. v1 ships
    // template + paste + selection-scope inserts instead.
    void sessions
    void sessionId
    return undefined
  } catch {
    return undefined
  }
}

interface SessionRowLike {
  cwd?: unknown
}

/** Best-effort workspace path of a session (shown as a toolbar hint). */
export function sessionWorkspaceHint(sessionId: string): string | undefined {
  try {
    const sessions = service<{ list?: { getSnapshot(): { byId?: Record<string, SessionRowLike> } } }>('sessions')
    const row = sessions?.list?.getSnapshot()?.byId?.[sessionId]
    const cwd = row?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Localized translate function alias (bound at apply time). */
export type Translate = ((key: keyof WorkbenchDictionary | string, params?: Record<string, string>) => string)

let translateFn: Translate = key => String(key)

/** Install the locale-bound translate helper. */
export function bindTranslate(t: Translate): void {
  translateFn = t
}

export function t(): Translate {
  return translateFn
}
