import { useCallback, useEffect, useState } from 'react'
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
