/**
 * Reads the shared task-registry projection for the remote session navigator, and owns the
 * display-local preference file that sits beside it.
 *
 * WHERE THE FILE IS. `$NODETERM_TASK_REGISTRY` names an absolute path to a JSON document in the
 * registry contract's shape. **There is no default.** An unset variable is its own answer —
 * `no-registry-configured` — and not an empty task list: nodeterm does not know where any
 * particular tool keeps its state, and guessing a path would turn "you have not configured this"
 * into "you have no work", which is the one mistake this reader exists to prevent. That is the same
 * `ok:false` ≠ `ok:true with no rows` rule the session-memory panel already holds (CLAUDE.md).
 *
 * FIVE ANSWERS, ALL DISTINGUISHABLE: not configured · file missing · file unreadable · not valid
 * JSON (or valid JSON that is not a registry) · read, with a `stale` flag when the document was
 * generated before the host last booted. A caller can tell them apart and say which one happened;
 * none of them renders as "no tasks".
 *
 * VERBATIM. `generated_at`, `generated_at_epoch`, `source.generation` and `host_boot_epoch` are
 * passed through untouched. This reader never restamps, reshapes or synthesizes freshness — a
 * client that cannot tell how old the data is will present stale state as current, and the whole
 * point of the contract's freshness fields is that it can.
 *
 * READ-ONLY on the registry. nodeterm is a consumer: pins and task closure are the registry's own
 * shared state and are written by the registry's own writer, never here. The one file this module
 * DOES write is `view-prefs.json` (sort direction, collapsed workers, which view is open) — display
 * state for one local client, kept beside the registry rather than inside it, and published through
 * `writeFileAtomic` like every other store in this repo (a bare `fs.rename` is banned and
 * guard-tested).
 *
 * Desktop and Server can share this core reader once wired. This module does not establish an
 * HTTP/WS route or a browser consumer. Browser preferences must be per client, never this sibling
 * file shared by a Server's viewers. Mobile needs an equivalent authenticated protocol.
 * See docs/remote-task-context.md for the exact adapter and integration requirements.
 */

import { promises as fs, constants } from 'fs'
import path from 'path'
import { writeFileAtomic } from '../fs-atomic'
import {
  DEFAULT_VIEW_PREFS,
  REGISTRY_ENV_VAR,
  VIEW_PREFS_FILENAME,
  classifyRegistryPayload,
  normalizeViewPrefs,
  resolveRegistryPath
} from '../../shared/remote-nav/model'
import type { RegistryRead, RegistrySource, ViewPrefs } from '../../shared/remote-nav/model'

export { REGISTRY_ENV_VAR, VIEW_PREFS_FILENAME, resolveRegistryPath }
export type { RegistryRead, ViewPrefs }

/** Everything this module touches outside itself, so a test drives it without a filesystem and
 *  without an environment. Defaults are the real ones. */
export interface RegistryReaderDeps {
  env?: NodeJS.ProcessEnv
  readFile?: (file: string) => Promise<string>
  writeFile?: (file: string, data: string) => Promise<void>
  /** Milliseconds. A parameter, never `Date.now()` inside the pure decision. */
  now?: () => number
  maxReadBytes?: number
}

export const MAX_REGISTRY_READ_BYTES = 1024 * 1024

/** Read at most the ceiling plus one sentinel byte, even if the file grows after open. */
async function readBounded(file: string, limit: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Registry source must be a regular file')
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit) throw new Error(`Registry exceeds ${limit} byte read limit; use the bounded context API`)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
  } finally { await handle.close() }
}

const defaults = {
  readFile: (file: string) => fs.readFile(file, 'utf-8'),
  writeFile: (file: string, data: string) => writeFileAtomic(file, data),
  now: () => Date.now()
}

/** Read and classify the registry. Never throws: every failure is one of the four refusals. */
export async function readTaskRegistry(deps: RegistryReaderDeps = {}): Promise<RegistryRead> {
  const env = deps.env ?? process.env
  const limit = deps.maxReadBytes ?? MAX_REGISTRY_READ_BYTES
  const readFile = deps.readFile ?? ((file: string) => readBounded(file, limit))
  const now = deps.now ?? defaults.now

  const resolved = resolveRegistryPath(env)
  if (!resolved.path) {
    const answer = classifyRegistryPayload({ kind: 'unset' }, now())
    // A relative value is still "not configured" — there is no path to read — but the reason it is
    // not configured is worth saying, because the fix is different from setting it at all.
    return resolved.reason && answer.ok === false && answer.kind === 'no-registry-configured'
      ? { ...answer, message: resolved.reason }
      : answer
  }

  let source: RegistrySource
  try {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REGISTRY_READ_BYTES) throw new Error('Invalid registry read limit')
    const text = await readFile(resolved.path)
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`Registry exceeds ${limit} byte read limit`)
    source = { kind: 'text', path: resolved.path, text }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    const detail = e instanceof Error ? e.message : String(e)
    // ENOENT is the only code that PROVES absence. Everything else — EACCES, EISDIR, a dead mount,
    // an interrupted read — is a failed read, and a failed read is never evidence of absence.
    source =
      code === 'ENOENT'
        ? { kind: 'missing', path: resolved.path, detail }
        : { kind: 'unreadable', path: resolved.path, detail }
  }
  return classifyRegistryPayload(source, now())
}

/** `view-prefs.json` lives BESIDE the registry document, so one device's layout travels with the
 *  registry it describes rather than with whichever directory a shell happened to start in. */
export function viewPrefsPathFor(registryPath: string): string {
  return path.join(path.dirname(registryPath), VIEW_PREFS_FILENAME)
}

/**
 * Read the display-local preferences, falling back to the defaults for anything unreadable or
 * unrecognized. Preferences are a convenience: a missing or corrupt file is never an error the
 * caller has to handle, unlike a missing registry, which is a fact about the work.
 */
export async function readViewPrefs(
  registryPath: string,
  deps: RegistryReaderDeps = {}
): Promise<ViewPrefs> {
  const readFile = deps.readFile ?? defaults.readFile
  try {
    return normalizeViewPrefs(JSON.parse(await readFile(viewPrefsPathFor(registryPath))))
  } catch {
    return { ...DEFAULT_VIEW_PREFS }
  }
}

/**
 * Publish the display-local preferences atomically.
 *
 * Returns whether it landed rather than throwing: a layout preference that could not be saved must
 * not take down the view it describes, and the caller still needs to know it did not persist.
 */
export async function writeViewPrefs(
  registryPath: string,
  prefs: ViewPrefs,
  deps: RegistryReaderDeps = {}
): Promise<{ persisted: boolean; path: string; error: string | null }> {
  const writeFile = deps.writeFile ?? defaults.writeFile
  const file = viewPrefsPathFor(registryPath)
  try {
    await writeFile(file, `${JSON.stringify(normalizeViewPrefs(prefs), null, 2)}\n`)
    return { persisted: true, path: file, error: null }
  } catch (e) {
    return { persisted: false, path: file, error: e instanceof Error ? e.message : String(e) }
  }
}
