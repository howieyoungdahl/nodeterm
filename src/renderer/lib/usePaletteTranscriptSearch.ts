import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptHit } from '@shared/types'
import { E_UNSUPPORTED } from '@shared/rpc'

export type PaletteTranscriptStatus = 'idle' | 'loading' | 'success' | 'unavailable' | 'error'
const searchTranscripts = (query: string) => window.nodeTerminal.transcripts.search(query)

/** One palette opening owns its searches. Cancellation invalidates in-flight work as well
 * as the debounce, including an old response for the same query in a later opening. */
export function usePaletteTranscriptSearch(open: boolean, search = searchTranscripts) {
  const [hits, setHits] = useState<TranscriptHit[]>([])
  const [status, setStatus] = useState<PaletteTranscriptStatus>('idle')
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback(() => {
    generation.current++
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const reset = useCallback(() => {
    cancel()
    setHits([])
    setStatus('idle')
  }, [cancel])

  useEffect(() => {
    reset()
    return cancel
  }, [open, search, reset, cancel])

  const onQueryChange = useCallback((query: string) => {
    reset()
    if (!open || query.trim().length < 2) return
    const mine = generation.current
    setStatus('loading')
    timer.current = setTimeout(() => {
      timer.current = null
      // Promise adoption also handles a synchronous bridge failure.
      void Promise.resolve().then(() => search(query)).then((result) => {
        if (generation.current !== mine) return
        setHits(result)
        setStatus('success')
      }).catch((reason: unknown) => {
        if (generation.current !== mine) return
        setStatus(reason && typeof reason === 'object' && 'code' in reason && reason.code === E_UNSUPPORTED
          ? 'unavailable' : 'error')
      })
    }, 180)
  }, [open, search, reset])

  return { hits, status, onQueryChange, reset }
}
