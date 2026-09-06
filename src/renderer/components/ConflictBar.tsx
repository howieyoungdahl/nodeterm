import { conflictBarMessage } from '../lib/externalChange'

/** Non-blocking strip shown when the active project's .nodeterm file changed on disk
 *  while there are unsaved local edits. Reload = take disk edits while retaining open cards; Keep mine =
 *  overwrite disk with the in-memory canvas on the next save.
 *
 *  It only ever covers the OVERLAPPING half of an outside change: nodes that arrived from another
 *  device (a session the phone registered) are adopted onto the canvas before this bar is raised,
 *  because nothing re-emits them and either button would otherwise be able to delete a running
 *  session. `addedCount` is how many did — the message says so, so the user is not asked to weigh
 *  a choice against something that is no longer at stake. */
export function ConflictBar({
  addedCount = 0,
  onReload,
  onKeepMine
}: {
  addedCount?: number
  onReload(): void
  onKeepMine(): void
}): JSX.Element {
  return (
    <div className="conflict-bar">
      <span>{conflictBarMessage(addedCount)}</span>
      <button onClick={onReload}>Reload from disk</button>
      <button onClick={onKeepMine}>Keep my version</button>
    </div>
  )
}
