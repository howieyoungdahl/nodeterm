import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { createCleanupPersistence } from '../../src/core/session-cleanup-persistence'
import { SessionCleanup, CLEANUP_IDLE_MS, cleanupHash } from '../../src/core/session-cleanup'
import { FileCleanupReservations } from '../../src/core/session-cleanup-reservations'
import { WorkspaceMutationQueue } from '../../src/server/workspace-mutation-queue'
import { createOpsApiHandler, type OpsApiDeps } from '../../src/server/ops-api'
import { ProjectCommitStore, revisionOf, type PublicationPhase } from '../../src/core/project-commit-store'
import { mergeWorkspacePublication } from '../../src/renderer/lib/workspacePublication'
import { flowToNodeStates, nodeStatesToFlow } from '../../src/renderer/state/workspace'
import type { CanvasNodeState, Project, Workspace } from '../../src/shared/types'

let dir: string, store: WorkspaceStore, workspace: Workspace, cleanup: SessionCleanup
let fence = 0
const now = 1_900_000_000_000
const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, group: null, color: '#888',
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, agentId: 'codex', agentModel: 'gpt-6.1-sol', agentSessionId: 'session-' + id,
  pinned: true, manualPlacement: true })
const project = (id: string): Project => ({ id, name: id, color: '#888', cwd: path.join(dir,id),
  nodes: [node(id+'a'),node(id+'b')], viewport: { x: 0, y: 0, zoom: 1 },
  kanban: { columns: [{ id: 'manual', title: 'Manual', color: '#888' }], assignments: [{ nodeId: id+'a', columnId: 'manual' }],
    manualAssignments: { [id+'a']: true }, manualAssignmentVersions: { [id+'a']: 'operator-choice' } } })
const file = (id: string) => path.join(dir,id,'.nodeterm','project.json')
const makeCleanup = (save?: (w: Workspace, check?: () => string | undefined) => Promise<void>, clock = () => now) => {
  const persistence = createCleanupPersistence(store), queue = new WorkspaceMutationQueue()
  return new SessionCleanup({ dataDir: dir, now: clock, ...persistence, ...(save ? { save: async (w: Workspace, check?: () => string | undefined) => { await persistence.save(w,check); await save(w,check) } } : {}),
    exclusive: work => queue.run(work), reserveSessions: ids => new FileCleanupReservations(path.join(dir,'leases')).reserve(ids, 'unique-fixture'),
    activityVersion: () => fence,
    probe: async () => ({ generation: 'generation', state: 'completed', activityAt: now-CLEANUP_IDLE_MS,
      pending: false, workChildren: 0, fingerprint: 'no-activity', reason: 'fixture', assistantTaskReceipt: 'a'.repeat(64) }),
    reviewedProbe: async (p,n) => ({ generation: 'exact-pane-pid-birth', fingerprint: cleanupHash({ id:n.id, fence }), ownerDigest: cleanupHash({ projectId:p.id, owner:'operator' }), admissible: true, reason:'operator-task-disposition-required' }) })
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(),'nt-operational-')); fence = 0
  initPlatform(fakePlatform({ userDataDir: dir })); store = new WorkspaceStore()
  workspace = { version: 2, activeProjectId: 'p', projects: [project('p'),project('q')] }
  await store.save(workspace)
  const raw = JSON.parse(await fs.readFile(file('p'),'utf8'))
  raw.futureProject = { nested: [1, { important: true }] }; raw.nodes[0].futureIdentity = { preserved: 'raw', owner: 'foreign' }
  await fs.writeFile(file('p'),JSON.stringify(raw,null,4)+'\n')
  const index = JSON.parse(await fs.readFile(path.join(dir,'workspace.json'),'utf8'))
  index.futureIndex = ['keep']; index.entries[0].privateFuture = { owner:'separate' }
  await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(index,null,3)+'\n')
  workspace = await store.load({ sideline:false }); cleanup = makeCleanup()
})
afterEach(async () => { resetPlatformForTests(); await fs.rm(dir,{recursive:true,force:true}) })
const request = async (ids = ['pa']) => ({ planId: (await cleanup.preview()).plan.id, nodeIds: ids })

