import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FileCleanupReservations } from './session-cleanup-reservations'
import { cleanupReaperGuards, readCleanupProtection } from './session-cleanup-protection'
import { createSessionReaper } from './session-budget'
let dir: string
beforeEach(async()=> { dir=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-protect-')) })
afterEach(async()=> { await fs.rm(dir,{recursive:true,force:true}) })
const workspace = {version:2,projects:[{nodes:[{id:'archived',cleanupArchiveId:'receipt'}]}]}
it('Desktop composition protects archived shared projects under pressure and cap',async()=> {
  await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(workspace))
  const calls: string[][]=[]
  const reaper=createSessionReaper({...cleanupReaperGuards(dir,new FileCleanupReservations(path.join(dir,'leases'))),
    tmuxBin:()=>'/test/tmux',sockets:['private-fixture'],env:{NODETERM_SESSION_MAX_DETACHED:'1'},nowSec:()=>12*60*60,
    readMem:()=>({availableMb:100,totalMb:64_000}),log:()=>{},
    exec:async(_bin,args)=> {calls.push(args);return args.includes('list-windows') ? 'nt-archived|0|1|1\n' : ''}})
  await reaper.sweep({pressure:'pty'}); await reaper.sweep()
  expect(calls.some(c=>c.includes('kill-session'))).toBe(false)
  await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify({version:2,projects:[{nodes:[{id:'archived'}]}]}))
  await reaper.sweep({pressure:'pty'})
  expect(calls.some(c=>c.includes('kill-session'))).toBe(true) // prove the fixture can exercise the kill path
})
it.each(['absent','corrupt','invalid-nodes','busy'])('fails closed on %s metadata',async(kind)=> {
  const file=path.join(dir,'workspace.json')
  if(kind!=='absent') await fs.writeFile(file,kind==='corrupt'?'bad':JSON.stringify(kind==='invalid-nodes'?{version:2,projects:[{}]}:workspace))
  if(kind==='busy'){const locks=path.join(dir,'.recovery','workspace.json');await fs.mkdir(locks,{recursive:true});await fs.writeFile(path.join(locks,'writer.lock'),'retained-owner')}
  await expect(readCleanupProtection(file)).rejects.toThrow()
  const calls:string[][]=[]
  const reaper=createSessionReaper({...cleanupReaperGuards(dir),tmuxBin:()=>'/test/tmux',sockets:['private-fixture'],
    exec:async(_bin,args)=> {calls.push(args);return ''}})
  await reaper.sweep({pressure:'pty'})
  expect(calls).toEqual([])
})
it('reads folder and PR30 inline data archives rather than stale caches',async()=> {
  const folder=path.join(dir,'folder','.nodeterm');await fs.mkdir(folder,{recursive:true})
  await fs.mkdir(path.join(dir,'inline-projects'))
  await fs.writeFile(path.join(folder,'project.json'),JSON.stringify({nodes:[{id:'folder',cleanupArchiveId:'receipt'}]}))
  await fs.writeFile(path.join(dir,'inline-projects','inline.json'),JSON.stringify({nodes:[{id:'inline',cleanupArchiveId:'receipt'}]}))
  const file=path.join(dir,'workspace.json')
  await fs.writeFile(file,JSON.stringify({version:3,entries:[{cwd:path.dirname(folder)},{id:'inline',dataFile:true,project:{nodes:[]}}]}))
  expect((await readCleanupProtection(file)).sort()).toEqual(['nt-folder','nt-inline'])
})
it('independent host owners share exact socket leases; conflicts roll back only owned locks',async()=> {
  const root=path.join(dir,'leases'),a=new FileCleanupReservations(root),b=new FileCleanupReservations(root)
  const first=await a.reserve(['nt-b'],'one');expect(first).not.toBeNull()
  expect(await b.reserve(['nt-a','nt-b'],'one')).toBeNull()
  const rolledBack=await b.reserve(['nt-a'],'one');expect(rolledBack).not.toBeNull();await rolledBack!()
  const other=await b.reserve(['nt-b'],'two');expect(other).not.toBeNull();await other!()
  await first!();await first!()
  const recovered=await b.reserve(['nt-b'],'one');expect(recovered).not.toBeNull();await recovered!()
})
it('does not steal old or corrupt leases and refuses unsafe directories',async()=> {
  const root=path.join(dir,'leases'),a=new FileCleanupReservations(root)
  await a.reserve(['nt-a'],'one')
  const file=path.join(root,(await fs.readdir(root))[0]);await fs.writeFile(file,'bad owner');await fs.utimes(file,1,1)
  expect(await new FileCleanupReservations(root).reserve(['nt-a'],'one')).toBeNull()
  expect(await fs.readFile(file,'utf8')).toBe('bad owner')
  if(process.getuid){await fs.chmod(root,0o777);await expect(a.reserve(['nt-b'],'one')).rejects.toThrow('unsafe-cleanup-lease-directory')}
})
