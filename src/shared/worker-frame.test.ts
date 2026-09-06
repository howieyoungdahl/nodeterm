import { describe, expect, it } from 'vitest'

import {
  planWorkerFrame,
  workerFrameLabel,
  workerNodeTitle,
  workerTaskSummary,
  type WorkerFrameInput,
  type WorkerFrameNode
} from './worker-frame'

const spawner = (over: Partial<WorkerFrameNode> = {}): WorkerFrameNode => ({
  id: 'src',
  kind: 'terminal',
  ...over
})

const worker = (id: string, over: Partial<WorkerFrameNode> = {}): WorkerFrameNode => ({
  id,
  kind: 'terminal',
  role: 'worker',
  ...over
})

const frame = (id: string, over: Partial<WorkerFrameNode> = {}): WorkerFrameNode => ({
  id,
  kind: 'group',
  ...over
})

const rope = (source: string, target: string) => ({ source, target })

const plan = (over: Partial<WorkerFrameInput> & Pick<WorkerFrameInput, 'nodes'>) =>
  planWorkerFrame({
    spawnerId: 'src',
    newWorkerIds: [],
    ropes: [],
    ...over
  })

describe('planWorkerFrame', () => {
  it('makes no frame for a single worker — one-member boxes are frame churn', () => {
    expect(
      plan({ nodes: [spawner(), worker('w1')], newWorkerIds: ['w1'], ropes: [rope('src', 'w1')] })
    ).toEqual({ kind: 'none', reason: 'single-worker' })
  })

  it('creates the frame when the SECOND worker under a spawner appears, taking the first with it', () => {
    expect(
      plan({
        nodes: [spawner(), worker('w1'), worker('w2')],
        newWorkerIds: ['w2'],
        ropes: [rope('src', 'w1'), rope('src', 'w2')]
      })
    ).toEqual({ kind: 'create', memberIds: ['w1', 'w2'] })
  })

  it('creates the frame on a single command that opens two workers', () => {
    expect(
      plan({
        nodes: [spawner(), worker('w1'), worker('w2')],
        newWorkerIds: ['w1', 'w2'],
        ropes: [rope('src', 'w1'), rope('src', 'w2')]
      })
    ).toEqual({ kind: 'create', memberIds: ['w1', 'w2'] })
  })

  it('joins the spawner OWN frame immediately — no second-worker rule, nothing existing moves', () => {
    expect(
      plan({
        nodes: [frame('g1'), spawner({ parentId: 'g1' }), worker('w1')],
        newWorkerIds: ['w1'],
        ropes: [rope('src', 'w1')]
      })
    ).toEqual({ kind: 'join', groupId: 'g1', memberIds: ['w1'] })
  })

  it('joins the tray this spawner already has, found by its occupants and not by name', () => {
    expect(
      plan({
        nodes: [
          frame('tray', { taskFrame: true }),
          spawner(),
          worker('w1', { parentId: 'tray' }),
          worker('w2', { parentId: 'tray' }),
          worker('w3')
        ],
        newWorkerIds: ['w3'],
        ropes: [rope('src', 'w1'), rope('src', 'w2'), rope('src', 'w3')]
      })
    ).toEqual({ kind: 'join', groupId: 'tray', memberIds: ['w3'] })
  })

  it('declines when this spawner’s workers are spread across two trays', () => {
    // Two candidate containers is ambiguity, and picking one would move a card the operator
    // deliberately re-parented. Left loose instead, which is visible and reversible.
    expect(
      plan({
        nodes: [
          frame('a', { taskFrame: true }),
          frame('b', { taskFrame: true }),
          spawner(),
          worker('w1', { parentId: 'a' }),
          worker('w2', { parentId: 'b' }),
          worker('w3')
        ],
        newWorkerIds: ['w3'],
        ropes: [rope('src', 'w1'), rope('src', 'w2'), rope('src', 'w3')]
      })
    ).toEqual({ kind: 'none', reason: 'single-worker' })
  })

  it('never pulls a pinned or hand-placed worker into a new frame', () => {
    const nodes = [spawner(), worker('w1', { pinned: true }), worker('w2')]
    expect(
      plan({ nodes, newWorkerIds: ['w2'], ropes: [rope('src', 'w1'), rope('src', 'w2')] })
    ).toEqual({ kind: 'none', reason: 'single-worker' })

    const handPlaced = [spawner(), worker('w1', { manualPlacement: true }), worker('w2')]
    expect(
      plan({ nodes: handPlaced, newWorkerIds: ['w2'], ropes: [rope('src', 'w1'), rope('src', 'w2')] })
    ).toEqual({ kind: 'none', reason: 'single-worker' })
  })

  it('never moves a prior worker the caller does not own', () => {
    expect(
      plan({
        nodes: [spawner(), worker('w1'), worker('w2')],
        newWorkerIds: ['w2'],
        ropes: [rope('src', 'w1'), rope('src', 'w2')],
        owns: (id) => id !== 'w1'
      })
    ).toEqual({ kind: 'none', reason: 'single-worker' })
  })

  it('ignores nodes another spawner opened, and nodes with no worker role', () => {
    expect(
      plan({
        nodes: [spawner(), worker('other'), worker('w2'), { id: 'manual', kind: 'terminal' }],
        newWorkerIds: ['w2'],
        ropes: [rope('elsewhere', 'other'), rope('src', 'w2'), rope('src', 'manual')]
      })
    ).toEqual({ kind: 'none', reason: 'single-worker' })
  })

  it('places nothing when the spawn landed in a project the spawner is not in', () => {
    // `--project` opens into another canvas; the spawner is not there, so there is no tray to
    // derive and the workers stay where placement put them.
    expect(
      plan({ nodes: [worker('w1'), worker('w2')], newWorkerIds: ['w1', 'w2'] })
    ).toEqual({ kind: 'none', reason: 'spawner-missing' })
  })

  it('does nothing when the new nodes are not workers', () => {
    expect(
      plan({ nodes: [spawner(), { id: 'n1', kind: 'terminal' }], newWorkerIds: ['n1'] })
    ).toEqual({ kind: 'none', reason: 'no-workers' })
  })

  it('is a no-op when the new workers are already in the frame', () => {
    expect(
      plan({
        nodes: [frame('g1'), spawner({ parentId: 'g1' }), worker('w1', { parentId: 'g1' })],
        newWorkerIds: ['w1'],
        ropes: [rope('src', 'w1')]
      })
    ).toEqual({ kind: 'none', reason: 'no-workers' })
  })
})

