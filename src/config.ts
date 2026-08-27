/**
 * Host plugin configuration schema. Every field is deployment-overridable from
 * the profile row (cordis.patch.yml / plugin settings page); credentials never
 * appear here.
 */
import z from '@deepseek-ai/schemastery'

/** Browser choices for the direct-CDP login window. */
export type OverleafBrowserChannel = 'auto' | 'default' | 'msedge' | 'chrome' | 'real'

/** How the login browser profile persists between login attempts. */
export type LoginProfileMode = 'persistent' | 'temporary'

/** Declared config shape; every field optional so defaults apply. */
export interface WorkbenchConfig {
  /** Upstream Overleaf origin (public cloud or self-hosted such as tex.nju.edu.cn). */
  baseUrl?: string
  /** Browser selection for the CDP login window. */
  browserChannel?: OverleafBrowserChannel
  /** Explicit Chromium-family executable tried first (third-party browsers). */
  browserPath?: string
  /** Login wait timeout in milliseconds before falling back to manual paste. */
  loginTimeoutMs?: number
  /** Login profile persistence mode. */
  loginProfile?: LoginProfileMode
  /** Show the floating selection-quote toolbar over the embedded editor (R5). */
  selectionQuoteEnabled?: boolean
  /** Accept cursor-insert commands inside the embedded editor (R6). */
  cursorInsertEnabled?: boolean
  /** Inject the bridge script into proxied HTML pages. */
  injectScriptEnabled?: boolean
  /** Show the assist panel (insert templates, outline, status) in the view (R7). */
  assistPanelEnabled?: boolean
}

/** Default upstream: NJU self-hosted Overleaf (the primary target audience). */
const DEFAULT_BASE_URL = 'https://tex.nju.edu.cn'
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000

export const Config: z<WorkbenchConfig> = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  browserChannel: z.union([
    z.const('auto'),
    z.const('default'),
    z.const('msedge'),
    z.const('chrome'),
    z.const('real'),
  ]).default('auto'),
  browserPath: z.string(),
  loginTimeoutMs: z.natural().default(DEFAULT_LOGIN_TIMEOUT_MS),
  loginProfile: z.union([z.const('persistent'), z.const('temporary')]).default('persistent'),
  selectionQuoteEnabled: z.boolean().default(true),
  cursorInsertEnabled: z.boolean().default(true),
  injectScriptEnabled: z.boolean().default(true),
  compileAssistEnabled: z.boolean().default(true),
})

/** Parsed config with every default applied. */
export interface ResolvedConfig {
  baseUrl: string
  browserChannel: OverleafBrowserChannel
  browserPath?: string
  loginTimeoutMs: number
  loginProfile: LoginProfileMode
  selectionQuoteEnabled: boolean
  cursorInsertEnabled: boolean
  injectScriptEnabled: boolean
  assistPanelEnabled: boolean
}

/** Apply defaults in the owning implementation, never hidden inside methods. */
export function resolveConfig(config: WorkbenchConfig): ResolvedConfig {
  const channel = config.browserChannel ?? 'auto'
  return {
    baseUrl: normalizeOrigin(config.baseUrl ?? DEFAULT_BASE_URL),
    browserChannel: channel,
    ...(config.browserPath !== undefined && config.browserPath.trim() !== ''
      ? { browserPath: config.browserPath.trim() }
      : {}),
    loginTimeoutMs: config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    loginProfile: config.loginProfile ?? 'persistent',
    selectionQuoteEnabled: config.selectionQuoteEnabled ?? true,
    cursorInsertEnabled: config.cursorInsertEnabled ?? true,
    injectScriptEnabled: config.injectScriptEnabled ?? true,
    assistPanelEnabled: config.assistPanelEnabled ?? true,
  }
}

/**
 * Normalize one configured origin: add https:// when scheme-less, trim
 * trailing slashes, reject anything carrying a path/query/hash. Used instead
 * of URL parsing failures to keep a bad entry from blocking service startup —
 * falls back to the default upstream.
 */
export function normalizeOrigin(raw: string): string {
  let candidate = raw.trim()
  if (candidate === '') return DEFAULT_BASE_URL
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `https://${candidate}`
  try {
    const url = new URL(candidate)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.pathname.replace(/\/+$/, '') !== ''
      || url.search !== '' || url.hash !== '') {
      return DEFAULT_BASE_URL
    }
    return url.origin
  } catch {
    return DEFAULT_BASE_URL
  }
}
