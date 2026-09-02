import { saveFailureMessage, type SaveDelivery } from '../lib/savePersistence'

/** Non-blocking strip shown when the whole-workspace save did NOT land.
 *
 *  It exists because the alternative shipped for months: `void api.workspace.save(...)` threw its
 *  rejection away, so a canvas that had stopped being written to disk looked exactly like one that
 *  was up to date. The strip states the consequence rather than a cause it cannot know, and — once
 *  the bounded retry schedule is spent — offers the only thing left, another attempt.
 *
 *  `Retry now` clears the delivery state, which is what re-arms the debounce. */
export function SaveFailureBar({
  delivery,
  onRetry
}: {
  delivery: SaveDelivery
  onRetry(): void
}): JSX.Element | null {
  const text = saveFailureMessage(delivery)
  if (!text) return null
  return (
    <div className="conflict-bar save-failure-bar">
      <span>{text}</span>
      {delivery.kind === 'failed' && <button onClick={onRetry}>Retry now</button>}
    </div>
  )
}
