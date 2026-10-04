#!/usr/bin/env node
// Offline packet preparation. This script never connects to a server or mutates a workspace.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

try {
  const [reviewFile,auditFile,previewFile,outputFile,...extra]=process.argv.slice(2)
  if(extra.length || ![reviewFile,auditFile,previewFile,outputFile].every(p=>typeof p==='string' && path.isAbsolute(p))) throw new Error('four_absolute_host_paths_required')
  const read=p=>{if(fs.statSync(p).size>1024*1024)throw new Error('packet_too_large');return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''))}
  const review=read(reviewFile),audit=read(auditFile),preview=read(previewFile)
  const count=review.targets?.length, now=Date.now(), safe=id=>typeof id==='string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id)
  if(review.requested!==true || !Array.isArray(review.targets) || count<1 || count>100 || review.confirmedObsolete!==count ||
    review.targets.some(r=>!r || !safe(r.nodeId)) || new Set(review.targets.map(r=>r.nodeId)).size!==count ||
    !Array.isArray(audit.rows) || !Array.isArray(preview.plan?.rows) || preview.version!==1 || preview.dryRun!==true ||
    !Number.isSafeInteger(preview.plan.createdAt) || preview.plan.createdAt>now ||
    !Number.isSafeInteger(preview.plan.expiresAt) || preview.plan.expiresAt<=now) throw new Error('exact_review_and_fresh_preview_required')
  const retains=new Set(audit.rows.filter(r=>r.category!=='redundant').map(r=>r.nodeId))
  const entries=review.targets.map(target=>{
    const current=preview.plan.rows.filter(r=>r.nodeId===target.nodeId),prior=audit.rows.filter(r=>r.nodeId===target.nodeId)
    if(retains.has(target.nodeId) || current.length!==1 || prior.length!==1 || prior[0].category!=='redundant' ||
      current[0].archived || current[0].projectId!==prior[0].projectId || current[0].title!==target.title ||
      !current[0].reviewedFence?.admissible || !/^[a-f0-9]{64}$/.test(current[0].reviewedFence.ownerDigest)) throw new Error('changed_ambiguous_or_retained_target:'+target.nodeId)
    // A disposition is an explicit human decision. Titles, provider screens and historical
    // task-status phrases cannot supply it, nor can a historical cohort size authorize targets.
    const disposition=target.disposition
    if(!['obsolete-completed','obsolete-superseded','obsolete-paused','obsolete-shell'].includes(disposition))
      throw new Error('explicit_human_disposition_required:'+target.nodeId)
    return {nodeId:target.nodeId,disposition,
      evidenceDigest:createHash('sha256').update(JSON.stringify(target)).digest('hex'),ownerDigest:current[0].reviewedFence.ownerDigest}
  })
  const projects=new Set(review.targets.map(t=>preview.plan.rows.find(r=>r.nodeId===t.nodeId).projectId))
  if(projects.size!==1) throw new Error('one_exact_project_scope_required')
  const output={projectId:[...projects][0],entries}
  fs.writeFileSync(outputFile,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stdout.write(JSON.stringify({prepared:count,retained:retains.size,output:outputFile,semantics:'human task receipts, never authoritative hooks'})+'\n')
} catch(e) {process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exitCode=1}
