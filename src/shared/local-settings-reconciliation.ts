import { sanitizeProjectLocalSettings, type ProjectLocalSettings } from './project-settings'
import { sameProjectJson, type ProjectJson } from './project-reconciliation'

export interface LocalSettingsBase { clientId: string; indexRevision: string }
export interface LocalSettingsView extends LocalSettingsBase { projectId: string; local: ProjectLocalSettings | undefined }
export interface LocalSettingsChange { family: string; key: string; envKey?: string; value?: unknown; remove?: true }
export interface LocalSettingsRequest extends LocalSettingsBase { projectId: string; operationId: string; changes: LocalSettingsChange[] }
export interface LocalSettingsOutcome {
  kind: 'committed' | 'already-applied' | 'conflict' | 'stale-base' | 'busy' | 'publication-refused' | 'publication-unknown' | 'unavailable'
  operationId: string
  recovery?: string
  message?: string
  receiptRevision?: string
  /** A fresh enrolled read, NOT the historical receipt's local projection. */
  current?: LocalSettingsView
}
const fields: Record<string, readonly string[]> = {
  setup: ['setupScript', 'archiveScript', 'waitForSetup'], worktree: ['basePath', 'baseRef', 'sharedPaths'],
  agents: ['defaultAgentId', 'launchCmd', 'env'], terminal: ['shell', 'theme', 'fontFamily'],
  ignoreShared: ['setup', 'worktree', 'agents', 'terminal']
}
const same = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : sameProjectJson(a as ProjectJson, b as ProjectJson)
export function validateLocalSettingsChanges(value: unknown): asserts value is LocalSettingsChange[] {
  if (!Array.isArray(value) || value.length > 144) throw new Error('Invalid bounded local-settings delta')
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || !Object.hasOwn(fields, item.family) || !fields[item.family].includes(item.key) ||
        Object.keys(item).some((key) => !['family', 'key', 'envKey', 'value', 'remove'].includes(key)) ||
        seen.has(`${item.family}.${item.key}.${item.envKey ?? ''}`)) throw new Error('Invalid or duplicate local-settings leaf')
    const env = item.family === 'agents' && item.key === 'env'
    if (env ? typeof item.envKey !== 'string' || item.envKey.length > 1024 || item.envKey === '__proto__' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.envKey) : Object.hasOwn(item, 'envKey'))
      throw new Error('Environment changes require an exact permitted entry key')
    seen.add(`${item.family}.${item.key}.${item.envKey ?? ''}`)
    if (item.remove === true && !Object.hasOwn(item, 'value')) continue
    if (Object.hasOwn(item, 'remove') || !Object.hasOwn(item, 'value') || item.value === undefined)
      throw new Error('A removal must be explicit')
    const raw = { [item.family]: { [item.key]: env ? { [item.envKey]: item.value } : item.value } }
    if (!same(sanitizeProjectLocalSettings(raw), raw)) throw new Error('Malformed local-settings value; not a clear operation')
  }
}

/** Legacy undefined means known-leaf removals only; unseen future extensions never travel. */
export function localSettingsDelta(before: ProjectLocalSettings | undefined, next: ProjectLocalSettings | undefined): LocalSettingsChange[] {
  if (next !== undefined && !same(sanitizeProjectLocalSettings(next), next)) throw new Error('Malformed local settings')
  const out: LocalSettingsChange[] = []
  for (const [family, keys] of Object.entries(fields)) for (const key of keys) {
    const a = (before as Record<string, Record<string, unknown>> | undefined)?.[family]?.[key]
    const b = (next as Record<string, Record<string, unknown>> | undefined)?.[family]?.[key]
    if (family === 'agents' && key === 'env') {
      const left = (a ?? {}) as Record<string, string>, right = (b ?? {}) as Record<string, string>
      for (const envKey of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const old = Object.hasOwn(left, envKey) ? left[envKey] : undefined, value = Object.hasOwn(right, envKey) ? right[envKey] : undefined
        if (old !== value) out.push(value === undefined ? { family, key, envKey, remove: true } : { family, key, envKey, value })
      }
      continue
    }
    if (!same(a, b)) out.push(b === undefined ? { family, key, remove: true } : { family, key, value: b })
  }
  validateLocalSettingsChanges(out)
  return out
}
