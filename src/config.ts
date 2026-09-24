/**
 * Host plugin configuration schema. Every field is deployment-overridable from
 * the profile row and, from DSH 0.1.7 on, live-editable from the Plugins page:
 * dsh-settings projects a form from the schema's `.volatile()` fields alone
 * (`volatileForm` omits an entry with none), keeps those values in a live
 * reference the Loader mutates in place, and re-emits `loader/volatile-update`
 * on the owning fiber instead of remounting the plugin. Reading a field
 * therefore always goes through {@link readField}. Credentials never appear here.
 */
import z from '@deepseek-ai/schemastery'

/** Browser choices for the direct-CDP login window. */
export type OverleafBrowserChannel = 'auto' | 'default' | 'msedge' | 'chrome' | 'real'

/** How the login browser profile persists between login attempts. */
export type LoginProfileMode = 'persistent' | 'temporary'

/**
 * The live reference the Loader substitutes for a `.volatile()` field
 * (cosmokit `createVolatile`): a frozen object whose `get()` returns the
 * current value and whose snapshot is replaced in place on every commit.
 */
export interface VolatileRef<T> {
  get(): T
}

/** Structural test for a live reference — importing cosmokit is not required. */
export function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read one configuration field. Volatile fields arrive as live references and
 * must be sampled per use; plain values (older harness generations, hand-edited
 * patches) pass through unchanged.
 */
export function readField<T>(value: T | VolatileRef<T> | undefined): T | undefined {
  return isVolatileRef(value) ? (value.get() as T) : (value as T | undefined)
}

/** Declared config shape; every field optional so defaults apply. */
export interface WorkbenchConfig {
  /** Upstream Overleaf origin (public cloud or self-hosted such as tex.nju.edu.cn). */
  baseUrl?: string | VolatileRef<string>
  /** Browser selection for the CDP login window. */
  browserChannel?: OverleafBrowserChannel | VolatileRef<OverleafBrowserChannel>
  /** Explicit Chromium-family executable tried first (third-party browsers). */
  browserPath?: string | VolatileRef<string>
  /** Proxy for the CDP login browser (e.g. Clash: http://127.0.0.1:7890); empty = system default. */
  loginProxyServer?: string | VolatileRef<string>
  /** Login wait timeout in milliseconds before falling back to manual paste. */
  loginTimeoutMs?: number | VolatileRef<number>
  /** Login profile persistence mode. */
  loginProfile?: LoginProfileMode | VolatileRef<LoginProfileMode>
  /** Show the floating selection-quote toolbar over the embedded editor (R5). */
  selectionQuoteEnabled?: boolean | VolatileRef<boolean>
  /** Accept cursor-insert commands inside the embedded editor (R6). */
  cursorInsertEnabled?: boolean | VolatileRef<boolean>
  /** Inject the bridge script into proxied HTML pages. */
  injectScriptEnabled?: boolean | VolatileRef<boolean>
  /** Show the assist panel (insert templates, outline, status) in the view (R7). */
  assistPanelEnabled?: boolean | VolatileRef<boolean>
}

/** Default upstream: the public Overleaf cloud (user decision, v0.1.3). */
const DEFAULT_BASE_URL = 'https://www.overleaf.com'
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000

/**
 * Every field is `.volatile()`: that is what makes this plugin's row appear in
 * the settings forms (an entry without one is skipped entirely) and what lets a
 * save apply live instead of remounting the plugin.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  browserChannel: z.union([
    z.const('auto'),
    z.const('default'),
    z.const('msedge'),
    z.const('chrome'),
    z.const('real'),
  ]).default('auto').volatile(),
  browserPath: z.string().volatile(),
  loginProxyServer: z.string().volatile(),
  loginTimeoutMs: z.natural().default(DEFAULT_LOGIN_TIMEOUT_MS).volatile(),
  loginProfile: z.union([z.const('persistent'), z.const('temporary')]).default('persistent').volatile(),
  selectionQuoteEnabled: z.boolean().default(true).volatile(),
  cursorInsertEnabled: z.boolean().default(true).volatile(),
  injectScriptEnabled: z.boolean().default(true).volatile(),
  assistPanelEnabled: z.boolean().default(true).volatile(),
})

/** Parsed config with every default applied. */
export interface ResolvedConfig {
  baseUrl: string
  browserChannel: OverleafBrowserChannel
  browserPath?: string
  loginProxyServer?: string
  loginTimeoutMs: number
  loginProfile: LoginProfileMode
  selectionQuoteEnabled: boolean
  cursorInsertEnabled: boolean
  injectScriptEnabled: boolean
  assistPanelEnabled: boolean
}

/**
 * Apply defaults in the owning implementation, never hidden inside methods.
 * Every field is sampled through {@link readField} so a live (volatile)
 * reference reports its current value instead of the reference object.
 */
export function resolveConfig(config: WorkbenchConfig): ResolvedConfig {
  const channel = readField(config.browserChannel) ?? 'auto'
  const browserPathRaw = readField(config.browserPath)
  const browserPath = browserPathRaw !== undefined && browserPathRaw.trim() !== ''
    ? browserPathRaw.trim()
    : undefined
  const loginProxyServerRaw = readField(config.loginProxyServer)
  const loginProxyServer = loginProxyServerRaw !== undefined && loginProxyServerRaw.trim() !== ''
    ? normalizeProxyServer(loginProxyServerRaw)
    : undefined
  return {
    baseUrl: normalizeOrigin(readField(config.baseUrl) ?? DEFAULT_BASE_URL),
    browserChannel: channel,
    ...(browserPath !== undefined ? { browserPath } : {}),
    ...(loginProxyServer !== undefined ? { loginProxyServer } : {}),
    loginTimeoutMs: readField(config.loginTimeoutMs) ?? DEFAULT_LOGIN_TIMEOUT_MS,
    loginProfile: readField(config.loginProfile) ?? 'persistent',
    selectionQuoteEnabled: readField(config.selectionQuoteEnabled) ?? true,
    cursorInsertEnabled: readField(config.cursorInsertEnabled) ?? true,
    injectScriptEnabled: readField(config.injectScriptEnabled) ?? true,
    assistPanelEnabled: readField(config.assistPanelEnabled) ?? true,
  }
}

/**
 * Normalize a user-supplied proxy server string into the form Chromium's
 * --proxy-server flag accepts (mirrors the dsh-browser helper): a bare port
 * becomes a loopback HTTP proxy, scheme-less host:port gains http://, and
 * full scheme URLs pass through. Empty/invalid yields undefined so the flag
 * is omitted entirely (system VPN / direct).
 */
export function normalizeProxyServer(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `http://${trimmed}`
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
