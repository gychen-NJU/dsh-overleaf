/** Client-half shared helpers: route POSTs with the shared wire envelope. */

export interface WireEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** POST one bounded JSON payload to a workbench host route. */
export async function postWorkbench<T>(path: string, payload: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = await response.json() as WireEnvelope<T>
    if (!response.ok || !body.ok || body.value === undefined) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`)
    }
    return body.value
  } finally {
    clearTimeout(timer)
  }
}

export interface WorkbenchStatusWire {
  loggedIn: boolean
  baseUrl: string
  embedUrl: string
  proxyReady: boolean
  editorAssistEnabled?: boolean | undefined
}

export interface EmbedInfo {
  baseUrl: string
  embedUrl: string
  selectionQuoteEnabled: boolean
  cursorInsertEnabled: boolean
  assistPanelEnabled: boolean
}
