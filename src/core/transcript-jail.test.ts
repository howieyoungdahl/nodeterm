import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeLocalTranscriptPathFollowingLinks } from './transcript-jail'

// Real symlinks on a real filesystem: the bug was a profile whose `projects` dir is a link into
// `~/.claude/projects`, refused by a text-only jail, so no fake can stand in for the link.
describe('safeLocalTranscriptPathFollowingLinks', () => {
  let home: string
  let userData: string
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jail-home-')))
    userData = path.join(home, 'userdata')
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-repo'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude-3'))
    fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude-3', 'projects'))
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'secret')
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const read = (p: string) => safeLocalTranscriptPathFollowingLinks(p, home, userData)
  const ok = (p: string) => read(p) !== undefined

  it('admits a profile transcript whose projects dir links into ~/.claude/projects', () => {
    const tp = path.join(home, '.claude-3', 'projects', '-repo', 's.jsonl')
    fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 's.jsonl'), '')
    // The RESOLVED path, so the tails read what was checked.
    expect(read(tp)).toBe(path.join(home, '.claude', 'projects', '-repo', 's.jsonl'))
  })

  it('reads what was checked even if the link is repointed afterwards', () => {
    const link = path.join(home, 'attacker-link')
    fs.symlinkSync(path.join(home, '.claude', 'projects'), link)
    const admitted = read(path.join(link, 'id_rsa'))
    fs.unlinkSync(link)
    fs.symlinkSync(path.join(home, '.ssh'), link)
    expect(admitted).toBe(path.join(home, '.claude', 'projects', 'id_rsa'))
  })

  it('admits it before the transcript file exists (SessionStart)', () => {
    expect(ok(path.join(home, '.claude-3', 'projects', '-repo', 'new.jsonl'))).toBe(true)
    expect(ok(path.join(home, '.claude-3', 'projects', '-new-repo', 'new.jsonl'))).toBe(true)
  })

  it('still refuses a profile path that is not a link into an allowed root', () => {
    fs.mkdirSync(path.join(home, '.claude-4', 'projects'), { recursive: true })
    expect(ok(path.join(home, '.claude-4', 'projects', 'x.jsonl'))).toBe(false)
  })

  it('refuses a link that points outside the allowed roots', () => {
    fs.symlinkSync(path.join(home, '.ssh'), path.join(home, '.claude-5'))
    expect(ok(path.join(home, '.claude-5', 'id_rsa'))).toBe(false)
    expect(ok(path.join(home, '.ssh', 'id_rsa'))).toBe(false)
  })
})
