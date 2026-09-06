import { useEffect, useRef, useState } from 'react'
import type {
  ProjectLocalSettings,
  ProjectSettingsDoc,
  ProjectSettingsFamily,
  ProjectSettingsSnapshot,
  ProjectSetupKind,
  ProjectSetupRunResult,
  ResolvedProjectSettings
} from '@shared/project-settings'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import { isKnownTerminalThemeId, TERMINAL_THEMES } from '@renderer/terminal/themes'
import { useProjectSetup } from '../../state/projectSetup'
import { useSettingsSearch } from './context'
import { FieldRow } from './FieldRow'
import { formatEnvLines, formatListLines, parseEnvLines, parseListLines } from './project-settings-env'
import { matchesQuery, type SettingsSearchEntry } from './search'

/**
 * The four per-family editors (setup / agents / worktree / terminal) that hang off
 * `ProjectSettingsSection`: for every field, a SHARED row (writes via `saveShared`, disabled while
 * the shared file is git-conflicted) and, inside a "This machine" `<details>`, a LOCAL row for the
 * same field (writes via `saveLocal`, never disabled — a machine-local override is independent of
 * the shared file's conflict state) plus one `ignoreShared` Switch per family.
 *
 * Split out of `ProjectSettingsSection.tsx` per the Task 4 brief: four families' worth of fields
 * would have pushed that file well past ~400 lines.
 */

type FieldKind = 'input' | 'textarea' | 'switch' | 'env' | 'list' | 'theme'

interface FieldConfig {
  key: string
  label: string
  description?: string
  kind: FieldKind
}

interface FamilyConfig {
  title: string
  fields: FieldConfig[]
}

const FAMILY_CONFIG: Record<ProjectSettingsFamily, FamilyConfig> = {
  setup: {
    title: 'Setup',
    fields: [
      {
        key: 'setupScript',
        label: 'Setup script',
        // Not only "when a worktree is created": `attachWorktree` is the single post-bind point, so
        // adopting an existing worktree and re-binding one to a group run it too (as does the failed
        // chip's Re-run). A script written for a fresh checkout only, and re-run over a working one,
        // is the kind of surprise the row itself has to warn about.
        description:
          'Runs when a worktree for this project is created, adopted, or re-bound to a group.',
        kind: 'textarea'
      },
      {
        key: 'archiveScript',
        label: 'Archive script',
        description: 'Runs when a worktree for this project is archived.',
        kind: 'textarea'
      },
      {
        key: 'waitForSetup',
        // The old label ("…before opening a terminal") promised something this switch never did:
        // the terminal opens immediately either way. What waits is the node's QUEUED LAUNCH COMMAND
        // (`launchesToFire`'s setup gate) — the agent command must not race an `npm ci` still
        // writing node_modules under it.
        label: 'Hold queued launch commands until the setup script finishes',
        description:
          'Nodes opened into a new worktree still open right away; only their queued command waits.',
        kind: 'switch'
      }
    ]
  },
  agents: {
    title: 'Agents',
    fields: [
      {
        key: 'defaultAgentId',
        label: 'Default agent',
        description: 'Agent id used for new sessions in this project.',
        kind: 'input'
      },
      {
        key: 'launchCmd',
        label: 'Launch command',
        description: 'Overrides how the default agent is launched.',
        kind: 'input'
      },
      {
        key: 'env',
        label: 'Environment variables',
        description: 'KEY=VALUE, one per line.',
        kind: 'env'
      }
    ]
  },
  worktree: {
    title: 'Worktree',
    fields: [
      {
        key: 'basePath',
        label: 'Base path',
        // NB: no literal "project" in this searchable copy — see `fieldEntry` / the "project" query
        // guard in ProjectSettingsSection.test.tsx. "Local checkouts only" carries the same meaning
        // as the SSH-inert note without the trap word.
        description:
          'Directory new worktrees are created under; overrides the global template. Local checkouts only.',
        kind: 'input'
      },
      {
        key: 'baseRef',
        label: 'Base ref',
        description: 'Branch or ref new worktrees are created from.',
        kind: 'input'
      },
      {
        key: 'sharedPaths',
        // Honest now that the linker exists (core/worktree-shared-paths.ts): it does not error on a
        // missing source or a target that already exists — it SKIPS them (SharedPathResult).
        label: 'Shared paths',
        description:
          'Relative paths symlinked into each new worktree — e.g. .env, node_modules. Skipped when the source is missing or the target already exists.',
        kind: 'list'
      }
    ]
  },
  terminal: {
    title: 'Terminal',
    fields: [
      { key: 'shell', label: 'Shell', kind: 'input' },
      // Neither description says the word "project": every row in this pane is a project setting,
      // so it discriminates nothing while making the query "project" match the whole pane — the
      // very thing `fieldEntry`'s keyword list is careful to avoid.
      {
        key: 'theme',
        label: 'Theme',
        description: 'Overrides the global terminal theme. Terminals already open repaint.',
        kind: 'theme'
      },
      {
        key: 'fontFamily',
        label: 'Font family',
        description: 'Overrides the global terminal font.',
        kind: 'input'
      }
    ]
  }
}

