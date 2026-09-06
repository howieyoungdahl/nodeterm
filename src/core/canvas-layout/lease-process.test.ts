import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { expect, it, onTestFinished } from 'vitest'
import { LayoutLeaseStore } from './lease'

it('refuses a second process while a first process is publishing, then names the persisted holder', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-layout-race-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = path.join(dir, 'lease.cjs')
  buildSync({ entryPoints: [path.resolve('src/core/canvas-layout/lease.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' })
  const filePath = path.join(dir, 'leases.json')
  const launch = (holder: string, delayed: boolean): ChildProcess => {
    const child = spawn(process.execPath, ['-e', `
      const { LayoutLeaseStore } = require(process.argv[1]);
      const { writeFileSync } = require('node:fs');
      const { once } = require('node:events');
      const filePath = process.argv[2];
      const delayed = process.argv[4] === 'yes';
      const store = new LayoutLeaseStore({ filePath, now: () => 1000,
        ...(delayed ? { write: async (text) => {
          process.send({ held: true });
          await once(process, 'message');
          writeFileSync(filePath, text, { mode: 0o600 });
        }} : {}) });
      store.acquire('p1', process.argv[3]).then(result => {
        process.send(result); process.disconnect();
      });
    `, bundle, filePath, holder, delayed ? 'yes' : 'no'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    onTestFinished(() => { if (child.exitCode === null) child.kill() })
    return child
  }
  const a = launch('ui-a', true)
  expect((await once(a, 'message'))[0]).toEqual({ held: true })
  const b = launch('ui-b', false)
  expect((await once(b, 'message'))[0]).toEqual({ ok: false, reason: 'source-unavailable' })
  const published = once(a, 'message')
  a.send('publish')
  const grant = (await published)[0]
  expect(grant).toMatchObject({ ok: true, lease: { holder: 'ui-a', token: expect.any(String) } })
  expect(JSON.parse(readFileSync(filePath, 'utf8')).leases.p1.token).toBe(grant.lease.token)
  if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o600)
  const c = launch('ui-b', false)
  expect((await once(c, 'message'))[0]).toEqual({ ok: false, reason: 'lease-held', holder: 'ui-a' })
}, 10_000)

it('does not steal a leftover lock or change its project file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-layout-lock-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'leases.json')
  writeFileSync(filePath, '{"leases":{}}')
  writeFileSync(`${filePath}.lock`, 'unresolved writer')
  const store = new LayoutLeaseStore({ filePath })
  expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'source-unavailable' })
  expect(readFileSync(`${filePath}.lock`, 'utf8')).toBe('unresolved writer')
  expect(readFileSync(filePath, 'utf8')).toBe('{"leases":{}}')
})
