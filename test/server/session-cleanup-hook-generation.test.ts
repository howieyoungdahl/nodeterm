import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { buildManagedScript, MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'

describe('cleanup sender process evidence on the authenticated hook transport', () => {
  const secret=Buffer.alloc(32,17), nodeId='term-cleanup-sender'
  let dir='', events:NormalizedAgentEvent[]=[]
  beforeAll(async()=>{
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'nt-cleanup-hook-'))
    resetPlatformForTests();initPlatform(fakePlatform({userDataDir:path.join(dir,'data')}))
    await hookServer.start();hookServer.setNodeAuthSecret(secret)
    hookServer.setListener(event=>events.push(event))
  })
  beforeEach(()=>{events=[]})
  afterAll(async()=>{hookServer.clearNodeAuthSecretForTests();hookServer.stop();resetPlatformForTests();await fs.rm(dir,{recursive:true,force:true})})
  const post=async (stamp:string|undefined,revision=MANAGED_SCRIPT_REVISION,verified=true)=>{
    const body=new URLSearchParams({nodeId,payload:JSON.stringify({hook_event_name:'SessionStart',session_id:'s',source:'startup',cleanupProcess:'999:999'})})
    if(stamp!==undefined)body.set('nodeterm_cleanup_process',stamp)
    const response=await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/codex`,{method:'POST',body,
      headers:{'X-Nodeterm-Hook-Token':hookServer.getToken(),'X-Nodeterm-Hook-Client':String(revision),
        ...(verified?{'X-Nodeterm-Node-Token':nodeAuthToken(secret,nodeId)}:{})}})
    expect(response.status).toBe(204)
    return events.at(-1)
  }
  it('accepts a bounded stamp only from the verified current managed transport',async()=>{
    expect(await post('10:1234')).toMatchObject({verified:true,cleanupProcess:'10:1234',freshSession:true})
  })
  it('legacy clients and raw provider JSON cannot invent a process stamp',async()=>{
    const legacy=await post('10:1234',4), raw=await post(undefined)
    expect(legacy).toMatchObject({verified:true});expect(raw).toMatchObject({verified:true})
    expect(legacy?.cleanupProcess).toBeUndefined();expect(raw?.cleanupProcess).toBeUndefined()
  })
  it('unverified transport never supplies cleanup sender authority',async()=>{
    const event=await post('10:1234',MANAGED_SCRIPT_REVISION,false)
    expect(event).toMatchObject({verified:false})
    expect(event?.cleanupProcess).toBeUndefined()
  })
  it.each(['10:1234\n','bad','10:1234:5678'])('rejects malformed sender stamp %j',async stamp=>{
    expect((await post(stamp))?.cleanupProcess).toBeUndefined()
  })
  it.skipIf(process.platform!=='linux')('executes the actual generated hook under its Codex ancestor and transmits that ancestor birth',async()=>{
    const script=path.join(dir,'codex.sh'), fixture=path.join(dir,'codex.cjs'), expected=path.join(dir,'expected.txt'), tokens=path.join(dir,'tokens')
    await fs.mkdir(tokens);await fs.writeFile(path.join(tokens,nodeId),nodeAuthToken(secret,nodeId)+'\n',{mode:0o600})
    await fs.writeFile(script,buildManagedScript('codex',null),{mode:0o700})
    await fs.writeFile(fixture,`process.title='codex';const fs=require('node:fs');const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');
      fs.writeFileSync(${JSON.stringify(expected)},process.pid+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
      const hook=require('node:child_process').spawn('sh',[${JSON.stringify(script)}],{stdio:['pipe','ignore','ignore']});
      hook.stdin.end(JSON.stringify({hook_event_name:'SessionStart',session_id:'executed',source:'startup'}));
      hook.on('close',code=>process.exit(code??1));`)
    const child=spawn(process.execPath,[fixture],{env:{...process.env,HOME:dir,NODETERM_NODE_ID:nodeId,NODETERM_HOOK_ENDPOINT:'',
      NODETERM_HOOK_SOCK:'',NODETERM_HOOK_PORT:String(hookServer.getPort()),NODETERM_HOOK_TOKEN:hookServer.getToken(),
      NODETERM_HOOK_VERSION:'2',NODETERM_NODE_TOKEN_DIR:tokens},stdio:'ignore'})
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
    expect(code).toBe(0)
    const deadline=Date.now()+4000
    while(!events.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20))
    expect(events.at(-1)).toMatchObject({verified:true,clientRevision:MANAGED_SCRIPT_REVISION,cleanupProcess:await fs.readFile(expected,'utf8')})
  },10000)
})
