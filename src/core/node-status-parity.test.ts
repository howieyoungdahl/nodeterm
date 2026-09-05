// Source-level parity: BOTH shells must register the pane-evidence channel, and the renderer must
// have a REAL implementation of it on every surface that has a bridge.
//
// Nothing else in the suite can tell you this channel is missing. A shell that stopped calling
// `registerNodeStatusIpc` still boots, still serves every other channel, and still paints badges —
// it simply can never say `failed`, and every stale `working` reads as healthy forever. This repo
// has shipped a hook/mirror change to exactly one shell three times (CONTRIBUTING, "Both raw
// listeners change together"), which is why the guard is a cheap grep rather than a hope.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

describe('pane-evidence channel parity', () => {
  it('the DESKTOP shell registers it, wired to its PtyManager', () => {
    const src = read('src/main/index.ts')
    expect(src).toContain("import { registerNodeStatusIpc } from '../core/node-status-service'")
    expect(src).toMatch(
      /registerNodeStatusIpc\(\{\s*panePresence:\s*\(nodeId\)\s*=>\s*ptyManager\.sessionPresence\(nodeId\)\s*\}\)/
    )
  })

  it('the SERVER EDITION shell registers it, wired to its PtyManager', () => {
    const src = read('src/server/index.ts')
    expect(src).toContain("import { registerNodeStatusIpc } from '../core/node-status-service'")
    expect(src).toMatch(
      /registerNodeStatusIpc\(\{\s*panePresence:\s*\(nodeId\)\s*=>\s*ptyManager\.sessionPresence\(nodeId\)\s*\}\)/
    )
  })

  it('the preload exposes it on the desktop api', () => {
    expect(read('src/preload/index.ts')).toMatch(
      /nodePaneEvidence:\s*\(nodeIds: string\[\]\)\s*=>\s*ipcRenderer\.invoke\(IPC\.nodeStatusPanes, nodeIds\)/
    )
  })

  it('the ws bridge implements it for real — a stub here would be a badge that never updates', () => {
    const src = read('src/renderer/bridge/ws-bridge.ts')
    expect(src).toMatch(/nodePaneEvidence:\s*\(nodeIds\)\s*=>\s*\n?\s*client\.request\(IPC\.nodeStatusPanes, nodeIds\)/)
    // …and it is declared as REAL in the stub api's exclusion list, not stubbed.
    expect(read('src/renderer/bridge/stubs.ts')).toContain("| 'nodePaneEvidence'")
  })

  it('the probe answer reaches the badge — Canvas runs the failure probe', () => {
    const src = read('src/renderer/canvas/Canvas.tsx')
    expect(src).toContain("import { runFailureProbe } from '../lib/failureProbe'")
    expect(src).toContain('api.nodePaneEvidence')
    expect(src).toMatch(/setPaneEvidence:\s*cs\.setPaneEvidence/)
    expect(src).toMatch(/markFailed:\s*cs\.markFailed/)
  })
})
