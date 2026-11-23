export interface ExternalTask {
  nodeId: string
  task: string
  displayName?: string | null
  taskTitle?: string | null
  manual?: boolean
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
  linkPage?: string
  backgroundNodeIds?: string[]
  featuredSession?: { label: string; nodeId: string | null }
}
