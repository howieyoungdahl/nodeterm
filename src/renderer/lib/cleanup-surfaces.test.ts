import { expect, it } from 'vitest'
import { buildSessionList, buildStatusList } from './sessionList'
import { nodeStatesToFlow, flowToNodeStates } from '../state/workspace'
import { toKanbanSession } from '../canvas/toKanbanSession'
import type { CanvasNodeState } from '@shared/types'

it('hides archive presentation in both Sessions groupings, canvas and kanban while retaining serialized identity and placement',()=> {
  const node = (id:string): CanvasNodeState => ({id,kind:'terminal',title:id,color:'#888',group:null,
    position:{x:17,y:29},size:{width:640,height:440},pinned:true,manualPlacement:true,
    agentId:'codex',agentModel:'gpt-6.1-sol',agentSessionId:'session-'+id})
  const states = [node('visible'),{...node('archived'),cleanupArchiveId:'receipt'}]
  const flow = nodeStatesToFlow(states), live = flow.map(n=>({id:n.id,kind:'terminal' as const,title:n.data.title,
    color:n.data.color,cleanupArchiveId:n.data.cleanupArchiveId}))
  const projects=[{id:'p',name:'P',color:'#888',nodes:states}]
  expect(flow[1].hidden).toBe(true);expect(flow[0].hidden).toBe(false)
  expect(flowToNodeStates(flow)[1]).toMatchObject(states[1])
  for(const liveNodes of [null,live]) {
    const groups=buildSessionList(projects,liveNodes,'p',{},'')
    expect(groups[0].ungrouped.map(n=>n.id)).toEqual(['visible'])
    expect(JSON.stringify(buildStatusList(projects,liveNodes,'p',{},''))).not.toContain('archived')
  }
  expect(flow.map(toKanbanSession).filter(Boolean).map(n=>n!.id)).toEqual(['visible'])
  delete states[1].cleanupArchiveId
  const restored=nodeStatesToFlow(states)
  expect(restored[1].hidden).toBe(false);expect(toKanbanSession(restored[1])?.id).toBe('archived')
  expect(flowToNodeStates(restored)[1]).toMatchObject(states[1])
})

it('uses the fresh live marker in status grouping before the stored baseline catches up, including brand-new cards',()=> {
  const old={id:'old',kind:'terminal' as const,title:'old',color:'#888'}
  const projects=[{id:'p',name:'P',color:'#888',nodes:[old]}]
  const live=[{...old,cleanupArchiveId:'receipt'},{...old,id:'new',cleanupArchiveId:'receipt'}]
  expect(JSON.stringify(buildStatusList(projects,live,'p',{},''))).not.toContain('"id":"old"')
  expect(JSON.stringify(buildStatusList(projects,live,'p',{},''))).not.toContain('"id":"new"')
})
