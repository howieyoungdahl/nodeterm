import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { createCleanupPersistence } from '../../src/core/session-cleanup-persistence'
import { SessionCleanup, CLEANUP_IDLE_MS } from '../../src/core/session-cleanup'
import { readCleanupProtection } from '../../src/core/session-cleanup-protection'
import type { Workspace } from '../../src/shared/types'
let dir:string, user:string, store:WorkspaceStore, files:string[], index:string
beforeEach(async()=> {
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-retained-'));user=path.join(dir,'user');await fs.mkdir(user)
  initPlatform(fakePlatform({userDataDir:user}));store=new WorkspaceStore();index=path.join(user,'workspace.json')
  const workspace:Workspace={version:2,activeProjectId:'p1',projects:['p1','p2'].map(id=>({id,name:id,color:'#888',
    cwd:path.join(dir,id),viewport:{x:0,y:0,zoom:1},nodes:[{id:`term-${id}`,kind:'terminal',title:'Review',color:'#888',group:null,
      position:{x:0,y:0},size:{width:640,height:440},shell:'/bin/bash'}]}))}
  await store.save(workspace)
  files=['p1','p2'].map(id=>path.join(dir,id,'.nodeterm','project.json'))
  for(const file of files){const raw=JSON.parse(await fs.readFile(file,'utf8'));raw.futureRoot={keep:true};raw.nodes[0].futureNode={keep:true};await fs.writeFile(file,JSON.stringify(raw))}
  const raw=JSON.parse(await fs.readFile(index,'utf8'));raw.futureIndex={keep:true};raw.entries.forEach((e:any)=>e.futureEntry={keep:true});await fs.writeFile(index,JSON.stringify(raw))
})
afterEach(async()=>{vi.restoreAllMocks();resetPlatformForTests();await fs.rm(dir,{recursive:true,force:true})})
const service=(s=store)=> {
  const activityAt=Date.now()-CLEANUP_IDLE_MS-60_000
  return new SessionCleanup({dataDir:user,...createCleanupPersistence(s),exclusive:async work=>work(),
    probe:async()=>({generation:'fixture:original',activityAt,state:'completed',
      workChildren:0,pending:false,fingerprint:'stable',reason:'fixture'})})
}
const select=async(s:SessionCleanup,nodeIds=['term-p1'])=>s.archive({planId:(await s.preview()).plan.id,nodeIds})
const unknowns=async()=> {const raw=JSON.parse(await fs.readFile(files[0],'utf8'));expect(raw.futureRoot).toEqual({keep:true});expect(raw.nodes[0].futureNode).toEqual({keep:true})}
it('real PR30 store preserves selected, sibling and index unknown fields through archive/restart/undo',async()=> {
  const indexBefore=await fs.readFile(index,'utf8'),siblingBefore=await fs.readFile(files[1],'utf8'),cleanup=service()
  const {receipt}=await select(cleanup)
  await unknowns();expect(await fs.readFile(index,'utf8')).toBe(indexBefore);expect(await fs.readFile(files[1],'utf8')).toBe(siblingBefore)
  expect((await readCleanupProtection(index))).toContain('nt-term-p1')
  // A later independent writer edits the archived card; undo only removes our marker.
  const raw=JSON.parse(await fs.readFile(files[0],'utf8'));raw.nodes[0].title='Later title';raw.nodes[0].position.x=123;await fs.writeFile(files[0],JSON.stringify(raw))
  await service(new WorkspaceStore()).undo(receipt.id)
  const restored=JSON.parse(await fs.readFile(files[0],'utf8'))
  expect(restored.nodes[0].cleanupArchiveId).toBeUndefined();expect(restored.nodes[0].title).toBe('Later title');expect(restored.nodes[0].position.x).toBe(123)
  await unknowns();expect(await fs.readFile(index,'utf8')).toBe(indexBefore);expect(await fs.readFile(files[1],'utf8')).toBe(siblingBefore)
})
it('preview does not enroll, rewrite or create recovery state',async()=> {
  const before=await fs.readFile(index,'utf8');await service().preview()
  expect(await fs.readFile(index,'utf8')).toBe(before)
  await expect(fs.lstat(path.join(dir,'p1','.nodeterm','.recovery'))).rejects.toMatchObject({code:'ENOENT'})
})
it('refuses a competing exact-head write rather than replacing it with a new base',async()=> {
  const coordinator=store.organizerCoordinator(),commit=coordinator.commitOrganizer.bind(coordinator)
  vi.spyOn(coordinator,'commitOrganizer').mockImplementation(async(...args)=> {
    const raw=JSON.parse(await fs.readFile(files[0],'utf8'));raw.nodes[0].title='Competing winner';await fs.writeFile(files[0],JSON.stringify(raw));return commit(...args)
  })
  await expect(select(service())).rejects.toMatchObject({code:expect.stringMatching(/^cleanup_publication_/ )})
  const raw=JSON.parse(await fs.readFile(files[0],'utf8'));expect(raw.nodes[0].title).toBe('Competing winner');expect(raw.nodes[0].cleanupArchiveId).toBeUndefined();await unknowns()
})
it('retains prepared recovery for unknown publication acknowledgment; durable undo survives restart',async()=> {
  const coordinator=store.organizerCoordinator(),commit=coordinator.commitOrganizer.bind(coordinator)
  vi.spyOn(coordinator,'commitOrganizer').mockImplementation(async(...args)=>({...await commit(...args),kind:'publication-unknown'}))
  const cleanup=service();await expect(select(cleanup)).rejects.toMatchObject({code:'cleanup_publication_publication-unknown_recovery_required'})
  const id=(await cleanup.receipts()).receiptIds[0];expect((await cleanup.receipt(id)).receipt.state).toBe('prepared')
  await service(new WorkspaceStore()).undo(id)
  expect(JSON.parse(await fs.readFile(files[0],'utf8')).nodes[0].cleanupArchiveId).toBeUndefined();await unknowns()
})
it('multi-project partial publication retains an inverse without touching the index',async()=> {
  const coordinator=store.organizerCoordinator(),commit=coordinator.commitOrganizer.bind(coordinator)
  vi.spyOn(coordinator,'commitOrganizer').mockImplementation(async(...args)=>args[1]==='p2'?{kind:'busy',recovery:'fixture-held-lease'}:commit(...args))
  const cleanup=service(),before=await fs.readFile(index,'utf8');await expect(select(cleanup,['term-p1','term-p2'])).rejects.toMatchObject({code:'cleanup_publication_busy_recovery_required'})
  expect(JSON.parse(await fs.readFile(files[0],'utf8')).nodes[0].cleanupArchiveId).toBeTruthy()
  expect(JSON.parse(await fs.readFile(files[1],'utf8')).nodes[0].cleanupArchiveId).toBeUndefined()
  await service(new WorkspaceStore()).undo((await cleanup.receipts()).receiptIds[0]);await unknowns();expect(await fs.readFile(index,'utf8')).toBe(before)
})
it('publication guard vetoes under the actual retained writer lock',async()=> {
  const adapter=createCleanupPersistence(store),workspace=await adapter.load();workspace.projects[0].nodes[0].cleanupArchiveId='fixture'
  await expect(adapter.save(workspace,()=> 'activity_during_publication')).rejects.toMatchObject({code:expect.stringMatching(/^cleanup_publication_/)})
  expect(JSON.parse(await fs.readFile(files[0],'utf8')).nodes[0].cleanupArchiveId).toBeUndefined();await unknowns()
})
