import { describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../core/pty-manager'
import { HeadlessNodeFactory } from './headless-node-factory'

// Only external backend timing is substituted. The production factory and destroy coalescer run.
vi.mock('node-pty', () => ({}))

describe('cancelled launch with an overlapping backend destroy', () => {
  it.each([false, true])('reaps the late backend after the earlier destroy settles (reject=%s)', async (rejectFirst) => {
    const manager = Object.create(PtyManager.prototype)
    const internals = manager as unknown as {
      ending: Map<string, unknown>
      runEndSession: () => Promise<void>
    }
    internals.ending = new Map()
    let backend = false
    let passes = 0
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    internals.runEndSession = async () => {
      passes++
      backend = false
      if (passes === 1) {
        await firstPending
        if (rejectFirst) throw Error('synthetic first backend uncertainty')
      }
    }
    let releaseAttach!: (result: { sessionId: string; fresh: boolean }) => void
    const attaching = new Promise<{ sessionId: string; fresh: boolean }>((resolve) => { releaseAttach = resolve })
    manager.createHeadless = () => attaching
    const send = vi.spyOn(manager, 'sendText').mockResolvedValue(true)
    const factory = Object.create(HeadlessNodeFactory.prototype)
    const state = factory as unknown as {
      attached: Set<string>
      cancelledLaunches: Set<string>
      launchPrepared: (plan: unknown) => Promise<{ ok: boolean; error?: string }>
      attach: () => Promise<{ sessionId: string; fresh: boolean }>
    }
    Object.assign(factory, {
      deps: { ptyManager: manager, launchTimeoutMs: 2000 },
      attached: new Set(), cancelledLaunches: new Set(), launchesInFlight: new Set(['term-overlap']),
      launchingAgents: new Set(), workingSeenDuringLaunch: new Set(), awaitingFirstWorking: new Set(),
      spawnHandlerState: { enqueue: () => ({ start() {}, finish() {} }) }
    })
    state.attach = async () => { const result = await attaching; state.attached.add('term-overlap'); return result }
    const opening = state.launchPrepared({
      created: [{ id: 'term-overlap' }], project: {}, commands: new Map([['term-overlap', 'synthetic-initial-command']]),
      after: [], verb: 'open-terminal'
    })
    await Promise.resolve()
    state.cancelledLaunches.add('term-overlap')
    // This pass has already killed the absent backend but is awaiting its second socket.
    const closing = manager.destroySession(null, 'term-overlap', { everySocket: true })
    const closeOutcome = closing.then(() => 'resolved', () => 'rejected')
    backend = true
    releaseAttach({ sessionId: 'pty-overlap', fresh: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(passes).toBe(1)
    expect(backend).toBe(true)
    expect(send).not.toHaveBeenCalled()
    releaseFirst()
    expect(await closeOutcome).toBe(rejectFirst ? 'rejected' : 'resolved')
    expect(await opening).toMatchObject({ ok: false, error: expect.stringContaining('launch-failed') })
    expect(send).not.toHaveBeenCalled()
    expect(passes).toBe(2)
    expect(backend).toBe(false)
    expect(state.attached.size).toBe(0)
  })
})
