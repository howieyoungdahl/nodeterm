import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Workspace } from '@shared/types'

/** A failed first read must never install or save an empty workspace. */
export function useWorkspaceStartup(load: () => Promise<Workspace>, hydrate: (workspace: Workspace) => void) {
  const callbacks = useRef({ load, hydrate })
  callbacks.current = { load, hydrate }
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0
    setFailed(false)
    const run = async () => {
      try {
        const workspace = await callbacks.current.load()
        if (cancelled) return
        callbacks.current.hydrate(workspace)
        setReady(true)
      } catch {
        if (cancelled) return
        if (++attempts < 6) timer = setTimeout(() => void run(), Math.min(500 * 2 ** (attempts - 1), 8000))
        else setFailed(true)
      }
    }
    void run()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [generation])
  return { ready, failed, retry: () => setGeneration(value => value + 1) }
}

export function WorkspaceStartupGate({ ready, failed, retry, children }: {
  ready: boolean; failed: boolean; retry: () => void; children: ReactNode
}) {
  if (ready) return <>{children}</>
  return <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[var(--bg)]" role="status">
    <p>{failed ? 'Workspace could not be loaded.' : 'Loading workspace…'}</p>
    {failed && <button type="button" onClick={retry}>Retry loading</button>}
  </div>
}
