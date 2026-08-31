/**
 * One FIFO for Server-owned read/modify/save transactions.
 *
 * WorkspaceStore serializes writes, but a stale load followed by a later write can still erase a
 * concurrent mutation. Agent canvas control and the operator plane therefore share this queue.
 */
export class WorkspaceMutationQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(work: () => Promise<T>): Promise<T> {
    const current = this.tail.then(work, work)
    this.tail = current.then(
      () => undefined,
      () => undefined
    )
    return current
  }
}
