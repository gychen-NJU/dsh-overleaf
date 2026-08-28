/** Snapshot returned by the fixed workspace handoff-file route. */
export interface InsertFileSnapshot {
  exists: boolean
  content?: string | undefined
  mtimeMs?: number | undefined
}

/**
 * Stable identity for one handoff-file revision. Including mtime lets a new
 * agent run intentionally return the same LaTeX text as an earlier run.
 */
export function insertFileSignature(snapshot: InsertFileSnapshot): string {
  if (!snapshot.exists) return 'missing'
  return `${snapshot.mtimeMs ?? 0}\u0000${snapshot.content ?? ''}`
}

/**
 * Remove presentation wrappers while preserving the LaTeX payload exactly.
 * The prompt asks for a plain file, but agents occasionally still wrap the
 * whole answer in a Markdown `latex`/`tex` code fence.
 */
export function cleanAgentInsertContent(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const fenced = trimmed.match(/^```(?:latex|tex)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i)
  return (fenced?.[1] ?? trimmed).trim()
}
