/**
 * Settings card rendered under Settings > Plugins > Plugin configuration,
 * keyed to the host-registered `dsh-overleaf` namespace. Owns its staging,
 * save/discard/reset — the surrounding tab only dispatches the slot.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** Structural face we rely on from settingsScope.bind({namespace}). */
export interface ScopeFace {
  getSnapshot(): {
    value?: Record<string, unknown>
    base?: Record<string, unknown>
    user?: Record<string, unknown>
    revision?: number
    writable?: boolean
    mode?: unknown
  }
  get?(field: string): unknown
  watch?(listener: () => void): () => void
  set(field: string, value: unknown): Promise<unknown>
  unset?(field: string): Promise<unknown>
}

interface FieldDef {
  key: string
  kind: 'text' | 'boolean' | 'number' | 'select'
  labelKey: string
  hintKey?: string
  options?: string[]
}

const FIELDS: FieldDef[] = [
  { key: 'baseUrl', kind: 'text', labelKey: 'set.baseUrl', hintKey: 'set.baseUrlHint' },
  { key: 'browserChannel', kind: 'select', labelKey: 'set.browserChannel', options: ['auto', 'default', 'msedge', 'chrome', 'real'] },
  { key: 'browserPath', kind: 'text', labelKey: 'set.browserPath', hintKey: 'set.browserPathHint' },
  { key: 'loginTimeoutMs', kind: 'number', labelKey: 'set.loginTimeoutMs' },
  { key: 'loginProfile', kind: 'select', labelKey: 'set.loginProfile', options: ['persistent', 'temporary'] },
  { key: 'selectionQuoteEnabled', kind: 'boolean', labelKey: 'set.selectionQuote' },
  { key: 'cursorInsertEnabled', kind: 'boolean', labelKey: 'set.cursorInsert' },
  { key: 'injectScriptEnabled', kind: 'boolean', labelKey: 'set.injectScript' },
  { key: 'assistPanelEnabled', kind: 'boolean', labelKey: 'set.assistPanel' },
  { key: 'loginProxyServer', kind: 'text', labelKey: 'set.loginProxyServer', hintKey: 'set.loginProxyServerHint' },
]

const STYLES = `
.dsc-card{display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsc-row{display:flex;flex-direction:column;gap:3px}
.dsc-label{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}
.dsc-overridden{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsc-input{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 8px;font-size:12px;width:min(360px,100%);box-sizing:border-box}
.dsc-actions{display:flex;gap:6px;align-items:center}
.dsc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;cursor:pointer}
.dsc-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsc-btn[disabled]{opacity:.5;cursor:default}
.dsc-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
`

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="dsh-overleaf-settings"]') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-overleaf'
  style.dataset.pluginCss = 'dsh-overleaf-settings'
  style.textContent = STYLES
  document.head.appendChild(style)
}

export interface OverleafSettingsCardProps {
  /** Bound scope supplied by the slot inject() closure. */
  scope?: ScopeFace | undefined
  /** Translate helper injected through the slot locale seat. */
  t?: (key: string, params?: Record<string, string>) => string
}

/** Minimal staged-form settings card. */
export function OverleafSettingsCard(props: OverleafSettingsCardProps): ReactNode {
  ensureStyles()
  const { scope, t: tr } = props
  const tt = tr ?? (key => String(key))
  const initial = useCallback((): Record<string, unknown> => ({ ...(scope?.getSnapshot().value ?? {}) }), [scope])
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  const [snapshotRev, setSnapshotRev] = useState(0)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>(undefined)

  useEffect(() => {
    if (scope === undefined || typeof scope.watch !== 'function') return
    return scope.watch(() => setSnapshotRev(rev => rev + 1)) as unknown as () => void
  }, [scope])

  useEffect(() => {
    setDraft(initial())
  }, [initial, snapshotRev])

  const snapshot = scope?.getSnapshot()
  const composedBase = snapshot?.base ?? {}
  const isOverridden = (key: string): boolean => Object.prototype.hasOwnProperty.call(snapshot?.user ?? {}, key)

  const stage = (key: string, value: unknown): void => {
    setDraft(previousDraft => ({ ...previousDraft, [key]: value }))
  }

  const discardAll = (): void => {
    setDraft(initial())
    setNote(undefined)
  }

  const resetOne = async (key: string): Promise<void> => {
    if (scope?.unset === undefined) return
    try {
      await scope.unset(key)
      setSnapshotRev(rev => rev + 1)
      setNote({ ok: true, text: tt('set.saved') })
    } catch (error) {
      setNote({ ok: false, text: String(error) })
    }
  }

  const save = async (): Promise<void> => {
    if (scope === undefined) return
    setSaving(true)
    try {
      for (const field of FIELDS) {
        const nextValue = draft[field.key]
        if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue
        // Only write fields whose drafted content differs from composition;
        // untouched inherited fields stay unwritten in the user layer.
        const defaultValue = composedBase[field.key]
        if (nextValue === undefined && defaultValue !== undefined) continue
        if (String(nextValue) === String(defaultValue) && !isOverridden(field.key)) continue
        if (nextValue === '') continue
        await scope.set(field.key, nextValue)
      }
      setNote({ ok: true, text: tt('set.saved') })
    } catch (error) {
      setNote({ ok: false, text: String(error) })
    } finally {
      setSaving(false)
      setSnapshotRev(rev => rev + 1)
    }
  }

  return (
    <div className="dsc-card">
      {FIELDS.map(field => (
        <div className="dsc-row" key={field.key}>
          <label className="dsc-label">
            <span>{tt(field.labelKey)}</span>
            {isOverridden(field.key) ? <span className="dsc-overridden">override</span> : null}
          </label>
          {field.kind === 'text' && (
            <input
              className="dsc-input"
              value={String(draft[field.key] ?? '')}
              onChange={event => stage(field.key, event.target.value)}
              placeholder={String(composedBase[field.key] ?? '')}
            />
          )}
          {field.kind === 'number' && (
            <input
              className="dsc-input"
              type="number"
              value={Number(draft[field.key] ?? 600000)}
              onChange={event => stage(field.key, Number(event.target.value))}
            />
          )}
          {field.kind === 'select' && (
            <select
              className="dsc-input"
              value={String(draft[field.key] ?? field.options?.[0] ?? '')}
              onChange={event => stage(field.key, event.target.value)}
            >
              {(field.options ?? []).map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          )}
          {field.kind === 'boolean' && (
            <input
              type="checkbox"
              checked={draft[field.key] !== false && draft[field.key] !== 'false'}
              onChange={event => stage(field.key, event.target.checked)}
            />
          )}
          {field.hintKey !== undefined && <span className="dsc-hint">{tt(field.hintKey)}</span>}
          {isOverridden(field.key) && (
            <button className="dsc-btn" onClick={() => { void resetOne(field.key) }}>{tt('set.reset')}</button>
          )}
        </div>
      ))}
      <div className="dsc-actions">
        <button className="dsc-btn dsc-btn-primary" disabled={saving || scope === undefined} onClick={() => { void save() }}>{tt('set.save')}</button>
        <button className="dsc-btn" disabled={saving} onClick={discardAll}>{tt('set.discard')}</button>
        {note !== undefined && <span className={`dsc-note ${note.ok ? '' : 'dsc-bad'}`}>{note.text}</span>}
      </div>
    </div>
  )
}