const FAMILIES = Object.keys(FAMILY_CONFIG) as ProjectSettingsFamily[]

/**
 * Search metadata, derived from the config above so a field can never exist without one. Static
 * (no project name in the keywords): a query naming the PROJECT is handled one level up, by the
 * pane's `forceVisible` — see ProjectSettingsSection.
 *
 * Each family field yields ONE entry covering both of its rows (shared + "this machine"): the two
 * are the same setting, and hiding the local override while its shared twin shows would read as
 * the override having been lost.
 */
function fieldEntry(family: ProjectSettingsFamily, f: FieldConfig): SettingsSearchEntry {
  return {
    // Deliberately NOT keyworded 'project': it discriminates nothing (every entry here is a project
    // setting) while making the query "project" match every field of every project — which mounts
    // every project's pane at once, and with it an SSH settings read per project.
    title: f.label,
    description: f.description,
    keywords: [family, FAMILY_CONFIG[family].title, f.key, 'this machine', 'override']
  }
}

function ignoreSharedEntry(family: ProjectSettingsFamily): SettingsSearchEntry {
  return {
    title: `Ignore shared ${FAMILY_CONFIG[family].title.toLowerCase()} settings`,
    keywords: [family, 'ignore', 'shared', 'override', 'this machine']
  }
}

/** Every family row's search entry, for the pane's `searchEntries`. */
export const FAMILY_SEARCH_ENTRIES: SettingsSearchEntry[] = FAMILIES.flatMap((family) => [
  ...FAMILY_CONFIG[family].fields.map((f) => fieldEntry(family, f)),
  ignoreSharedEntry(family)
])

/** Text a non-env, non-list field shows in its box: the raw string, or '' when unset. */
function textOf(kind: FieldKind, raw: unknown): string {
  if (kind === 'list') return formatListLines(raw as string[] | undefined)
  return typeof raw === 'string' ? raw : ''
}

/** Text -> value for a non-env field. Blank (or all-whitespace) text clears the field. An `input`
 *  is trimmed on commit (matches the identity rows' name field); a `textarea` (script bodies)
 *  keeps its interior whitespace verbatim — only "nothing but whitespace" counts as empty. */
function valueOf(kind: FieldKind, text: string): unknown {
  if (kind === 'list') {
    const items = parseListLines(text)
    return items.length ? items : undefined
  }
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return kind === 'input' ? trimmed : text
}

function useDraft(value: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return [draft, setDraft]
}

function textareaClass(disabled?: boolean): string {
  return `min-h-20 w-72 rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-text outline-none focus:border-accent${disabled ? ' disabled:opacity-50' : ''}`
}

function StringField({
  id,
  label,
  ariaLabel,
  description,
  note,
  multiline,
  text,
  disabled,
  onCommit
}: {
  id: string
  label: string
  /** Accessible name, when it must differ from the visible label — a LOCAL row carries
   *  "(this machine)" so it does not present the same name as its shared twin (SwitchField's
   *  `ariaLabel` does the same). Omitted on a shared row, which is named by its `<label>`. */
  ariaLabel?: string
  description?: string
  note?: string
  multiline: boolean
  text: string
  disabled?: boolean
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useDraft(text)
  const commit = (): void => {
    if (draft !== text) onCommit(draft)
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      htmlFor={id}
      control={
        multiline ? (
          <textarea
            id={id}
            value={draft}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className={textareaClass(disabled)}
          />
        ) : (
          <Input
            id={id}
            className="w-72"
            value={draft}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        )
      }
    />
  )
}

/** `env` gets its own field: unlike every other field, its warn note is a LIVE parse of the
 *  current draft (rejected lines only exist before a commit — once saved, only the valid pairs
 *  remain, so there is nothing left to report). Provenance note is shown once the draft has
 *  nothing to reject. */
function EnvField({
  id,
  label,
  ariaLabel,
  description,
  disabled,
  text,
  overrideNote,
  onCommitValue
}: {
  id: string
  label: string
  /** See `StringField`'s `ariaLabel`: the local row's name carries "(this machine)". */
  ariaLabel?: string
  description?: string
  disabled?: boolean
  text: string
  overrideNote?: string
  onCommitValue: (value: Record<string, string> | undefined) => void
}): React.JSX.Element {
  const [draft, setDraft] = useDraft(text)
  const { rejected } = parseEnvLines(draft)
  const note = rejected.length > 0 ? `Ignored (not KEY=VALUE): ${rejected.join(', ')}` : overrideNote
  const commit = (): void => {
    if (draft === text) return
    const { env } = parseEnvLines(draft)
    onCommitValue(Object.keys(env).length ? env : undefined)
  }
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      htmlFor={id}
      control={
        <textarea
          id={id}
          value={draft}
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className={textareaClass(disabled)}
        />
      }
    />
  )
}

