import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { ServerLifecycleReader } from './lifecycle'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-life-transcripts-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })
const sid = '00000000-1111-2222-3333-444444444444'
const at = 1_800_000_000_000
function write(file: string, provider: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ type: provider === 'codex' ? 'event_msg' : 'assistant',
    timestamp: new Date(at).toISOString(), payload: { type: 'task_complete' } }) + '\n')
}
async function read(entry: MirrorEntry) {
  const reader = new ServerLifecycleReader({ entry: () => entry, now: () => at + 100, userDataDir: path.join(home, 'data'),
    capture: async () => '', paneCommand: async () => 'node' })
  return reader.read('n', { paneState: 'alive', isAgent: true, provider: entry.agentId, sessionId: entry.sessionId })
}
const restored = (agentId: 'claude' | 'codex', transcriptPath?: string): MirrorEntry => ({
  agentId, sessionId: sid, state: 'done', updatedAt: at, restored: true, transcriptPath
})
describe('restored lifecycle transcript files', () => {
  it('recovers Claude assistant evidence with no live hook and without a persisted path', async () => {
    const file = path.join(home, '.claude', 'projects', '-test', `${sid}.jsonl`)
    write(file, 'claude')
    expect(await read(restored('claude'))).toMatchObject({ state: 'idle-warm', lastDoneAt: at, lastDoneClean: false })
  })
  it('finds the exact Codex rollout under dated directories for legacy mirrors', async () => {
    const file = path.join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-fixture-${sid}.jsonl`)
    write(file, 'codex')
    expect(await read(restored('codex'))).toMatchObject({ state: 'idle-warm', lastDoneAt: at, lastDoneClean: true })
  })
  it('does not read a persisted path outside its provider root', async () => {
    const file = path.join(home, 'outside', `${sid}.jsonl`)
    write(file, 'claude')
    expect((await read(restored('claude', file))).state).toBe('unknown')
  })
  it('does not reuse a different session or cross-provider transcript', async () => {
    const other = path.join(home, '.claude', 'projects', '-test', 'other.jsonl')
    write(other, 'claude')
    expect((await read(restored('claude', other))).state).toBe('unknown')
    const codex = path.join(home, '.codex', 'sessions', `${sid}.jsonl`)
    write(codex, 'claude')
    expect((await read(restored('claude', codex))).state).toBe('unknown')
  })
  it.skipIf(process.platform === 'win32')('refuses a symlink escaping the permitted transcript root', async () => {
    const outside = path.join(home, 'outside', `${sid}.jsonl`)
    const file = path.join(home, '.claude', 'projects', '-test', `${sid}.jsonl`)
    write(outside, 'claude')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.symlinkSync(outside, file)
    expect((await read(restored('claude', file))).state).toBe('unknown')
  })
  it('keeps a foreign Windows path unknown rather than treating it as a local transcript', async () => {
    const file = `C:\\Users\\fixture\\.claude\\projects\\fixture\\${sid}.jsonl`
    expect((await read(restored('claude', file))).state).toBe('unknown')
  })
  it('missing/unreadable transcripts remain unknown', async () => {
    expect((await read(restored('claude', path.join(home, '.claude', 'projects', '-missing', `${sid}.jsonl`)))).state).toBe('unknown')
  })
})
