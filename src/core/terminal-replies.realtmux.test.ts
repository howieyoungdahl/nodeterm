import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type PtyCreateResult } from '../shared/types'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { makeTmuxTmpdir } from './tmux-test-socket'
import { PtyManager } from './pty-manager'

const socket = `nt-replies-${process.pid}`
vi.mock('./tmux-naming', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tmux-naming')>(),
  TMUX_SOCKET: `nt-replies-${process.pid}`
}))

it.skipIf(process.platform === 'win32' || spawnSync('tmux', ['-V']).status !== 0)(
  'keeps replies from two subscribers out of the pane while delivering typed input',
  async () => {
    const tmp = makeTmuxTmpdir('ntr-', socket)
    const shell = path.join(tmp, 'logger')
    fs.writeFileSync(shell, '#!/bin/sh\nstty raw -echo\nprintf "LOGGER_READY\\n"\nexec cat > "$0.stdin"\n', { mode: 0o700 })
    const paneInput = `${shell}.stdin`
    vi.stubEnv('TMUX_TMPDIR', tmp)
    const platform = fakePlatform({ userDataDir: tmp })
    initPlatform(platform)
    const manager = new PtyManager()
    try {
      manager.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true }))
      manager.registerIpc()
      const create = platform.handlers[IPC.ptyCreate]
      const write = platform.senderListeners[IPC.ptyWrite]
      const options = { cols: 80, rows: 24, persistKey: 'reply-test', shell, cwd: tmp }
      const { sessionId } = await create(1, options) as PtyCreateResult
      expect(await create(2, options)).toMatchObject({ sessionId })

      for (const clientId of [1, 2]) {
        await vi.waitFor(() => {
          const output = platform.sent
            .filter(({ to, channel }) => to === clientId && channel === IPC.ptyData(sessionId))
            .map(({ args }) => args[0])
            .join('')
          expect(output).toContain('\x1b[c')
          expect(output).toContain('\x1b[>c')
          expect(output).toContain('LOGGER_READY')
        })
        write(clientId, sessionId, '\x1b[?1;2c')
        write(clientId, sessionId, '\x1b[>0;276;0c')
      }
      write(1, sessionId, 'hello')
      await vi.waitFor(() => expect(fs.readFileSync(paneInput, 'utf8')).toContain('hello'))
      expect(fs.readFileSync(paneInput, 'utf8')).toBe('hello')
    } finally {
      await manager.killAll()
      spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
      vi.unstubAllEnvs()
      resetPlatformForTests()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
)