/**
 * The terminal `theme` row: a Select over the ids this build actually ships, not a free-text box.
 *
 * Three properties the plain Input could not have:
 *  - the ids are not guessable ('catppuccin-mocha', 'tokyo-night'), and a typo used to be
 *    indistinguishable from a working value — the merge ignores an unknown id, so the terminal just
 *    kept the global theme with nothing on screen saying why.
 *  - the empty option is INHERIT, not "no theme": it clears the field so this machine's global
 *    setting (or, on a local row, the shared document) decides.
 *  - a stored id this build does not know must still READ AS ITSELF rather than silently showing as
 *    "inherit" — same precedent as the identity pane's unknown-account option. A teammate's newer
 *    theme name, or one since removed, is a real value sitting in a real document; presenting the
 *    box as empty would invite a save that erases it.
 */
function ThemeField({
  id,
  label,
  ariaLabel,
  description,
  note,
  value,
  disabled,
  onCommit
}: {
  id: string
  label: string
  ariaLabel?: string
  description?: string
  note?: string
  value: string
  disabled?: boolean
  onCommit: (value: string | undefined) => void
}): React.JSX.Element {
  const unknown = value !== '' && !isKnownTerminalThemeId(value)
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      htmlFor={id}
      control={
        <Select
          id={id}
          className="w-72"
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">Inherit (use this machine&rsquo;s setting)</option>
          {TERMINAL_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
          {unknown ? <option value={value}>{value} (not in this version)</option> : null}
        </Select>
      }
    />
  )
}

function SwitchField({
  label,
  description,
  note,
  ariaLabel,
  checked,
  disabled,
  onCommit
}: {
  label: string
  description?: string
  note?: string
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  onCommit: (v: boolean) => void
}): React.JSX.Element {
  return (
    <FieldRow
      label={label}
      description={description}
      note={note}
      control={
        <Switch checked={checked} ariaLabel={ariaLabel} disabled={disabled} onChange={onCommit} />
      }
    />
  )
}

/** Merges one family field into the WHOLE local settings object, preserving every other family and
 *  `ignoreShared` untouched — `saveLocal` replaces the file, so dropping a sibling here would erase
 *  it from disk. `undefined` clears the field; an emptied family key is dropped, and an entirely
 *  empty result collapses to `undefined` (clears the local overlay file itself). */
function nextLocalField(
  current: ProjectLocalSettings | undefined,
  family: ProjectSettingsFamily,
  key: string,
  value: unknown
): ProjectLocalSettings | undefined {
  const out: Record<string, unknown> = { ...current }
  const familyObj: Record<string, unknown> = {
    ...((current?.[family] as Record<string, unknown> | undefined) ?? {})
  }
  if (value === undefined) delete familyObj[key]
  else familyObj[key] = value
  if (Object.keys(familyObj).length === 0) delete out[family]
  else out[family] = familyObj
  return Object.keys(out).length === 0 ? undefined : (out as ProjectLocalSettings)
}

function nextLocalIgnoreShared(
  current: ProjectLocalSettings | undefined,
  family: ProjectSettingsFamily,
  on: boolean
): ProjectLocalSettings | undefined {
  const out: Record<string, unknown> = { ...current }
  const ignore: Record<string, unknown> = { ...(current?.ignoreShared ?? {}) }
  if (on) ignore[family] = true
  else delete ignore[family]
  if (Object.keys(ignore).length === 0) delete out.ignoreShared
  else out.ignoreShared = ignore
  return Object.keys(out).length === 0 ? undefined : (out as ProjectLocalSettings)
}

