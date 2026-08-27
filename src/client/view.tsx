/**
 * The Overleaf conversation-view component: same-origin proxied site iframe
 * plus a small host-side chrome (toolbar, floating quote CTA, assist panel,
 * cookie dialog, status strip). All strings go through the bound locale
 * helper; failures degrade to status notes instead of throwing (client apply
 * must never crash the GUI shell).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Translate } from './workbench.ts'
import {
  insertQuoteIntoComposer, sessionWorkspaceHint,
} from './workbench.ts'
import { postWorkbench } from './wire.ts'
import type { EmbedInfo, LoginStatusWire, WorkbenchStatusWire } from './wire.ts'

/** Message shape sent by the embedded bridge script. */
export interface BridgeMessage {
  ns?: string
  type?: string
}

export interface OutlineItem {
  level?: string | undefined
  title?: string | undefined
  line?: number | undefined
  text?: string | undefined
}

export interface OverleafViewProps {
  /** Provided by the standard conversation kit. */
  sessionId?: string | undefined
  /** Slot locale translate helper. */
  t?: Translate | undefined
  /** Feature switches resolved from embed-info. */
  features?: EmbedInfo | undefined
}

/** Editor engine reported by the bridge capabilities probe. */
type EditorEngine = 'none' | 'cm5' | 'cm6'

const LATex_TEMPLATES = {
  section: '\\section{}\n',
  subsection: '\\subsection{}\n',
  figure: [
    '\\begin{figure}[htbp]',
    '  \\centering',
    '  % \\includegraphics[width=0.8\\textwidth]{figure.pdf}',
    '  \\caption{}',
    '  \\label{fig:}',
    '\\end{figure}',
    '',
  ].join('\n'),
  table: [
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\caption{}',
    '  \\label{tab:}',
    '  \\begin{tabular}{lll}',
    '    & & \\\\',
    '    & & \\\\',
    '  \\end{tabular}',
    '\\end{table}',
    '',
  ].join('\n'),
  equation: '\\begin{equation}\n  \n  \\label{eq:}\n\\end{equation}\n',
  bibitem: '@article{key,\n  title = {},\n  author = {},\n  journal = {},\n  year = {},\n}\n',
}

/** Insert the shared stylesheet once per page lifetime. */
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="dsh-overleaf-workbench"]') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-overleaf'
  style.dataset.pluginCss = 'dsh-overleaf-workbench'
  style.textContent = `
.dso-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.dso-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dso-toolbar-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin-right:4px}
.dso-hint{font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-bottom:1px dashed var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dso-stage{position:relative;flex:1;min-height:0;display:flex}
.dso-frame{flex:1;width:100%;height:100%;border:none;background:#fff}
.dso-quote-cta{position:absolute;right:18px;top:14px;z-index:30;padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.dso-quote-cta:hover{background:var(--dsw-alias-bg-layer-2)}
.dso-panel{position:absolute;right:0;top:0;bottom:0;width:min(320px,90%);z-index:25;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:-6px 0 18px rgba(0,0,0,.10)}
.dso-panel-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dso-tabs{display:flex;gap:4px;padding:0 10px 6px}
.dso-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer}
.dso-tab[data-active="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.dso-panel-body{flex:1;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dso-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:3px 9px;border-radius:7px;cursor:pointer}
.dso-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dso-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dso-btn[disabled]{opacity:.55;cursor:default}
.dso-statusbar{display:flex;align-items:center;gap:8px;padding:5px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dso-note-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.dso-note-bad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.dso-textarea{width:100%;box-sizing:border-box;min-height:72px;resize:vertical;font-family:var(--ds-font-family-code,monospace);font-size:12px;padding:6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dso-outline-row{display:flex;align-items:center;gap:6px;justify-content:space-between;padding:2px 0;cursor:pointer}
.dso-outline-row:hover{color:var(--dsw-alias-brand-primary)}
.dso-modal-scrim{position:absolute;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:40}
.dso-modal{width:min(520px,94%);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 12px 40px rgba(0,0,0,.28)}
.dso-modal h3{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dso-muted{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}
`
  document.head.appendChild(style)
}

