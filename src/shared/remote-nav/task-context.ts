import type { ContextOperation, ContextPage, ContextScope, ContextSource, RemoteOpenTarget } from './context-page'

/** Display filters only. The authenticated host chooses the source and read authority. */
export interface TaskContextQuery {
  operation: ContextOperation
  scope: ContextScope
  cursor?: Record<string, unknown> | null
  previousSources?: ContextSource[]
  limit?: number
}
export interface TaskFocusResult {
  ok: boolean
  code: string
  controlGranted: false
}
export interface TaskContextApi {
  read(query: TaskContextQuery): Promise<ContextPage>
  focus(target: RemoteOpenTarget): Promise<TaskFocusResult>
}