/** What a refused write says. Shared and local fail for different reasons and are recoverable in
 *  different ways, so they do not share one vague sentence. */
const SAVE_FAILED_NOTE: Record<'shared' | 'local', string> = {
  shared:
    'Could not save — the shared settings file may be conflicted or unavailable; reload the project settings.',
  local: 'Could not save this override on this machine; the edit is retained. Retry the retained local edit above.'
}

/** Why a run the service refused never happened. A refusal must read as a refusal: the button was
 *  pressed and nothing appeared, which is otherwise indistinguishable from a broken button. */
const SKIP_NOTE: Record<Extract<ProjectSetupRunResult, { status: 'skipped' }>['reason'], string> = {
  'no-script': 'Skipped: no script is set for this project.',
  declined: 'Skipped: the trust prompt was answered "Skip", so nothing ran.',
  unanswered: 'Skipped: the trust prompt went unanswered, so nothing ran.',
  busy: 'Skipped: a run for this project is already in progress.',
  unavailable: 'Skipped: this project has nowhere to run — no folder and no server connection.'
}

const RUN_LABEL: Record<ProjectSetupKind, string> = { setup: 'Run setup', archive: 'Run archive' }

/**
 * A `launchCmd` with no `defaultAgentId` beside it is INERT, and silently so — the launch layer
 * (`workspace.ts agentLaunchOverride`) consumes a project's launch command only for the agent that
 * project itself names, and never falls back to this machine's global default agent (that would
 * make a shared doc type one agent's wrapper into whatever agent the local user happens to prefer).
 * A setting that does nothing must say it does nothing, on the row where it was typed.
 */
export const LAUNCH_CMD_UNPAIRED_NOTE =
  'Launch command applies only when a Default agent id is set above.'

/**
 * The whole worktree family is INERT on an SSH project: `git worktree` runs against the local
 * filesystem, and an SSH project has no local checkout to create worktrees in (both creation sites —
 * the "New worktree" dialog and the `open-worktree` verb — refuse SSH outright). Shown on every
 * worktree row so a value typed there does not look as if it will ever take effect. Unlike the
 * searchable field copy this note may say "project" — it is a `note`, not part of any search entry.
 */
export const WORKTREE_SSH_INERT_NOTE =
  'Worktree settings apply to local projects; this is an SSH project.'

/** How a finished run reads in the badge. */
function exitNote(state: 'done' | 'failed' | 'cancelled', exitCode: number | undefined): string {
  if (state === 'cancelled') return 'Cancelled'
  if (state === 'done') return `Finished (exit ${exitCode ?? 0})`
  return `Failed (exit ${exitCode ?? 'unknown'})`
}

/**
 * Manual "Run setup" / "Run archive" for this project, with the live output of whatever is running.
 *
 * The service — not this component — decides whether a script may run: a shared-sourced script goes
 * through the consent dialog (`SetupConsentDialog`), and every refusal comes back as a `skipped`
 * reason that is shown verbatim-ish below. So the properties that matter here are:
 *
 *  - SUBSCRIBE BEFORE RUN. Main can emit the first chunks before the `run` invoke resolves, so a
 *    subscription opened on the ack would silently lose the head of the output (Task 1 review, T1).
 *    The subscription is opened on the first click and held until the pane unmounts — a late
 *    `cancelled`/`failed` event after a terminal-looking one must still land.
 *  - HONEST DISABLED STATE. Disabled while a run is live (main would answer `busy` anyway), while
 *    the family sets no EFFECTIVE script for that kind (local-over-shared — a machine-local script
 *    is a real script), and for a project with nowhere to run (no folder, no server): the service
 *    refuses that with `unavailable`, and offering a button that can only fail is a lie.
 *  - The run is PROJECT-scoped: `worktreePath` is deliberately `undefined` here. Worktree-bound
 *    runs come from the worktree flow (Task 5), which owns the path main then validates.
 */
