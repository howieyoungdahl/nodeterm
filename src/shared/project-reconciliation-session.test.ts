import { describe, expect, it } from 'vitest'
import {
  acknowledgeProjectSave, openProjectReconciliation, prepareProjectSave,
  receiveProjectSnapshot, reconcileProjectSave, type ProjectCommitReceipt, type ProjectSnapshot
} from './project-reconciliation-session'

const snapshot = (revision: string, value: unknown): ProjectSnapshot => ({ revision, raw: JSON.stringify(value) })
const base = snapshot('r1', { name: 'canvas', nodes: [{ id: 'a', title: 'original', x: 0 }] })
const changed = (title: string, x = 0, extra: object = {}): string =>
  JSON.stringify({ name: 'canvas', nodes: [{ id: 'a', title, x }], ...extra })

describe('project revision and acknowledgment transitions', () => {
  it('keeps its committed baseline while saving and rebases edits made before the acknowledgment', () => {
    const opened = { ...openProjectReconciliation('p1', base), local: changed('first') }
    const prepared = prepareProjectSave(opened, 'op-1')
    expect(prepared.kind).toBe('prepared')
    expect(prepared.state.base).toEqual(base)
    const receipt: ProjectCommitReceipt = { projectId: 'p1', operationId: 'op-1', expectedRevision: 'r1',
      outcome: 'committed', snapshot: { revision: 'r2', raw: changed('first', 0, { color: 'blue' }) } }
    const ack = acknowledgeProjectSave({ ...prepared.state, local: changed('second') }, receipt)
    expect(ack.kind).toBe('acknowledged')
    expect(ack.state.base).toEqual(receipt.snapshot)
    expect(JSON.parse(ack.state.local)).toEqual(JSON.parse(changed('second', 0, { color: 'blue' })))
    expect(ack.state.pending).toBeUndefined()
  })

  it('merges a stale save only when the coordinator can establish the exact common base', () => {
    const prepared = prepareProjectSave({ ...openProjectReconciliation('p1', base), local: changed('local') }, 'op-stale')
    if (prepared.kind !== 'prepared') throw new Error('Expected request')
    const disk = { revision: 'r2', raw: changed('original', 40, { future: { enabled: true } }) }
    const merged = reconcileProjectSave(prepared.request, base, disk)
    expect(merged).toMatchObject({ kind: 'merged', document: JSON.parse(changed('local', 40, { future: { enabled: true } })) })
    expect(reconcileProjectSave(prepared.request, undefined, disk).kind).toBe('unknown-base')
    expect(reconcileProjectSave({ ...prepared.request, commonBase: changed('forged') }, base, disk).kind).toBe('unknown-base')
    expect(reconcileProjectSave({ ...prepared.request, expectedRevision: 'wrong' }, base, disk).kind).toBe('unknown-base')
    expect(reconcileProjectSave(prepared.request, base, { revision: 'r3', raw: changed('conflicting') })).toMatchObject({
      kind: 'conflict', conflicts: [{ path: ['nodes', 'a', 'title'] }]
    })
  })

  it('recovers a lost acknowledgment with the same operation and preserves newer local edits', () => {
    const prepared = prepareProjectSave({ ...openProjectReconciliation('p1', base), local: changed('sent') }, 'lost-op')
    if (prepared.kind !== 'prepared') throw new Error('Expected request')
    // The host committed but the response was lost. A UI retry cannot create a second operation.
    const edited = { ...prepared.state, local: changed('edited after send') }
    const retry = prepareProjectSave(edited, 'must-not-be-sent')
    expect(retry.kind).toBe('pending')
    if (retry.kind !== 'pending') throw new Error('Expected pending request')
    expect(retry.request).toEqual(prepared.request)
    const acknowledged = acknowledgeProjectSave(retry.state, { projectId: 'p1', operationId: 'lost-op',
      expectedRevision: 'r1', outcome: 'already-applied', snapshot: { revision: 'r2', raw: changed('sent') } })
    expect(acknowledged.kind).toBe('acknowledged')
    expect(JSON.parse(acknowledged.state.local).nodes[0].title).toBe('edited after send')
    expect(acknowledged.state.base.revision).toBe('r2')
  })

  it('does not let tab switching or a different project receipt decide a parked conflict', () => {
    const first = receiveProjectSnapshot({ ...openProjectReconciliation('first', base), local: changed('local') },
      { revision: 'r2', raw: changed('remote') }, 'r1').state
    const other = prepareProjectSave({ ...openProjectReconciliation('other', base), local: changed('other') }, 'shared-id')
    const receipt: ProjectCommitReceipt = { projectId: 'other', operationId: 'shared-id', expectedRevision: 'r1',
      outcome: 'committed', snapshot: { revision: 'r2', raw: changed('other') } }
    expect(acknowledgeProjectSave(other.state, receipt).kind).toBe('acknowledged')
    expect(acknowledgeProjectSave(first, receipt)).toMatchObject({ kind: 'unrecognized', state: first })
    const pendingFirst = prepareProjectSave(openProjectReconciliation('first', base), 'shared-id')
    expect(acknowledgeProjectSave(pendingFirst.state, receipt).kind).toBe('unrecognized')
    // Returning to the first tab retains its exact recoverable versions and still blocks save.
    expect(first.conflict).toMatchObject({ kind: 'conflict', recovery: {
      base: base.raw, local: changed('local'), incoming: changed('remote')
    } })
    expect(prepareProjectSave(first, 'after-switch').kind).toBe('blocked')
    expect(first.base).toEqual(base)
  })

  it('rejects a delayed snapshot after a baseline change and keeps unsaved deletes absent', () => {
    const without = snapshot('r2', { name: 'canvas', nodes: [] })
    const removed = receiveProjectSnapshot(openProjectReconciliation('p1', base), without, 'r1')
    expect(removed.kind).toBe('merged')
    expect(removed.state.deletedNodeIds).toEqual(['a'])
    expect(receiveProjectSnapshot(removed.state, base, 'r1')).toMatchObject({ kind: 'stale', state: removed.state })
    const replay = receiveProjectSnapshot(removed.state, { ...base, revision: 'r3' }, 'r2')
    expect(replay.kind).toBe('conflict')
    expect(JSON.parse(replay.state.local).nodes).toEqual([])
  })

  it('defers external observations while an operation is pending and refuses mismatched acknowledgments', () => {
    const saved = prepareProjectSave(openProjectReconciliation('p1', base), 'op-1')
    expect(receiveProjectSnapshot(saved.state, { revision: 'r2', raw: changed('other') }, 'r1').kind).toBe('pending')
    expect(acknowledgeProjectSave(saved.state, { projectId: 'p1', operationId: 'op-2', expectedRevision: 'r1',
      outcome: 'committed', snapshot: base }).kind).toBe('unrecognized')
    expect(acknowledgeProjectSave(saved.state, { projectId: 'p1', operationId: 'op-1', expectedRevision: 'r0',
      outcome: 'committed', snapshot: base }).kind).toBe('unrecognized')
    expect(saved.state.base).toEqual(base)
    expect(saved.state.pending).toBeDefined()
  })

  it('preserves parse failures and refuses to mark an invalid acknowledgment saved', () => {
    const saved = prepareProjectSave(openProjectReconciliation('p1', base), 'op-1')
    const result = acknowledgeProjectSave(saved.state, { projectId: 'p1', operationId: 'op-1', expectedRevision: 'r1',
      outcome: 'committed', snapshot: { revision: 'r2', raw: '{' } })
    expect(result.kind).toBe('unavailable')
    expect(result.state.pending).toEqual(saved.state.pending)
    expect(result.state.base).toEqual(base)
    expect(result.state.conflict).toMatchObject({ recovery: { incoming: '{' } })
  })
})
