import { useCallback, useEffect, useRef, useState } from 'react'
import { autosaveDelay, nextSaveDelivery, type SaveDelivery } from './savePersistence'

/** Every workspace write, including hydration, reports rejection to the same retry loop. */
export function useSavePersistence() {
  const [delivery, setDelivery] = useState<SaveDelivery | undefined>()
  const attemptSave = useCallback(async (write: () => Promise<void>): Promise<boolean> => {
    try {
      await write()
      setDelivery(undefined)
      return true
    } catch (error) {
      console.warn('[canvas] workspace save failed', error)
      setDelivery((previous) => nextSaveDelivery(previous, Date.now()))
      return false
    }
  }, [])
  const retrySave = useCallback(() => setDelivery(undefined), [])
  return { delivery, attemptSave, retrySave }
}

/** Saves the workspace ONCE, right after the React commit that created a terminal-backed card.
 *
 *  The debounced `useAutosave` below is a trailing 800 ms timer, so a brand-new card is not on
 *  disk for at least that long — and in the field the first save carrying one landed 4.5 s to 55 s
 *  after the card was minted. Anything server-side that decides from the file (agent-hook
 *  recovery, canvas-control source resolution) loses that race, so a creation path asks for an
 *  immediate flush on top of the debounce. The extra save is harmless: the store serializes saves
 *  on its chain and skips a write whose content is unchanged.
 *
 *  `requestFlush()` bumps a counter; the effect keyed on it runs AFTER the commit, so the node
 *  the caller just added is already in `nodesRef` when `persist` serializes. `enabled` is false
 *  while the conflict bar is open (that bar deliberately suspends autosave so the timer cannot
 *  silently "keep mine") and while a programmatic project load is in flight — a request made
 *  while disabled is DROPPED, not queued, exactly like `markDirty`'s `loadingRef` no-op.
 */
export function useCreateFlush(persist: () => Promise<void>, enabled: boolean): () => void {
  const [request, setRequest] = useState(0)
  /** The last request this hook has already decided about — served or deliberately dropped. */
  const settledRef = useRef(0)
  const requestFlush = useCallback(() => setRequest((v) => v + 1), [])
  useEffect(() => {
    if (request === settledRef.current) return
    // Settle FIRST: a request is decided exactly once, so re-enabling later (or `persist` merely
    // changing identity) can never replay a flush that was already served or dropped.
    settledRef.current = request
    if (!enabled) return
    void persist()
  }, [request, enabled, persist])
  return requestFlush
}

export function useAutosave(
  dirty: boolean,
  conflictOpen: boolean,
  persist: () => Promise<void>,
  resaveTick: number,
  delivery: SaveDelivery | undefined
): void {
  useEffect(() => {
    const delay = autosaveDelay(dirty, conflictOpen, delivery)
    if (delay === null) return
    const timer = setTimeout(() => void persist(), delay)
    return () => clearTimeout(timer)
    // A failure leaves dirty unchanged. Delivery MUST re-arm the timer even without another edit.
  }, [dirty, conflictOpen, persist, resaveTick, delivery])
}
