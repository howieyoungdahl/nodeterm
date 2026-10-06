import type { Project, Workspace, WorkspaceApi } from '@shared/types'
import { useProjects } from '../state/projects'
import { reloadKeepingOpenNodes } from './externalChange'
import { applyDeletedEntities } from './deletedEntities'

// Build each snapshot AFTER the preceding acknowledgment. A racing edit stays unsaved;
// acknowledgments advance revision evidence, never overwrite content with an old snapshot.
let saveChain: Promise<unknown> = Promise.resolve()
export function saveWorkspace(api: WorkspaceApi): Promise<void> {
  const run = saveChain.then(async () => {
    const snapshot = useProjects.getState().toWorkspace()
    const ack = await api.save(snapshot)
    // An older/unsupported host cannot acknowledge a write by returning nothing.
    if (!ack || !/^[a-f0-9]{64}$/.test(ack.revision) || !ack.projectRevisions ||
      Object.values(ack.projectRevisions).some((revision) => !/^[a-f0-9]{64}$/.test(revision))) {
      throw new Error('workspace_conflict: revision acknowledgment missing; reload an updated host')
    }
    useProjects.getState().acknowledgeSave(ack, snapshot)
  })
  saveChain = run.catch(() => {})
  return run
}

/** Keep manual assignments while adopting organization content and newly made cards. */
export function mergeOrganizationProject(local: Project, incoming: Project): Project {
  local = applyDeletedEntities(local, incoming)
  const byId = new Map(incoming.nodes.map((n) => [n.id, n]))
  const localIds = new Set(local.nodes.map((n) => n.id))
  let kanban = local.kanban ?? incoming.kanban
  const localChoice = (id: string) => {
    if (local.kanban?.manualAssignments?.[id] !== true) return false
    if (local.loadedKanban === undefined) return true // No reliable baseline: preserve the local choice.
    const current = local.kanban.assignments.find((a) => a.nodeId === id)
    const baseline = local.loadedKanban?.assignments.find((a) => a.nodeId === id)
    return local.loadedKanban?.manualAssignments?.[id] !== true ||
      local.kanban.manualAssignmentVersions?.[id] !== local.loadedKanban?.manualAssignmentVersions?.[id] ||
      current?.columnId !== baseline?.columnId ||
      local.kanban.assignments.findIndex((a) => a.nodeId === id) !==
        (local.loadedKanban?.assignments.findIndex((a) => a.nodeId === id) ?? -1)
  }
  if (kanban && incoming.kanban?.manualAssignments) {
    const versions = { ...kanban.manualAssignmentVersions }
    for (const [id, value] of Object.entries(incoming.kanban.manualAssignmentVersions ?? {})) if (!localChoice(id)) versions[id] = value
    kanban = { ...kanban, manualAssignmentVersions: versions,
      manualAssignments: { ...incoming.kanban.manualAssignments, ...kanban.manualAssignments } }
  }
  if (kanban) {
    const baseline = local.loadedKanban
    const incomingAssignments = incoming.kanban?.assignments ?? []
    const baselineAssignments = baseline?.assignments ?? []
    const changed = new Set<string>()
    for (const node of incoming.nodes) {
      if ((!node.organization && incoming.kanban?.manualAssignments?.[node.id] !== true) || localChoice(node.id)) continue
      const assignment = incomingAssignments.find((a) => a.nodeId === node.id)
      const before = baselineAssignments.find((a) => a.nodeId === node.id)
      // Without a loaded baseline, only new cards have reliable placement deltas.
      if (baseline === undefined && localIds.has(node.id)) {
        // Older callers without a baseline can still adopt an explicit incoming manual choice
        // on a card with no local manual intent. They cannot infer automatic placement deltas.
        if (incoming.kanban?.manualAssignments?.[node.id] === true) changed.add(node.id)
        continue
      }
      if (assignment?.columnId !== before?.columnId) { changed.add(node.id); continue }
      // An explicit server-side manual action can reorder a card within its column. Compare
      // relative order of surviving peers, so insertions/moves of other cards are not its delta.
      if (assignment && incoming.kanban?.manualAssignments?.[node.id] === true &&
        incoming.kanban.manualAssignmentVersions?.[node.id] !== baseline?.manualAssignmentVersions?.[node.id]) {
        const peers = new Set(baselineAssignments.filter((a) => a.columnId === assignment.columnId &&
          incomingAssignments.some((next) => next.nodeId === a.nodeId && next.columnId === a.columnId)).map((a) => a.nodeId))
        const order = (list: typeof incomingAssignments) => list.filter((a) => peers.has(a.nodeId)).map((a) => a.nodeId)
        if (order(incomingAssignments).indexOf(node.id) !== order(baselineAssignments).indexOf(node.id)) changed.add(node.id)
      }
    }
    const assignments = kanban.assignments.filter((a) => !changed.has(a.nodeId))
    // Insert changed cards in assignment order, independent of renderer node iteration order.
    // Untouched cards (including a local manual drag) retain their exact relative order.
    for (let index = incomingAssignments.length - 1; index >= 0; index--) {
      const assignment = incomingAssignments[index]
      if (!changed.has(assignment.nodeId)) continue
      const nextId = incomingAssignments.slice(index + 1).find((a) => assignments.some((held) => held.nodeId === a.nodeId))?.nodeId
      const before = nextId ? assignments.findIndex((a) => a.nodeId === nextId) : -1
      assignments.splice(before < 0 ? assignments.length : before, 0, assignment)
    }
    kanban = { ...kanban, assignments }
  }
  return { ...local, revision: incoming.revision, loadedKanban: incoming.kanban ?? null, kanbanOrganization: incoming.kanbanOrganization,
    ...(kanban ? { kanban } : {}),
    nodes: [...local.nodes.map((node) => {
      const server = byId.get(node.id)
      if (!server?.organization) return node
      const manual = localChoice(node.id)
      return { ...node, organization: { ...server.organization, ...(manual ? { mode: 'manual' as const } : {}) } }
    }), ...incoming.nodes.filter((n) => !localIds.has(n.id))] }
}

/** Explicit user resolution covers background projects as well as the active canvas. */
export function resolveWorkspaceConflict(local: Workspace, incoming: Workspace, keep: boolean): Workspace {
  const localById = new Map(local.projects.map((p) => [p.id, p]))
  const incomingIds = new Set(incoming.projects.map((p) => p.id))
  return { ...incoming, activeProjectId: local.activeProjectId,
    projects: [...incoming.projects.map((project) => {
      const current = localById.get(project.id)
      return current ? keep ? mergeOrganizationProject(current, project) :
        reloadKeepingOpenNodes(current, project).project : project
    }), ...local.projects.filter((p) => !incomingIds.has(p.id))] }
}
