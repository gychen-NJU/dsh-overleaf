/** Product-neutral entry: let the upstream redirect / to its own dashboard. */
export const WORKBENCH_HOME = '/overleaf-proxy/'
export const WORKBENCH_SETTINGS_CHANGED = 'dsh-overleaf:settings-changed'

export function workbenchEntry(embedUrl?: string): string {
  // Only host-owned same-origin proxy paths are valid frame destinations.
  if (embedUrl?.startsWith(WORKBENCH_HOME) && !/[\\\r\n]/.test(embedUrl)) {
    const parsed = new URL(embedUrl, 'http://workbench.invalid')
    if (parsed.pathname.startsWith(WORKBENCH_HOME)) return parsed.pathname + parsed.search + parsed.hash
  }
  return WORKBENCH_HOME
}

interface WorkbenchFrame {
  src: string
  dataset: { upstreamOrigin?: string }
}

export function navigateToWorkbenchHome(frame: WorkbenchFrame | null, embedUrl?: string): void {
  if (frame !== null) frame.src = workbenchEntry(embedUrl)
}

/** Preserve an open project on tab switches, but never on upstream switches. */
export function updateFrameUpstream(frame: WorkbenchFrame, origin: string, embedUrl?: string): boolean {
  const previous = frame.dataset.upstreamOrigin
  frame.dataset.upstreamOrigin = origin
  if (previous === undefined || previous === origin) return false
  navigateToWorkbenchHome(frame, embedUrl)
  return true
}
