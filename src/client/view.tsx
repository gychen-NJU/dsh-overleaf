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
import {
  buildFixCompilePrompt, buildSelectionAgentPrompt, cleanAgentInsertContent, insertFileSignature,
  parseCompileLog, parseFixEdits,
} from './ai-output.ts'
import type { CompileLogItem, FixEditParse, InsertFileSnapshot } from './ai-output.ts'

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
  /** Standard-kit composer actions (submit the edited draft). */
  inputActions?: { submit(): unknown; setDraft(text: string): unknown } | undefined
}

interface AiOutputWatch {
  cwd: string
  baselineSignature: string
  startedAt: number
  purpose: 'insert' | 'selection-replace' | 'fix'
  selection?: EditorSelectionTarget | undefined
}

interface EditorSelectionTarget {
  text: string
  selectionId?: string | undefined
  engine: 'cm5' | 'cm6' | 'dom'
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
.dso-log-list{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dso-log-row{display:flex;gap:6px;align-items:flex-start;font-size:11px;line-height:1.45}
.dso-log-badge{flex:none;min-width:16px;text-align:center;border-radius:4px;font-weight:700;font-size:10px;padding:0 3px;background:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dso-log-row[data-level="error"] .dso-log-badge{background:var(--dsw-alias-state-error-primary,#c0392b);color:#fff}
.dso-log-row[data-level="warning"] .dso-log-badge{background:var(--dsw-alias-state-warning-primary,#b8860b);color:#fff}
.dso-log-text{word-break:break-word;color:var(--dsw-alias-label-primary)}
.dso-modal-scrim{position:absolute;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:40}
.dso-modal{width:min(520px,94%);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 12px 40px rgba(0,0,0,.28)}
.dso-modal h3{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dso-muted{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dso-ai-wait{display:flex;align-items:center;gap:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.5}
.dso-ai-spinner{width:12px;height:12px;box-sizing:border-box;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dso-ai-spin .8s linear infinite;flex:none}
@keyframes dso-ai-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dso-ai-spinner{animation:none}}
`
  document.head.appendChild(style)
}

/* ------------------------------------------------------------------ */
/* Persistent iframe (tab-switch keep-alive)                            */
/*                                                                      */
/* DSH unmounts the inactive conversation view, which would destroy a   */
/* React-owned iframe and reload /project on every tab switch. The      */
/* iframe instead lives at body level for the whole page lifetime and   */
/* is POSITIONED over the view's stage area with fixed geometry; on     */
/* unmount it is merely hidden. The document (login state, scroll,      */
/* open project) survives every tab switch.                             */
/* ------------------------------------------------------------------ */

let persistentFrame: HTMLIFrameElement | undefined

function ensurePersistentFrame(): HTMLIFrameElement {
  if (persistentFrame !== undefined) return persistentFrame
  const frame = document.createElement('iframe')
  frame.className = 'dso-frame'
  frame.title = 'Overleaf'
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen')
  frame.src = '/overleaf-proxy/project'
  // Attach DIRECTLY to body and keep it there forever. Moving an iframe in
  // the DOM reloads it, so after creation the node is never re-parented —
  // show/hide is done purely via inline styles. It starts hidden; the view
  // effect reveals it with fixed geometry once the stage is measured.
  frame.style.display = 'none'
  document.body.appendChild(frame)
  persistentFrame = frame
  return frame
}

function hidePersistentFrame(): void {
  if (persistentFrame !== undefined) persistentFrame.style.display = 'none'
}

/** OverleafView — registered under the conversation.view slot. */
export function OverleafView(props: OverleafViewProps): ReactNode {
  ensureStyles()
  const { sessionId, t: tr, features, inputActions } = props
  const tt = tr ?? (key => String(key))
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [status, setStatus] = useState<WorkbenchStatusWire | undefined>(undefined)
  const [embedInfo, setEmbedInfo] = useState<EmbedInfo | undefined>(features)
  const [engine, setEngine] = useState<EditorEngine>('none')
  const [selectedText, setSelectedText] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<'insert' | 'selection' | 'compile' | 'outline' | 'status'>('insert')
  const [insertDraft, setInsertDraft] = useState('')
  const [selectionTarget, setSelectionTarget] = useState<EditorSelectionTarget | undefined>(undefined)
  const [selectionPrompt, setSelectionPrompt] = useState('')
  const [selectionDraft, setSelectionDraft] = useState('')
  const [pendingReplacement, setPendingReplacement] = useState<EditorSelectionTarget | undefined>(undefined)
  const [outlineItems, setOutlineItems] = useState<OutlineItem[] | undefined>(undefined)
  const [compileInfo, setCompileInfo] = useState<{
    status: string
    files: Array<{ path: string; text: string; error?: string | undefined }>
    items: CompileLogItem[]
    errors: number
    warnings: number
    at: number
  } | undefined>(undefined)
  const [fixDraft, setFixDraft] = useState('')
  const [fixParsed, setFixParsed] = useState<FixEditParse | undefined>(undefined)
  const [outlineError, setOutlineError] = useState<string | undefined>(undefined)
  const [outlineDebug, setOutlineDebug] = useState<string | undefined>(undefined)
  const docRef = useRef<{ name: string; text: string } | undefined>(undefined)
  const [cookieDialogOpen, setCookieDialogOpen] = useState(false)
  const [cookieValue, setCookieValue] = useState('')
  const [busy, setBusy] = useState<'login' | 'cookie' | undefined>(undefined)
  const [frameEscaped, setFrameEscaped] = useState(false)
  const [embeddedLoginHint, setEmbeddedLoginHint] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [attachContext, setAttachContext] = useState(true)
  const [attachFullDoc, setAttachFullDoc] = useState(false)
  const [aiOutputWatch, setAiOutputWatch] = useState<AiOutputWatch | undefined>(undefined)
  const [aiWaitSeconds, setAiWaitSeconds] = useState(0)
  const [aiBusy, setAiBusy] = useState(false)
  const cursorContextRef = useRef<{ before: string; after: string; cursor: number } | undefined>(undefined)
  const stageRef = useRef<HTMLDivElement | null>(null)

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

  // Keep-alive: adopt the persistent iframe, position it over the stage area
  // with fixed geometry, and re-sync on layout changes. On unmount the frame
  // is hidden (NOT destroyed) so the open project survives tab switches.
  useEffect(() => {
    const frame = ensurePersistentFrame()
    frameRef.current = frame
    const sync = (): void => {
      const stage = stageRef.current
      if (stage === null) {
        hidePersistentFrame()
        return
      }
      const rect = stage.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) {
        hidePersistentFrame()
        try { document.documentElement.setAttribute('data-dsh-frame', 'hidden:stage-too-small') } catch {}
        return
      }
      frame.style.display = 'block'
      frame.style.position = 'fixed'
      frame.style.left = `${Math.round(rect.left)}px`
      frame.style.top = `${Math.round(rect.top)}px`
      // The iframe is a body-level root stacking-context child with a very
      // high z-index. A React child rendered inside the stage cannot paint on
      // top of it, regardless of the child's own z-index. When the assist
      // panel opens, reserve the same width as `.dso-panel` (min(320px, 90%))
      // so the iframe no longer covers the panel's hit-testing/paint area.
      const panelWidth = panelOpen ? Math.min(320, Math.round(rect.width * 0.9)) : 0
      const frameWidth = Math.max(0, Math.round(rect.width) - panelWidth)
      frame.style.width = `${frameWidth}px`
      frame.style.height = `${Math.round(rect.height)}px`
      // The frame lives under <body> (root stacking context); DSH shell
      // containers commonly use mid-range z-indexes, so claim a high one —
      // the frame only ever covers the stage rectangle, nothing else.
      frame.style.zIndex = '99999'
      frame.style.border = 'none'
      try { document.documentElement.setAttribute('data-dsh-frame', `visible ${frameWidth}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)} panel:${panelWidth}`) } catch {}
    }
    sync()
    const observer = new ResizeObserver(() => sync())
    if (stageRef.current !== null) observer.observe(stageRef.current)
    window.addEventListener('resize', sync)
    // Any scrollable ancestor changes the stage's viewport rect.
    window.addEventListener('scroll', sync, true)
    const interval = window.setInterval(sync, 400)
    frame.addEventListener('load', checkFrameLocation)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.clearInterval(interval)
      frame.removeEventListener('load', checkFrameLocation)
      hidePersistentFrame()
      frameRef.current = null
    }
  }, [checkFrameLocation, panelOpen])

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
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as BridgeMessage | undefined
      if (data === undefined || data.ns !== 'dsh-overleaf') return
      switch (data.type) {
        case 'selection': {
          const text = typeof (data as { text?: unknown }).text === 'string' ? (data as { text: string }).text : undefined
          if (text === undefined || text.trim() === '') return
          const rawEngine = (data as unknown as { engine?: unknown }).engine
          const selectionId = typeof (data as unknown as { selectionId?: unknown }).selectionId === 'string'
            ? (data as unknown as { selectionId: string }).selectionId
            : undefined
          const selectionEngine: EditorSelectionTarget['engine'] = rawEngine === 'cm5' || rawEngine === 'cm6'
            ? rawEngine
            : 'dom'
          setSelectionTarget({ text, selectionId, engine: selectionEngine })
          if (selectionQuoteEnabled) setSelectedText(text)
          return
        }
        case 'selection-cleared':
          setSelectedText(undefined)
          return
        case 'capabilities':
          setEngine(data.type === undefined ? 'none' : ((data as unknown as { editor?: EditorEngine }).editor ?? 'none'))
          return
        case 'outline': {
          const payload = data as unknown as { items?: OutlineItem[]; error?: string; debug?: { engine?: string; chars?: number; hits?: number; url?: string } }
          setOutlineItems(payload.items ?? [])
          setOutlineError(payload.error ?? undefined)
          const debug = payload.debug
          if (debug !== undefined) {
            const parts = [debug.engine !== undefined ? `engine=${debug.engine}` : null,
              debug.chars !== undefined ? `chars=${debug.chars}` : null,
              debug.hits !== undefined ? `hits=${debug.hits}` : null].filter(Boolean)
            setOutlineDebug(parts.length > 0 ? parts.join(' · ') : undefined)
          } else {
            setOutlineDebug(undefined)
          }
          return
        }
        case 'insert-done': {
          const done = data as unknown as { ok?: boolean; error?: string }
          if (done.ok === true) setNote({ ok: true, text: 'OK' })
          else setNote({ ok: false, text: done.error ?? '' })
          return
        }
        case 'selection-replace-done': {
          const done = data as unknown as { ok?: boolean; error?: string }
          if (done.ok === true) {
            setSelectionDraft('')
            setPendingReplacement(undefined)
            setSelectionTarget(undefined)
            setSelectedText(undefined)
            setNote({ ok: true, text: tt('selection.replaced') })
          } else {
            setNote({
              ok: false,
              text: done.error === 'selection-stale' || done.error === 'selection-expired'
                ? tt('selection.stale')
                : tt('selection.replaceFailed'),
            })
          }
          return
        }
        case 'cursor-context': {
          const cc = data as unknown as { before?: string; after?: string; cursor?: number; error?: string }
          cursorContextRef.current = cc.error === undefined && typeof cc.before === 'string'
            ? { before: cc.before, after: cc.after ?? '', cursor: cc.cursor ?? 0 }
            : undefined
          return
        }
        case 'compile-log': {
          const report = data as unknown as {
            status?: string
            files?: Array<{ path?: string; text?: string; error?: string }>
          }
          const files = Array.isArray(report.files)
            ? report.files.map(file => ({
                path: typeof file?.path === 'string' ? file.path : 'unknown',
                text: typeof file?.text === 'string' ? file.text : '',
                ...(typeof file?.error === 'string' ? { error: file.error } : {}),
              }))
            : []
          const combined = files.map(file => file.text).join('\n')
          const parsed = parseCompileLog(combined)
          setCompileInfo({
            status: typeof report.status === 'string' ? report.status : 'unknown',
            files,
            items: parsed.items,
            errors: parsed.errors,
            warnings: parsed.warnings,
            at: Date.now(),
          })
          return
        }
        case 'document': {
          const doc = data as unknown as { name?: string; text?: string; error?: string }
          if (doc.error === undefined && typeof doc.text === 'string') {
            docRef.current = { name: typeof doc.name === 'string' ? doc.name : 'current-document', text: doc.text }
          }
          return
        }
        case 'fix-applied': {
          const done = data as unknown as { ok?: boolean; applied?: number; error?: string; detail?: string }
          if (done.ok === true) {
            setFixDraft('')
            setFixParsed(undefined)
            setNote({ ok: true, text: tt('compile.applied').replace('{count}', String(done.applied ?? 0)) })
          } else {
            const detail = done.error === 'no-editor'
              ? tt('compile.applyFailed').replace('{detail}', 'no-editor')
              : tt('compile.applyFailed').replace('{detail}', String(done.detail ?? done.error ?? '').slice(0, 120))
            setNote({ ok: false, text: detail })
          }
          return
        }
        case 'recompile-clicked': {
          const done = data as unknown as { ok?: boolean }
          setNote({ ok: done.ok === true, text: done.ok === true ? tt('compile.recompileSent') : tt('compile.recompileFailed') })
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
  }, [selectionQuoteEnabled, tt])

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
    setOutlineError(undefined)
    setOutlineDebug(undefined)
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

  // Poll the fixed workspace handoff file after submission. A changed
  // revision must remain identical across two polls before it is accepted, so
  // a partially-written file never lands in the custom-content box.
  useEffect(() => {
    if (aiOutputWatch === undefined) return
    let disposed = false
    let candidateSignature = ''
    let candidateFirstSeenAt = 0
    const tick = async (): Promise<void> => {
      if (disposed) return
      if (Date.now() - aiOutputWatch.startedAt > 10 * 60_000) {
        setAiOutputWatch(undefined)
        setNote({ ok: false, text: tt('ai.outputTimeout') })
        return
      }
      try {
        const result = await postWorkbench<InsertFileSnapshot>(
          aiOutputWatch.purpose === 'fix' ? '/overleaf/workbench/read-fix-file' : '/overleaf/workbench/read-insert-file',
          { cwd: aiOutputWatch.cwd }, 15_000,
        )
        if (disposed) return
        const signature = insertFileSignature(result)
        if (!result.exists || signature === aiOutputWatch.baselineSignature || typeof result.content !== 'string') return
        if (signature !== candidateSignature) {
          candidateSignature = signature
          candidateFirstSeenAt = Date.now()
          return
        }
        if (Date.now() - candidateFirstSeenAt < 1_000) return
        const clean = cleanAgentInsertContent(result.content)
        setAiOutputWatch(undefined)
        if (clean === '') {
          setNote({ ok: false, text: tt('ai.outputEmpty') })
          return
        }
        if (aiOutputWatch.purpose === 'selection-replace' && aiOutputWatch.selection !== undefined) {
          setSelectionDraft(clean)
          setPendingReplacement(aiOutputWatch.selection)
          setNote({ ok: true, text: tt('selection.outputReady') })
          return
        }
        if (aiOutputWatch.purpose === 'fix') {
          const parsed = parseFixEdits(clean)
          setFixDraft(clean)
          setFixParsed(parsed)
          setNote({
            ok: parsed.ok,
            text: parsed.ok ? tt('compile.fixReady') : tt('compile.fixEmpty'),
          })
          return
        }
        setInsertDraft(clean)
        setNote({ ok: true, text: tt('ai.outputReady') })
      } catch { /* transient; keep polling */ }
    }
    const interval = window.setInterval(() => { void tick() }, 2_000)
    void tick()
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [aiOutputWatch, tt])

  // Keep the waiting hint live while the agent is generating its response.
  useEffect(() => {
    if (aiOutputWatch === undefined) {
      setAiWaitSeconds(0)
      return
    }
    const update = (): void => setAiWaitSeconds(Math.max(0, Math.round((Date.now() - aiOutputWatch.startedAt) / 1_000)))
    update()
    const interval = window.setInterval(update, 1_000)
    return () => window.clearInterval(interval)
  }, [aiOutputWatch])

  // Entry point: land directly on the project dashboard instead of the site
  // root, removing the root->dashboard redirect chain (and any ambiguity
  // around cached/restored intermediate pages).
  const embedBase = embedInfo?.embedUrl ?? '/overleaf-proxy/'
  const embedEntry = `${embedBase}${embedBase.endsWith('/') ? '' : '/'}project`

  const templates: Array<[string, string]> = [
    [tt('insert.section'), LATex_TEMPLATES.section],
    [tt('insert.subsection'), LATex_TEMPLATES.subsection],
    [tt('insert.figure'), LATex_TEMPLATES.figure],
    [tt('insert.table'), LATex_TEMPLATES.table],
    [tt('insert.equation'), LATex_TEMPLATES.equation],
    [tt('insert.bibitem'), LATex_TEMPLATES.bibitem],
  ]

  const captureSelection = useCallback((): void => {
    try {
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      if (text.trim() === '') {
        setNote({ ok: false, text: tt('ai.captureEmpty') })
        return
      }
      setInsertDraft(text)
      setNote({ ok: true, text: tt('ai.captured') })
    } catch (error) {
      setNote({ ok: false, text: String(error) })
    }
  }, [tt])

  const sendToAgent = useCallback((): void => {
    const requestedText = aiPrompt.trim()
    if (requestedText === '') {
      setNote({ ok: false, text: tt('insert.emptyInput') })
      return
    }
    if (inputActions?.setDraft === undefined || inputActions?.submit === undefined) {
      setNote({ ok: false, text: tt('ai.composerUnavailable') })
      return
    }
    if (aiOutputWatch !== undefined) return
    setAiBusy(true)
    cursorContextRef.current = undefined
    const cwd = sessionId === undefined ? undefined : sessionWorkspaceHint(sessionId)
    sendToFrame({ type: 'cursor-context-request', radius: attachFullDoc ? 200_000 : 1200 })
    void (async () => {
      try {
        const [baseline] = await Promise.all([
          cwd === undefined
            ? Promise.resolve<InsertFileSnapshot | undefined>(undefined)
            : postWorkbench<InsertFileSnapshot>('/overleaf/workbench/read-insert-file', { cwd }, 15_000)
                .catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 350)),
        ])
        const parts: string[] = [`【任务】${requestedText}`]
        parts.push('【输出要求】只输出最终需要插入或替换的 LaTeX 内容本身，不要解释，不要使用代码块围栏。')
        parts.push('【重要交付】全部生成完成后，请把最终要插入的完整 LaTeX 内容原样写入当前工作区文件 dsh-overleaf-insert.md。该文件只能包含最终内容，不要代码块围栏、标题、解释或过程文字；写完文件后再结束回复。')
        const ctx = cursorContextRef.current
        if (attachContext && ctx !== undefined) {
          parts.push('【光标前的文档内容】\n' + ctx.before)
          parts.push('【光标后的文档内容】\n' + ctx.after)
        }
        const prompt = parts.join('\n')
        inputActions?.setDraft(prompt)
        inputActions?.submit()
        setAiPrompt('')
        if (cwd !== undefined && baseline !== undefined) {
          setAiOutputWatch({ cwd, baselineSignature: insertFileSignature(baseline), startedAt: Date.now(), purpose: 'insert' })
          setNote({ ok: true, text: tt('ai.sent') })
        } else {
          setNote({ ok: false, text: tt('ai.autoCaptureUnavailable') })
        }
      } catch (error) {
        setNote({ ok: false, text: String(error) })
      } finally {
        setAiBusy(false)
      }
    })()
  }, [aiPrompt, aiOutputWatch, attachContext, attachFullDoc, inputActions, sendToFrame, sessionId, tt])

  const sendSelectionToAgent = useCallback((mode: 'ask' | 'modify'): void => {
    const target = selectionTarget
    const requestedText = selectionPrompt.trim()
    if (target === undefined || target.text.trim() === '') {
      setNote({ ok: false, text: tt('selection.empty') })
      sendToFrame({ type: 'selection-request' })
      return
    }
    if (requestedText === '') {
      setNote({ ok: false, text: tt('selection.requirementEmpty') })
      return
    }
    if (mode === 'modify' && (target.selectionId === undefined || target.engine === 'dom')) {
      setNote({ ok: false, text: tt('selection.notReplaceable') })
      return
    }
    if (inputActions?.setDraft === undefined || inputActions?.submit === undefined) {
      setNote({ ok: false, text: tt('ai.composerUnavailable') })
      return
    }
    if (aiOutputWatch !== undefined || aiBusy) return
    setAiBusy(true)
    void (async () => {
      try {
        const prompt = buildSelectionAgentPrompt(mode, requestedText, target.text)
        if (mode === 'ask') {
          inputActions.setDraft(prompt)
          inputActions.submit()
          setSelectionPrompt('')
          setNote({ ok: true, text: tt('selection.askSent') })
          return
        }

        const cwd = sessionId === undefined ? undefined : sessionWorkspaceHint(sessionId)
        const baseline = cwd === undefined
          ? undefined
          : await postWorkbench<InsertFileSnapshot>('/overleaf/workbench/read-insert-file', { cwd }, 15_000)
              .catch(() => undefined)
        await new Promise<void>(resolve => setTimeout(resolve, 250))
        inputActions.setDraft(prompt)
        inputActions.submit()
        setSelectionPrompt('')
        setSelectionDraft('')
        setPendingReplacement(undefined)
        if (cwd !== undefined && baseline !== undefined) {
          setAiOutputWatch({
            cwd,
            baselineSignature: insertFileSignature(baseline),
            startedAt: Date.now(),
            purpose: 'selection-replace',
            selection: target,
          })
          setNote({ ok: true, text: tt('selection.modifySent') })
        } else {
          setNote({ ok: false, text: tt('ai.autoCaptureUnavailable') })
        }
      } catch (error) {
        setNote({ ok: false, text: String(error) })
      } finally {
        setAiBusy(false)
      }
    })()
  }, [aiBusy, aiOutputWatch, inputActions, selectionPrompt, selectionTarget, sessionId, sendToFrame, tt])

  const replaceSelectedText = useCallback((): void => {
    if (selectionDraft.trim() === '') {
      setNote({ ok: false, text: tt('selection.outputEmpty') })
      return
    }
    if (pendingReplacement?.selectionId === undefined) {
      setNote({ ok: false, text: tt('selection.stale') })
      return
    }
    sendToFrame({ type: 'replace-selection', selectionId: pendingReplacement.selectionId, text: selectionDraft })
  }, [pendingReplacement, selectionDraft, sendToFrame, tt])

  const openCompileTab = useCallback((): void => {
    setPanelTab('compile')
    sendToFrame({ type: 'compile-log-request' })
  }, [sendToFrame])

  const sendFixToAgent = useCallback((): void => {
    if (inputActions?.setDraft === undefined || inputActions?.submit === undefined) {
      setNote({ ok: false, text: tt('ai.composerUnavailable') })
      return
    }
    if (aiOutputWatch !== undefined || aiBusy) return
    if (compileInfo === undefined || compileInfo.items.length === 0) {
      setNote({ ok: false, text: tt('compile.empty') })
      sendToFrame({ type: 'compile-log-request' })
      return
    }
    setAiBusy(true)
    docRef.current = undefined
    const docRequest = new Promise<{ name: string; text: string } | undefined>(resolve => {
      const started = Date.now()
      const timer = window.setInterval(() => {
        if (docRef.current !== undefined) {
          window.clearInterval(timer)
          resolve(docRef.current)
        } else if (Date.now() - started > 4_500) {
          window.clearInterval(timer)
          resolve(undefined)
        }
      }, 100)
      sendToFrame({ type: 'document-request' })
    })
    void (async () => {
      try {
        const documentSnapshot = await docRequest
        if (documentSnapshot === undefined || documentSnapshot.text.trim() === '') {
          setNote({ ok: false, text: tt('compile.staleDoc') })
          return
        }
        const cwd = sessionId === undefined ? undefined : sessionWorkspaceHint(sessionId)
        const baseline = cwd === undefined
          ? undefined
          : await postWorkbench<InsertFileSnapshot>('/overleaf/workbench/read-fix-file', { cwd }, 15_000)
              .catch(() => undefined)
        const logText = compileInfo.files.map(file => file.text).join('\n')
        const prompt = buildFixCompilePrompt({
          logText: logText.slice(0, 120_000),
          docText: documentSnapshot.text.slice(0, 120_000),
          docName: documentSnapshot.name,
          errors: compileInfo.errors,
          warnings: compileInfo.warnings,
        })
        inputActions?.setDraft(prompt)
        inputActions?.submit()
        setFixDraft('')
        setFixParsed(undefined)
        if (cwd !== undefined && baseline !== undefined) {
          setAiOutputWatch({ cwd, baselineSignature: insertFileSignature(baseline), startedAt: Date.now(), purpose: 'fix' })
          setNote({ ok: true, text: tt('compile.fixSent') })
        } else {
          setNote({ ok: false, text: tt('ai.autoCaptureUnavailable') })
        }
      } catch (error) {
        setNote({ ok: false, text: String(error) })
      } finally {
        setAiBusy(false)
      }
    })()
  }, [aiBusy, aiOutputWatch, compileInfo, inputActions, sendToFrame, sessionId, tt])

  const applyFix = useCallback((): void => {
    if (fixDraft.trim() === '') {
      setNote({ ok: false, text: tt('compile.fixEmpty') })
      return
    }
    const parsed = parseFixEdits(fixDraft)
    if (!parsed.ok) {
      setNote({ ok: false, text: tt('compile.fixEmpty') })
      return
    }
    sendToFrame({ type: 'apply-fix-edits', edits: parsed.edits.map(edit => ({ old: edit.old, new: edit.new })) })
  }, [fixDraft, sendToFrame, tt])

  return (
    <div className="dso-root">
      <div className="dso-toolbar">
        <span className="dso-toolbar-title">Overleaf</span>
        <button className="dso-btn" title={tt('toolbar.reload')} onClick={() => { try { frameRef.current?.contentWindow?.location.reload() } catch { /* cross-doc reload race */ } }}>⟳</button>
        <button
          className="dso-btn"
          title={tt('toolbar.openWindow')}
          onClick={() => { window.open(`${location.origin}${embedEntry}`, '_blank') }}
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
          ? <button className="dso-btn" data-open={panelOpen ? '1' : undefined} onClick={() => setPanelOpen(open => !open)}>{tt('toolbar.panel')}</button>
          : null}
      </div>
      <div className="dso-hint">
        {status?.baseUrl ?? ''}
        {workspaceHint !== undefined ? ` · ${workspaceHint}` : ''}
      </div>
      <div className="dso-stage" ref={stageRef}>
        {/* The persistent iframe lives at body level (see ensurePersistentFrame)
            and is positioned over this stage area via fixed geometry; it is
            hidden — never destroyed — when the tab or session changes. */}
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
                    ['selection', tt('panel.tabSelection'), () => { setPanelTab('selection'); sendToFrame({ type: 'selection-request' }) }],
                    ['compile', tt('panel.tabCompile'), openCompileTab],
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
                      <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('ai.title')}</div>
                      <textarea
                        className="dso-textarea"
                        value={aiPrompt}
                        onChange={event => setAiPrompt(event.target.value)}
                        placeholder={tt('ai.placeholder')}
                      />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                        <input type="checkbox" checked={attachContext} onChange={event => setAttachContext(event.target.checked)} />
                        <span>{tt('ai.attachContext')}</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                        <input type="checkbox" checked={attachFullDoc} onChange={event => setAttachFullDoc(event.target.checked)} />
                        <span>{tt('ai.attachFullDoc')}</span>
                      </label>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="dso-btn dso-btn-primary" disabled={aiBusy || aiOutputWatch !== undefined} onClick={sendToAgent}>{tt('ai.send')}</button>
                        <button className="dso-btn" onClick={captureSelection}>{tt('ai.captureSelection')}</button>
                      </div>
                      {aiBusy && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span>{tt('ai.preparing')}</span>
                        </div>
                      )}
                      {aiOutputWatch?.purpose === 'insert' && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span style={{ flex: 1 }}>{tt('ai.waiting').replace('{seconds}', String(aiWaitSeconds))}</span>
                          <button className="dso-btn" onClick={() => { setAiOutputWatch(undefined); setNote({ ok: true, text: tt('ai.waitCanceled') }) }}>{tt('ai.cancelWait')}</button>
                        </div>
                      )}
                      <div className="dso-muted">{tt('ai.hint')}</div>
                      <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('insert.templateLabel')}</div>
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
                  {panelTab === 'selection' && (
                    <>
                      <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('selection.title')}</div>
                      <div className="dso-muted">{tt('selection.hint')}</div>
                      <button className="dso-btn" onClick={() => sendToFrame({ type: 'selection-request' })}>{tt('selection.refresh')}</button>
                      <textarea
                        className="dso-textarea"
                        readOnly
                        value={selectionTarget?.text ?? ''}
                        placeholder={tt('selection.empty')}
                        style={{ minHeight: 96 }}
                      />
                      {selectionTarget !== undefined && (
                        <div className="dso-muted">
                          {tt('selection.detected')
                            .replace('{chars}', String(selectionTarget.text.length))
                            .replace('{engine}', selectionTarget.engine)}
                        </div>
                      )}
                      <textarea
                        className="dso-textarea"
                        value={selectionPrompt}
                        onChange={event => setSelectionPrompt(event.target.value)}
                        placeholder={tt('selection.placeholder')}
                      />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        <button
                          className="dso-btn"
                          disabled={aiBusy || aiOutputWatch !== undefined || selectionTarget === undefined}
                          onClick={() => sendSelectionToAgent('ask')}
                        >{tt('selection.ask')}</button>
                        <button
                          className="dso-btn dso-btn-primary"
                          disabled={aiBusy || aiOutputWatch !== undefined || selectionTarget?.selectionId === undefined}
                          onClick={() => sendSelectionToAgent('modify')}
                        >{tt('selection.modify')}</button>
                      </div>
                      {aiBusy && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span>{tt('ai.preparing')}</span>
                        </div>
                      )}
                      {aiOutputWatch?.purpose === 'selection-replace' && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span style={{ flex: 1 }}>{tt('selection.waiting').replace('{seconds}', String(aiWaitSeconds))}</span>
                          <button className="dso-btn" onClick={() => { setAiOutputWatch(undefined); setNote({ ok: true, text: tt('ai.waitCanceled') }) }}>{tt('ai.cancelWait')}</button>
                        </div>
                      )}
                      <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('selection.result')}</div>
                      <textarea
                        className="dso-textarea"
                        value={selectionDraft}
                        onChange={event => setSelectionDraft(event.target.value)}
                        placeholder={tt('selection.resultPlaceholder')}
                        style={{ minHeight: 110 }}
                      />
                      <button
                        className="dso-btn dso-btn-primary"
                        disabled={!cursorInsertEnabled || pendingReplacement?.selectionId === undefined || selectionDraft.trim() === ''}
                        onClick={replaceSelectedText}
                      >{tt('selection.replace')}</button>
                      <div className="dso-muted">{tt('selection.safety')}</div>
                    </>
                  )}
                  {panelTab === 'compile' && (
                    <>
                      <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('compile.title')}</div>
                      <div className="dso-muted">{tt('compile.hint')}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        <button className="dso-btn" onClick={() => sendToFrame({ type: 'compile-log-request' })}>{tt('compile.refresh')}</button>
                        <button className="dso-btn" onClick={() => sendToFrame({ type: 'recompile-click' })}>{tt('compile.recompile')}</button>
                      </div>
                      {compileInfo === undefined ? (
                        <div className="dso-muted">{tt('compile.empty')}</div>
                      ) : (
                        <>
                          <div className="dso-muted">
                            {tt('compile.summary')
                              .replace('{status}', compileInfo.status)
                              .replace('{errors}', String(compileInfo.errors))
                              .replace('{warnings}', String(compileInfo.warnings))}
                          </div>
                          <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('compile.listTitle')}</div>
                          {compileInfo.items.length === 0
                            ? <div className="dso-muted">{tt('compile.noIssue')}</div>
                            : (
                                <div className="dso-log-list">
                                  {compileInfo.items.slice(0, 40).map((item, index) => (
                                    <div key={`${index}-${item.message.slice(0, 12)}`} className="dso-log-row" data-level={item.level}>
                                      <span className="dso-log-badge">{item.level === 'error' ? 'E' : 'W'}</span>
                                      <span className="dso-log-text">
                                        {item.file !== undefined ? `${item.file}${item.line !== undefined ? `:${item.line}` : ''} ` : ''}
                                        {item.message}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                          <button
                            className="dso-btn dso-btn-primary"
                            disabled={aiBusy || aiOutputWatch !== undefined || compileInfo.items.length === 0}
                            onClick={sendFixToAgent}
                          >{tt('compile.fix')}</button>
                        </>
                      )}
                      {aiBusy && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span>{tt('ai.preparing')}</span>
                        </div>
                      )}
                      {aiOutputWatch?.purpose === 'fix' && (
                        <div className="dso-ai-wait" role="status" aria-live="polite">
                          <span className="dso-ai-spinner" aria-hidden="true" />
                          <span style={{ flex: 1 }}>{tt('compile.waiting').replace('{seconds}', String(aiWaitSeconds))}</span>
                          <button className="dso-btn" onClick={() => { setAiOutputWatch(undefined); setNote({ ok: true, text: tt('ai.waitCanceled') }) }}>{tt('ai.cancelWait')}</button>
                        </div>
                      )}
                      {fixDraft !== '' && (
                        <>
                          <div className="dso-muted" style={{ fontWeight: 600 }}>{tt('compile.result')}</div>
                          {fixParsed !== undefined && (
                            <div className="dso-muted">
                              {fixParsed.ok
                                ? tt('compile.editsCount').replace('{count}', String(fixParsed.edits.length))
                                : fixParsed.remark !== undefined
                                  ? tt('compile.fixRemark').replace('{remark}', fixParsed.remark.slice(0, 240))
                                  : tt('compile.fixEmpty')}
                            </div>
                          )}
                          <textarea
                            className="dso-textarea"
                            value={fixDraft}
                            onChange={event => { setFixDraft(event.target.value); setFixParsed(parseFixEdits(event.target.value)) }}
                            style={{ minHeight: 130 }}
                          />
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            <button
                              className="dso-btn dso-btn-primary"
                              disabled={!cursorInsertEnabled || fixDraft.trim() === ''}
                              onClick={applyFix}
                            >{tt('compile.apply')}</button>
                          </div>
                          <div className="dso-muted">{tt('compile.reviewNote')}</div>
                        </>
                      )}
                    </>
                  )}
                  {panelTab === 'outline' && (
                    <>
                      <button className="dso-btn" onClick={requestOutline}>{tt('outline.refresh')}</button>
                      {outlineItems === undefined
                        ? <div className="dso-muted">…</div>
                        : outlineItems.length === 0
                          ? <div className="dso-muted">{outlineError === undefined ? tt('outline.empty') : tt('outline.noEditor')}</div>
                          : outlineItems.map((item, index) => (
                              <div
                                key={`${index}-${item.line ?? 0}`}
                                className="dso-outline-row"
                                style={{ paddingLeft: outlineIndent(item.level) }}
                                onClick={() => { if (item.line !== undefined || item.text !== undefined) sendToFrame({ type: 'reveal', query: item.text, line: item.line }) }}
                              >
                                <span>{item.title}</span>
                                <small>{item.level}</small>
                              </div>
                          ))}
                      {outlineDebug !== undefined && <div className="dso-muted">bridge: {outlineDebug}</div>}
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
