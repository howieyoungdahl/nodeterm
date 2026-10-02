import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SessionCleanup, CLEANUP_IDLE_MS } from '../../src/core/session-cleanup'
import { CleanupActivity, createCleanupProbe } from '../../src/core/session-cleanup-probe'
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
      nodes:[{id,kind:'terminal',agentId:'codex',title:'fixture',color:'#888',group:null,position:{x:0,y:0},size:{width:640,height:440}}]}] }
    const probe = createCleanupProbe({tmuxBin:()=> 'tmux',status:()=>undefined,lastActivity:()=>undefined,activity:new CleanupActivity()})
    const observed = () => probe(workspace.projects[0],workspace.projects[0].nodes[0])
    const until = async (predicate: (e: Awaited<ReturnType<typeof observed>>) => boolean) => {
      const deadline = Date.now()+6000
      while (Date.now()<deadline) { const e = await observed(); if (predicate(e)) return e; await new Promise(r=>setTimeout(r,50)) }
      throw new Error(`probe did not settle: ${JSON.stringify(await observed())}`)
    }
    try {
      // Synthetic CLI semantics, real foreground process / process tree / tmux screen. No provider call.
      await fs.writeFile(fixture, `process.title='codex'; console.log('cleanup-preserved-output\\nReview finished\\n  Worked for 47m 50s • 23:08\\n\\n› Ask Codex to do anything\\n'); process.stdin.resume(); process.stdin.on('data',()=>require('node:child_process').spawn('sleep',['60']));`)
      await call('new-session','-d','-s',name,'-x','100','-y','30',process.execPath,fixture)
      const initial = await until(e=>e.state==='completed' && e.workChildren===0)
      await fs.writeFile(disk,JSON.stringify(workspace))
      const cleanup = new SessionCleanup({dataDir:dir,now:()=>Date.now()+2*CLEANUP_IDLE_MS,
        load:async()=>JSON.parse(await fs.readFile(disk,'utf8')),save:w=>writeFileAtomic(disk,JSON.stringify(w)),exclusive:w=>w(),probe})
      const preview = await cleanup.preview()
      expect(preview.plan.rows[0].eligible).toBe(true)
      const {receipt}=await cleanup.archive({planId:preview.plan.id,nodeIds:[id]})
      expect(JSON.parse(await fs.readFile(disk,'utf8')).projects[0].nodes[0].cleanupArchiveId).toBe(receipt.id)
      expect((await observed()).generation).toBe(initial.generation)
      expect((await call('capture-pane','-p','-t',target)).stdout).toContain('cleanup-preserved-output')
      await cleanup.undo(receipt.id)
      expect(JSON.parse(await fs.readFile(disk,'utf8'))).toEqual(workspace)
      expect((await observed()).generation).toBe(initial.generation)
      await call('send-keys','-t',target,'job','Enter')
      await until(e=>e.workChildren!==null && e.workChildren>0)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('kill-session','-t',`=${name}`)
      await call('new-session','-d','-s',name,'-x','100','-y','30','env','PS1=review$ ','bash','--noprofile','--norc')
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
})
