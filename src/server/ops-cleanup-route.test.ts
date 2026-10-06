import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { expect, it, vi } from 'vitest'
import { createOpsApiHandler, type OpsApiDeps } from './ops-api'

async function call(action: string, body?: unknown, auth = 'Bearer synthetic-ops', peer = '127.0.0.1') {
  const cleanup={preview:vi.fn(async()=>({version:1,dryRun:true})),reviewedPreview:vi.fn(async()=>({version:1,dryRun:true})),
    archive:vi.fn(async()=>({version:1})),undo:vi.fn(async()=>({version:1})),receipts:vi.fn(async()=>({version:1,receiptIds:[]}))}
  const req=Object.assign(new EventEmitter(),{url:'/opsapi/cleanup/'+action,method:body===undefined?'GET':'POST',
    socket:{remoteAddress:peer},headers:{authorization:auth,'content-type':'application/json'}})
  let status=0, result: unknown
  const res={setHeader:vi.fn(),writeHead:(value:number)=>{status=value},end:(value:string)=>{result=JSON.parse(value)}}
  const handler=createOpsApiHandler({token:'synthetic-ops',cleanup} as unknown as OpsApiDeps)
  const run=handler(req as unknown as http.IncomingMessage,res as unknown as http.ServerResponse)
  queueMicrotask(()=>{if(body!==undefined)req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')})
  await run
  return {status,result,cleanup}
}
it('admits a bounded 43-ID review packet larger than the unrelated management 10 KiB bound',async()=> {
  const input={projectId:'p',entries:Array.from({length:43},(_,i)=>({nodeId:`term-reviewed-candidate-card-${i}`,disposition:'obsolete-superseded',evidenceDigest:'e'.repeat(64),ownerDigest:'c'.repeat(64)}))}
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(10*1024)
  const result=await call('reviewed-preview',input)
  expect(result.status).toBe(200);expect(result.cleanup.reviewedPreview).toHaveBeenCalledWith(input)
})
it.each(['','Bearer node-token','Bearer conversation-token'])('never treats %j as management authority',async auth=> {
  const r=await call('archive',{planId:'x',nodeIds:['x']},auth)
  expect(r.status).toBe(401);expect(r.cleanup.archive).not.toHaveBeenCalled()
})
it('refuses a non-loopback peer even with the management credential',async()=> {
  const r=await call('archive',{},'Bearer synthetic-ops','192.0.2.1')
  expect(r.status).toBe(403);expect(r.cleanup.archive).not.toHaveBeenCalled()
})
it('refuses a review body exceeding its separate hard byte budget',async()=> {
  const r=await call('reviewed-preview',{data:'x'.repeat(64001)})
  expect(r.status).toBe(413);expect(r.cleanup.reviewedPreview).not.toHaveBeenCalled()
})
