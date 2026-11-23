import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KanbanLabel, ProjectKanban } from '@shared/types'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'
import { useViewMode } from '../../state/viewMode'
import { useProjects } from '../../state/projects'
import { NO_BACKGROUND, taskBoardHref, taskDisplayTitle, useExternalBoard } from '../../state/externalTaskBoard'
import { useSettings } from '../../state/settings'
import {
  addColumn, assignNode, assignedTo, boardLabels, cardMatchesLabelFilter, cardMeta, columnForNode,
  deleteColumn, labelsForCard, moveColumn,
  nextColumnColor, pruneAssignments, recolorColumn, renameColumn, setCardPriority, unassigned
} from '../../lib/kanban'
import { effectivePriority, sortByPriority } from '../../lib/kanbanPriority'
import { labelSwatch } from '../../lib/kanbanLabelColors'
import { CardModal } from './CardModal'
import { PRIORITIES } from './CardMetaBar'
import { KanbanColumn, NewSessionMenu, type KanbanLane } from './KanbanColumn'
import { TaskBoardMatrix } from './TaskBoardMatrix'
import { SessionCard } from './SessionCard'
import { NodeStatusBadge } from '../../nodes/NodeStatusBadge'
import { showsStatus } from '../../lib/nodeStatusView'
import { taskBoardVisibility } from '../../lib/taskBoardVisibility'
import { taskBoardMatrix } from '../../lib/taskBoardColumns'
import type { ExternalTask } from '@shared/external-task-board'
import { parseTaskPlanning, TASK_CATEGORIES, type TaskCategory } from '@shared/task-planning'
import { GitHubIssueCard } from './GitHubIssueCard'
import { kanbanSource, sourceVisible } from '../../lib/kanbanSources'
import type { ModalSpawn } from './ModalTerminal'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { IconAgent, IconExternal, IconNote, IconSwitch, IconTerminal, IconTrash, IconWeb } from '../icons'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { useGitHubIssues } from '../../state/githubIssues'
import { useAgentStatus } from '../../state/agentStatus'
import { useSession } from '../../session/session'
import { KanbanSourceFilter, type KanbanSource } from './KanbanSourceFilter'
import { GitHubIssueSummaryModal } from './GitHubIssueSummaryModal'
import { ConfirmDialog } from '../ConfirmDialog'
import {
  githubMoveConfirmation,
  githubMoveIntent,
  type GitHubMoveConfirmation
} from '../../lib/githubIssueMove'

/** One session node shown as a board card — derived LIVE from the canvas nodes; the board
 *  itself stores only column assignments. */
export interface KanbanSession {
  titleAuto?: boolean
  taskPlanning?: import('@shared/task-planning').TaskPlanning
  pinned?: boolean
  manualPlacement?: boolean
  organization?: import('@shared/kanban-organization').NodeOrganization
  id: string
  title: string
  color: string
  kind: 'terminal' | 'sticky' | 'browser'
  agentId?: string
  /** Sticky note body — shown in the expanded detail row. */
  text?: string
  /** Sticky-only: last canvas-control `sticky` write (cleared on hand edits) — the modal's stamp. */
  textUpdatedAt?: number
  textUpdatedBy?: string
  /** Browser node URL (kind 'browser' only) — shown on the card, opened in the modal webview. */
  url?: string
  /** Browser node session partition (kind 'browser' only) — threaded to the modal webview so it
   *  shares the canvas node's jar (`browser-partition-parity.test.tsx`). Absent = default session. */
  partition?: string
  /** The subset of the node's `data` the card modal's co-attach terminal needs to spawn/join the
   *  same session (kind 'terminal' only; sticky passes `{}`). */
  spawn: ModalSpawn
}

/** What the per-column "+ New" menu can create. */
export type KanbanCreateChoice =
  | { kind: 'terminal' }
  | { kind: 'sticky' }
  | { kind: 'browser' }
  | { kind: 'agent'; agentId: AgentId }

/** One "+ New" menu entry (label + the choice it fires). */
export interface KanbanCreateOption {
  key: string
  label: string
  choice: KanbanCreateChoice
  icon: JSX.Element
}

export interface KanbanViewProps {
  board: ProjectKanban
  sessions: KanbanSession[]
  onChange: (next: ProjectKanban) => void
  /** Open a session from its card: switch back to canvas view and focus the node. */
  onOpenNode: (nodeId: string) => void
  /** Create in the selected column and return the ID when the node can be opened immediately. */
  onCreateNode: (choice: KanbanCreateChoice, columnId: string | null) => string | void
  /** Rename a node (same funnel as the sessions sidebar). */
  onRenameNode: (nodeId: string, title: string) => void
  /** Write-through a sticky node's body text (only fired for kind 'sticky'). */
  onEditSticky: (nodeId: string, text: string) => void
  /** Permanently delete a node (ends its session) — routed through the canvas confirm. */
  onDeleteNode: (nodeId: string) => void
  /** Reports which node's card modal is open (null = none) so the canvas can target it — e.g.
   *  the dictation shortcut dictates into the open card's session, not a canvas selection. */
  onModalNodeChange: (nodeId: string | null) => void
  /** Persist a browser card's navigation (url/title) from the modal webview to the node. */
  onBrowserNav: (nodeId: string, patch: { url?: string; title?: string }) => void
}

