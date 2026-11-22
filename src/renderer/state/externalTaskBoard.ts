import { useEffect } from 'react'
import { create } from 'zustand'
import type { ExternalTask, ExternalTaskBoard } from '../../shared/external-task-board'
import { isBrowserRuntime } from '../bridge/runtime'
import { useProjects } from './projects'

interface BoardView {
  project: string
  url: string | null
  available: boolean
  tasks: Map<string, ExternalTask>
}
const empty = { project: '', url: null, available: false, tasks: new Map<string, ExternalTask>() }
export const useExternalBoard = create<BoardView>(() => empty)

/** Poll once for the active project, shared by the canvas and all its Kanban cards. */
export function useExternalBoardSync() {
  const project = useProjects((s) => s.activeProjectId)
  useEffect(() => {
    if (!isBrowserRuntime() || !project) return
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    useExternalBoard.setState({ ...empty, project })
    async function refresh() {
      try {
        const res = await fetch('/task-board?project=' + encodeURIComponent(project), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          cache: 'no-store'
        })
        if (!res.ok) throw new Error('Task board unavailable')
        const { board }: { board: ExternalTaskBoard | null } = await res.json()
        if (!controller.signal.aborted)
          useExternalBoard.setState({
            project,
            url: board?.url ?? null,
            available: board?.available ?? false,
            tasks: new Map(board?.cards.map((card) => [card.nodeId, card]))
          })
      } catch {
        if (!controller.signal.aborted) useExternalBoard.setState({ available: false, tasks: new Map() })
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 30000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
      useExternalBoard.setState(empty)
    }
  }, [project])
}
