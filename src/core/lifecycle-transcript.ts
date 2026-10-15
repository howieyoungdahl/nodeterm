/** Bounded-tail scanner. Tool records and file mtimes never establish a completed turn. */
export function latestLifecycleTurn(text: string, provider: string, now: number): { at: number; clean: boolean } | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: { type?: string; timestamp?: unknown; payload?: { type?: string }; message?: { role?: string } }
    try { row = JSON.parse(lines[i]) } catch { continue }
    if (provider === 'codex') {
      if (row.type !== 'event_msg') continue
      if (row.payload?.type === 'task_started') return null
      if (row.payload?.type !== 'task_complete') continue
    } else if (provider === 'claude') {
      // A newer submitted prompt is evidence that the previous assistant is no longer idle.
      if (row.type === 'user') return null
      if (row.type !== 'assistant') continue
    } else return null
    const at = typeof row.timestamp === 'number' ? row.timestamp : typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(at) || at < 0 || at > now) return null
    return { at, clean: provider === 'codex' }
  }
  return null
}