type Drag =
  | { kind: 'column'; id: string }
  | { kind: 'card'; sourceId: 'sessions'; id: string }
  | { kind: 'card'; sourceId: 'github'; issue: GitHubIssueCardView }
  | null

type CardDrag = Extract<Drag, { kind: 'card' }>

/** A dragged card whose column the PROVIDER owns: dropping it is the provider's write (which may
 *  confirm or refuse), never a board assignment. The branch is the registry's `placement`, not
 *  the source's name — the union only supplies the narrowing. */
const isProviderDrag = (drag: CardDrag): drag is Extract<CardDrag, { sourceId: 'github' }> =>
  kanbanSource(drag.sourceId).placement === 'provider'

/** Shared empty results — stable identities so memoized cards/columns see "no change". */
const NO_LABELS: KanbanLabel[] = []
const NO_CARDS: KanbanSession[] = []
const NO_TASKS = new Map<string, ExternalTask>()

/** Full-page session board OVER the canvas. The canvas stays mounted underneath (its
 *  agent-status listeners must keep running, and display:none would 0×0-resize every
 *  terminal into a tmux SIGWINCH) — this is an opaque overlay, nothing more.
 *  memo: Canvas re-renders on plenty the board doesn't care about (agent signatures, camera
 *  banners…); with every prop stable (Canvas useCallbacks + memoized board/sessions) those
 *  renders stop at this boundary. */
