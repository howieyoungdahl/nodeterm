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
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import { writeFileAtomic } from '../../src/core/fs-atomic'
import type { Workspace } from '../../src/shared/types'

const exec = promisify(execFile)
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], {stdio:'ignore'}); return true } catch { return false } })()
describe.skipIf(process.platform !== 'linux' || !hasTmux || !!privateTmuxSocketReason())('actual disposable tmux cleanup', () => {
  it('archives/undoes a quiet live shell with the same backend and preserved output; protects a long job and a draft', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-cleanup-live-'))
    const id = `term-cleanup-${randomUUID()}`
    const name = sessionName(id)
    const paneTarget = `=${name}:`
    const call = (...args: string[]) => exec('tmux', ['-L', TMUX_SOCKET, ...args], {timeout:4000})
    const disk = path.join(dir, 'workspace.json')
    const workspace: Workspace = { version:2, activeProjectId:'p', projects:[{id:'p',name:'P',color:'#888',viewport:{x:0,y:0,zoom:1},
      nodes:[{id,kind:'terminal',title:'fixture',color:'#888',group:null,position:{x:0,y:0},size:{width:640,height:440}}]}] }
    const probe = createCleanupProbe({tmuxBin:()=> 'tmux',status:()=>undefined,lastActivity:()=>undefined,activity:new CleanupActivity()})
    try {
      await call('new-session','-d','-s',name,'-x','100','-y','30','env','PS1=cleanup-fixture$ ','bash','--noprofile','--norc')
      const observed = async () => probe(workspace.projects[0],workspace.projects[0].nodes[0])
      const until = async (predicate: (e: Awaited<ReturnType<typeof observed>>) => boolean) => {
        const deadline = Date.now()+6000
        while (Date.now()<deadline) { const e = await observed(); if (predicate(e)) return e; await new Promise(r=>setTimeout(r,50)) }
        throw new Error(`probe did not settle: ${JSON.stringify(await observed())}`)
      }
      await call('send-keys','-t',paneTarget,'printf "cleanup-preserved-output\\n"','Enter')
      const initial = await until(e=>e.state==='idle-shell' && e.workChildren===0)
      await fs.writeFile(disk,JSON.stringify(workspace))
      const cleanup = new SessionCleanup({dataDir:dir,now:()=>Date.now()+2*CLEANUP_IDLE_MS,
        load:async()=>JSON.parse(await fs.readFile(disk,'utf8')),save:w=>writeFileAtomic(disk,JSON.stringify(w)),exclusive:w=>w(),probe})
      const preview = await cleanup.preview()
      expect(preview.plan.rows[0].eligible).toBe(true)
      const {receipt}=await cleanup.archive({planId:preview.plan.id,nodeIds:[id]})
      const archived=JSON.parse(await fs.readFile(disk,'utf8'))
      expect(archived.projects[0].nodes[0].cleanupArchiveId).toBe(receipt.id)
      expect((await observed()).generation).toBe(initial.generation)
      expect((await call('capture-pane','-p','-t',paneTarget)).stdout).toContain('cleanup-preserved-output')
      await cleanup.undo(receipt.id)
      expect(JSON.parse(await fs.readFile(disk,'utf8'))).toEqual(workspace)
      expect((await observed()).generation).toBe(initial.generation)
      // Real exited-review shape: the known Codex footer remains above a live idle shell.
      workspace.projects[0].nodes[0].agentId = 'codex'
      await call('send-keys','-t',paneTarget,"printf '\\nReview finished\\n  Worked for 47m 50s \\u2022 23:08\\n\\n\\u203a Ask Codex to do anything\\n\\n'",'Enter')
      await until(e=>e.state==='completed' && e.workChildren===0)
      await fs.writeFile(disk,JSON.stringify(workspace))
      const review = await cleanup.preview()
      expect(review.plan.rows[0].eligible).toBe(true)
      const reviewArchive = await cleanup.archive({planId:review.plan.id,nodeIds:[id]})
      expect((await observed()).generation).toBe(initial.generation)
      await cleanup.undo(reviewArchive.receipt.id)
      expect(JSON.parse(await fs.readFile(disk,'utf8'))).toEqual(workspace)
      delete workspace.projects[0].nodes[0].agentId
      await fs.writeFile(disk,JSON.stringify(workspace))
      // A job can be silent for hours and still be real work. Its mere process ancestry vetoes.
      await call('send-keys','-t',paneTarget,'sleep 60','Enter')
      await until(e=>e.workChildren!==null && e.workChildren>0)
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('send-keys','-t',paneTarget,'C-c')
      await until(e=>e.state==='idle-shell')
      await call('send-keys','-l','-t',paneTarget,'unsent draft')
      await until(e=>e.state==='unknown')
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
      await call('new-window','-d','-t',`=${name}`,'sleep 60')
      expect((await observed()).reason).toBe('ambiguous-pane')
      expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
    } finally {
      // Only this test-minted ID on the test runner's private socket is terminated.
      await call('kill-session','-t',`=${name}`).catch(()=>{})
      await fs.rm(dir,{recursive:true,force:true})
    }
  },20000)
})
