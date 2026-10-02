import { expect, it } from 'vitest'
import { normalizeCodex } from './normalize'
it.each(['startup','resume','reconnect','compact',undefined])('retains Codex working state but only labels explicit startup (%s)',source=> {
  const event=normalizeCodex({nodeId:'n',agentId:'codex',payload:{hook_event_name:'SessionStart',session_id:'s',source}})
  expect(event).toMatchObject({kind:'state',state:'working',sessionPhase:'start',freshSession:source==='startup'})
})
