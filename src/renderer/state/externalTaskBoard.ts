import { useEffect } from 'react'
import { create } from 'zustand'
import type { ExternalTask, ExternalTaskBoard, ExternalTaskColumns } from '../../shared/external-task-board'
import { isBrowserRuntime } from '../bridge/runtime'
import { useProjects } from './projects'

interface BoardView {
  project: string
  url: string | null
  homeUrl?: string
  available: boolean
  reading: boolean
  linkPage?: string
  lastPlacement: Map<string, ExternalTask>
  columns: ExternalTaskColumns | null
  backgroundNodeIds: string[]
  featuredSession: ExternalTaskBoard['featuredSession']
  tasks: Map<string, ExternalTask>
}
export const NO_BACKGROUND: string[] = []
const empty = { project: '', url: null, homeUrl: undefined, linkPage: undefined, available: false, reading: false, lastPlacement: new Map<string, ExternalTask>(), columns: null, backgroundNodeIds: NO_BACKGROUND, featuredSession: undefined, tasks: new Map<string, ExternalTask>() }
export const useExternalBoard = create<BoardView>(() => empty)

export interface ProjectTaskLink {
  url: string
  available: boolean
  manageUrl?: string
  task?: ExternalTask
}

/** The compact badge and the open card use the same project-scoped reading. */
export function useProjectTaskLink(nodeId?: string): ProjectTaskLink | null {
  const projectId = useProjects(s => s.projects.find(p =>
    p.nodes.some(n => n.id === nodeId && n.kind === 'terminal'))?.id)
  const url = useExternalBoard(s => s.project === projectId ? s.url : null)
  const task = useExternalBoard(s => nodeId && s.project === projectId ? s.tasks.get(nodeId) : undefined)
  const available = useExternalBoard(s => s.available)
  const linkPage = useExternalBoard(s => s.project === projectId && s.available ? s.linkPage : undefined)
  return url ? { url, task, available, manageUrl: nodeId && linkPage ? cardLinkHref(linkPage, nodeId) : undefined } : null
}

export function cardLinkHref(page: string, node: string): string {
  const url = new URL(page)
  url.searchParams.set('node', node)
  return url.toString()
}

export function taskBoardHref(board: string, task?: string): string {
  const url = new URL(board)
  if (task) url.searchParams.set('task', task)
  return url.toString()
}

/** A manual canvas title wins. A verified outcome can also name a fresh numbered terminal. */
export function taskDisplayTitle(title: string, titleAuto: boolean | undefined, task?: ExternalTask): string {
  if (titleAuto === false || !task) return title
  if (task.displayName) return task.displayName
  return task.taskTitle && (!title || /^Terminal(?: \d+)?$/i.test(title)) ? task.taskTitle : title
}

/** Poll once for the active project, shared by the canvas and all its Kanban cards. */
export function useExternalBoardSync() {
  const project = useProjects((s) => s.activeProjectId)
  useEffect(() => {
    if (!isBrowserRuntime() || !project) return
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    useExternalBoard.setState({ ...empty, project, reading: true })
    async function refresh() {
      try {
        const res = await fetch('/task-board?project=' + encodeURIComponent(project), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          cache: 'no-store'
        })
        if (!res.ok) throw new Error('Task board unavailable')
        const { board }: { board: ExternalTaskBoard | null } = await res.json()
        if (!controller.signal.aborted)
          useExternalBoard.setState(previous => {
            const tasks = new Map(board?.cards.map(card => [card.nodeId, card]))
            const offline = board && !board.available && previous.project === project && previous.url === board.url
            return {
              project, reading: false, linkPage: board?.available ? board.linkPage : undefined, url: board?.url ?? null,
              homeUrl: board?.homeUrl, available: board?.available ?? false,
              featuredSession: board?.featuredSession, backgroundNodeIds: board?.backgroundNodeIds ?? NO_BACKGROUND,
              columns: offline ? previous.columns : board?.columns ?? null,
              lastPlacement: offline ? previous.lastPlacement : tasks, tasks
            }
          })
      } catch {
        if (!controller.signal.aborted)
          useExternalBoard.setState(previous => previous.project === project ? {
            available: false, tasks: new Map(), backgroundNodeIds: NO_BACKGROUND,
            featuredSession: previous.featuredSession && { ...previous.featuredSession, nodeId: null }
          } : previous)
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
