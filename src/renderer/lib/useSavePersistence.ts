import { useCallback, useEffect, useRef, useState } from 'react'
import { autosaveDelay, nextSaveDelivery, type SaveDelivery } from './savePersistence'

/** Every workspace write, including hydration, reports rejection to the same retry loop. */
export function useSavePersistence() {
  const [delivery, setDelivery] = useState<SaveDelivery | undefined>()
  const [revisionConflict, setRevisionConflict] = useState(false)
  const attemptSave = useCallback(async (write: () => Promise<void>): Promise<boolean> => {
    try {
      await write()
      setDelivery(undefined)
      setRevisionConflict(false)
      return true
    } catch (error) {
      console.warn('[canvas] workspace save failed', error)
      if (error instanceof Error && error.message.includes('workspace_conflict:')) {
        setDelivery(undefined)
        setRevisionConflict(true)
        return false
      }
      setDelivery((previous) => nextSaveDelivery(previous, Date.now()))
      return false
    }
  }, [])
  const retrySave = useCallback(() => { setDelivery(undefined); setRevisionConflict(false) }, [])
  return { delivery, attemptSave, retrySave, revisionConflict }
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
export function useCreateFlush(persist: () => Promise<void>, enabled: boolean, whileDisabled?: () => void): () => void {
  const [request, setRequest] = useState(0)
  /** The last request this hook has already decided about — served or deliberately dropped. */
  const settledRef = useRef(0)
  const requestFlush = useCallback(() => setRequest((v) => v + 1), [])
  useEffect(() => {
    if (request === settledRef.current) return
    // Settle FIRST: a request is decided exactly once, so re-enabling later (or `persist` merely
    // changing identity) can never replay a flush that was already served or dropped.
    settledRef.current = request
    // Still not a save: a disabled flush only REPORTS the canvas (see useSuspendedObserve), so the
    // card just created survives a reload even while the bar holds every write.
    if (!enabled) { whileDisabled?.(); return }
    void persist()
  }, [request, enabled, persist, whileDisabled])
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

/** First report after saves become suspended, and the steady cadence while they stay suspended. */
export const SUSPENDED_REPORT_DELAY_MS = 2_000
export const SUSPENDED_REPORT_INTERVAL_MS = 30_000

/** While autosave is suspended (the conflict bar, or a revision conflict still resyncing), report
 *  the canvas to the host WITHOUT saving it.
 *
 *  Field 2026-11-17 (Server Edition): a tab sat behind the bar for 64 minutes. Every write was held,
 *  the create flush was dropped, and the Server never heard of a card opened in that time; its
 *  recovery only ever learned presentation from a REFUSED save, and a suspended tab sends none.
 *  A browser refresh then loaded the file without the card while its agent kept running in tmux.
 *  The report feeds that same presentation-only path, so the Server persists a live terminal card
 *  after its usual grace period. It never resolves the bar and never overwrites anything.
 */
export function useSuspendedObserve(suspended: boolean, report: () => void): void {
  useEffect(() => {
    if (!suspended) return
    const first = setTimeout(report, SUSPENDED_REPORT_DELAY_MS)
    const steady = setInterval(report, SUSPENDED_REPORT_INTERVAL_MS)
    return () => { clearTimeout(first); clearInterval(steady) }
  }, [suspended, report])
}
