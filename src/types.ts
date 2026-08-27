/**
 * Wire-facing types shared across the dsh-overleaf host half.
 */

/** Common JSON response envelope for the /overleaf/workbench/* routes. */
export interface WorkbenchWireResponse<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** Login status reported by /overleaf/workbench/status. */
export interface WorkbenchStatus {
  /** A session-cookie credential is stored (not necessarily still valid). */
  loggedIn: boolean
  /** Configured upstream origin. */
  baseUrl: string
  /** Origin actually embedded by the view iframe today. */
  embedUrl: string
  /** True once the proxy routes are registered. */
  proxyReady: boolean
}/** One project listed through the upstream dashboard API/HTML. */
export interface WorkbenchProject {
  id: string
  name: string
  lastUpdated?: string | undefined
}

/** Result of a CDP or manual login attempt. */
export interface WorkbenchLoginResult {
  kind: 'automatic' | 'manual'
  loginUrl?: string | undefined
  instructions?: string | undefined
}