/** OverleafView — registered under the conversation.view slot. */
export function OverleafView(props: OverleafViewProps): ReactNode {
  ensureStyles()
  const { sessionId, t: tr, features } = props
  const tt = tr ?? (key => String(key))
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [nonce, setNonce] = useState(0)
  const [status, setStatus] = useState<WorkbenchStatusWire | undefined>(undefined)
  const [embedInfo, setEmbedInfo] = useState<EmbedInfo | undefined>(features)
  const [engine, setEngine] = useState<EditorEngine>('none')
  const [selectedText, setSelectedText] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<'insert' | 'outline' | 'status'>('insert')
  const [insertDraft, setInsertDraft] = useState('')
  const [outlineItems, setOutlineItems] = useState<OutlineItem[] | undefined>(undefined)
  const [cookieDialogOpen, setCookieDialogOpen] = useState(false)
  const [cookieValue, setCookieValue] = useState('')
  const [busy, setBusy] = useState<'login' | 'cookie' | undefined>(undefined)
  const [frameEscaped, setFrameEscaped] = useState(false)
  const [embeddedLoginHint, setEmbeddedLoginHint] = useState(false)

  // Same-origin detection: if the iframe document navigated itself outside
  // the proxy prefix (site anti-framing JS), surface a hint instead of a
  // silently dead pane.
  const checkFrameLocation = useCallback((): void => {
    try {
      const href = frameRef.current?.contentWindow?.location.href ?? ''
      setFrameEscaped(href !== '' && !href.includes('/overleaf-proxy'))
    } catch {
      /* navigation still in flight; ignore */
    }
  }, [])

  const selectionQuoteEnabled = embedInfo?.selectionQuoteEnabled ?? true
  const cursorInsertEnabled = embedInfo?.cursorInsertEnabled ?? true
  const assistPanelEnabled = embedInfo?.assistPanelEnabled ?? true

  useEffect(() => {
    if (embedInfo !== undefined) return
    void postWorkbench<EmbedInfo>('/overleaf/workbench/embed-info')
      .then(info => setEmbedInfo(info))
      .catch(error => setNote({ ok: false, text: `${tt('error.generic')}: ${String(error)}` }))
  }, [embedInfo, tt])

  useEffect(() => {
    void postWorkbench<WorkbenchStatusWire>('/overleaf/workbench/status')
      .then(value => setStatus(value))
      .catch((error: unknown) => setNote({ ok: false, text: String(error) }))
  }, [])

  const sendToFrame = useCallback((message: Record<string, unknown>): void => {
    try {
      frameRef.current?.contentWindow?.postMessage({ ns: 'dsh-overleaf', ...message }, '*')
    } catch {
      /* cross-window messaging races during reloads are harmless */
    }
  }, [])

  // Bridge message pump.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data as BridgeMessage | undefined
      if (data === undefined || data.ns !== 'dsh-overleaf') return
      switch (data.type) {
        case 'selection': {
          if (!selectionQuoteEnabled) return
          const text = typeof (data as { text?: unknown }).text === 'string' ? (data as { text: string }).text : undefined
          if (text !== undefined && text.trim() !== '') setSelectedText(text.trim())
          return
        }
        case 'selection-cleared':
          setSelectedText(undefined)
          return
        case 'capabilities':
          setEngine(data.type === undefined ? 'none' : ((data as unknown as { editor?: EditorEngine }).editor ?? 'none'))
          return
        case 'outline':
          setOutlineItems((data as unknown as { items?: OutlineItem[] }).items ?? [])
          return
        case 'insert-done': {
          const done = data as unknown as { ok?: boolean; error?: string }
          if (done.ok === true) setNote({ ok: true, text: 'OK' })
          else setNote({ ok: false, text: done.error ?? '' })
          return
        }
        case 'url-change': {
          const href = typeof (data as { href?: unknown }).href === 'string'
            ? (data as { href: string }).href
            : ''
          // CAPTCHA cannot run inside the embedded origin (domain-locked
          // site key), so flag login pages and steer to the popup/cookie.
          setEmbeddedLoginHint(href.includes('/login'))
          return
        }
        case 'snapshot-saved':
        default:
          return
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [selectionQuoteEnabled])

  const refreshStatus = useCallback((): void => {
    void postWorkbench<WorkbenchStatusWire>('/overleaf/workbench/status')
      .then(value => setStatus(value))
      .catch(error => setNote({ ok: false, text: String(error) }))
  }, [])

  const onQuoteSelected = useCallback((): void => {
    if (selectedText === undefined || sessionId === undefined || sessionId === '') return
    const result = insertQuoteIntoComposer(sessionId, selectedText)
    if (result.ok) {
      setNote({ ok: true, text: `${result.refLabel ?? tt('quote.done')} (${result.kind})` })
    } else {
      setNote({ ok: false, text: result.message })
    }
    setSelectedText(undefined)
  }, [selectedText, sessionId, tt])

  const onInsert = useCallback((text: string): void => {
    if (text.trim() === '') {
      setNote({ ok: false, text: tt('insert.emptyInput') })
      return
    }
    sendToFrame({ type: 'snapshot' })
    setTimeout(() => sendToFrame({ type: 'insert', text }), 60)
    setNote({ ok: true, text: tt('insert.action') })
    setInsertDraft('')
  }, [sendToFrame, tt])

  const requestOutline = useCallback((): void => {
    setOutlineItems(undefined)
    sendToFrame({ type: 'outline-request' })
  }, [sendToFrame])

  const openOutlineTab = useCallback((): void => {
    setPanelTab('outline')
    requestOutline()
  }, [requestOutline])

  // Login flow: start it in the background, then poll /login-status so a
  // slow CDP wait (or even a page refresh) never wedges the toolbar.
  useEffect(() => {
    if (busy !== 'login') return
    let disposed = false
    const startedAt = Date.now()
    const tick = (): void => {
      if (disposed) return
      void postWorkbench<LoginStatusWire>('/overleaf/workbench/login-status')
        .then(current => {
          if (disposed) return
          if (current.running) {
            setNote({ ok: true, text: `${tt('status.loginPending').replace('{seconds}', String(Math.round((Date.now() - startedAt) / 1000)))}` })
            return
          }
          setBusy(undefined)
          if (current.error !== undefined) {
            setNote({ ok: false, text: current.error })
          } else if (current.result !== undefined) {
            setNote(current.result.kind === 'automatic'
              ? { ok: true, text: 'OK' }
              : { ok: false, text: current.result.instructions ?? tt('status.loginPending') })
          }
          refreshStatus()
        })
        .catch(() => { /* transient network hiccups: keep polling */ })
    }
    tick()
    const timer = setInterval(tick, 3_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [busy, refreshStatus, tt])

  const startLogin = useCallback((): void => {
    if (busy !== undefined) return
    void postWorkbench<{ kind: string }>('/overleaf/workbench/login', {})
      .then(result => {
        if (result.kind === 'pending') {
          // A login started earlier (maybe before a refresh) is still running.
          setBusy('login')
          return
        }
        setBusy('login')
        setNote({ ok: true, text: tt('status.loginWindowOpened') })
      })
      .catch(error => setNote({ ok: false, text: String(error) }))
  }, [busy, tt])

  const saveCookie = useCallback((): void => {
    if (cookieValue.trim() === '') return
    setBusy('cookie')
    void postWorkbench<{ saved: boolean }>('/overleaf/workbench/cookie', { cookie: cookieValue.trim() })
      .then(() => {
        setNote({ ok: true, text: 'cookie saved' })
        setCookieDialogOpen(false)
        setCookieValue('')
        refreshStatus()
      })
      .catch(error => setNote({ ok: false, text: String(error) }))
      .finally(() => setBusy(undefined))
  }, [cookieValue, refreshStatus])

  const logout = useCallback((): void => {
    void postWorkbench<{ cleared: boolean }>('/overleaf/workbench/logout')
      .then(() => refreshStatus())
      .catch(error => setNote({ ok: false, text: String(error) }))
  }, [refreshStatus])

  const workspaceHint = useMemo(
    () => sessionId !== undefined ? sessionWorkspaceHint(sessionId) : undefined,
    [sessionId],
  )

  const templates: Array<[string, string]> = [
    [tt('insert.section'), LATex_TEMPLATES.section],
    [tt('insert.subsection'), LATex_TEMPLATES.subsection],
    [tt('insert.figure'), LATex_TEMPLATES.figure],
    [tt('insert.table'), LATex_TEMPLATES.table],
    [tt('insert.equation'), LATex_TEMPLATES.equation],
    [tt('insert.bibitem'), LATex_TEMPLATES.bibitem],
  ]

  return (
    <div className="dso-root">
      <div className="dso-toolbar">
        <span className="dso-toolbar-title">Overleaf</span>
        <button className="dso-btn" title={tt('toolbar.reload')} onClick={() => setNonce(n => n + 1)}>⟳</button>
        <button
          className="dso-btn"
          title={tt('toolbar.openWindow')}
          onClick={() => { window.open(`${location.origin}/overleaf-proxy/`, '_blank') }}
        >↗</button>
        <span style={{ flex: 1 }} />
        {busy === 'login'
          ? <button className="dso-btn" disabled>…</button>
          : status?.loggedIn === true
            ? <>
                <button className="dso-btn" onClick={logout}>{tt('toolbar.logout')}</button>
              </>
            : <>
                <button className="dso-btn dso-btn-primary" onClick={startLogin}>{tt('toolbar.login')}</button>
                <button className="dso-btn" onClick={() => setCookieDialogOpen(true)}>{tt('toolbar.cookieDialog')}</button>
              </>
        }
        {assistPanelEnabled
          ? <button className="dso-btn" data-open={panelOpen ? '1' : undefined} onClick={() => { if (!panelOpen) { setPanelOpen(true); setPanelTab(prev => prev) } else setPanelOpen(false) }}>{tt('toolbar.panel')}</button>
          : null}
      </div>
      <div className="dso-hint">
        {status?.baseUrl ?? ''}
        {workspaceHint !== undefined ? ` · ${workspaceHint}` : ''}
      </div>
      <div className="dso-stage">
        <iframe
          ref={frameRef}
          key={nonce}
          className="dso-frame"
          src="/overleaf-proxy/"
          title="Overleaf"
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={checkFrameLocation}
        />
        {frameEscaped && <div className="dso-hint" style={{ color: 'var(--dsw-alias-state-error-primary, #c0392b)' }}>{tt('status.frameBust')}</div>}
        {embeddedLoginHint && <div className="dso-hint" style={{ color: 'var(--dsw-alias-state-error-primary, #c0392b)' }}>{tt('status.embeddedLoginHint')}</div>}
        {selectedText !== undefined
          ? <button className="dso-quote-cta" onClick={onQuoteSelected}>{tt('quote.cta')}</button>
          : null}
        {panelOpen && assistPanelEnabled
          ? (
              <div className="dso-panel">
                <div className="dso-panel-head">
                  <span>{tt('panel.title')}</span>
                  <button className="dso-btn" onClick={() => setPanelOpen(false)}>×</button>
                </div>
                <div className="dso-tabs">
                  {([['insert', tt('panel.tabInsert'), () => setPanelTab('insert')],
                    ['outline', tt('panel.tabOutline'), openOutlineTab],
                    ['status', tt('panel.tabStatus'), () => setPanelTab('status')]] as Array<[string, string, () => void]>).map(([id, label, run]) => (
                      <button
                        key={id}
                        className="dso-tab"
                        data-active={panelTab === id ? '1' : undefined}
                        onClick={run}
                      >{label}</button>
                  ))}
                </div>
                <div className="dso-panel-body">
                  {panelTab === 'insert' && (
                    <>
                      <div className="dso-muted">{tt('insert.templateLabel')}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {templates.map(([label, snippet]) => (
                          <button key={label} className="dso-btn" disabled={!cursorInsertEnabled} onClick={() => onInsert(snippet)}>{label}</button>
                        ))}
                      </div>
                      <div className="dso-muted">{tt('insert.pasteLabel')}</div>
                      <textarea
                        className="dso-textarea"
                        value={insertDraft}
                        onChange={event => setInsertDraft(event.target.value)}
                        placeholder="\\section{...}"
                      />
                      <button className="dso-btn dso-btn-primary" disabled={!cursorInsertEnabled} onClick={() => onInsert(insertDraft)}>{tt('insert.action')}</button>
                      {!cursorInsertEnabled && <div className="dso-muted">R6 insert is disabled in settings.</div>}
                    </>
                  )}
                  {panelTab === 'outline' && (
                    <>
                      <button className="dso-btn" onClick={requestOutline}>{tt('outline.refresh')}</button>
                      {outlineItems === undefined
                        ? <div className="dso-muted">…</div>
                        : outlineItems.length === 0
                          ? <div className="dso-muted">{tt('outline.empty')}</div>
                          : outlineItems.map((item, index) => (
                              <div
                                key={`${index}-${item.line ?? 0}`}
                                className="dso-outline-row"
                                style={{ paddingLeft: outlineIndent(item.level) }}
                                onClick={() => { if (item.text !== undefined) sendToFrame({ type: 'reveal', query: item.text }) }}
                              >
                                <span>{item.title}</span>
                                <small>{item.level}</small>
                              </div>
                          ))}
                    </>
                  )}
                  {panelTab === 'status' && (
                    <>
                      <div><b>{tt('status.baseUrl')}:</b> {status?.baseUrl}</div>
                      <div>
                        {engine === 'none' ? tt('status.editorUnavailable') : tt('status.editorAvailable').replace('{engine}', engine)}
                      </div>
                      <div>{status?.loggedIn === true ? tt('status.loggedIn') : tt('status.loggedOut')}</div>
                      <div className="dso-muted">{tt('status.composeNote')}</div>
                    </>
                  )}
                </div>
              </div>
            )
          : null}
      </div>
      {(note !== undefined || status !== undefined) && (
        <div className={`dso-statusbar ${note === undefined ? '' : note.ok ? 'dso-note-ok' : 'dso-note-bad'}`}>
          <span>{note !== undefined ? note.text : status?.loggedIn === true ? tt('status.loggedIn') : tt('status.loggedOut')}</span>
          {note !== undefined && <button className="dso-btn" onClick={() => setNote(undefined)}>×</button>}
        </div>
      )}
      {cookieDialogOpen && (
        <div className="dso-modal-scrim">
          <div className="dso-modal">
            <h3>{tt('cookie.title')}</h3>
            <div className="dso-muted">{tt('cookie.hint')}</div>
            <textarea className="dso-textarea" value={cookieValue} onChange={event => setCookieValue(event.target.value)} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dso-btn dso-btn-primary" disabled={busy === 'cookie'} onClick={saveCookie}>{tt('cookie.save')}</button>
              <button className="dso-btn" onClick={() => setCookieDialogOpen(false)}>{tt('cookie.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function outlineIndent(level: string | number | undefined): string {
  const indentLevels: Record<string, number> = { part: 0, chapter: 4, section: 8, subsection: 16, subsubsection: 24 }
  return `${indentLevels[String(level)] ?? 0}px`
}
