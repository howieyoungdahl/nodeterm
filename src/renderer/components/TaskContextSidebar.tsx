import { useEffect, useRef, useState } from 'react'
import type { ContextPage, ContextRow, ContextScope, RemoteOpenTarget } from '@shared/remote-nav/context-page'
import type { TaskContextApi, TaskContextQuery } from '@shared/remote-nav/task-context'
import { normalizeViewPrefs, type ViewPrefs } from '@shared/remote-nav/model'

const PREFS = 'nodeterm.taskSidebar.v1'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
function browserStorage(): StorageLike | undefined {
  try { return window.localStorage } catch { return undefined }
}
export function readTaskPrefs(storage: StorageLike | undefined): ViewPrefs {
  try { return normalizeViewPrefs(JSON.parse(storage?.getItem(PREFS) ?? 'null')) }
  catch { return normalizeViewPrefs(null) }
}
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const words = (v: unknown, fallback = 'Unknown'): string => typeof v === 'string' && v ? v : fallback
function textField(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textField).filter(Boolean).join('; ')
  const r = obj(v)
  return words(r.text ?? r.action ?? r.detail ?? r.reason, '')
}

/** The existing SessionsSidebar owns this view. A page is replaceable display state; it never
 * becomes the node registry. No UI callback to focusNodeById bypasses the host's focus boundary. */