describe('generated names', () => {
  it('names a worker by its owner and what it runs, numbered across the whole fan-out', () => {
    expect(workerNodeTitle('Organizer director', 'Claude', 1)).toBe('Organizer director · Claude')
    expect(workerNodeTitle('Organizer director', 'Claude', 3)).toBe('Organizer director · Claude 3')
  })

  it('elides a long owner name rather than filling the header with it', () => {
    const title = workerNodeTitle('A'.repeat(80), 'Codex', 1)
    expect(title.startsWith('AAAA')).toBe(true)
    expect(title).toContain('…')
    expect(title.length).toBeLessThan(45)
  })

  it('falls back to a generic lane when the owner has no title', () => {
    expect(workerNodeTitle('', 'Claude', 1)).toBe('Agent · Claude')
    expect(workerFrameLabel('')).toBe('Agent workers')
  })

  it('summarizes owner and task on one line, and stays one line', () => {
    expect(workerTaskSummary('Director', 'review\nthe   diff')).toBe(
      'Opened by Director — review the diff'
    )
    expect(workerTaskSummary('Director')).toBe('Opened by Director')
    expect(workerTaskSummary('Director', '   ')).toBe('Opened by Director')
  })

  it('truncates a paragraph-length prompt', () => {
    const summary = workerTaskSummary('Director', 'x'.repeat(500))
    expect(summary.length).toBeLessThan(200)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('labels the tray after its owner', () => {
    expect(workerFrameLabel('Organizer director')).toBe('Organizer director workers')
  })
})
