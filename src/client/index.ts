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
import type { ScopeFace } from './settings-card.tsx'
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
 * The settings entry id of this plugin, tried in order. 0.1.7+ addresses a
 * plugin's configuration by its profile row id (`overleaf-workbench`, the id
 * in cordis.patch.yml); the package name is kept as a fallback for
 * deployments whose composition names the row after the package.
 */
const CONFIG_NS_CANDIDATES = ['overleaf-workbench', 'dsh-overleaf'] as const

/** Structural face of a 0.1.7+ `ctx.configForms.get(entryId)` form. */
interface ConfigFormFace {
  getSnapshot(): {
    status?: string
    value?: Record<string, unknown>
    base?: unknown
    user?: unknown
    revision?: number
    writable?: boolean
  }
  subscribe?(listener: () => void): () => void
  set(field: string, value: unknown): Promise<unknown>
  unset?(field: string): Promise<unknown>
}

/** Structural face of the 0.1.7+ settings transport service. */
interface ConfigFormsFace {
  get(entryId: string): ConfigFormFace | undefined
}

/**
 * Narrow a wire-shaped bag to the record the card indexes into. The
 * ConfigForms transport types `base`/`user` as `unknown`; anything that is not
 * a plain object is reported as absent so the card's `hasOwnProperty` and
 * index reads stay safe.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/**
 * Bridge the ConfigForms transport to the card's scope face. The card never
 * needs to know which entry id resolved: this proxy reports the first READY
 * candidate's snapshot, subscribes to every candidate, and writes through the
 * ready one (falling back to the row-id candidate while loading).
 */
function makeConfigScope(forms: ConfigFormsFace): ScopeFace {
  const formAt = (ns: string): ConfigFormFace | undefined => {
    try {
      return forms.get(ns) ?? undefined
    } catch {
      return undefined
    }
  }
  const readyForm = (): ConfigFormFace | undefined => {
    for (const ns of CONFIG_NS_CANDIDATES) {
      try {
        const form = formAt(ns)
        if (form?.getSnapshot?.().status === 'ready') return form
      } catch {
        /* treat a throwing snapshot as not ready */
      }
    }
    return undefined
  }
  const anyForm = (): ConfigFormFace | undefined =>
    readyForm() ?? formAt(CONFIG_NS_CANDIDATES[0]) ?? formAt(CONFIG_NS_CANDIDATES[1])
  return {
    getSnapshot: () => {
      try {
        const snap = anyForm()?.getSnapshot?.()
        if (snap === undefined) return {}
        return {
          status: snap.status,
          value: snap.value,
          base: asRecord(snap.base),
          user: asRecord(snap.user),
          revision: snap.revision,
          writable: snap.writable,
        }
      } catch {
        return {}
      }
    },
    subscribe: (listener: () => void) => {
      const offs: Array<() => void> = []
      for (const ns of CONFIG_NS_CANDIDATES) {
        try {
          const off = formAt(ns)?.subscribe?.(listener)
          if (typeof off === 'function') offs.push(off)
        } catch {
          /* a missing candidate simply has no subscription */
        }
      }
      return () => {
        for (const off of offs) {
          try {
            off()
          } catch {
            /* dispose best-effort */
          }
        }
      }
    },
    set: async (field: string, value: unknown) => {
      const form = anyForm()
      if (form === undefined) return false
      return form.set(field, value)
    },
    unset: async (field: string) => {
      const form = anyForm()
      if (form?.unset === undefined) return false
      return form.unset(field)
    },
  }
}

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

    // 0.1.7+ settings surfaces. The harness dropped `settings.plugin.item` and
    // now serves plugin configuration through `ctx.configForms` (keyed by the
    // profile entry id), rendered inside the Plugins page: `plugins.bundle.config`
    // for the bundle's own page (key = package name) and `plugins.row.config`
    // for a row's Configure page (key = `<package>#<row id>`). A
    // `settings.section` page is registered as well so the same card stays one
    // click away under Settings. Absent services inside the card degrade to a
    // read-only view instead of breaking the page.
    const configForms = ctx.get('configForms') as ConfigFormsFace | undefined
    if (configForms !== undefined && typeof configForms.get === 'function') {
      try {
        const scope = makeConfigScope(configForms)
        // The Plugins page also dispatches these keyed seats with view:'summary'
        // for one-line rows; only the page view carries the form.
        const card = (props: Record<string, unknown>): unknown =>
          props.view === 'summary'
            ? null
            : createElement(OverleafSettingsCard as unknown as Parameters<typeof createElement>[0], props)
        const label = (): string => String(rawT('set.title'))
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'dsh-overleaf-settings',
          order: 45,
          locale: LOCALE_NS,
          label,
          inject: () => ({ scope }),
        }, card))
        slots.inject('plugins.bundle.config', () => slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-overleaf',
          order: 30,
          locale: LOCALE_NS,
          label,
          inject: () => ({ scope }),
        }, card))
        slots.inject('plugins.row.config', () => slots.register({
          name: 'plugins.row.config',
          key: 'dsh-overleaf#overleaf-workbench',
          order: 30,
          locale: LOCALE_NS,
          label,
          inject: () => ({ scope }),
        }, card))
      } catch (seatError) {
        console.warn('[dsh-overleaf] plugins settings seats skipped:', seatError)
      }
    }
  } catch (error) {
    // Never break GUI boot because of this plugin.
    console.error('[dsh-overleaf] client apply failed:', error)
  }
}
