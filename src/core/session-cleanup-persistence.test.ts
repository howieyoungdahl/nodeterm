import { expect, it } from 'vitest'
import { createCleanupPersistence } from './session-cleanup-persistence'
import type { Workspace } from '../shared/types'
it('refuses a legacy writer without reading, serializing or retaining a proposal',async()=> {
  let called=false
  const adapter=createCleanupPersistence({load:async()=>{called=true;return {} as Workspace}})
  await expect(adapter.load()).rejects.toMatchObject({code:'cleanup_revision_contract_required',status:503})
  await expect(adapter.save({} as Workspace)).rejects.toMatchObject({code:'cleanup_revision_contract_required',status:503})
  expect(called).toBe(false)
})
