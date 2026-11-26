import { create } from 'zustand'

// Renderer observations only. Disconnection does not prove a terminal has ended.
export const useTerminalAvailability = create<{ unavailable: ReadonlySet<string> }>(() => ({
  unavailable: new Set()
}))

export function setTerminalUnavailable(key: string, unavailable: boolean): void {
  const previous = useTerminalAvailability.getState().unavailable
  if (previous.has(key) === unavailable) return
  const next = new Set(previous)
  if (unavailable) next.add(key)
  else next.delete(key)
  useTerminalAvailability.setState({ unavailable: next })
}