it.skipIf(process.platform !== 'linux')('runs the Fern helper through the actual reviewed HTTP archive and undo contract with retained data', async () => {
  cleanup = makeCleanup(undefined, Date.now)
  const token = 'synthetic-helper-cleanup-token-00000000000000000'
  await fs.writeFile(path.join(dir, 'ops-token'), token, { mode: 0o600 })
  const handler = createOpsApiHandler({ token, cleanup } as unknown as OpsApiDeps)
  const pending = new Set<Promise<void>>()
  const server = http.createServer((q, r) => {
    const work = handler(q, r); pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const run = async (command: string, args: string[]) => JSON.parse((await promisify(execFile)('python3',
      [path.resolve('drafts/fern/fern-nodeterm.py'), '--url', url, '--data-dir', dir, command, ...args],
      { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout)
    const preview = await run('cleanup-preview', []), row = preview.plan.rows.find((r: { nodeId: string }) => r.nodeId === 'pa')
    const packet = path.join(dir, 'review.json'), output = path.join(dir, 'archive-outcome.json')
    await fs.writeFile(packet, JSON.stringify({ projectId: 'p', entries: [{ nodeId: 'pa', disposition: 'obsolete-paused',
      ownerDigest: row.reviewedFence.ownerDigest, evidenceDigest: cleanupHash('explicit authorized fixture task disposition') }] }))
    const history = path.join(dir, 'history.bin'), binding = path.join(dir, 'binding.json')
    await fs.writeFile(history, 'retained terminal history'); await fs.writeFile(binding, '{"nodeId":"pa","sessionId":"session-pa"}')
    const index = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), sibling = await fs.readFile(file('q'), 'utf8')
    const archived = await run('cleanup', ['--request-file', packet, '--receipt-file', output])
    expect(archived.outcomeKnown).toBe(true); expect(archived.receipt.state).toBe('applied')
    expect(archived.receipt.items.map((i: { nodeId: string }) => i.nodeId)).toEqual(['pa'])
    expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual(archived)
    const raw = JSON.parse(await fs.readFile(file('p'), 'utf8'))
    expect(raw.nodes[0]).toMatchObject({ cleanupArchiveId: archived.receipt.id, agentSessionId: 'session-pa',
      agentModel: 'gpt-6.1-sol', pinned: true, manualPlacement: true, futureIdentity: { preserved: 'raw', owner: 'foreign' } })
    raw.nodes[0].title = 'later edit'; await fs.writeFile(file('p'), JSON.stringify(raw))
    const undone = await run('cleanup-undo', ['--receipt-id', archived.receipt.id, '--receipt-file', path.join(dir, 'undo-outcome.json')])
    expect(undone.outcomeKnown).toBe(true); expect(undone.receipt.state).toBe('undone')
    const after = JSON.parse(await fs.readFile(file('p'), 'utf8'))
    expect(after.nodes[0].cleanupArchiveId).toBeUndefined(); expect(after.nodes[0].title).toBe('later edit')
    expect(after.kanban).toEqual(raw.kanban)
    expect(await fs.readFile(history, 'utf8')).toBe('retained terminal history')
    expect(await fs.readFile(binding, 'utf8')).toBe('{"nodeId":"pa","sessionId":"session-pa"}')
    expect(await fs.readFile(file('q'), 'utf8')).toBe(sibling); expect(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).toBe(index)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.allSettled([...pending])
  }
}, 30_000)

it.skipIf(process.platform === 'win32')('uses the real retained writer, preserves unknown fields and sibling/index bytes, and recovers receipts after restart', async () => {
  const index = await fs.readFile(path.join(dir,'workspace.json'),'utf8'), sibling = await fs.readFile(file('q'),'utf8')
  const preview = await cleanup.preview()
  expect(preview.counts).toMatchObject({ raw:4,visible:4,archived:0,candidates:4,exclusions:0 })
  expect(await fs.readdir(dir)).not.toContain('session-cleanup')
  const result = await cleanup.archive({planId:preview.plan.id,nodeIds:['pa']})
  const archived = JSON.parse(await fs.readFile(file('p'),'utf8'))
  expect(archived.nodes[0]).toMatchObject({cleanupArchiveId:result.receipt.id, futureIdentity:{preserved:'raw',owner:'foreign'}, pinned:true,agentSessionId:'session-pa'})
  expect(archived.futureProject).toEqual({nested:[1,{important:true}]})
  expect(await fs.readFile(file('q'),'utf8')).toBe(sibling); expect(await fs.readFile(path.join(dir,'workspace.json'),'utf8')).toBe(index)
  archived.nodes[0].title = 'later edit'; archived.nodes[0].futureIdentity.later = true
  await fs.writeFile(file('p'),JSON.stringify(archived))
  store = new WorkspaceStore(); cleanup = makeCleanup()
  expect((await cleanup.receipts()).receiptIds).toContain(result.receipt.id)
  await cleanup.undo(result.receipt.id); await cleanup.undo(result.receipt.id)
  expect(JSON.parse(await fs.readFile(file('p'),'utf8')).nodes[0]).toMatchObject({title:'later edit',futureIdentity:{later:true}})
  expect(JSON.parse(await fs.readFile(file('p'),'utf8')).nodes[0].cleanupArchiveId).toBeUndefined()
})
it.skipIf(process.platform === 'win32')('archives and restores an inline project through the retained index without changing other entries', async () => {
  const inline = await store.load({ sideline: false })
  inline.projects.push({ ...project('inline'), cwd: undefined })
  await store.save(inline)
  cleanup = makeCleanup()
  const result = await cleanup.archive(await request(['inlinea']))
  expect((await store.load({ sideline: false })).projects.find(p => p.id === 'inline')!.nodes[0].cleanupArchiveId).toBe(result.receipt.id)
  await cleanup.undo(result.receipt.id)
  expect((await store.load({ sideline: false })).projects.find(p => p.id === 'inline')!.nodes[0].cleanupArchiveId).toBeUndefined()
})
it('preserves opaque inline project/node fields through an ordinary Flow save and still applies known metadata deletion', async () => {
  const inline = await store.load({ sideline: false })
  inline.projects.push({ ...project('inline'), cwd: undefined })
  await store.save(inline)
  const indexFile = path.join(dir, 'workspace.json'), raw = JSON.parse(await fs.readFile(indexFile, 'utf8'))
  const entry = raw.entries.find((e: any) => e.id === 'inline')
  entry.project.futureProject = { preserved: 'opaque' }
  Object.assign(entry.project.nodes[0], { futureIdentity: { preserved: 'opaque' }, taskSummary: 'delete this known field' })
  await fs.writeFile(indexFile, JSON.stringify(raw))
  const local = await store.load({ sideline: false }), current = local.projects.find(p => p.id === 'inline')!
  current.nodes = flowToNodeStates(nodeStatesToFlow(current.nodes))
  current.nodes[0].title = 'ordinary browser rename'; delete current.nodes[0].taskSummary
  delete (current as any).futureProject
  await store.save(local, { requireRevision: true })
  const persisted = JSON.parse(await fs.readFile(indexFile, 'utf8')).entries.find((e: any) => e.id === 'inline').project
  expect(persisted.futureProject).toEqual({ preserved: 'opaque' })
  expect(persisted.nodes[0]).toMatchObject({ title: 'ordinary browser rename', futureIdentity: { preserved: 'opaque' } })
  expect(persisted.nodes[0].taskSummary).toBeUndefined()
})

it.skipIf(process.platform === 'win32').each(['folder', 'inline'] as const)('keeps an archive through a real older-client %s save that strips marker fields and then omits hidden nodes', async kind => {
  if (kind === 'inline') {
    const w = await store.load({ sideline: false }); w.projects.push({ ...project('inline'), cwd: undefined }); await store.save(w)
  }
  const projectId = kind === 'folder' ? 'p' : 'inline', selected = projectId + 'a'
  cleanup = makeCleanup()
  const result = await cleanup.archive(await request([selected]))
  for (const omit of [false, true]) {
    const legacy = await store.load({ sideline: false }), p = legacy.projects.find(p => p.id === projectId)!
    for (const n of p.nodes) delete n.cleanupArchiveId // A pre-marker client decodes only its known node fields.
    if (omit) {
      p.nodes = p.nodes.filter(n => n.id !== selected)
      p.kanban!.assignments = []; p.kanban!.manualAssignments = {}; p.kanban!.manualAssignmentVersions = {}
    }
    p.nodes.find(n => n.id === projectId + 'b')!.title = `legitimate older-client edit ${omit}`
    await store.save(legacy, { requireRevision: true })
    const adopted = (await store.load({ sideline: false })).projects.find(p => p.id === projectId)!
    expect(adopted.nodes.map(n => n.id)).toEqual([selected, projectId + 'b'])
    expect(adopted.nodes[0]).toMatchObject({ cleanupArchiveId: result.receipt.id, pinned: true, manualPlacement: true,
      agentSessionId: 'session-' + selected, agentModel: 'gpt-6.1-sol' })
    expect(adopted.nodes[1].title).toBe(`legitimate older-client edit ${omit}`)
    expect(adopted.kanban!.assignments).toEqual([{ nodeId: selected, columnId: 'manual' }])
    expect(adopted.kanban!.manualAssignmentVersions![selected]).toBe('operator-choice')
  }
  const legacy = await store.load({ sideline: false })
  legacy.projects = legacy.projects.filter(p => p.id !== projectId)
  await store.save(legacy, { requireRevision: true })
  expect((await store.load({ sideline: false })).projects.find(p => p.id === projectId)!.nodes[0].cleanupArchiveId).toBe(result.receipt.id)
  // Restore still requires the explicit audited inverse and keeps the ordinary client's edits.
  await cleanup.undo(result.receipt.id)
  const restored = (await store.load({ sideline: false })).projects.find(p => p.id === projectId)!
  expect(restored.nodes[0].cleanupArchiveId).toBeUndefined()
  expect(restored.nodes[1].title).toBe('legitimate older-client edit true')
})

it.skipIf(process.platform === 'win32')('fences raw selected, sibling and index changes without a marker write', async () => {
  for (const target of [file('p'),file('q'),path.join(dir,'workspace.json')]) {
    const r = await request(), raw = await fs.readFile(target,'utf8')
    await fs.writeFile(target,raw+' ')
    await expect(cleanup.archive(r)).rejects.toThrow('workspace_changed')
    expect(JSON.parse(await fs.readFile(file('p'),'utf8')).nodes[0].cleanupArchiveId).toBeUndefined()
  }
})
it.skipIf(process.platform === 'win32').each(['before-displace', 'before-publish', 'published'] as PublicationPhase[])
('retains actual competing target bytes at cleanup %s and discovers the unfinished inverse', async phase => {
  const target = file('p'), raw = await fs.readFile(target, 'utf8'), external = JSON.parse(raw)
  external.futureProject.evidence = 'competing writer actual bytes'
  const competing = JSON.stringify(external, null, 3) + '\n'
  const r = await request()
  store.publicationPhase = async at => { if (at === phase) await fs.writeFile(target, competing) }
  await expect(cleanup.archive(r)).rejects.toThrow('cleanup_publication_publication-')
  store.publicationPhase = undefined
  expect(await fs.readFile(target, 'utf8')).toBe(competing)
  const ids = (await cleanup.receipts()).receiptIds
  expect(ids).toHaveLength(1)
  expect((await cleanup.receipt(ids[0])).receipt.state).toBe('prepared')
  expect(await cleanup.protectedNodeIds()).toContain('pa')
  const retained = new ProjectCommitStore(target)
  expect(await retained.known(revisionOf(raw))).toBe(raw)
  expect(await retained.known(revisionOf(competing))).toBe(competing)
  // Restart discovers the exact pending receipt; undo never restores an older whole document.
  store = new WorkspaceStore(); cleanup = makeCleanup()
  await cleanup.undo(ids[0])
  expect(await fs.readFile(target, 'utf8')).toBe(competing)
  expect((await cleanup.receipt(ids[0])).receipt.state).toBe('undone')
})
it.skipIf(process.platform === 'win32').each(['before-displace', 'before-publish', 'published'] as PublicationPhase[])
('fences external sibling/index bytes through actual cleanup %s', async phase => {
  for (const sibling of [file('q'), path.join(dir, 'workspace.json')]) {
    const r = await request(), raw = await fs.readFile(sibling, 'utf8'), competing = raw + ' '
    store.publicationPhase = async at => { if (at === phase) await fs.writeFile(sibling, competing) }
    await expect(cleanup.archive(r)).rejects.toThrow('cleanup_publication_publication-')
    store.publicationPhase = undefined
    expect(await fs.readFile(sibling, 'utf8')).toBe(competing)
    const ids = (await cleanup.receipts()).receiptIds
    const marker = JSON.parse(await fs.readFile(file('p'), 'utf8')).nodes[0].cleanupArchiveId
    const latest = ids.find(id => id === marker)
    if (phase === 'published') {
      expect(latest).toBeDefined()
      await cleanup.undo(latest!)
      expect(await fs.readFile(sibling, 'utf8')).toBe(competing)
    }
    expect(JSON.parse(await fs.readFile(file('p'), 'utf8')).nodes[0].cleanupArchiveId).toBeUndefined()
  }
})
it.skipIf(process.platform === 'win32')('records uncertain partial publication and undo removes only this receipt markers across projects', async () => {
  const persistence = createCleanupPersistence(store), commit = store.organizerCoordinator().commitOrganizer.bind(store.organizerCoordinator())
  const spy = vi.spyOn(store.organizerCoordinator(),'commitOrganizer').mockImplementation(async (...args) => {
    if (args[1] === 'q') throw new Error('interrupted-second-project')
    return commit(...args)
  })
  await expect(cleanup.archive(await request(['pa','qa']))).rejects.toThrow('interrupted-second-project')
  spy.mockRestore()
  const id = (await cleanup.receipts()).receiptIds[0]
  expect((await cleanup.receipt(id)).receipt.state).toBe('prepared')
  expect((await store.load({sideline:false})).projects[0].nodes[0].cleanupArchiveId).toBe(id)
  store = new WorkspaceStore(); cleanup = makeCleanup()
  await cleanup.undo(id)
  expect((await store.load({sideline:false})).projects.flatMap(p=>p.nodes).every(n=>!n.cleanupArchiveId)).toBe(true)
  expect(persistence).toBeDefined()
})
it('keeps an interrupted lease and rejects non-marker proposals through the actual writer',async()=> {
  const persistence = createCleanupPersistence(store), w = await persistence.load()
  w.projects[0].nodes[0].title = 'unsafe'; await expect(persistence.save(w)).rejects.toThrow('cleanup_non_marker_change')
  const lock = path.join(path.dirname(file('p')),'.recovery','project.json','writer.lock')
  await fs.mkdir(path.dirname(lock),{recursive:true}); await fs.writeFile(lock,'another writer')
  await expect(cleanup.preview()).rejects.toThrow('E_PUBLICATION_BUSY')
  expect(await fs.readFile(lock,'utf8')).toBe('another writer')
})
it.skipIf(process.platform === 'win32')('operator review has exact scope, per-ID disposition digests, refuses changed activity and never invents hook completion',async()=> {
  const preview = await cleanup.preview(), row = preview.plan.rows.find(r=>r.nodeId==='pa')!
  const input = {projectId:'p',entries:[{nodeId:'pa',disposition:'obsolete-superseded',evidenceDigest:cleanupHash('task-receipt'),ownerDigest:row.reviewedFence!.ownerDigest}]}
  await expect(cleanup.reviewedPreview({...input,projectId:'q'})).rejects.toThrow('reviewed_owner_scope')
  await expect(cleanup.reviewedPreview({...input,entries:[{...input.entries[0],ownerDigest:'f'.repeat(64)}]})).rejects.toThrow('reviewed_owner_scope')
  const plan = await cleanup.reviewedPreview(input); fence++
  await expect(cleanup.archive({planId:plan.plan.id,nodeIds:['pa']})).rejects.toThrow('activity_or_generation_changed')
  const fresh = await cleanup.reviewedPreview(input)
  const archived = await cleanup.archive({planId:fresh.plan.id,nodeIds:['pa']})
  expect(archived.receipt.review?.[0]).toMatchObject(input.entries[0])
})
it.each(['create','metadata'])('ordinary server %s content merges before revision acknowledgment with disjoint local edits',async kind=> {
  const local = structuredClone(workspace.projects); local[0].nodes[1].position.x=123
  const server = await store.load({sideline:false})
  if (kind==='create') server.projects[0].nodes.push(node('new'))
  else server.projects[0].nodes[0].title='server rename'
  await store.save(server)
  const result = mergeWorkspacePublication(workspace.revision,local,server.projects[0].workspaceChange)
  expect(result.kind).toBe('adopt')
  if (result.kind!=='adopt') throw new Error('merge refused')
  expect(result.projects[0].nodes[1].position.x).toBe(123)
  expect(result.projects[0].nodes[0].title).toBe(kind==='metadata'?'server rename':'pa')
  expect(result.projects[0].nodes.some(n=>n.id==='new')).toBe(kind==='create')
  await expect(store.save({ ...server,projects:result.projects,revision:result.revision },{requireRevision:true})).resolves.toHaveProperty('revision')
})
it('rejects real overlap, missing/foreign/dropped/out-of-order acknowledgments and changed background raw content',async()=> {
  const local = structuredClone(workspace.projects);local[0].nodes[0].title='local'
  const server = await store.load({sideline:false});server.projects[0].nodes[0].title='remote';await store.save(server)
  const change = server.projects[0].workspaceChange!
  expect(mergeWorkspacePublication(workspace.revision,local,change).kind).toBe('conflict')
  expect(mergeWorkspacePublication(workspace.revision,workspace.projects,undefined).kind).toBe('conflict')
  expect(mergeWorkspacePublication('f'.repeat(64),workspace.projects,change).kind).toBe('conflict')
  expect(mergeWorkspacePublication(workspace.revision,[workspace.projects[1]],change).kind).toBe('conflict')
  server.revision = change.after;server.projects[1].nodes[0].title='background';await store.save(server)
  expect(mergeWorkspacePublication(workspace.revision,workspace.projects,server.projects[0].workspaceChange).kind).toBe('conflict')
  const merged = mergeWorkspacePublication(change.before,workspace.projects,change)
  if (merged.kind!=='adopt') throw new Error('bad fixture')
  await fs.appendFile(file('q'),' ')
  await expect(store.save({...workspace,projects:merged.projects,revision:merged.revision},{requireRevision:true})).rejects.toThrow('workspace_conflict')
})

it.skipIf(process.platform === 'win32')('a subsequent acknowledged browser metadata save retains raw foreign node/project/index fields and untouched sibling bytes',async()=> {
  const result=await cleanup.archive(await request()), sibling=await fs.readFile(file('q'),'utf8')
  const local=await store.load({sideline:false}); local.projects[0].nodes[0].title='after cleanup browser rename'
  await store.save(local,{requireRevision:true})
  const raw=JSON.parse(await fs.readFile(file('p'),'utf8')), index=JSON.parse(await fs.readFile(path.join(dir,'workspace.json'),'utf8'))
  expect(raw.futureProject).toEqual({nested:[1,{important:true}]})
  expect(raw.nodes[0].futureIdentity).toEqual({preserved:'raw',owner:'foreign'})
  expect(raw.nodes[0].cleanupArchiveId).toBe(result.receipt.id)
  expect(index.futureIndex).toEqual(['keep']);expect(index.entries[0].privateFuture).toEqual({owner:'separate'})
  expect(await fs.readFile(file('q'),'utf8')).toBe(sibling)
})
it.skipIf(process.platform === 'win32')('fences changed eligibility after durable marker publication and restores it before success',async()=> {
  cleanup=makeCleanup(async ()=> {fence++})
  const preview=await cleanup.preview(), row=preview.plan.rows.find(r=>r.nodeId==='pa')!
  const plan=await cleanup.reviewedPreview({projectId:'p',entries:[{nodeId:'pa',disposition:'obsolete-shell',evidenceDigest:cleanupHash('shell receipt'),ownerDigest:row.reviewedFence!.ownerDigest}]})
  await expect(cleanup.archive({planId:plan.plan.id,nodeIds:['pa']})).rejects.toThrow('activity_raced_archive_restored')
  expect((await store.load({sideline:false})).projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
})
it('preserves disjoint manual board, pin and order choices and refuses a real overlapping pin edit',async()=> {
  const local=structuredClone(workspace.projects);local[0].nodes[1].pinned=false
  local[0].kanban!.assignments.reverse();local[0].kanban!.manualAssignmentVersions!['pb']='local-new-choice'
  const server=await store.load({sideline:false});server.projects[0].nodes[0].title='rename';await store.save(server)
  const r=mergeWorkspacePublication(workspace.revision,local,server.projects[0].workspaceChange)
  expect(r.kind).toBe('adopt');if(r.kind!=='adopt')throw new Error('bad fixture')
  expect(r.projects[0].kanban).toEqual(local[0].kanban);expect(r.projects[0].nodes[1].pinned).toBe(false)
  const overlap=structuredClone(server.projects[0].workspaceChange!)
  overlap.changes[0].after.nodes[1].pinned=undefined
  expect(mergeWorkspacePublication(workspace.revision,local,overlap).kind).toBe('conflict')
})

it.skipIf(process.platform === 'win32')('actual retained coordinator refuses non-marker edits, stale enrolled bytes, wrong revision and publication-time activity',async()=> {
  const bound=await store.loadReconciled(), held=bound.projects.p
  const invoke=(p:Project,revision=held.revision,check:()=>string|undefined=()=>undefined)=>store.organizerCoordinator().commitOrganizer(bound.clientId,'p',revision,'operation',p,check)
  const unsafe=structuredClone(held.project);unsafe.nodes[0].title='not a marker'
  expect((await invoke(unsafe)).kind).toBe('non-marker-change')
  const proposal=structuredClone(held.project);proposal.nodes[0].cleanupArchiveId='receipt'
  expect((await invoke(proposal,'wrong-revision')).kind).toBe('base-not-retained')
  expect((await invoke(proposal,held.revision,()=> 'activity-during-lock')).kind).toBe('activity-during-lock')
  await fs.appendFile(file('q'),' ')
  expect((await invoke(proposal)).kind).toBe('conflict')
  expect(JSON.parse(await fs.readFile(file('p'),'utf8')).nodes[0].cleanupArchiveId).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('archives one reviewed cohort of 43 out of 55, retains every excluded card, and cannot split that reviewed request',async()=> {
  const w=await store.load({sideline:false})
  w.projects[0].nodes=Array.from({length:55},(_,i)=>node(i===54?'term-murumtyj-6tzk8guc':`cohort-${i}`));w.projects[1].nodes=[]
  await store.save(w)
  const persistence=createCleanupPersistence(store)
  const c=new SessionCleanup({dataDir:dir,...persistence,exclusive:work=>work(),
    probe:async()=>({generation:'',activityAt:null,state:'unknown',pending:true,workChildren:null,fingerprint:'',reason:'no-current-boot-proof'}),
    reviewedProbe:async(p,n)=>({generation:'generation-'+n.id,ownerDigest:cleanupHash({scope:p.id}),fingerprint:cleanupHash(n),admissible:true,reason:'operator-task-disposition-required'})})
  const ordinary=await c.preview();expect(ordinary.counts).toMatchObject({raw:55,visible:55,archived:0,candidates:0,exclusions:55})
  const entries=ordinary.plan.rows.slice(0,43).map(row=>({nodeId:row.nodeId,disposition:'obsolete-superseded',evidenceDigest:cleanupHash('review receipt '+row.nodeId),ownerDigest:row.reviewedFence!.ownerDigest}))
  const plan=await c.reviewedPreview({projectId:'p',entries})
  expect(plan.counts).toMatchObject({raw:55,candidates:43,exclusions:12})
  await expect(c.archive({planId:plan.plan.id,nodeIds:entries.slice(0,5).map(e=>e.nodeId)})).rejects.toThrow('whole_reviewed_cohort_required')
  const result=await c.archive({planId:plan.plan.id,nodeIds:entries.map(e=>e.nodeId)})
  expect((await c.preview()).counts).toMatchObject({raw:55,visible:12,archived:43,candidates:0})
  expect((await store.load({sideline:false})).projects[0].nodes.find(n=>n.id==='term-murumtyj-6tzk8guc')!.cleanupArchiveId).toBeUndefined()
  await c.undo(result.receipt.id)
  expect((await c.preview()).counts).toMatchObject({raw:55,visible:55,archived:0})
})

it('ordinary creation merges its new board assignment while retaining a disjoint intentional local Ungrouped choice',async()=> {
  const local=structuredClone(workspace.projects);local[0].kanban!.assignments=[]
  local[0].kanban!.manualAssignments!['pa']=true;local[0].kanban!.manualAssignmentVersions!['pa']='local-ungrouped'
  const server=await store.load({sideline:false});server.projects[0].nodes.push(node('new-board-card'))
  server.projects[0].kanban!.assignments.push({nodeId:'new-board-card',columnId:'manual'})
  await store.save(server)
  const result=mergeWorkspacePublication(workspace.revision,local,server.projects[0].workspaceChange)
  expect(result.kind).toBe('adopt');if(result.kind!=='adopt')throw new Error('bad fixture')
  expect(result.projects[0].kanban!.assignments).toEqual([{nodeId:'new-board-card',columnId:'manual'}])
  expect(result.projects[0].kanban!.manualAssignmentVersions!['pa']).toBe('local-ungrouped')
})
