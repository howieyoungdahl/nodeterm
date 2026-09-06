import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readTaskRegistry } from './registry-reader'
import fixture from '../../shared/remote-nav/producer-eight.json'
import { buildNavigator } from '../../shared/remote-nav/model'
import type { TaskRegistry } from '../../shared/remote-nav/fixture'

let directory: string
let file: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-producer-'))
  file = path.join(directory, 'registry.json')
})
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
const read = (maxReadBytes?: number) => readTaskRegistry({ env: { NODETERM_TASK_REGISTRY: file },
  now: () => fixture.generated_at_epoch * 1000, maxReadBytes })

describe('producer file and CLI consumers', () => {
  it.skipIf(process.platform === 'win32')('the generated hint passes read-only and exact-target flags through a real shell', async () => {
    // Only this test-owned stub is on PATH. The test never reaches a tmux server.
    const stub = path.join(directory, 'tmux')
    await fs.writeFile(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    const nav = buildNavigator({ registry: fixture as unknown as TaskRegistry, nowMs: fixture.generated_at_epoch * 1000 })
    const result = spawnSync('/bin/sh', ['-c', nav.tasks[0].open.command!], { encoding: 'utf8',
      env: { PATH: directory }, timeout: 5000 })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['-L', 'node-terminal', 'attach', '-r', '-t', '=nt-term-owner-0'])
  })

  it('reads the producer document through the actual filesystem without rewriting it', async () => {
    const text = JSON.stringify(fixture)
    await fs.writeFile(file, text)
    const result = await read()
    expect(result).toMatchObject({ ok: true, registry: { source: { generation: 433 }, tasks: fixture.tasks } })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('refuses oversize, invalid UTF-8, and non-file sources', async () => {
    await fs.writeFile(file, '界'.repeat(100))
    expect(await read(250)).toMatchObject({ ok: false, kind: 'registry-unreadable' })
    await fs.writeFile(file, Buffer.from([0xff, 0xfe]))
    expect(await read()).toMatchObject({ ok: false, kind: 'registry-unreadable' })
    expect(await readTaskRegistry({ env: { NODETERM_TASK_REGISTRY: directory } })).toMatchObject({ ok: false, kind: 'registry-unreadable' })
  })

  it('counts byte ceilings and refuses invalid limits before injected reads', async () => {
    let calls = 0
    const result = await readTaskRegistry({ env: { NODETERM_TASK_REGISTRY: file }, maxReadBytes: -1,
      readFile: async () => { calls++; return '{}' } })
    expect(result.ok).toBe(false)
    expect(calls).toBe(0)
  })

  it('CLI exposes task bindings and generation but never opens a session', async () => {
    await fs.writeFile(file, JSON.stringify(fixture))
    const result = spawnSync(process.execPath, ['scripts/remote-nav.mjs', '--registry', file, '--task', 'task-1', '--json'],
      { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ source_generation: 433,
      task: { owner: { node: 'term-owner-1', session: 'session-1', account: '2' }, open: { typingAllowed: false, command: null } } })
  })
})