export function TaskContextSidebar({ api, projectId, storage = browserStorage() }: {
  api: TaskContextApi | undefined; projectId: string | null; storage?: StorageLike
}): JSX.Element {
  const [prefs, setPrefs] = useState(() => readTaskPrefs(storage))
  const [taskSearch, setTaskSearch] = useState('')
  const [scope, setScope] = useState<ContextScope>(() => projectId ? { project_id: projectId } : {})
  const [page, setPage] = useState<ContextPage | null>(null)
  const [rows, setRows] = useState<ContextRow[]>([])
  const [details, setDetails] = useState<Record<string, ContextRow>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const revision = useRef(0)
  const busy = useRef(false)
  const query = useRef<TaskContextQuery>({ operation: 'summary', scope })
  const update = (patch: Partial<ViewPrefs>): void => {
    const next = normalizeViewPrefs({ ...prefs, ...patch })
    setPrefs(next)
    try { storage?.setItem(PREFS, JSON.stringify(next)) } catch { /* display choices remain usable */ }
  }

  async function load(append = false): Promise<void> {
    if (busy.current) return
    const serial = ++revision.current
    busy.current = true
    setPending(true)
    setNotice('')
    if (!append) { setPage(null); setRows([]); setDetails({}); setExpanded({}) }
    const request: TaskContextQuery = { ...query.current, limit: 25,
      ...(append && page?.ok ? { cursor: page.continuation, previousSources: page.sources } : {}) }
    try {
      const result = api ? await api.read(request) : { ok: false as const, code: 'source_unavailable', controlGranted: false as const }
      if (serial !== revision.current) return
      setPage(result)
      if (!result.ok) { setRows([]); setDetails({}); setExpanded({}); return }
      // The host adapter already rejects changed generations on continuation. A finite window
      // keeps a 320+ inventory bounded even after many deliberate Next page clicks.
      setRows((old) => append ? [...old, ...result.records].slice(-100) : result.records)
    } catch {
      if (serial === revision.current) { setRows([]); setPage({ ok: false, code: 'source_unavailable', controlGranted: false }) }
    } finally {
      if (serial === revision.current) { busy.current = false; setPending(false) }
    }
  }
  useEffect(() => {
    const next = projectId ? { project_id: projectId } : {}
    revision.current++
    busy.current = false
    query.current = { operation: 'summary', scope: next }
    setScope(next)
    setTaskSearch('')
    void load()
    return () => { revision.current++; busy.current = false }
  }, [api, projectId])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function detail(row: ContextRow): Promise<void> {
    const wasOpen = expanded[row.task_id] ?? !prefs.collapseWorkers
    setExpanded((old) => ({ ...old, [row.task_id]: !wasOpen || !details[row.task_id] }))
    if (details[row.task_id] || !api || !page?.ok) return
    const serial = revision.current
    try {
      const result = await api.read({ operation: 'task', scope: { ...scope, task_id: row.task_id }, previousSources: page.sources })
      if (serial !== revision.current) return
      if (!result.ok) {
        setNotice(result.code)
        if (['reset_required', 'source_changed', 'stale_publication'].includes(result.code)) {
          setRows([]); setDetails({}); setPage(result)
        }
        return
      }
      setDetails((old) => ({ ...old, [row.task_id]: result.records[0] }))
    } catch { if (serial === revision.current) setNotice('source_unavailable') }
  }
  async function focus(row: ContextRow): Promise<void> {
    // Only a trusted host integration may supply this identity. Current D15 output does not;
    // its absence is shown, never filled using titles, stored canvas IDs, or the viewer's host.
    if (!api || !row.focusTarget) { setNotice('Focus unavailable: current target authority is missing.'); return }
    const serial = revision.current
    try {
      const result = await api.focus(row.focusTarget as RemoteOpenTarget)
      if (serial === revision.current) setNotice(result.ok ? 'Focused existing session.' : `Focus unavailable: ${result.code}`)
    } catch { if (serial === revision.current) setNotice('Focus unavailable: host disconnected.') }
  }

  const staleNow = (row: ContextRow): boolean => row.observation.stale || row.observation.observedAt === null ||
    now / 1000 - row.observation.observedAt > 300 || row.observation.observedAt > now / 1000
  const visible = rows.filter((row) => {
    const closed = ['done', 'abandoned'].includes(String(row.stage))
    if (prefs.view === 'needs_attention') return row.needs_attention === true || staleNow(row)
    if (prefs.view === 'active') return !closed
    if (prefs.view === 'inactive') return closed
    return true
  }).sort((a, b) => {
    const key = prefs.sort.key
    const left = key === 'freshness' ? a.observation.observedAt ?? 0 : key === 'attention' ? Number(a.needs_attention) : words(a[key === 'project' ? 'project_id' : 'stage'], '')
    const right = key === 'freshness' ? b.observation.observedAt ?? 0 : key === 'attention' ? Number(b.needs_attention) : words(b[key === 'project' ? 'project_id' : 'stage'], '')
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
    return (prefs.sort.direction === 'desc' ? -order : order) || a.task_id.localeCompare(b.task_id)
  })
  return <section className="task-context" aria-label="Tasks">
    <form onSubmit={(event) => {
      event.preventDefault()
      if (pending) return
      const next = { ...(projectId ? { project_id: projectId } : {}), ...(taskSearch.trim() ? { task_id: taskSearch.trim() } : {}) }
      query.current = { operation: 'summary', scope: next }
      setScope(next)
      if (taskSearch.trim()) update({ view: 'all' })
      void load()
    }}>
      <input aria-label="Find task by exact ID" value={taskSearch} maxLength={512} onChange={(e) => setTaskSearch(e.target.value)} placeholder="Task ID…" />
      <button disabled={pending}>Find task</button>
    </form>
    <div className="task-context__options">
      <select aria-label="Task view" value={prefs.view} onChange={(e) => update({ view: e.target.value as ViewPrefs['view'] })}>
        <option value="needs_attention">Needs attention</option><option value="active">Active</option>
        <option value="inactive">Inactive</option><option value="all">All tasks</option>
      </select>
      <select aria-label="Sort tasks" value={prefs.sort.key} onChange={(e) => update({ sort: { ...prefs.sort, key: e.target.value as ViewPrefs['sort']['key'] } })}>
        <option value="attention">Attention</option><option value="freshness">Observation time</option>
        <option value="project">Project</option><option value="stage">Stage</option>
      </select>
      <button onClick={() => update({ sort: { ...prefs.sort, direction: prefs.sort.direction === 'asc' ? 'desc' : 'asc' } })}>Reverse sort</button>
      <label><input type="checkbox" checked={prefs.collapseWorkers} onChange={(e) => { update({ collapseWorkers: e.target.checked }); setExpanded({}) }} />Collapse workers</label>
      <button disabled={pending} onClick={() => void load()}>Refresh tasks</button>
    </div>
    {pending && <p role="status">Loading task context…</p>}
    {notice && <p role="status">{notice}</p>}
    {page && !page.ok && <p role="alert">Task context unavailable: {page.code}. Refresh tasks to retry.</p>}
    {page?.ok && <>
      <p>Generation {page.sources[0].generation} · {rows.length} loaded (maximum 100). {page.truncated ? 'More context available.' : 'End of this query.'}</p>
      {page.code !== 'ok' && <p role="status">Partial page: {page.code}. Use Next page to continue.</p>}
      {!!page.uncertainty.length && <details><summary>Context limitations</summary>{page.uncertainty.join('; ')}</details>}
      {!visible.length && <p>No tasks match this view in the loaded page.</p>}
      {visible.map((row) => {
        const fields = obj(details[row.task_id]?.fields)
        const isExpanded = expanded[row.task_id] ?? !prefs.collapseWorkers
        const observed = row.observation.observedAt
        const age = observed === null ? null : Math.max(0, Math.floor(now / 1000 - observed))
        const stale = staleNow(row)
        return <article key={row.task_id} data-task-id={row.task_id}>
          <h3>{row.task_id}</h3>
          <p>Project: {words(row.project_id)} · Owner node: {words(row.node)} · {words(row.stage)}</p>
          <p>Supervisor task: {words(row.supervisor_task_id)} · Role: {words(row.role)}</p>
          <p>{words(row.observation_class)} · {age === null ? 'Observation unavailable' : `Observed ${age}s ago`}{stale ? ' · Stale' : ''}</p>
          {row.ownership_conflict === true && <p>Ownership conflict</p>}
          <button aria-expanded={isExpanded} onClick={() => void detail(row)}>Task details and workers</button>
          <button disabled={stale || !row.focusTarget} onClick={() => void focus(row)}>Focus existing session</button>
          {!row.focusTarget && <p>Focus unavailable: current target authority is missing.</p>}
          {isExpanded && <div>
            {!details[row.task_id] ? <p>Use Task details and workers to load this task.</p> : <>
              <p>Next step: {textField(fields.next_action) || 'Unknown'}</p>
              <p>Blockers: {textField(fields.blockers) || 'None reported'}</p>
              {Array.isArray(fields.workers) && fields.workers.map((worker, i) => <p key={i}>Worker: {words(obj(worker).node)} · {words(obj(worker).state)} · {textField(obj(worker).blockers) || 'No blocker reported'}</p>)}
              {!!Object.keys(obj(details[row.task_id].deferred_fields)).length && <p>Additional fields were deferred by the source.</p>}
            </>}
          </div>}
          <pre className="task-context__summary">{words(obj(row.human_summary).text, 'Summary unavailable')}</pre>
        </article>
      })}
      {page.continuation && <button disabled={pending} onClick={() => void load(true)}>Next page</button>}
    </>}
  </section>
}
