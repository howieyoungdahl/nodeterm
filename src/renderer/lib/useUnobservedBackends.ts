import { useEffect, useRef, useState } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import { probeUnobservedBackends, type BackendObservation, type BackendProbeTarget } from './unobservedBackend'

/** Sidebar-owned display cache. Nothing reaches agentStatus, localStorage or workspace saves. */
export function useUnobservedBackends(
  open: boolean,
  api: NodeTerminalApi,
  targets: BackendProbeTarget[]
): Record<string, BackendObservation> {
  const [state, setState] = useState<{ api: NodeTerminalApi; observations: Record<string, BackendObservation> }>({ api, observations: {} })
  const latest = useRef(targets)
  latest.current = targets
  const passRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    setState({ api, observations: {} })
    if (!open) return
    let disposed = false
    let inFlight = false
    let cache: Record<string, BackendObservation> = {}
    const pass = async (): Promise<void> => {
      if (disposed || inFlight) return
      inFlight = true
      try {
        const next = await probeUnobservedBackends({
          targets: () => latest.current,
          observations: cache,
          probe: typeof api.nodePaneEvidence === 'function'
            ? (ids) => api.nodePaneEvidence(ids) : undefined
        })
        if (disposed) return
        // Drop removed/filtered nodes so a long-lived sidebar cache cannot grow indefinitely.
        const retained: Record<string, BackendObservation> = {}
        for (const target of latest.current) {
          const observation = next[target.id] ?? cache[target.id]
          if (observation) retained[target.id] = observation
        }
        cache = retained
        setState({ api, observations: cache })
      } finally {
        inFlight = false
      }
    }
    passRef.current = pass
    void pass()
    const timer = window.setInterval(() => void pass(), 60_000)
    return () => {
      disposed = true
      passRef.current = null
      window.clearInterval(timer)
    }
  }, [open, api])

  useEffect(() => { void passRef.current?.() }, [targets])
  // A different core may reuse the same node ids. Do not display the old core's cache for even
  // the render before this effect resets it.
  return open && state.api === api ? state.observations : {}
}