export const KanbanView = memo(function KanbanView({
  board, sessions, onChange, onOpenNode, onCreateNode, onRenameNode, onEditSticky, onDeleteNode,
  onModalNodeChange, onBrowserNav
}: KanbanViewProps) {
  const { api } = useSession()
  const dragRef = useRef<Drag>(null)
  // One card modal at a time; a deleted node closes it via the byId.has render guard.
  const [modalNodeId, setModalNodeId] = useState<string | null>(null)
  const [expandedSupport, setExpandedSupport] = useState<Set<string>>(new Set())
  const toggleSupport = useCallback((id: string) => setExpandedSupport(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])
  // Right-click card menu (open on canvas / move / delete).
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  // Board label filter — transient (per board session; resets when you leave the board). Empty =
  // show everything; otherwise a card must carry at least one selected label (cardMatchesLabelFilter).
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState<TaskCategory | 'all'>('all')
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [backgroundMenu, setBackgroundMenu] = useState<{ x: number; y: number } | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [source, setSource] = useState<KanbanSource>('all')
  const [modalIssue, setModalIssue] = useState<GitHubIssueCardView | null>(null)
  const [githubRetry, setGitHubRetry] = useState(0)
  // A move that would close or reopen the issue on GitHub waits here for an explicit confirmation.
  const [pendingGitHubMove, setPendingGitHubMove] = useState<
    { issue: GitHubIssueCardView; columnId: string | null; confirmation: GitHubMoveConfirmation } | null
  >(null)
  // Primitive selectors (not one object) — an object selector would re-render on every store set.
  const projectId = useProjects((s) => s.activeProjectId)
  const workflowBoard = useExternalBoard(s => s.project === projectId ? s.url : null)
  const catalog = useExternalBoard(s => s.project === projectId ? s.columns : null)
  const feedAvailable = useExternalBoard(s => s.project === projectId && s.available)
  const backgroundIds = useExternalBoard(s => s.project === projectId ? s.backgroundNodeIds : NO_BACKGROUND)
  const featured = useExternalBoard(s => s.project === projectId ? s.featuredSession : undefined)
  const externalTasks = useExternalBoard(s => s.project === projectId ? s.tasks : NO_TASKS)
  const reading = useExternalBoard(s => s.project === projectId && s.reading)
  const lastPlacement = useExternalBoard(s => s.project === projectId ? s.lastPlacement : NO_TASKS)
  const placement = feedAvailable ? externalTasks : lastPlacement
  const workflowOptions = useMemo(() => Array.from(new Set([
    ...(catalog?.workflows ?? []),
    ...Array.from(placement.values(), t => t.workflow).filter((w): w is string => Boolean(w)).sort()
  ])), [catalog, placement])
  const preferredColumns = useViewMode(s => s.kanbanColumnsByProject[projectId] ?? 'workflow')
  const setKanbanColumns = useViewMode(s => s.setKanbanColumns)
  const columnMode = (reading || (workflowBoard && (catalog || !feedAvailable))) && source !== 'github' ? preferredColumns : 'canvas'
  const canvasSort = useViewMode(s => s.kanbanSortByProject[projectId] ?? 'manual')
  const sortMode = columnMode === 'canvas' ? canvasSort : 'priority'
  const setKanbanSort = useViewMode(s => s.setKanbanSort)
  // One sampled clock for badges, sorting and supporting-session urgency, without a timer.
  const priorityNow = useMemo(() => Date.now(), [board, sessions, sortMode])
  const projectName = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name)
  const projectColor = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.color)
  const github = useGitHubIssues((state) => state.projects[projectId])
  const githubReadOnly = Object.values(github?.pages ?? {}).some((page) => page.readOnly)
  const connectGitHub = useGitHubIssues((state) => state.connect)
  const moveGitHubState = useGitHubIssues((state) => state.move)
  const loadMoreGitHub = useGitHubIssues((state) => state.loadMore)
  // Drop ids no longer in the palette so a deleted label can't keep the board filtered to nothing.
  const paletteLabels = useMemo(() => boardLabels(board), [board])
  const githubLabels = useMemo(() => {
    const labels = new Map<string, { name: string; color: string }>()
    for (const page of Object.values(github?.pages ?? {})) {
      for (const issue of page.items) {
        for (const label of issue.labels) {
          const key = label.name.normalize('NFKC').toLocaleLowerCase('en-US')
          if (!labels.has(key)) labels.set(key, { name: label.name, color: label.color })
        }
      }
    }
    return [...labels.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [github?.pages])
  const localFilterKeys = useMemo(() => new Set(paletteLabels.map((label) => `local:${label.id}`)), [paletteLabels])
  const activeFilter = useMemo(
    () => labelFilter.filter((id) => localFilterKeys.has(id) || id.startsWith('github:')),
    [labelFilter, localFilterKeys]
  )
  const activeLocalFilter = useMemo(() => activeFilter
    .filter((key) => key.startsWith('local:')).map((key) => key.slice(6)), [activeFilter])
  const activeGitHubFilter = useMemo(() => activeFilter
    .filter((key) => key.startsWith('github:')), [activeFilter])
  const toggleFilter = (id: string): void =>
    setLabelFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))
  // Report the open node to the canvas (dictation shortcut targeting) and mark its completion read.
  // This clears notification affordances only; the live `done` state remains waiting for a prompt.
  useEffect(() => {
    onModalNodeChange(modalNodeId)
    if (modalNodeId) useAgentStatus.getState().clearUnread(modalNodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalNodeId])
  // Someone asked for a card while the board is up (notch Go, a notification, ⌘K…). Open it here
  // instead of framing the node on the canvas nobody can see under this overlay.
  const requestedCardNodeId = useViewMode((s) => s.requestedCardNodeId)
  useEffect(() => {
    if (!requestedCardNodeId) return
    setModalNodeId(requestedCardNodeId)
    useViewMode.getState().clearCardRequest()
  }, [requestedCardNodeId])
  const githubConfigKey = JSON.stringify(board.github ?? null)
  const columnIdsKey = board.columns.map((column) => column.id).join('\0')
  const githubFilterKey = activeGitHubFilter.join('\0')
  useEffect(() => {
    if (!board.github || !projectId) return
    let disposed = false
    let disconnect: (() => void) | undefined
    void connectGitHub(
      api.githubIssues,
      projectId,
      board.columns.map((column) => column.id),
      activeGitHubFilter
    )
      .then((teardown) => {
        if (disposed) teardown()
        else disconnect = teardown
      })
    return () => {
      disposed = true
      disconnect?.()
    }
    // The serialised config is the epoch visible to the renderer. Reconnect when mappings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, githubConfigKey, columnIdsKey, githubFilterKey, connectGitHub, githubRetry])
  useEffect(() => {
    setSource('all')
    setModalIssue(null)
  }, [projectId])
  useEffect(() => {
    if (!modalIssue || !github) return
    const latest = Object.values(github.pages)
      .flatMap((page) => page.items)
      .find((issue) => issue.number === modalIssue.number)
    if (latest && latest.updatedAt !== modalIssue.updatedAt) setModalIssue(latest)
  }, [github, modalIssue])
  const customAgents = useSettings((s) => s.settings.customAgents)
  const disabledAgents = useSettings((s) => s.settings.disabledAgents)
  // "+ New" menu entries: the builtin agents, the user's custom agents, then terminal + sticky
  // (same universe as the dock's add menu, minus canvas-only kinds). Memoized — a fresh array
  // (with fresh icon elements) per render would re-render every memoized column.
  // Respects Settings → Agents → Enabled/Disabled (like the dock, the pane menu and the palette).
  const createOptions: KanbanCreateOption[] = useMemo(
    () => [
      ...BUILTIN_AGENT_IDS.filter((id) => !disabledAgents.includes(id)).map((id) => ({
        key: id,
        label: AGENT_CONFIG[id].label,
        choice: { kind: 'agent', agentId: id } as KanbanCreateChoice,
        icon: <IconAgent />
      })),
      ...customAgents.filter((a) => !disabledAgents.includes(a.id)).map((a) => ({
        key: a.id,
        label: a.label,
        choice: { kind: 'agent', agentId: a.id } as KanbanCreateChoice,
        icon: <IconAgent />
      })),
      { key: 'terminal', label: 'Terminal', choice: { kind: 'terminal' }, icon: <IconTerminal /> },
      { key: 'browser', label: 'Browser', choice: { kind: 'browser' }, icon: <IconWeb /> },
      { key: 'sticky', label: 'Sticky note', choice: { kind: 'sticky' }, icon: <IconNote /> }
    ],
    [customAgents, disabledAgents]
  )
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions])
  const candidate = featured?.nodeId ? byId.get(featured.nodeId) : undefined
  const featuredCard = candidate?.kind === 'terminal' ? candidate : undefined
  const backgroundCards = useMemo(() => backgroundIds.flatMap(id => {
    const card = byId.get(id)
    return card?.kind === 'terminal' && card !== featuredCard ? [card] : []
  }), [backgroundIds, byId, featuredCard])
  const reserved = useMemo(() => new Set([
    ...backgroundCards.map(card => card.id), ...(featuredCard ? [featuredCard.id] : [])
  ]), [backgroundCards, featuredCard])
  const groupingTasks = columnMode === 'canvas' ? undefined : placement
  const taskVisibility = useMemo(() => taskBoardVisibility(
    reserved.size ? sessions.filter(s => !reserved.has(s.id)) : sessions, board, groupingTasks
  ), [sessions, reserved, board, groupingTasks])

  // Stable per-card label arrays: labelsForCard allocates a fresh array per call, and that
  // identity churn alone would defeat SessionCard's memo. Recomputed only on a board change.
  const labelsByCard = useMemo(() => {
    const m = new Map<string, KanbanLabel[]>()
    if (Array.isArray(board.meta)) {
      for (const entry of board.meta) {
        if (!entry?.nodeId) continue
        const l = labelsForCard(board, entry.nodeId)
        if (l.length) m.set(entry.nodeId, l)
      }
    }
    return m
  }, [board])
  const labelsOf = useCallback((id: string) => labelsByCard.get(id) ?? NO_LABELS, [labelsByCard])
  const metaOf = useCallback((id: string) => cardMeta(board, id), [board])

  // Prune dead nodes' assignments on every persisted change, so they never accumulate
  // in the shared file.
  const commit = useCallback(
    (next: ProjectKanban) => onChange(pruneAssignments(next, sessionIds)),
    [onChange, sessionIds]
  )

  const takeDrag = (): Drag => {
    const d = dragRef.current
    dragRef.current = null
    return d
  }

  // The ONE path every GitHub card move takes — drag drop, the card's Move selector, and the
  // summary modal — so none of them can skip the confirmation the others ask for.
  const requestGitHubMove = useCallback(
    (issue: GitHubIssueCardView, columnId: string | null) => {
      if (githubReadOnly) return
      const completion = board.github?.completionColumnId
      const intent = githubMoveIntent(issue, columnId, completion)
      // Dropping a card back where it already sits is not a write: sending it would spend an API
      // call and let GitHub rewrite state_reason for no reason the user asked for.
      if (intent.kind === 'noop') return
      const confirmation = githubMoveConfirmation(issue, columnId, completion)
      if (confirmation) {
        setPendingGitHubMove({ issue, columnId, confirmation })
        return
      }
      void moveGitHubState(api.githubIssues, projectId, issue.number, columnId, issue.updatedAt)
    },
    [api.githubIssues, board.github?.completionColumnId, githubReadOnly, moveGitHubState, projectId]
  )

  // columnId null = the virtual Ungrouped column.
  const dropOnColumn = useCallback(
    (columnId: string | null) => {
      const drag = takeDrag()
      if (!drag || columnMode !== 'canvas') return
      if (drag.kind === 'column') {
        if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
        // a column dropped on Ungrouped is a no-op — Ungrouped is always first
      } else if (isProviderDrag(drag)) requestGitHubMove(drag.issue, columnId)
      else if (sortMode === 'manual') commit(assignNode(board, drag.id, columnId, null))
    },
    [board, commit, requestGitHubMove, sortMode, columnMode]
  )

  const dropAtCard = useCallback(
    (columnId: string | null, targetNodeId: string, side: 'before' | 'after') => {
      const drag = takeDrag()
      if (!drag || columnMode !== 'canvas') return
      if (drag.kind === 'column') {
        if (columnId !== null) commit(moveColumn(board, drag.id, columnId))
        return
      }
      if (isProviderDrag(drag)) {
        requestGitHubMove(drag.issue, columnId)
        return
      }
      if (sortMode === 'priority') return
      // "after this card" = "before the NEXT card in the column" (null = end of column).
      const ids = columnId === null ? unassigned(board, sessionIds) : assignedTo(board, columnId)
      let beforeId: string | null = targetNodeId
      if (side === 'after') {
        const i = ids.indexOf(targetNodeId)
        beforeId = i >= 0 && i + 1 < ids.length ? ids[i + 1] : null
      }
      commit(assignNode(board, drag.id, columnId, beforeId))
    },
    [board, commit, requestGitHubMove, sessionIds, sortMode, columnMode]
  )

  // Per-column card lists in one pass, so a board render doesn't re-derive (and re-allocate)
  // them per column — and their identities hold across renders that change neither the board,
  // the sessions, nor the filter, which is what lets the memoized columns skip.
  const columnCards = useMemo(() => {
    const externalOrder = new Map(Array.from(placement.keys(), (id, index) => [id, index]))
    function groupOrder(card: KanbanSession) {
      let earliest = externalOrder.get(card.id) ?? Infinity
      for (const child of taskVisibility.supports.get(card.id) ?? [])
        earliest = Math.min(earliest, externalOrder.get(child.id) ?? Infinity)
      return earliest
    }
    const workflow = workflowOptions.includes(workflowFilter) ? workflowFilter : ''
    const vis = (ids: string[]): string[] =>
      activeLocalFilter.length ? ids.filter((id) => cardMatchesLabelFilter(board, id, activeLocalFilter)) : ids
    const toCards = (ids: string[]): KanbanSession[] => {
      const cards = ids.flatMap((id) => {
        const card = byId.get(id)
        if (!card || reserved.has(id) || taskVisibility.hidden.has(id)) return []
        if (workflowBoard) {
          const matchesWorkflow = (entry: KanbanSession) => placement.get(entry.id)?.workflow === workflow
          const matchesSupport = columnMode === 'canvas' && taskVisibility.supports.get(id)?.some(matchesWorkflow)
          return !workflow || matchesWorkflow(card) || matchesSupport ? [card] : []
        }
        const matches = (entry: KanbanSession) => (cardMeta(board, entry.id)?.category ?? parseTaskPlanning(entry.taskPlanning)?.category ?? 'needs-classification') === categoryFilter
        return categoryFilter === 'all' || matches(card) || taskVisibility.supports.get(id)?.some(matches) ? [card] : []
      })
      if (!cards.length) return NO_CARDS
      if (sortMode !== 'priority') return cards
      if (workflowBoard) return cards.sort((a, b) => groupOrder(a) - groupOrder(b))
      return sortByPriority(cards, card => effectivePriority(cardMeta(board, card.id), card.taskPlanning, priorityNow))
    }
    if (columnMode !== 'canvas') {
      return { matrix: taskBoardMatrix(toCards(vis(sessionIds)), placement, catalog ?? { workflows: [], stages: [] }, columnMode, workflow),
        ungrouped: NO_CARDS, byColumn: new Map<string, KanbanSession[]>() }
    }
    return { matrix: null, ungrouped: toCards(vis(unassigned(board, sessionIds))),
      byColumn: new Map(board.columns.map(c => [c.id, toCards(vis(assignedTo(board, c.id)))])) }
  }, [board, byId, sessionIds, reserved, activeLocalFilter, taskVisibility, categoryFilter, sortMode, priorityNow, workflowBoard, placement, workflowOptions, workflowFilter, catalog, columnMode])

  // Stable column/card plumbing — every handler the memoized columns receive is identity-stable
  // across renders (the column binds its own id; cards bind theirs).
  const handleCardDragStart = useCallback((id: string) => {
    dragRef.current = { kind: 'card', sourceId: 'sessions', id }
  }, [])
  const handleGitHubDragStart = useCallback((issue: GitHubIssueCardView) => {
    dragRef.current = { kind: 'card', sourceId: 'github', issue }
  }, [])
  const handleColumnDragStart = useCallback((columnId: string) => {
    dragRef.current = { kind: 'column', id: columnId }
  }, [])
  const handleDragEnd = useCallback(() => {
    dragRef.current = null
  }, [])
  const handleCardContext = useCallback(
    (id: string, x: number, y: number) => setCardMenu({ nodeId: id, x, y }),
    []
  )
  const handleRenameColumn = useCallback(
    (columnId: string, t: string) => commit(renameColumn(board, columnId, t)),
    [board, commit]
  )
  const handleRecolorColumn = useCallback(
    (columnId: string, c: string) => commit(recolorColumn(board, columnId, c)),
    [board, commit]
  )
  const handleDeleteColumn = useCallback(
    (columnId: string) => commit(deleteColumn(board, columnId)),
    [board, commit]
  )
  const handleMoveGitHub = requestGitHubMove
  const githubPage = useCallback((columnId: string | null) =>
    github?.pages[columnId ?? 'ungrouped'], [github])

  // One bound card-drop handler per column, cached by column id: SessionCard is memoized on its
  // props, so a fresh closure per render would defeat it. (The column used to bind this itself,
  // back when it knew which of its cards were sessions.)
  const dropAtCardFor = useMemo(() => {
    const cache = new Map<string, (nodeId: string, side: 'before' | 'after') => void>()
    return (columnId: string | null) => {
      const key = columnId ?? '\u0000ungrouped'
      let bound = cache.get(key)
      if (!bound) {
        bound = (nodeId, side) => dropAtCard(columnId, nodeId, side)
        cache.set(key, bound)
      }
      return bound
    }
  }, [dropAtCard])

  function sessionCards(cards: KanbanSession[], columnId: string | null) {
    const onDropAt = dropAtCardFor(columnId)
    return cards.map((s) => (
      <SessionCard
        key={s.id}
        session={s}
        reorderEnabled={sortMode === 'manual'}
        priorityNow={priorityNow}
        meta={metaOf(s.id)}
        labels={labelsOf(s.id)}
        supportingSessions={taskVisibility.supports.get(s.id)}
        urgentSupportingCount={(taskVisibility.supports.get(s.id) ?? []).filter(child => {
          if (workflowBoard) return externalTasks.get(child.id)?.urgent === true
          return effectivePriority(metaOf(child.id), child.taskPlanning, priorityNow) === 'urgent'
        }).length}
        supportsExpanded={expandedSupport.has(s.id)}
        onToggleSupport={toggleSupport}
        onOpen={setModalNodeId}
        onContext={handleCardContext}
        onDragStart={handleCardDragStart}
        onDragEnd={handleDragEnd}
        onDropAt={onDropAt}
      />
    ))
  }

  const githubLane = (columnId: string | null): KanbanLane => {
    const page = githubPage(columnId)
    return {
      sourceId: 'github',
      // The provider's own total for the column, which can exceed the page fetched so far.
      count: (columnId === null ? page?.counts.ungrouped : page?.counts[columnId]) ?? 0,
      cards: (page?.items ?? []).map((issue) => (
        <GitHubIssueCard
          key={`github:${issue.id}`}
          issue={issue}
          columns={board.columns}
          moving={!!github?.moving[issue.number]}
          readOnly={githubReadOnly}
          status={github?.issueStatus[issue.number]}
          onOpen={setModalIssue}
          onMove={handleMoveGitHub}
          onDragStart={handleGitHubDragStart}
          onDragEnd={handleDragEnd}
        />
      )),
      footer: page?.nextCursor
        ? (
          <button
            className="kanban-github-more"
            onClick={() => void loadMoreGitHub(api.githubIssues, projectId, columnId)}
          >
            Show more issues
          </button>
        )
        : undefined
    }
  }

  const showGitHub = sourceVisible(source, 'github') && kanbanSource('github').configured(board)
  const lanesFor = (columnId: string | null): KanbanLane[] => {
    const lanes: KanbanLane[] = []
    if (sourceVisible(source, 'sessions')) {
      const cards = columnId === null ? columnCards.ungrouped : columnCards.byColumn.get(columnId) ?? NO_CARDS
      lanes.push({ sourceId: 'sessions', count: cards.length, cards: sessionCards(cards, columnId) })
    }
    if (showGitHub) lanes.push(githubLane(columnId))
    return lanes
  }
  // Provider pagination and moves remain attached to the original provider column.
  const issueGroups = columnMode !== 'canvas' && showGitHub
    ? [null, ...board.columns].map(col => ({ col, lane: githubLane(col?.id ?? null) }))
        .filter(({ lane }) => lane.count || lane.footer || (Array.isArray(lane.cards) && lane.cards.length))
    : []

  // Right-click menu for a card: open on canvas, move to another column, delete.
  const cardMenuItems = (nodeId: string): MenuItem[] => {
    const curColId = columnForNode(board, nodeId)?.id ?? null
    const moveTargets: MenuItem[] = [
      ...(curColId !== null
        ? [{ label: 'Ungrouped', onClick: () => commit(assignNode(board, nodeId, null, null)) }]
        : []),
      ...board.columns
        .filter((c) => c.id !== curColId)
        .map((c) => ({
          label: c.title,
          onClick: () => commit(assignNode(board, nodeId, c.id, null))
        }))
    ]
    return [
      { label: 'Open card', icon: <IconExternal />, onClick: () => setModalNodeId(nodeId) },
      { label: 'Open on canvas', icon: <IconExternal />, onClick: () => onOpenNode(nodeId) },
      ...(moveTargets.length
        ? ([{ type: 'submenu', label: columnMode === 'canvas' ? 'Move to' : 'Move to canvas group', icon: <IconSwitch />, children: moveTargets }] as MenuItem[])
        : []),
      workflowBoard ? { label: 'Open workflow board', icon: <IconExternal />, onClick: () => {
        window.open(taskBoardHref(workflowBoard, externalTasks.get(nodeId)?.task), '_blank', 'noopener,noreferrer')
      }} : { type: 'submenu', label: 'Priority', children: [
        ...PRIORITIES.map(priority => ({
          label: priority.label,
          icon: <span style={{ color: priority.color }}>●</span>,
          onClick: () => commit(setCardPriority(board, nodeId, priority.id))
        })),
        { label: 'Clear', onClick: () => commit(setCardPriority(board, nodeId, null)) }
      ] },
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => onDeleteNode(nodeId) }
    ]
  }

  return (
    <div className="kanban-overlay">
      {/* Title strip: names the board's project AND pushes the columns below the top-right
          controls cluster, so column headers never sit under its icons. */}
      <div className="kanban-header">
        <span className="kanban-header__dot" style={{ background: projectColor }} />
        <span className="kanban-header__name">{projectName}</span>
        <button type="button" className="kanban-header__new-terminal" onClick={() => {
          const id = onCreateNode({ kind: 'terminal' }, null)
          if (id) setModalNodeId(id)
        }}>+ New terminal</button>
        {featured && sourceVisible(source, 'sessions') && (
          <button type="button" className="kanban-featured" disabled={!featuredCard}
            title={featuredCard ? taskDisplayTitle(featuredCard.title, featuredCard.titleAuto, externalTasks.get(featuredCard.id)) : 'Current session unavailable'}
            onClick={() => featuredCard && setModalNodeId(featuredCard.id)}>
            {featured.label}
            {featuredCard && showsStatus({ type: featuredCard.kind, agentId: featuredCard.agentId as AgentId }) &&
              <NodeStatusBadge nodeId={featuredCard.id} agentId={featuredCard.agentId as AgentId} compact />}
            {!featuredCard && <small>Unavailable</small>}
          </button>
        )}
        {backgroundCards.length > 0 && sourceVisible(source, 'sessions') && <>
          <button type="button" className="kanban-background" aria-expanded={!!backgroundMenu}
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect()
              setBackgroundMenu({ x: rect.left, y: rect.bottom + 4 })
            }}>Background ({backgroundCards.length})</button>
          {backgroundMenu && <ContextMenu {...backgroundMenu} scroll
            items={backgroundCards.map(card => ({
              label: taskDisplayTitle(card.title, card.titleAuto, externalTasks.get(card.id)),
              onClick: () => setModalNodeId(card.id)
            }))}
            onClose={() => setBackgroundMenu(null)} />}
        </>}
        <NewSessionMenu columnId={null} createOptions={createOptions} onCreate={onCreateNode} label="Agents & more" />
        {workflowBoard && <a className="kanban-github-status" href={workflowBoard} target="_blank" rel="noreferrer">Workflow board ↗</a>}
        {workflowBoard && (catalog || !feedAvailable) && <label className="kanban-column-mode">Columns
          <select aria-label="Columns" value={columnMode} disabled={source === 'github'}
            onChange={e => {
              const mode = e.target.value
              if (mode === 'workflow' || mode === 'stage' || mode === 'canvas') setKanbanColumns(projectId, mode)
            }}>
            <option value="workflow">Workflow</option>
            <option value="stage">Stage</option>
            <option value="canvas">Canvas groups</option>
          </select>
        </label>}
        {workflowBoard && source !== 'github' && (columnMode !== 'canvas' || sortMode !== 'manual') && (
          <button type="button" className="kanban-github-status" onClick={() => {
            setKanbanColumns(projectId, 'canvas')
            setKanbanSort(projectId, 'manual')
          }} title="Drag sessions between canvas groups or reorder them within a group">Arrange canvas cards</button>
        )}
        {workflowBoard && !feedAvailable && <span className="kanban-github-status" role="status">{catalog ? 'Work Board unavailable. Showing last known positions.' : 'Work Board unavailable. Reconnecting…'}</span>}
        {columnMode === 'canvas' && <select aria-label="Card order" value={sortMode} title="Priority view uses derived order. Choose Manual order to drag cards; Move to remains available in the card menu."
          onChange={e => { const mode = e.target.value; if (mode === 'manual' || mode === 'priority') setKanbanSort(projectId, mode) }}>
          <option value="manual">Manual order</option>
          <option value="priority">{workflowBoard ? 'Work Board urgency' : 'Priority'}</option>
        </select>}
        {board.github && <KanbanSourceFilter value={source} onChange={setSource} />}
        {workflowBoard ? <select aria-label="Workflow" value={workflowOptions.includes(workflowFilter) ? workflowFilter : ''}
          onChange={e => setWorkflowFilter(e.target.value)}>
          <option value="">All workflows</option>
          {workflowOptions.map(workflow => <option key={workflow}>{workflow}</option>)}
        </select> : <select aria-label="Work category" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as TaskCategory | 'all')}>
          <option value="all">All work categories</option>
          {TASK_CATEGORIES.map(category => <option key={category} value={category}>{category.replaceAll('-', ' ')}</option>)}
        </select>}
        {board.github && github?.loading && <span className="kanban-github-status">Loading GitHub issues…</span>}
        {board.github && github?.error && (
          <button
            className="kanban-github-status kanban-github-status--error kanban-github-retry"
            onClick={() => setGitHubRetry((value) => value + 1)}
          >
            GitHub issues unavailable · Retry
          </button>
        )}
        {board.github && githubReadOnly && (
          <span className="kanban-github-status kanban-github-status--error">
            GitHub issues are read only until configuration and refresh are complete.
          </span>
        )}
        {(paletteLabels.length > 0 || githubLabels.length > 0 || activeFilter.length > 0) && (
          <div className="kanban-header__filter">
            <button
              className={`kanban-filter-btn${activeFilter.length ? ' kanban-filter-btn--on' : ''}`}
              title="Filter by label"
              onClick={() => setFilterOpen((v) => !v)}
            >
              Filter{activeFilter.length ? ` · ${activeFilter.length}` : ''}
            </button>
            {filterOpen && (
              <>
                <div className="label-picker__scrim" onMouseDown={() => setFilterOpen(false)} />
                <div className="kanban-filter-menu">
                  {paletteLabels.length > 0 && <div className="kanban-filter-group">Sessions</div>}
                  {paletteLabels.map((l) => {
                    const s = labelSwatch(l.color)
                    const key = `local:${l.id}`
                    const on = activeFilter.includes(key)
                    return (
                      <button key={key} className="kanban-filter-row" onClick={() => toggleFilter(key)}>
                        <span className="kanban-label-chip" style={{ background: s.bg, color: s.fg }}>
                          {l.name || 'Label'}
                        </span>
                        {on && <span className="label-picker__rowcheck">✓</span>}
                      </button>
                    )
                  })}
                  {githubLabels.length > 0 && <div className="kanban-filter-group">GitHub</div>}
                  {githubLabels.map((label) => {
                    const key = `github:${label.name.normalize('NFKC').toLocaleLowerCase('en-US')}`
                    const on = activeFilter.includes(key)
                    return (
                      <button key={key} className="kanban-filter-row" onClick={() => toggleFilter(key)}>
                        <span className="github-issue-label" style={{
                          borderColor: `#${label.color}`,
                          color: `#${label.color}`
                        }}>{label.name}</span>
                        {on && <span className="label-picker__rowcheck">✓</span>}
                      </button>
                    )
                  })}
                  {activeFilter.length > 0 && (
                    <button className="kanban-filter-clear" onClick={() => setLabelFilter([])}>
                      Clear filter
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className={columnCards.matrix ? 'kanban-board kanban-board--matrix' : 'kanban-board'}>
          {columnCards.matrix && columnMode !== 'canvas' ? <>
            {catalog && <TaskBoardMatrix matrix={columnCards.matrix} columnField={columnMode} renderCards={cards => sessionCards(cards, null)} />}
            {columnCards.matrix.unlinked.length > 0 && <section className="kanban-board__other" aria-label={feedAvailable ? 'No linked task' : 'Sessions'}>
              <h2>{feedAvailable ? 'No linked task' : 'Sessions'} <span className="kanban-col__count">{columnCards.matrix.unlinked.length}</span></h2>
              <div className="kanban-board__other-cards">{sessionCards(columnCards.matrix.unlinked, null)}</div>
            </section>}
            {issueGroups.length > 0 && <section className="kanban-board__other" aria-label="GitHub issues">
              <h2>GitHub issues</h2>
              {issueGroups.map(({ col, lane }) => <div className="kanban-col__issue-group" key={col?.id ?? ''}>
                <h3>{col?.title ?? 'Ungrouped'}</h3>{lane.cards}{lane.footer}
              </div>)}
            </section>}
          </> : <div className="kanban-board__columns">
            <KanbanColumn
              column={null}
              lanes={lanesFor(null)}
              createOptions={createOptions}
              onCreate={onCreateNode}
              onDragEnd={handleDragEnd}
              onDropOnColumn={dropOnColumn}
            />
            {board.columns.map((col) => (
              <KanbanColumn
                key={col.id}
                column={col}
                lanes={lanesFor(col.id)}
                onRename={handleRenameColumn}
                onRecolor={handleRecolorColumn}
                onDelete={handleDeleteColumn}
                createOptions={createOptions}
                onCreate={onCreateNode}
                onColumnDragStart={handleColumnDragStart}
                onDragEnd={handleDragEnd}
                onDropOnColumn={dropOnColumn}
              />
            ))}
            <button
              className="kanban-add-col"
              onClick={() => commit(addColumn(board, 'New column', nextColumnColor(board)))}
            >
              + Add column
            </button>
          </div>}
      </div>
      {cardMenu && byId.has(cardMenu.nodeId) && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          zIndex={60}
          items={cardMenuItems(cardMenu.nodeId)}
          onClose={() => setCardMenu(null)}
        />
      )}
      {modalNodeId && byId.has(modalNodeId) && (
        <CardModal
          session={byId.get(modalNodeId)!}
          columnTitle={columnForNode(board, modalNodeId)?.title ?? null}
          board={board}
          onChangeBoard={commit}
          onClose={() => setModalNodeId(null)}
          onOpenCanvas={() => {
            setModalNodeId(null)
            onOpenNode(modalNodeId)
          }}
          onRename={(t) => onRenameNode(modalNodeId, t)}
          onEditSticky={(t) => onEditSticky(modalNodeId, t)}
          onBrowserNav={(patch) => onBrowserNav(modalNodeId, patch)}
        />
      )}
      {modalIssue && (
        <GitHubIssueSummaryModal
          issue={modalIssue}
          columns={board.columns}
          moving={!!github?.moving[modalIssue.number]}
          readOnly={githubReadOnly}
          status={github?.issueStatus[modalIssue.number]}
          onMove={(columnId) => handleMoveGitHub(modalIssue, columnId)}
          onClose={() => setModalIssue(null)}
        />
      )}
      {pendingGitHubMove && (
        <ConfirmDialog
          message={pendingGitHubMove.confirmation.message}
          confirmLabel={pendingGitHubMove.confirmation.confirmLabel}
          danger={pendingGitHubMove.confirmation.danger}
          onCancel={() => setPendingGitHubMove(null)}
          onConfirm={() => {
            const { issue, columnId } = pendingGitHubMove
            setPendingGitHubMove(null)
            void moveGitHubState(
              api.githubIssues, projectId, issue.number, columnId, issue.updatedAt
            )
          }}
        />
      )}
    </div>
  )
})
