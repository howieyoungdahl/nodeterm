import { describe, expect, it, vi } from 'vitest'
import { LayoutTriggerQueue, type PendingLayoutTrigger } from './layoutTriggerQueue'

const spawn = (id: string, projectId = 'project'): PendingLayoutTrigger => ({
  projectId, trigger: 'node-created', createdIds: [id]
})

describe('LayoutTriggerQueue', () => {
  it('keeps a burst and attention changes received while another plan is running', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const plans: PendingLayoutTrigger[] = []
    const queue = new LayoutTriggerQueue(async (request) => {
      plans.push(request)
      if (plans.length === 1) await held
    })
    const initial = queue.enqueue(spawn('first'))
    await vi.waitFor(() => expect(plans).toHaveLength(1))
    const burst = Array.from({ length: 8 }, (_, index) => queue.enqueue(spawn(`worker-${index}`)))
    const attention = queue.enqueue({ projectId: 'project', trigger: 'status-changed', createdIds: [] })
    expect(plans).toHaveLength(1)
    release()
    await Promise.all([initial, attention, ...burst])
    expect(plans).toEqual([
      spawn('first'),
      { projectId: 'project', trigger: 'node-created', createdIds: Array.from({ length: 8 }, (_, i) => `worker-${i}`) },
      { projectId: 'project', trigger: 'status-changed', createdIds: [] }
    ])
  })

  it('keeps project identity and removes duplicate worker IDs', async () => {
    const plans: PendingLayoutTrigger[] = []
    const queue = new LayoutTriggerQueue(async (request) => { plans.push(request) })
    await Promise.all([queue.enqueue(spawn('one')), queue.enqueue(spawn('one')), queue.enqueue(spawn('two', 'other'))])
    expect(plans).toEqual([spawn('one'), spawn('two', 'other')])
  })

  it('a failed plan does not discard another project or prevent future requests', async () => {
    const plans: PendingLayoutTrigger[] = []
    const queue = new LayoutTriggerQueue(async (request) => {
      plans.push(request)
      if (request.projectId === 'project') throw new Error('connection lost')
    })
    const failed = queue.enqueue(spawn('one'))
    void queue.enqueue(spawn('two', 'other'))
    await expect(failed).rejects.toThrow('connection lost')
    await queue.enqueue(spawn('three', 'other'))
    expect(plans.map((plan) => plan.createdIds)).toEqual([['one'], ['two'], ['three']])
  })
})
