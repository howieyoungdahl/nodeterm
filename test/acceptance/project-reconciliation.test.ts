import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendProjectNode } from '../../src/core/project-node-append'
import { writeFileAtomic } from '../../src/core/fs-atomic'
import { reconcileProjectBytes } from '../../src/shared/project-reconciliation'
import { acknowledgeProjectSave, openProjectReconciliation, prepareProjectSave,
  reconcileProjectSave } from '../../src/shared/project-reconciliation-session'

// Exercises the real host registrar's bytes, not a claimed phone/device end-to-end test. No
// server, terminal, hook installer or provider home is started/touched by this fixture.
let fixtureDir: string
beforeEach(async () => { fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-reconcile-')) })
afterEach(async () => { await fs.rm(fixtureDir, { recursive: true, force: true }) })

const original = JSON.stringify({ version: 1, rev: 1, name: 'Fixture', nodes: [
  { id: 'term-aaa-111', kind: 'terminal', title: 'Local task', position: { x: 0, y: 0 },
    size: { width: 500, height: 300 }, color: '#fff', group: null }
], layoutRules: { futureRule: true }, futureProject: { preserved: true } }, null, 2) + '\n'

describe('disposable project reconciliation drill', () => {
  it('retains a host registration across a stale local save, lost ack and serialized recovery', async () => {
    const file = path.join(fixtureDir, 'project.json')
    await writeFileAtomic(file, original)
    const base = { revision: 'revision-before-registration', raw: await fs.readFile(file, 'utf8') }
    const local = JSON.parse(base.raw)
    local.nodes[0].position.x = 250
    const prepared = prepareProjectSave({ ...openProjectReconciliation('fixture', base), local: JSON.stringify(local) }, 'op-layout')
    if (prepared.kind !== 'prepared') throw new Error('Expected request')
    const registered = appendProjectNode(base.raw, { id: 'term-phone-222', title: 'Remote task',
      agentId: 'claude', accountId: 'account-a' }, new Date('2026-09-05T12:00:00Z'))
    expect(registered).not.toBeNull()
    await writeFileAtomic(file, registered!)
    const disk = { revision: 'revision-after-registration', raw: await fs.readFile(file, 'utf8') }
    const plan = reconcileProjectSave(prepared.request, base, disk)
    if (plan.kind !== 'merged') throw new Error(`Unexpected ${plan.kind}`)
    const final = JSON.stringify(plan.document)
    await writeFileAtomic(file, final)
    // Store fixtures are explicit, local test files. This is not a production journal contract.
    const receipt = { projectId: 'fixture', operationId: 'op-layout', expectedRevision: base.revision,
      outcome: 'already-applied' as const, snapshot: { revision: 'revision-after-merge', raw: final } }
    await writeFileAtomic(path.join(fixtureDir, 'receipt.json'), JSON.stringify(receipt))
    await writeFileAtomic(path.join(fixtureDir, 'pending.json'), JSON.stringify(prepared.state))
    const restored = JSON.parse(await fs.readFile(path.join(fixtureDir, 'pending.json'), 'utf8'))
    const recovered = acknowledgeProjectSave(restored, JSON.parse(await fs.readFile(path.join(fixtureDir, 'receipt.json'), 'utf8')))
    expect(recovered.kind).toBe('acknowledged')
    const result = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(['term-aaa-111', 'term-phone-222'])
    expect(result.nodes[0].position.x).toBe(250)
    expect(result.nodes[1]).toMatchObject({ title: 'Remote task', agentId: 'claude', accountId: 'account-a' })
    expect(result.futureProject).toEqual({ preserved: true })
    expect(result.layoutRules).toEqual({ futureRule: true })
    expect(appendProjectNode(final, { id: 'term-phone-222' }, new Date())).toBeNull()
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(reconcileProjectBytes({ base: final, local: final, incoming: await fs.readFile(file, 'utf8') }).kind).toBe('merged')
    }
  })

  it('keeps all exact bytes across partial replacement and a real same-field conflict', async () => {
    const raw = JSON.parse(original)
    raw.nodes[0].title = 'Local change'
    const local = JSON.stringify(raw)
    raw.nodes[0].title = 'External change'
    const incoming = JSON.stringify(raw, null, 4) + '\n'
    const file = path.join(fixtureDir, 'project.json')
    await writeFileAtomic(file, '{"version":1,')
    const partial = reconcileProjectBytes({ base: original, local, incoming: await fs.readFile(file, 'utf8') })
    expect(partial.kind).toBe('unavailable')
    await writeFileAtomic(file, incoming)
    const conflict = reconcileProjectBytes({ base: original, local, incoming: await fs.readFile(file, 'utf8') })
    expect(conflict).toMatchObject({ kind: 'conflict', conflicts: [{ path: ['nodes', 'term-aaa-111', 'title'] }] })
    const copy = path.join(fixtureDir, 'recovery.json')
    await writeFileAtomic(copy, JSON.stringify(conflict.recovery))
    expect(JSON.parse(await fs.readFile(copy, 'utf8'))).toEqual({ base: original, local, incoming })
    expect(await fs.readFile(file, 'utf8')).toBe(incoming)
  })
})
