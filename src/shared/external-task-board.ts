export interface ExternalTask {
  nodeId: string
  task: string
  workflow: string | null
  stage: string
  urgency: string | null
  urgent?: boolean
  reason: string | null
  priority: string | null
}

export interface ExternalTaskBoard {
  url: string
  available: boolean
  cards: ExternalTask[]
}