function SetupRunControls({
  projectId,
  canRun,
  hasScript
}: {
  projectId: string
  /** False when the project has neither a folder nor an SSH endpoint. */
  canRun: boolean
  hasScript: Record<ProjectSetupKind, boolean>
}): React.JSX.Element {
  // Resolved through the ATTACHMENT this component made at ack time, not through "whatever event
  // arrived on the channel we subscribed to": events carry no lane discriminator, so a worktree's
  // run and this panel's run are told apart only by who claimed which runKey.
  const attached = useProjectSetup((s) => s.runForProject(projectId))
  const [busy, setBusy] = useState<'' | ProjectSetupKind | 'cancel'>('')
  const [notice, setNotice] = useState('')
  /** The run main acknowledged, held until the store reports THAT run (by `runId`). `runKey` alone
   *  will not do: it is deterministic, so the entry sitting under it may still be the PREVIOUS run
   *  of the same script — showing its exit badge over a script that is starting right now. */
  const [started, setStarted] = useState<{ runKey: string; runId: string } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      unsubRef.current?.()
      unsubRef.current = null
    },
    []
  )

  // The acked run's first event has not landed yet, so what sits in the lane (if anything) is the
  // PREVIOUS run of the same script. It is not ours to show.
  const awaitingStarted = started !== null && attached?.runId !== started.runId
  const run = awaitingStarted ? undefined : attached
  const active = busy !== '' || run?.state === 'running' || awaitingStarted
  const liveKey = run?.state === 'running' ? run.runKey : awaitingStarted ? started.runKey : null

  const start = async (kind: ProjectSetupKind): Promise<void> => {
    setNotice('')
    setBusy(kind)
    // Before the call, never after — see the T1 note above.
    if (!unsubRef.current) unsubRef.current = useProjectSetup.getState().subscribeProject(projectId)
    try {
      const res = await window.nodeTerminal.projectSetup.run(projectId, kind, undefined)
      if (res.status === 'skipped') {
        setNotice(SKIP_NOTE[res.reason])
        return
      }
      // Claim the lane with the runKey main gave us — this is what makes the events ours rather
      // than some other initiator's, and it is why `attachProject` takes the ACKED key.
      useProjectSetup.getState().attachProject(projectId, res.runKey)
      setStarted({ runKey: res.runKey, runId: res.runId })
    } catch {
      setNotice('Could not start the script — the project may have become unavailable.')
    } finally {
      setBusy('')
    }
  }

  const stop = async (runKey: string): Promise<void> => {
    setBusy('cancel')
    try {
      await window.nodeTerminal.projectSetup.cancel(runKey)
    } catch {
      /* A cancel that cannot be delivered leaves the run where it was; the event stream still owns
         the truth about whether it ended. */
    } finally {
      setBusy('')
      // Stop waiting for an acked run we just asked to die: from here the event stream (a
      // `cancelled`, or a terminal event that beat the cancel) owns what the box shows.
      setStarted(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {(['setup', 'archive'] as ProjectSetupKind[]).map((kind) => (
          <Button
            key={kind}
            disabled={!canRun || !hasScript[kind] || active}
            onClick={() => void start(kind)}
          >
            {RUN_LABEL[kind]}
          </Button>
        ))}
        {liveKey ? (
          <Button variant="ghost" disabled={busy === 'cancel'} onClick={() => void stop(liveKey)}>
            Cancel
          </Button>
        ) : null}
        {run && run.state !== 'running' ? (
          <span className="text-[12px] text-muted">{exitNote(run.state, run.exitCode)}</span>
        ) : null}
      </div>
      {!canRun ? (
        <p className="text-[12px] leading-relaxed text-muted">
          This project has nowhere to run a script — set a folder or a server connection first.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-[12px] leading-relaxed text-[color:var(--warn)]">
          {notice}
        </p>
      ) : null}
      {run ? (
        <pre
          role="log"
          aria-label="Setup script output"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text"
        >
          {run.tail}
        </pre>
      ) : null}
    </div>
  )
}

function FamilySection({
  projectId,
  family,
  sharedFamily,
  localFamily,
  ignoreShared,
  resolvedFamily,
  conflict,
  ready,
  sharedEditable,
  canRun,
  ssh,
  saveShared,
  saveLocal,
  localError,
  reload
}: {
  projectId: string
  family: ProjectSettingsFamily
  sharedFamily: Record<string, unknown> | undefined
  localFamily: Record<string, unknown> | undefined
  ignoreShared: boolean
  resolvedFamily: Record<string, { source: 'local' | 'shared' } | undefined>
  conflict: boolean
  /** False until `snapshot` is an actual object (not `'loading'`, not `null`). Gates EVERY editor
   *  in this family, shared and local alike: before the first read answers (or after a failed
   *  one), there is no reliable doc to merge an edit into, and for an SSH project that window is a
   *  network round-trip, not a render tick — a blur landing in it would write a doc built from
   *  `{}`/`undefined`, silently deleting every other family already on disk. */
  ready: boolean
  /** False when this project has no file to share (see `ProjectFamilyEditors`). */
  sharedEditable: boolean
  /** False when the project has nowhere to run a script. Deliberately NOT `sharedEditable`, even
   *  though today both come out of `project.cwd || project.ssh`: one is about where a FILE can be
   *  written, the other about where a PROCESS can be spawned, and the run buttons live outside the
   *  shared-editing gate entirely (a machine-local script on a folderless project still cannot
   *  run). */
  canRun: boolean
  /** SSH project → the whole `worktree` family is inert (no local checkout). Drives the per-row
   *  caveat below; ignored by every other family. */
  ssh: boolean
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (
    update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined
  ) => Promise<boolean>
  /** Re-reads the project's settings. Rung after a REFUSED shared write: a refusal is usually the
   *  file's answer, not ours (it went conflicted, or the folder went away, between our read and our
   *  write), and only a fresh read can make the pane describe the file as it now is. */
  reload: () => void
  localError?: string | null
}): React.JSX.Element | null {
  const config = FAMILY_CONFIG[family]
  const sharedDisabled = conflict || !ready || !sharedEditable
  const localDisabled = !ready
  // Which half last refused a write, or null. Set from the saver's own answer — before this, a
  // `false` was dropped on the floor and the row simply snapped back to its old value, which reads
  // as "the app ignored me". Cleared by the next save of the same half that succeeds; NOT cleared
  // by the reload a failure triggers (that would erase the message we just put up).
  const [saveFailed, setSaveFailed] = useState<'shared' | 'local' | null>(null)
  // Row-level search filtering. Done here rather than with `SearchableRow` wrappers because every
  // field renders TWICE (shared + "this machine") from the same list — filtering the list keeps
  // the two copies in step by construction. An entirely unmatched family drops out, heading and
  // "This machine" disclosure included, so the search never leaves an empty shell behind.
  const query = useSettingsSearch()
  const fields = config.fields.filter((f) => matchesQuery(query, fieldEntry(family, f)))
  const showIgnoreShared = matchesQuery(query, ignoreSharedEntry(family))
  if (fields.length === 0 && !showIgnoreShared) return null

  // Guarded here too, not just via the `disabled` attribute below: a disabled control blocks real
  // user interaction, but nothing stops a caller (or a test) from dispatching events on it
  // directly, and the merge-base hazard this guards against is a data-corruption risk, not a UX
  // nicety — it must hold even if the DOM attribute is bypassed.
  // Every commit path routes its saver's answer through here: a dropped `false` is a silent data
  // loss — the row reverts to the stored value with no explanation, which is indistinguishable
  // from the app ignoring the edit.
  const settle = (half: 'shared' | 'local', ok: boolean): void => {
    if (ok) {
      setSaveFailed((prev) => (prev === half ? null : prev))
      return
    }
    setSaveFailed(half)
    if (half === 'shared') reload()
  }
  const commitShared = (key: string, value: unknown): void => {
    if (sharedDisabled) return
    void saveShared({ [family]: { [key]: value } } as ProjectSettingsDoc).then((ok) =>
      settle('shared', ok)
    )
  }
  const commitLocal = (key: string, value: unknown): void => {
    if (localDisabled) return
    void saveLocal((current) => nextLocalField(current, family, key, value)).then(
      (ok) => settle('local', ok), () => settle('local', false))
  }
  const commitIgnoreShared = (on: boolean): void => {
    if (localDisabled) return
    void saveLocal((current) => nextLocalIgnoreShared(current, family, on)).then(
      (ok) => settle('local', ok), () => settle('local', false))
  }

  // EFFECTIVE values (local-over-shared, `ignoreShared` respected), like the setup family's run
  // buttons above: a launch command nothing can consume is reported wherever it was typed — on the
  // shared row and on its "this machine" twin, since either one alone can be the value that is
  // sitting there doing nothing. Absence of a resolved `defaultAgentId` is the whole condition;
  // an id that resolves to no launchable agent is a different (and much louder) problem.
  const launchCmdUnpaired =
    family === 'agents' &&
    resolvedFamily.launchCmd !== undefined &&
    resolvedFamily.defaultAgentId === undefined
  // The whole worktree family cannot take effect on an SSH project (no local checkout) — every row
  // of it carries the caveat, not just one.
  const worktreeInert = family === 'worktree' && ssh
  /** The caveat WINS over the provenance note ("Active" / "Overridden on this machine"): where the
   *  value comes from hardly matters while nothing consumes it. */
  const caveatNote = (f: FieldConfig): string | undefined => {
    if (worktreeInert) return WORKTREE_SSH_INERT_NOTE
    if (launchCmdUnpaired && f.key === 'launchCmd') return LAUNCH_CMD_UNPAIRED_NOTE
    return undefined
  }

  const renderShared = (f: FieldConfig): React.JSX.Element => {
    const overridden = resolvedFamily[f.key]?.source === 'local'
    const id = `project-${family}-${f.key}-${projectId}`
    const overrideNote = caveatNote(f) ?? (overridden ? 'Overridden on this machine' : undefined)
    if (f.kind === 'switch') {
      return (
        <SwitchField
          key={f.key}
          label={f.label}
          description={f.description}
          note={overrideNote}
          ariaLabel={f.label}
          checked={sharedFamily?.[f.key] === true}
          disabled={sharedDisabled}
          onCommit={(on) => commitShared(f.key, on ? true : undefined)}
        />
      )
    }
    if (f.kind === 'env') {
      return (
        <EnvField
          key={f.key}
          id={id}
          label={f.label}
          description={f.description}
          disabled={sharedDisabled}
          text={formatEnvLines(sharedFamily?.[f.key] as Record<string, string> | undefined)}
          overrideNote={overrideNote}
          onCommitValue={(v) => commitShared(f.key, v)}
        />
      )
    }
    if (f.kind === 'theme') {
      return (
        <ThemeField
          key={f.key}
          id={id}
          label={f.label}
          description={f.description}
          note={overrideNote}
          disabled={sharedDisabled}
          value={textOf(f.kind, sharedFamily?.[f.key])}
          onCommit={(v) => commitShared(f.key, v)}
        />
      )
    }
    return (
      <StringField
        key={f.key}
        id={id}
        label={f.label}
        description={f.description}
        multiline={f.kind === 'textarea' || f.kind === 'list'}
        note={overrideNote}
        disabled={sharedDisabled}
        text={textOf(f.kind, sharedFamily?.[f.key])}
        onCommit={(text) => commitShared(f.key, valueOf(f.kind, text))}
      />
    )
  }

  const renderLocal = (f: FieldConfig): React.JSX.Element => {
    const active = resolvedFamily[f.key]?.source === 'local'
    const id = `project-${family}-${f.key}-local-${projectId}`
    const activeNote = caveatNote(f) ?? (active ? 'Active' : undefined)
    if (f.kind === 'switch') {
      return (
        <SwitchField
          key={f.key}
          label={f.label}
          description={f.description}
          note={activeNote}
          ariaLabel={`${f.label} (this machine)`}
          checked={localFamily?.[f.key] === true}
          disabled={localDisabled}
          onCommit={(on) => commitLocal(f.key, on ? true : undefined)}
        />
      )
    }
    if (f.kind === 'env') {
      return (
        <EnvField
          key={f.key}
          id={id}
          label={f.label}
          description={f.description}
          ariaLabel={`${f.label} (this machine)`}
          disabled={localDisabled}
          text={formatEnvLines(localFamily?.[f.key] as Record<string, string> | undefined)}
          overrideNote={activeNote}
          onCommitValue={(v) => commitLocal(f.key, v)}
        />
      )
    }
    if (f.kind === 'theme') {
      return (
        <ThemeField
          key={f.key}
          id={id}
          label={f.label}
          ariaLabel={`${f.label} (this machine)`}
          description={f.description}
          note={activeNote}
          disabled={localDisabled}
          value={textOf(f.kind, localFamily?.[f.key])}
          onCommit={(v) => commitLocal(f.key, v)}
        />
      )
    }
    return (
      <StringField
        key={f.key}
        id={id}
        label={f.label}
        ariaLabel={`${f.label} (this machine)`}
        description={f.description}
        multiline={f.kind === 'textarea' || f.kind === 'list'}
        note={activeNote}
        disabled={localDisabled}
        text={textOf(f.kind, localFamily?.[f.key])}
        onCommit={(text) => commitLocal(f.key, valueOf(f.kind, text))}
      />
    )
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold text-text">{config.title}</h3>
      {family === 'setup' ? (
        <SetupRunControls
          projectId={projectId}
          canRun={canRun}
          // EFFECTIVE values (local-over-shared), not the shared row's text: a machine-local
          // script is a real script, and a family whose shared half is ignored on this machine
          // has none even when the file sets one.
          hasScript={{
            setup: resolvedFamily.setupScript !== undefined,
            archive: resolvedFamily.archiveScript !== undefined
          }}
        />
      ) : null}
      {saveFailed && (saveFailed !== 'local' || localError !== null) ? (
        <p role="status" className="text-[12px] leading-relaxed text-[color:var(--warn)]">
          {SAVE_FAILED_NOTE[saveFailed]}
        </p>
      ) : null}
      <div className="space-y-2.5">{fields.map(renderShared)}</div>
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">This machine</summary>
        <div className="mt-3 space-y-2.5">
          <p className="text-[12px] leading-relaxed text-muted">
            Overrides that apply only on this machine. Never written to the shared file.
          </p>
          {fields.map(renderLocal)}
          {showIgnoreShared && (
            <SwitchField
              label={`Ignore shared ${config.title.toLowerCase()} settings`}
              description="Never use the git-shared values for this family on this machine, even where this machine sets none of its own."
              ariaLabel={`Ignore shared ${family} settings on this machine`}
              checked={ignoreShared}
              disabled={localDisabled}
              onCommit={commitIgnoreShared}
            />
          )}
        </div>
      </details>
    </div>
  )
}

export function ProjectFamilyEditors({
  projectId,
  snapshot,
  resolved,
  conflict,
  sharedEditable,
  canRun,
  ssh = false,
  saveShared,
  saveLocal,
  localError,
  reload
}: {
  projectId: string
  snapshot: ProjectSettingsSnapshot | null | 'loading'
  resolved: ResolvedProjectSettings
  conflict: boolean
  /**
   * False for a project with no folder at all — an inline canvas tab (no `cwd`, no `ssh`). There is
   * nowhere to put a `.nodeterm/settings.json`, so the store refuses every shared write
   * (`writeProjectSettings` returns false on `!e.cwd`); rendering live editors there offers a save
   * that can only ever fail. The shared rows go read-only with a sentence saying why.
   *
   * The "This machine" rows stay live: the local overlay lives in this machine's workspace index,
   * not in the project folder, so `updateLocal` genuinely succeeds for a folderless project.
   */
  sharedEditable: boolean
  /** See `FamilySection`'s `canRun`: where a PROCESS may be spawned, which is a different question
   *  from where the shared file may be written. */
  canRun: boolean
  /** SSH project → the worktree family is inert (local-only feature). Defaults false; forwarded to
   *  each `FamilySection` for its per-row caveat. */
  ssh?: boolean
  localError?: string | null
  saveShared: (doc: ProjectSettingsDoc) => Promise<boolean>
  saveLocal: (
    update: (current: ProjectLocalSettings | undefined) => ProjectLocalSettings | undefined
  ) => Promise<boolean>
  reload: () => void
}): React.JSX.Element {
  // Loading and failed-read (`null`) both mean "no doc it is safe to merge an edit into" — see
  // `FamilySection`'s `ready` doc comment.
  const ready = snapshot !== 'loading' && snapshot !== null
  const shared: ProjectSettingsDoc = snapshot && snapshot !== 'loading' && snapshot.shared ? snapshot.shared : {}
  const local: ProjectLocalSettings | undefined = snapshot && snapshot !== 'loading' ? snapshot.local : undefined
  return (
    <>
      {!sharedEditable ? (
        <p className="border-t border-border pt-4 text-[13px] leading-relaxed text-muted">
          This project has no folder, so there is no shared <code>.nodeterm/settings.json</code> to
          write: the shared rows below are read-only. Overrides under &ldquo;This machine&rdquo;
          still apply.
        </p>
      ) : null}
      {FAMILIES.map((family) => (
        <FamilySection
          key={family}
          projectId={projectId}
          family={family}
          sharedFamily={shared[family] as Record<string, unknown> | undefined}
          localFamily={local?.[family] as Record<string, unknown> | undefined}
          ignoreShared={local?.ignoreShared?.[family] === true}
          resolvedFamily={resolved[family] as Record<string, { source: 'local' | 'shared' } | undefined>}
          conflict={conflict}
          ready={ready}
          sharedEditable={sharedEditable}
          canRun={canRun}
          ssh={ssh}
          saveShared={saveShared}
          saveLocal={saveLocal}
          localError={localError}
          reload={reload}
        />
      ))}
    </>
  )
}
