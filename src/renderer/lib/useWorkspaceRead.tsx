import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'

/** A failed initial read never hydrates a default workspace or enables autosave.
 * Manual retries are one request each; a failed refresh keeps the last good view. */
export function useWorkspaceRead(reader: { load(): Promise<Workspace> }, hydrate: (workspace: Workspace) => void) {
  const hydrateRef = useRef(hydrate)
  hydrateRef.current = hydrate
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    setPending(true)
    void reader.load().then((workspace) => {
      if (cancelled) return
      hydrateRef.current(workspace)
      setLoaded(true)
      setError(null)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(`Workspace revision load failed: ${String(reason)}`)
    }).finally(() => { if (!cancelled) setPending(false) })
    return () => { cancelled = true }
  }, [reader, attempt])
  return { error, pending, loaded, retry: () => setAttempt((value) => value + 1) }
}

export function WorkspaceReadNotice({ error, pending, retry }: Pick<ReturnType<typeof useWorkspaceRead>, 'error' | 'pending' | 'retry'>) {
  return error ? <div role="alert" style={{ padding: 8 }}>{error}{' '}
    <button disabled={pending} onClick={retry}>Retry workspace read</button>
  </div> : null
}
