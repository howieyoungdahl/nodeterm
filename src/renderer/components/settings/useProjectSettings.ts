import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  resolveProjectSettings,
  type ProjectLocalSettings,
  type ProjectSettingsDoc,
  type ProjectSettingsFileV1,
  type ProjectSettingsSnapshot,
  type ResolvedProjectSettings
} from '@shared/project-settings'
import { ensureProjectLaunchInfo, invalidateProjectLaunchInfo } from '../../state/projectLaunchInfo'
import { localSettingsDelta, type LocalSettingsRequest } from '@shared/local-settings-reconciliation'

/**
 * One project's `.nodeterm/settings.json` (the git-shared doc) plus this machine's local overlay,
 * as the Settings panel needs them: the raw snapshot for provenance/conflict decisions, the
 * resolved local-over-shared view for showing effective values, and two savers.
 *
 * `snapshot` is `'loading'` until the first read answers, then the snapshot, or `null` when the
 * project is unknown to the store or the read failed. A failed read is never an exception here:
 * the panel must still render its identity rows for a project whose settings file is unreadable.
 */
export interface ProjectSettingsHook {
  snapshot: ProjectSettingsSnapshot | null | 'loading'
  /** `resolveProjectSettings(local, shared)`; empty families while the first read is in flight. */
  resolved: ResolvedProjectSettings
  /**
   * Commits an edit to the GIT-SHARED document. The argument is a PATCH, merged field-by-field
   * into the document that was last read — `writeShared` is a whole-document write (it replaces
   * the file), so an editor that owns one field must not blank its siblings. A field set to
   * `undefined` is removed; a family left with no fields is removed with it, so an unset setting
   * adds no bytes to a file the whole team reads.
   *
   * Returns the store's accept/refuse answer, and re-reads on success: the store bumped `rev` and
   * may have sanitized what it wrote, so what the panel shows afterwards is the FILE, not our hope.
   */
  saveShared(doc: ProjectSettingsDoc): Promise<boolean>
  /**
   * Serializes known-leaf deltas over acknowledged local metadata. An unresolved request is
   * retained across reloads in this tab and must settle before another edit can be submitted.
   * `saveLocal(() => undefined)` removes known leaves, never unknown extensions.
   */
  saveLocal(
    update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined
  ): Promise<boolean>
  reload(): void
  localError: string | null
  retryLocal(): Promise<boolean>
}

/** The document half of a shared file — `version`/`rev`/`savedAt` belong to the store, which
 *  re-stamps them on every write, so they never travel back through an editor. */
function docOf(shared: ProjectSettingsFileV1 | null | undefined): ProjectSettingsDoc {
  if (!shared) return {}
  const { version: _version, rev: _rev, savedAt: _savedAt, ...doc } = shared
  return doc
}

/**
 * Field-level merge of `patch` into `current`, dropping `undefined` (a cleared field) and any
 * family the clearing leaves empty. A whole family set to `undefined` is dropped outright.
 * Exported for the tests that pin the "an editor never blanks a field it does not own" rule (see
 * `mergeSharedDoc` in ProjectSettingsSection.test.tsx).
 */
export function mergeSharedDoc(
  current: ProjectSettingsDoc,
  patch: ProjectSettingsDoc
): ProjectSettingsDoc {
  const out: Record<string, unknown> = { ...current }
  for (const family of Object.keys(patch) as (keyof ProjectSettingsDoc)[]) {
    const patchFamily = patch[family] as Record<string, unknown> | undefined
    if (patchFamily === undefined) {
      delete out[family]
      continue
    }
    const merged: Record<string, unknown> = {
      ...(current[family] as Record<string, unknown> | undefined),
      ...patchFamily
    }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    if (Object.keys(merged).length === 0) delete out[family]
    else out[family] = merged
  }
  return out as ProjectSettingsDoc
}

const EMPTY_FAMILIES = (): ResolvedProjectSettings => resolveProjectSettings(undefined, undefined)

