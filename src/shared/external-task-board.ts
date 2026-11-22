export interface ExternalTask {
  nodeId: string
  task: string
  displayName?: string | null
  taskTitle?: string | null
  workflow: string | null
  stage: string
  urgency: string | null
  urgent?: boolean
  reason: string | null
  priority: string | null
}

export interface ExternalTaskColumns {
  workflows: string[]
  stages: string[]
}

export interface ExternalTaskBoard {
  url: string
  available: boolean
  cards: ExternalTask[]
  columns?: ExternalTaskColumns
}
