import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

// Runtime fixtures must never poll provider homes for automatic session titles.
vi.mock('../../src/core/session-name-sweep', () => ({ startSessionNameSweep: () => () => {},
  displayNodeTitle: (node: { title: string }) => node.title }))
import { startServer } from '../../src/server/index'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import { cleanupHash } from '../../src/core/session-cleanup'
import type { Workspace } from '../../src/shared/types'

it.skipIf(process.platform !== 'linux')('archives an exact operator-reviewed card on a disposable Server without changing pane, PID, output, history or later metadata',async()=> {
  if (privateTmuxSocketReason() || !/^nt-(?:vitest-\d+|operational-fresh-[A-Za-z0-9-]+)$/.test(TMUX_SOCKET))
    throw new Error('unique-private-test-socket-required')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'nt-cleanup-runtime-')), id='term-'+randomUUID()
  const name=sessionName(id), call=(...args:string[])=>execFileSync('tmux',['-L',TMUX_SOCKET,...args],{encoding:'utf8',timeout:4000})
  let stop: (()=>Promise<void>) | undefined
  try {
    const fixture=path.join(dir,'fixture.sh')
    // A sleep process is quiet after startup. Node's startup/JIT CPU ticks legitimately change
    // the reviewed fingerprint while the first preview is open, so it is not a quiescent fixture.
    await fs.writeFile(fixture,"printf 'unchanged cleanup history\\n'\nexec sleep 600\n")
    const paneId = call('new-session','-d','-P','-F','#{pane_id}','-s',name,'sh',fixture).trim()
    expect(paneId).toMatch(/^%\d+$/)
    // Pane commands accept a pane ID directly. '=session' is a session-target grammar,
    // not a reliable pane target on supported tmux versions. Wait for this fixture's output.
    await expect.poll(() => call('capture-pane','-p','-S','-','-t',paneId)).toContain('unchanged cleanup history')
    const p = {id:'fixture',name:'Fixture',color:'#888',viewport:{x:0,y:0,zoom:1},nodes:[{id,kind:'terminal' as const,title:'old receipt',titleAuto:false,
      color:'#888',group:null,position:{x:0,y:0},size:{width:640,height:440},agentId:'codex',agentModel:'gpt-6.1-sol',agentSessionId:'preserved'}]}
    const w:Workspace={version:2,activeProjectId:p.id,projects:[p]}
    await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(w))
    await fs.writeFile(path.join(dir,'node-ownership.json'),JSON.stringify({v:1,owners:{[id]:{sourceNodeId:'ops-operator',projectId:p.id,recordedAt:Date.now()}}}),{mode:0o600})
    // Migrating a synthetic v2 fixture is setup, before any cleanup preview.
    const { WorkspaceStore } = await import('../../src/core/workspace-store')
    const {initPlatform,resetPlatformForTests}=await import('../../src/core/platform')
    const {fakePlatform}=await import('../../src/core/platform-fake')
    initPlatform(fakePlatform({userDataDir:dir}));const s=new WorkspaceStore();await s.save(await s.load({sideline:false}));resetPlatformForTests()
    const server=await startServer({port:0,host:'127.0.0.1',dataDir:dir,rendererDir:path.join(dir,'no-renderer'),insecureHttp:false,
      passwordSeed:'synthetic-test-only',installHooks:false,headless:false,deadCardReapMinutes:0})
    stop=server.close;const base=`http://127.0.0.1:${server.port}`
    const token=(await fs.readFile(path.join(dir,'ops-token'),'utf8')).trim(), headers={authorization:`Bearer ${token}`,'content-type':'application/json'}
    const get=async(route:string)=> {const r=await fetch(base+route,{headers});expect(r.status).toBe(200);return r.json()}
    const post=async(route:string,body:unknown)=> {const r=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
    expect((await fetch(base+'/opsapi/cleanup/preview',{headers:{cookie:'fake'}})).status).toBe(401)
    const beforePane=call('list-panes','-s','-t','='+name,'-F','#{pane_id}:#{pane_pid}'), beforeOutput=call('capture-pane','-p','-S','-','-t',paneId)
    const panePid = beforePane.trim().split(':')[1]
    const processBirth = async () => { const stat = await fs.readFile(`/proc/${panePid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
    const beforeBirth = await processBirth(), transcript = path.join(dir, 'synthetic-provider-transcript.jsonl')
    const transcriptBytes = '{"session":"preserved","synthetic":"provider history must remain unchanged"}\n'
    await fs.writeFile(transcript, transcriptBytes)
    expect(beforeOutput).toContain('unchanged cleanup history')
    const preview=await get('/opsapi/cleanup/preview'), row=preview.plan.rows.find((r:{nodeId:string})=>r.nodeId===id)
    // The fixture is an observed long-lived process, with no verified task history.
    // Process work must exclude automatic cleanup even though the human may review its card.
    expect(row.evidence.state).toBe('active');expect(row.evidence.pending).toBe(true)
    expect(row.eligible).toBe(false);expect(row.reviewedFence.admissible,row.reviewedFence.reason).toBe(true)
    const input={projectId:p.id,entries:[{nodeId:id,disposition:'obsolete-superseded',evidenceDigest:cleanupHash('synthetic task receipt, not hooks'),ownerDigest:row.reviewedFence.ownerDigest}]}
    const reviewed=await post('/opsapi/cleanup/reviewed-preview',input);expect(reviewed.status).toBe(200)
    const result=await post('/opsapi/cleanup/archive',{planId:reviewed.body.plan.id,nodeIds:[id]})
    expect(result.status,JSON.stringify(result.body)).toBe(200);const receiptId=result.body.receipt.id
    expect(call('list-panes','-s','-t','='+name,'-F','#{pane_id}:#{pane_pid}')).toBe(beforePane)
    expect(call('capture-pane','-p','-S','-','-t',paneId)).toBe(beforeOutput)
    expect(await processBirth()).toBe(beforeBirth)
    expect(await fs.readFile(transcript, 'utf8')).toBe(transcriptBytes)
    const index=JSON.parse(await fs.readFile(path.join(dir,'workspace.json'),'utf8'))
    index.entries[0].project.nodes[0].title='later operator edit'
    await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(index))
    await stop();stop=undefined
    const restarted=await startServer({port:0,host:'127.0.0.1',dataDir:dir,rendererDir:path.join(dir,'no-renderer'),insecureHttp:false,
      passwordSeed:'synthetic-test-only',installHooks:false,headless:false,deadCardReapMinutes:0})
    stop=restarted.close
    const recovered=await fetch(`http://127.0.0.1:${restarted.port}/opsapi/cleanup/receipts`,{headers})
    expect((await recovered.json()).receiptIds).toContain(receiptId)
    const undo=await fetch(`http://127.0.0.1:${restarted.port}/opsapi/cleanup/undo`,{method:'POST',headers,body:JSON.stringify({receiptId})})
    expect(undo.status).toBe(200)
    const restored=JSON.parse(await fs.readFile(path.join(dir,'workspace.json'),'utf8')).entries[0].project.nodes[0]
    expect(restored.title).toBe('later operator edit');expect(restored.cleanupArchiveId).toBeUndefined()
    expect(restored.agentSessionId).toBe('preserved');expect(restored.agentModel).toBe('gpt-6.1-sol')
    expect(call('list-panes','-s','-t','='+name,'-F','#{pane_id}:#{pane_pid}')).toBe(beforePane)
    expect(call('capture-pane','-p','-S','-','-t',paneId)).toBe(beforeOutput)
    expect(await processBirth()).toBe(beforeBirth)
    expect(await fs.readFile(transcript, 'utf8')).toBe(transcriptBytes)
  } finally {
    await stop?.()
    try {call('kill-session','-t','='+name)} catch {}
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
},30000)
