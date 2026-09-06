import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { rankQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { IconEditor } from './icons'
import type { PaletteTranscriptStatus } from '../lib/usePaletteTranscriptSearch'

export interface Command {
  id: string
  label: string
  /** Right-aligned metadata that IS part of the search corpus (e.g. a file's directory). */
  hint?: string
  /**
   * Right-aligned metadata that is NOT searchable — a reason, not a key. A disabled affordance still
   * has to say why (worktrees on an SSH project), and putting that sentence in `hint` fed it to the
   * fuzzy matcher, so the row answered queries like "ssh" or "supported". Shown when `hint` is unset.
   */
  note?: string
  section?: string
  icon?: ReactNode
  /** Searchable body text (e.g. a terminal's visible output) — matched by substring. */
  content?: string
  run: () => void
  /** Optional secondary action shown as a right-aligned button (e.g. "Reveal in Explorer"). */
  onSecondary?: () => void
  /** Label for the secondary-action button (defaults to "Reveal"). */
  secondaryLabel?: string
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  /** Prepared file index for the active project (⌘K file search). */
  fileIndex?: QuickOpenIndexedFile[]
  /** Open a file result by its root-relative path. */
  onOpenFile?: (relPath: string) => void
  /** Reveal a file result in the Explorer by its root-relative path. */
  onRevealFile?: (relPath: string) => void
  /** Called whenever the query input changes (for async result sources). */
  onQueryChange?: (q: string) => void
  /** Pre-filtered commands appended verbatim (NOT re-filtered) — e.g. transcript hits. */
  extraCommands?: Command[]
  /** Transcript capability/failure is separate from ordinary command/file matches. */
  transcriptStatus?: PaletteTranscriptStatus
}

/** Case-insensitive subsequence match — "ntr" matches "New TeRminal". */
function matches(label: string, q: string): boolean {
  if (!q) return true
  const s = label.toLowerCase()
  let i = 0
  for (const ch of q.toLowerCase()) {
    i = s.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

/** Cmd/Ctrl+K command palette: fuzzy-filter actions and jump targets, Enter to run. */
export function CommandPalette({
  commands,
  onClose,
  fileIndex,
  onOpenFile,
  onRevealFile,
  onQueryChange,
  extraCommands,
  transcriptStatus = 'idle'
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  // Fuzzy-match label+hint; also substring-match the body text (e.g. terminal output).
  const contentHit = (c: Command) =>
    query.length >= 2 && !!c.content && c.content.toLowerCase().includes(query.toLowerCase())
  const labelHit = (c: Command) => matches(`${c.label} ${c.hint ?? ''}`, query)

  const filtered = useMemo(
    () => commands.filter((c) => labelHit(c) || contentHit(c)).slice(0, 50),
    [commands, query]
  )

  const fileCommands = useMemo<Command[]>(() => {
    if (!fileIndex || !onOpenFile || query.trim().length < 1) return []
    return rankQuickOpenFiles(query, fileIndex, 20).map((r) => {
      const base = r.path.split('/').pop() ?? r.path
      const dir = r.path.slice(0, r.path.length - base.length).replace(/\/$/, '')
      return {
        id: `file:${r.path}`,
        label: base,
        hint: dir,
        section: 'Files',
        icon: <IconEditor />,
        run: () => onOpenFile(r.path),
        onSecondary: onRevealFile ? () => onRevealFile(r.path) : undefined,
        secondaryLabel: 'Reveal in Explorer'
      }
    })
  }, [fileIndex, onOpenFile, onRevealFile, query])

  const items = useMemo(
    () => [...filtered, ...fileCommands, ...(extraCommands ?? [])],
    [filtered, fileCommands, extraCommands]
  )

  const run = (cmd?: Command) => {
    if (!cmd) return
    cmd.run()
    onClose()
  }

  return createPortal(
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette__input"
          autoFocus
          spellCheck={false}
          placeholder="Type a command or name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            onQueryChange?.(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              const c = items[active]
              if (c?.onSecondary) {
                c.onSecondary()
                onClose()
              }
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(items[active])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="palette__list">
          {transcriptStatus !== 'idle' && (transcriptStatus !== 'success' || !extraCommands?.length) && (
            <div role="status" aria-live="polite">
              <div className="palette__section">Transcripts</div>
              <div className="palette__empty">
                {transcriptStatus === 'unavailable' ? 'Transcript search is unavailable here. Commands and files remain searchable.'
                  : transcriptStatus === 'error' ? 'Transcript search failed. Change the query to retry.'
                    : transcriptStatus === 'loading' ? 'Searching transcripts…' : 'No transcript matches.'}
              </div>
            </div>
          )}
          {items.length === 0 && <div className="palette__empty">{transcriptStatus === 'idle' ? 'No matches' : 'No matching commands or files'}</div>}
          {items.map((c, i) => (
            <div key={c.id} className="palette__row">
              {c.section && c.section !== items[i - 1]?.section && (
                <div className="palette__section">{c.section}</div>
              )}
              <button
                className={`palette__item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="palette__icon">{c.icon}</span>
                <span className="palette__label">{c.label}</span>
                {!labelHit(c) && contentHit(c) ? (
                  <span className="palette__hint">found in output</span>
                ) : (
                  (c.hint ?? c.note) && (
                    <span className="palette__hint">{c.hint ?? c.note}</span>
                  )
                )}
                {c.onSecondary && (
                  <span
                    className="palette__secondary"
                    title={c.secondaryLabel}
                    onClick={(e) => {
                      e.stopPropagation()
                      c.onSecondary?.()
                      onClose()
                    }}
                  >
                    ⤷
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
