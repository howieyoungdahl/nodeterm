import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SessionCleanup, CLEANUP_IDLE_MS } from '../../src/core/session-cleanup'
import { CleanupActivity, createCleanupProbe } from '../../src/core/session-cleanup-probe'
import { createCleanupStartupWitness } from '../../src/core/session-cleanup-generation'
import { CLEANUP_PROCESS_STAMP_SH } from '../../src/core/agents/hooks/cleanup-process-sh'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
import { makeTmuxTmpdir } from '../../src/core/tmux-test-socket'
import { writeFileAtomic } from '../../src/core/fs-atomic'
import type { Workspace } from '../../src/shared/types'
const exec = promisify(execFile)
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], {stdio:'ignore'}); return true } catch { return false } })()
describe.skipIf(process.platform !== 'linux' || !hasTmux)('actual disposable tmux cleanup', () => {
  it('retains completed live Codex; excludes silent child jobs, shell drafts and root builtin reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-cleanup-live-'))
    const previousTmp = process.env.TMUX_TMPDIR
    const tmuxDir = makeTmuxTmpdir('nt-cleanup-', TMUX_SOCKET)
    process.env.TMUX_TMPDIR = tmuxDir
    const id = `term-cleanup-${randomUUID()}`, name = sessionName(id), target = `=${name}:`
    const call = (...args: string[]) => exec('tmux', ['-L', TMUX_SOCKET, ...args], {timeout:4000})
    const disk = path.join(dir, 'workspace.json'), fixture = path.join(dir,'codex-fixture.cjs')
    const workspace: Workspace = { version:2, activeProjectId:'p', projects:[{id:'p',name:'P',color:'#888',viewport:{x:0,y:0,zoom:1},
      nodes:[{id,kind:'terminal',agentId:'codex',agentSessionId:'fresh-fixture',title:'fixture',color:'#888',group:null,position:{x:0,y:0},size:{width:640,height:440}}]}] }
    const originalActivity: CleanupActivity = new CleanupActivity((nodeId,claim)=>
      createCleanupStartupWitness(()=> 'tmux',originalActivity.bootId)(nodeId,claim))
    const makeProbe = (activity: CleanupActivity) => createCleanupProbe({tmuxBin:()=> 'tmux',status:()=>undefined,lastActivity:()=>undefined,activity})
    let probe = makeProbe(originalActivity)
    const observed = () => probe(workspace.projects[0],workspace.projects[0].nodes[0])
    const until = async (predicate: (e: Awaited<ReturnType<typeof observed>>) => boolean) => {
      const deadline = Date.now()+6000
      while (Date.now()<deadline) { const e = await observed(); if (predicate(e)) return e; await new Promise(r=>setTimeout(r,50)) }
      throw new Error(`probe did not settle: ${JSON.stringify(await observed())}`)
    }
    try {
      // Synthetic CLI semantics, real foreground process / process tree / tmux screen. No provider call.
      await fs.writeFile(fixture, `process.title='codex'; console.log('cleanup-preserved-output\\nReview finished\\n  Worked for 47m 50s • 23:08\\n\\n› Ask Codex to do anything\\n'); process.stdin.resume(); process.stdin.on('data',()=>require('node:child_process').spawn('sleep',['60']));`)
      await call('new-session','-d','-s',name,'-x','100','-y','30','env',`NODETERM_CLEANUP_BOOT=${originalActivity.bootId}`,process.execPath,fixture)
      const uncovered = await until(e=>e.reason==='child-history-unproven' && e.workChildren===0)
      const claim=uncovered.generation.split(':').slice(-2).join(':')
      await originalActivity.observe({nodeId:id,agentId:'codex',kind:'state',state:'working',sessionId:'fresh-fixture',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:claim})
      const initial = await until(e=>e.state==='completed' && e.workChildren===0)
      await fs.writeFile(disk,JSON.stringify(workspace))
      const cleanup = new SessionCleanup({dataDir:dir,now:()=>Date.now()+2*CLEANUP_IDLE_MS,
        load:async()=>JSON.parse(await fs.readFile(disk,'utf8')),save:w=>writeFileAtomic(disk,JSON.stringify(w)),exclusive:w=>w(),probe:(...args)=>probe(...args)})
      const preview = await cleanup.preview()
      expect(preview.plan.rows[0].eligible).toBe(true)
      const {receipt}=await cleanup.archive({planId:preview.plan.id,nodeIds:[id]})
      expect(JSON.parse(await fs.readFile(disk,'utf8')).projects[0].nodes[0].cleanupArchiveId).toBe(receipt.id)
      expect((await observed()).generation).toBe(initial.generation)
      await cleanup.undo(receipt.id)
      expect(JSON.parse(await fs.readFile(disk,'utf8'))).toEqual(workspace)
      expect((await observed()).generation).toBe(initial.generation)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(true)
      // Same-PID child work survives parent completion and cannot disappear after Server restart.
      originalActivity.observe({nodeId:id,agentId:'codex',kind:'subagent-start',toolUseId:'internal-child',sessionId:'fresh-fixture'})
      originalActivity.observe({nodeId:id,agentId:'codex',kind:'state',state:'done',sessionId:'fresh-fixture'})
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      const restarted: CleanupActivity = new CleanupActivity((nodeId,stamp)=>
        createCleanupStartupWitness(()=> 'tmux',restarted.bootId)(nodeId,stamp))
      probe = makeProbe(restarted)
      expect((await observed()).generation).toBe(initial.generation)
      expect((await cleanup.preview()).plan.rows[0]).toMatchObject({eligible:false,evidence:{state:'unknown',pending:true,reason:'child-history-unproven'}})
      restarted.observe({nodeId:id,agentId:'codex',kind:'state',state:'working',sessionId:'fresh-fixture',sessionPhase:'start',freshSession:false,verified:true})
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      // Even a spurious startup label cannot retrofit an inherited process's private boot marker.
      await restarted.observe({nodeId:id,agentId:'codex',kind:'state',state:'working',sessionId:'spurious-fresh-fixture',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:claim})
      expect(restarted.covered(id,'spurious-fresh-fixture',initial.generation)).toBe(false)
      await call('set-environment','-t',`=${name}`,'NODETERM_CLEANUP_BOOT',restarted.bootId)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      probe = makeProbe(originalActivity)
      expect(originalActivity.pending(id)).toBe(1)
      originalActivity.observe({nodeId:id,agentId:'codex',kind:'subagent-end',toolUseId:'internal-child',sessionId:'fresh-fixture'})
      expect((await call('capture-pane','-p','-t',target)).stdout).toContain('cleanup-preserved-output')
      await call('send-keys','-t',target,'job','Enter')
      await until(e=>e.workChildren!==null && e.workChildren>0)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('kill-session','-t',`=${name}`)
      await call('new-session','-d','-s',name,'-x','100','-y','30','env',`NODETERM_CLEANUP_BOOT=${originalActivity.bootId}`,'PS1=review$ ','bash','--noprofile','--norc')
      await until(e=>e.workChildren===0)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('send-keys','-t',target,"printf '\\nWorked for 47m 50s \\u2022 23:08\\n\\n\\u203a Ask Codex to do anything\\n'",'Enter')
      await until(e=>e.workChildren===0)
      await call('send-keys','-l','-t',target,'echo $')
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('send-keys','-t',target,'C-c')
      await call('send-keys','-t',target,'read -p "$ " value','Enter')
      await until(e=>e.workChildren===0)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('new-window','-d','-t',`=${name}`,'sleep 60')
      expect((await observed()).reason).toBe('ambiguous-pane')
    } finally {
      await call('kill-session','-t',`=${name}`).catch(()=>{})
      await fs.rm(dir,{recursive:true,force:true})
      await fs.rm(tmuxDir,{recursive:true,force:true})
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR
      else process.env.TMUX_TMPDIR = previousTmp
    }
  },20000)
  it('binds sender evidence to the exact foreground CLI across delayed hooks and same-shell replacements', async () => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nt-cleanup-replace-'))
    const previousTmp=process.env.TMUX_TMPDIR, tmuxDir=makeTmuxTmpdir('nt-cleanup-',TMUX_SOCKET)
    process.env.TMUX_TMPDIR=tmuxDir
    const id=`term-cleanup-${randomUUID()}`, name=sessionName(id), target=`=${name}:`
    const call=(...args:string[])=>exec('tmux',['-L',TMUX_SOCKET,...args],{timeout:4000})
    const fixture=path.join(dir,'codex.cjs'), stamp=path.join(dir,'sender.txt')
    const workspace: Workspace={version:2,activeProjectId:'p',projects:[{id:'p',name:'P',color:'#888',viewport:{x:0,y:0,zoom:1},nodes:[{
      id,kind:'terminal',agentId:'codex',agentSessionId:'old',title:'fixture',color:'#888',group:null,position:{x:0,y:0},size:{width:640,height:440}}]}]}
    const activity: CleanupActivity=new CleanupActivity((nodeId,claim)=>createCleanupStartupWitness(()=> 'tmux',activity.bootId)(nodeId,claim))
    const probe=createCleanupProbe({tmuxBin:()=> 'tmux',status:()=>undefined,lastActivity:()=>undefined,activity})
    const observed=()=>probe(workspace.projects[0],workspace.projects[0].nodes[0])
    const cleanup=new SessionCleanup({dataDir:dir,now:()=>Date.now()+2*CLEANUP_IDLE_MS,load:async()=>structuredClone(workspace),
      save:async()=>{throw Error('replacement test must never archive')},exclusive:w=>w(),probe})
    const until=async (predicate:(e:Awaited<ReturnType<typeof observed>>)=>boolean)=>{
      const deadline=Date.now()+6000
      while(Date.now()<deadline){const e=await observed();if(predicate(e))return e;await new Promise(r=>setTimeout(r,50))}
      const failed=await observed(), rootPid=failed.generation.split(':')[3]
      const rows=(await exec('ps',['-eo','pid=,ppid=,comm='])).stdout.split('\n').filter(line=>line.trim().split(/\s+/)[1]===rootPid)
      throw Error(`replacement fixture did not settle: ${JSON.stringify(failed)} children=${JSON.stringify(rows)}`)
    }
    try {
      // Execute the managed sender's ancestry stamp under a synthetic CLI, before any POST.
      await fs.writeFile(fixture,`process.title='codex'; const sh=${JSON.stringify(CLEANUP_PROCESS_STAMP_SH+'\nprintf %s "$nt_cleanup_process"')};
        require('node:fs').writeFileSync(${JSON.stringify(stamp)},require('node:child_process').execFileSync('sh',['-c',sh]));
        console.log('Review finished\\n  Worked for 47m 50s • 23:08\\n\\n› Ask Codex to do anything\\n');
        process.stdin.resume();process.stdin.on('data',data=>{if(data.toString().includes('exit'))process.exit()});`)
      await call('new-session','-d','-s',name,'-x','100','-y','30','env',`NODETERM_CLEANUP_BOOT=${activity.bootId}`,'bash','--noprofile','--norc')
      const launch=()=>call('send-keys','-t',target,`${process.execPath} ${fixture}`,'Enter')
      await launch()
      const old=await until(e=>e.reason==='child-history-unproven'&&e.workChildren===0)
      const oldClaim=await fs.readFile(stamp,'utf8')
      expect(oldClaim).toBe(old.generation.split(':').slice(-2).join(':'))
      await call('send-keys','-t',target,'exit','Enter')
      await until(e=>e.reason==='shell-input-boundary-unproven')
      await launch()
      const next=await until(e=>e.reason==='child-history-unproven'&&e.workChildren===0&&e.generation!==old.generation)
      expect(next.generation.split(':').slice(0,5)).toEqual(old.generation.split(':').slice(0,5))
      // A first startup POST delayed until after replacement cannot enroll that replacement.
      await activity.observe({nodeId:id,agentId:'codex',kind:'state',sessionId:'old',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:oldClaim})
      expect((await cleanup.preview()).plan.rows[0]).toMatchObject({eligible:false,evidence:{state:'unknown',pending:true}})
      const nextClaim=await fs.readFile(stamp,'utf8')
      workspace.projects[0].nodes[0].agentSessionId='next'
      await activity.observe({nodeId:id,agentId:'codex',kind:'state',sessionId:'next',sessionPhase:'start',freshSession:true,verified:true,cleanupProcess:nextClaim})
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(true)
      await call('send-keys','-t',target,'exit','Enter')
      await until(e=>e.reason==='shell-input-boundary-unproven')
      await launch()
      const third=await until(e=>e.reason==='child-history-unproven'&&e.workChildren===0&&e.generation!==next.generation)
      expect(third.generation.split(':').slice(0,5)).toEqual(next.generation.split(':').slice(0,5))
      // A new preview cannot reuse the previous covered foreground's session or generation.
      expect((await cleanup.preview()).plan.rows[0]).toMatchObject({eligible:false,evidence:{state:'unknown',pending:true}})
    } finally {
      await call('kill-session','-t',`=${name}`).catch(()=>{})
      await fs.rm(dir,{recursive:true,force:true});await fs.rm(tmuxDir,{recursive:true,force:true})
      if(previousTmp===undefined)delete process.env.TMUX_TMPDIR;else process.env.TMUX_TMPDIR=previousTmp
    }
  },20000)
})