export function useProjectSettings(projectId: string): ProjectSettingsHook {
  const [snapshot, setSnapshot] = useState<ProjectSettingsSnapshot | null | 'loading'>('loading')
  const [nonce, setNonce] = useState(0)
  const [localError, setLocalError] = useState<string | null>(null)
  const localIntent = useRef<{ projectId: string; request: LocalSettingsRequest } | null>(null)
  const localFlight = useRef<Promise<boolean> | null>(null)
  const localQueue = useRef<Promise<boolean>>(Promise.resolve(true))
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const readProject = useRef(projectId)
  const generation = useRef(0)
  const active = useRef(true)
  const intentKey = `nodeterm.local-settings.intent.${projectId}`
  useEffect(() => {
    active.current = true
    return () => { active.current = false; generation.current += 1 }
  }, [])
  /** Counts successful writes, so a read can tell whether it started before or after the last one. */
  const writeSeqRef = useRef(0)

  // The merge base for `saveShared` must be the LATEST document, without making the saver identity
  // change on every read (a blur handler holding last render's saver would then merge into a stale
  // document and silently revert a sibling field).
  const snapshotRef = useRef<ProjectSettingsSnapshot | null | 'loading'>(snapshot)
  snapshotRef.current = snapshot

  // The document we last WROTE, which outranks the snapshot until the re-read replaces it. Without
  // it, two blurs in a row (shell, then theme) both merge into the pre-first-save document — and
  // because every write is a WHOLE-document write, the second one silently drops the first. The
  // re-read is asynchronous; the user's next blur is not going to wait for it. Tagged with the
  // project id so a pane switch can never merge one project's edit into another's file.
  const pendingRef = useRef<{ projectId: string; doc: ProjectSettingsDoc } | null>(null)

  useEffect(() => {
    let alive = true
    const changed = readProject.current !== projectId
    readProject.current = projectId
    if (changed) {
      generation.current += 1
      localQueue.current = Promise.resolve(true)
      localFlight.current = null
      snapshotRef.current = 'loading'
    }
    try {
      const raw = sessionStorage.getItem(intentKey)
      localIntent.current = raw ? JSON.parse(raw) : null
      if (localIntent.current) setLocalError('A local edit is retained in this tab. Retry its original operation.')
      else if (changed) setLocalError(null)
    } catch { setLocalError('Retained local edit storage is unavailable; no new edit will be sent.') }
    setSnapshot((last) => !changed && nonce && last !== 'loading' ? last : 'loading')
    // A read only supersedes the pending doc if no write happened while it was in flight;
    // otherwise what we just wrote is still the newer truth. Belt-and-braces: the effect's own
    // cancellation below already drops a read issued before the write in every path the test
    // harness can produce — this closes the remaining window, where the write's `reload()`
    // re-render has not been processed yet when the older read answers.
    const seqAtStart = writeSeqRef.current
    const settle = (next: ProjectSettingsSnapshot | null): void => {
      if (!alive) return
      if (writeSeqRef.current !== seqAtStart) return
      if (writeSeqRef.current === seqAtStart) {
        pendingRef.current = null
      }
      if (next !== null || !nonce) setSnapshot(next)
    }
    void window.nodeTerminal.projectSettings.read(projectId).then((next) => {
      settle(next)
      if (alive && next && !localIntent.current) setLocalError(null)
    }, () => {
      settle(null)
      if (alive) setLocalError('Local settings are unavailable. Reload to retry the read; retained edits are not discarded.')
    })
    return () => {
      alive = false
    }
  }, [projectId, nonce, intentKey])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const saveShared = useCallback(
    async (doc: ProjectSettingsDoc): Promise<boolean> => {
      const pending = pendingRef.current?.projectId === projectId ? pendingRef.current : null
      const snap = snapshotRef.current
      // Defence in depth under the editors' own `ready` gate: with no snapshot object AND no
      // pending write to merge into, the merge base would be `{}` — and every write here is a
      // WHOLE-document write, so committing it would delete whatever the file already holds. There
      // is nothing to merge into yet, so there is nothing safe to write: refuse.
      if (!pending && (snap === 'loading' || snap === null)) return false
      const current = pending ? pending.doc : docOf((snap as ProjectSettingsSnapshot).shared)
      const next = mergeSharedDoc(current, doc)
      const ok = await window.nodeTerminal.projectSettings.writeShared(projectId, next)
      if (!ok) return false
      // Advance the merge base NOW, not when the re-read lands: the next blur may arrive first.
      writeSeqRef.current += 1
      pendingRef.current = { projectId, doc: next }
      reload()
      // A shared write can change what a launch needs to know (a new/edited launchCmd, a new
      // trust-relevant shell) — drop the stale launch-info snapshot and re-warm it, same pair
      // `onTrustChanged` runs on Canvas.
      invalidateProjectLaunchInfo(projectId)
      void ensureProjectLaunchInfo(projectId)
      return true
    },
    [projectId, reload]
  )

  const retryLocal = useCallback((): Promise<boolean> => {
    if (localFlight.current) return localFlight.current
    const intent = localIntent.current
    if (!active.current || !intent || intent.projectId !== projectId || currentProject.current !== projectId) return Promise.resolve(false)
    const gen = generation.current
    const run = (async () => {
      try {
        // Every attempt, including retry after a failed setItem, needs exact tab retention
        // BEFORE transport. A different retained intent belongs to a newer editor instance.
        const owned = JSON.stringify(intent), stored = sessionStorage.getItem(intentKey)
        if (stored === null) sessionStorage.setItem(intentKey, owned)
        if (sessionStorage.getItem(intentKey) !== owned) throw new Error('Retained local operation changed; this attempt was not sent')
        const result = await window.nodeTerminal.projectSettings.updateLocal(projectId, intent.request)
        if (!active.current || currentProject.current !== projectId || generation.current !== gen) return false
        if (result.operationId !== intent.request.operationId || !['committed', 'already-applied'].includes(result.kind) ||
            !result.receiptRevision || !result.current || result.current.projectId !== projectId) {
          setLocalError(`${result.kind ?? 'unavailable'}: ${result.message ?? 'The edit is retained; retry the same operation.'}`)
          return false
        }
        const previous = snapshotRef.current
        if (!previous || previous === 'loading') return false
        if (sessionStorage.getItem(intentKey) !== owned) throw new Error('Retained local operation changed; late acknowledgment did not clear it')
        sessionStorage.removeItem(intentKey)
        const next = { ...previous, local: result.current.local,
          localBase: { clientId: result.current.clientId, indexRevision: result.current.indexRevision } }
        writeSeqRef.current += 1
        snapshotRef.current = next
        setSnapshot(next)
        localIntent.current = null
        setLocalError(null)
        invalidateProjectLaunchInfo(projectId)
        void ensureProjectLaunchInfo(projectId)
        return true
      } catch (error) {
        if (active.current && currentProject.current === projectId && generation.current === gen)
          setLocalError(`unavailable: ${String(error)}. The edit and operation are retained.`)
        return false
      }
    })()
    localFlight.current = run
    void run.finally(() => { if (localFlight.current === run) localFlight.current = null })
    return run
  }, [projectId, intentKey])

  const saveLocal = useCallback((update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined): Promise<boolean> => {
    const run = localQueue.current.then(async () => {
      if (!active.current || currentProject.current !== projectId) return false
      // No new operation can pass an unresolved intent. Explicit retry uses its original ID.
      if (localIntent.current) { setLocalError('An earlier local edit is retained. Retry it before submitting another edit.'); return false }
      const snap = snapshotRef.current
      if (!snap || snap === 'loading' || !snap.localBase) { setLocalError('Local settings have no acknowledged base; reload to retry the read.'); return false }
      try {
        if (sessionStorage.getItem(intentKey)) { setLocalError('A retained local request must settle first.'); return false }
        const next = update(snap.local), changes = localSettingsDelta(snap.local, next)
        if (!changes.length) return true
        localIntent.current = { projectId, request: { ...snap.localBase, projectId, operationId: crypto.randomUUID(), changes } }
        sessionStorage.setItem(intentKey, JSON.stringify(localIntent.current))
        return await retryLocal()
      } catch (error) { setLocalError(String(error)); return false }
    })
    localQueue.current = run
    return run
  }, [projectId, retryLocal, intentKey])

  const resolved = useMemo(
    () =>
      snapshot && snapshot !== 'loading'
        ? resolveProjectSettings(snapshot.local, docOf(snapshot.shared))
        : EMPTY_FAMILIES(),
    [snapshot]
  )

  return { snapshot, resolved, saveShared, saveLocal, reload, localError, retryLocal }
}
