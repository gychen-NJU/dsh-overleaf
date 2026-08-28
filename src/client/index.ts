/**
 * dsh-overleaf client half entry. Registered by the host bundle loader through
 * `window.__ModuleLoader__.load({ id: 'dsh-overleaf', factory })` (the module
 * id must equal the npm package name); Cordis calls `apply(ctx)` on
 * activation. Everything degrades silently when a service is missing — a
 * broken integration must never take the GUI down.
 */
import { createElement } from 'react'
import { OverleafView } from './view.tsx'
import { OverleafSettingsCard } from './settings-card.tsx'
import { LOCALE_NS, ZH_DICTIONARY, EN_DICTIONARY } from './locales.ts'
import type { WorkbenchDictionary } from './locales.ts'
import { bindRootContext, quoteRefSourceDescriptor, bindTranslate } from './workbench.ts'

export {
  buildFixCompilePrompt, buildSelectionAgentPrompt, cleanAgentInsertContent, insertFileSignature,
  parseCompileLog, parseFixEdits, FIX_EDIT_START, FIX_OLD, FIX_NEW, FIX_END,
} from './ai-output.ts'

/** Client module display name (shown in diagnostics). */
export const name = 'dsh-overleaf'

/** Services that must exist before apply() runs. */
export const inject = ['slots', 'locale']

interface RootLike {
  get(serviceName: string): unknown
  effect(execute: () => unknown, label?: string): unknown
  /** Optional declarative service waiting: pending forever when absent. */
  inject?(services: string[], callback: (childCtx: never) => void): unknown
}

interface SlotsFace {
  inject(slotName: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

type LocaleTranslate = (key: keyof WorkbenchDictionary | string, params?: Record<string, unknown>) => string

/**
 * Activate the client half:
 *  - register zh/en dictionaries;
 *  - publish the quote-ref trigger source feeding composer chips;
 *  - mount the "Overleaf" conversation view tab (order 30, after chat /
 *    trajectory / context).
 */
export function apply(ctx: RootLike): void {
  try {
    bindRootContext(ctx as never)
    const slots = ctx.get('slots') as SlotsFace | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      console.warn('[dsh-overleaf] slots service unavailable; Overleaf tab not registered')
      return
    }
    const locale = ctx.get('locale') as {
      register?(ns: string, dict: { zh: WorkbenchDictionary; en: WorkbenchDictionary }): unknown
      bind?(ns: string): LocaleTranslate | ((key: string) => string)
    } | undefined
    if (locale?.register !== undefined) {
      ctx.effect(
        () => locale.register?.(LOCALE_NS, { zh: ZH_DICTIONARY, en: EN_DICTIONARY }),
        'dsh-overleaf: dictionaries',
      )
    }
    const rawT = locale?.bind?.(LOCALE_NS) ?? ((key: string) => key)
    bindTranslate(rawT as unknown as Parameters<typeof bindTranslate>[0])

    // Quote pipeline source: empty candidates keep menus clean; only the codec
    // participates, expanding occurrences we inserted ourselves.
    const inputTriggers = ctx.get('inputTriggers') as { registerSource?: (src: Record<string, unknown>) => () => void } | undefined
    if (inputTriggers !== undefined && typeof inputTriggers.registerSource === 'function') {
      ctx.effect(() => inputTriggers.registerSource?.(quoteRefSourceDescriptor()), 'dsh-overleaf: quote-ref source')
    } else {
      console.info('[dsh-overleaf] inputTriggers unavailable; quotes degrade to plain text')
    }

    slots.inject('conversation.view', () => slots.register({
      name: 'conversation.view',
      id: 'overleaf',
      order: 30,
      locale: LOCALE_NS,
      label: () => String(rawT('tab')),
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: Record<string, unknown>) => createElement(OverleafView as unknown as Parameters<typeof createElement>[0], props)))

    // Settings card under Settings > Plugins > Plugin configuration. The
    // optional settingsScope service simply keeps this callback pending when
    // a profile ships no settings provider — no hard requirement.
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['settingsScope'], (raw: RootLike & { settingsScope?: unknown }) => {
          try {
            const binder = raw.settingsScope as {
              bind(options: { namespace: string }): unknown
            } | undefined
            if (binder === undefined) return
            // Bind the namespace directly on the caller's fiber. (Wrapping
            // bind() in raw.effect() made cordis reject the scope object as
            // an "Invalid effect" — the bound scope is not a Disposable.)
            const scopeBinder = binder.bind({ namespace: LOCALE_NS })
            const innerSlots = raw.get('slots') as SlotsFace | undefined
            if (innerSlots?.inject === undefined || innerSlots.register === undefined) return
            innerSlots.inject('settings.plugin.item', () => innerSlots.register({
              name: 'settings.plugin.item',
              key: LOCALE_NS,
              locale: LOCALE_NS,
              inject: () => ({ scope: scopeBinder }),
            }, (props: Record<string, unknown>) =>
              createElement(OverleafSettingsCard as unknown as Parameters<typeof createElement>[0], props)))
          } catch (cardError) {
            console.warn('[dsh-overleaf] settings card registration skipped:', cardError)
          }
        })
      } catch (injectError) {
        console.warn('[dsh-overleaf] settingsScope inject unavailable:', injectError)
      }
    }
  } catch (error) {
    // Never break GUI boot because of this plugin.
    console.error('[dsh-overleaf] client apply failed:', error)
  }
}
