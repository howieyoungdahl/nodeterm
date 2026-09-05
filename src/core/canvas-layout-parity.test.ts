// Source-level parity for the layout engine, in the spirit of `node-status-parity.test.ts` — and
// for the same recorded reason: this repo has shipped a one-shell change three times, and nothing
// else in a 6,000-test suite can tell you a shell stopped registering a channel.
//
// A shell that dropped `registerCanvasLayoutIpc` boots fine, serves every other channel, passes
// every unit test in `src/core/canvas-layout/` (they are pure and do not go through it), and
// simply never organises anything — with no error anywhere. So the call is one greppable line per
// shell, and this asserts both of them plus the renderer's real implementations.
//
// The `enabled` half is pinned here too. It is the difference between a feature that is off by
// default and one that starts rearranging canvases on upgrade, and it is one word in one object
// literal per shell.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

/** Source with comments stripped. The scans below are about what the CODE does; a file that
 *  explains in prose which calls it deliberately avoids must not fail its own guard. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

describe('canvas-layout channel parity', () => {
  it('the DESKTOP shell registers it, reading the machine-local switch', () => {
    const src = read('src/main/index.ts')
    expect(src).toContain("import { registerCanvasLayoutIpc } from '../core/canvas-layout'")
    expect(src).toMatch(
      /registerCanvasLayoutIpc\(\{\s*settings:\s*\(\)\s*=>\s*settingsStore\.get\(\)\.canvasLayout\s*\}\)/
    )
  })

  it('the SERVER EDITION shell registers it, reading the same switch', () => {
    const src = read('src/server/index.ts')
    expect(src).toContain("import { registerCanvasLayoutIpc } from '../core/canvas-layout'")
    expect(src).toMatch(
      /registerCanvasLayoutIpc\(\{\s*settings:\s*\(\)\s*=>\s*settingsStore\.get\(\)\.canvasLayout\s*\}\)/
    )
  })

  it('the preload exposes it on the desktop api', () => {
    const src = read('src/preload/index.ts')
    expect(src).toMatch(/plan:\s*\(request: unknown\)\s*=>\s*ipcRenderer\.invoke\(IPC\.canvasLayoutPlan, request\)/)
    expect(src).toContain('IPC.canvasLayoutRelease')
  })

  it('the ws bridge implements it for real — a stub is a feature that silently never plans', () => {
    const src = read('src/renderer/bridge/ws-bridge.ts')
    expect(src).toMatch(/plan:\s*\(request\)\s*=>\s*client\.request\(IPC\.canvasLayoutPlan, request\)/)
    expect(src).toContain('IPC.canvasLayoutRelease')
    // …and it is declared REAL in the stub api's exclusion list, not stubbed.
    expect(read('src/renderer/bridge/stubs.ts')).toContain("| 'canvasLayout'")
  })

  it('the engine is OFF by default, in the shipped settings', () => {
    expect(read('src/shared/types.ts')).toContain('canvasLayout: { enabled: false }')
  })

  it('the switch is machine-local: the shared project block never carries `enabled`', () => {
    const rules = read('src/shared/canvas-layout-rules.ts')
    // The interface for the SHARED block has no `enabled` field. A repo must not be able to switch
    // on automatic rearrangement for everyone who clones it.
    const shared = rules.slice(
      rules.indexOf('export interface CanvasLayoutRules {'),
      rules.indexOf('/** `Settings.canvasLayout`')
    )
    expect(shared).not.toContain('enabled')
    expect(rules).toMatch(/export interface CanvasLayoutSettings \{[^}]*enabled\?: boolean/s)
  })

  it('the shared rule block is sanitized on BOTH boundaries, and on the inline load path', () => {
    const files = read('src/core/workspace-files.ts')
    // Read (fileToProject) and write (projectToFile).
    expect(files).toContain('sanitizeCanvasLayoutRules(f.layoutRules)')
    expect(files).toContain('sanitizeCanvasLayoutRules(p.layoutRules)')
    // …and the cwd-less inline branch, which deliberately skips fileToProject.
    expect(read('src/core/workspace-store.ts')).toContain(
      'sanitizeCanvasLayoutRules(base.layoutRules)'
    )
  })

  it('NOTHING in the engine runs on a timer — the operator ruled that cost out', () => {
    for (const rel of [
      'src/core/canvas-layout/plan.ts',
      'src/core/canvas-layout/service.ts',
      'src/core/canvas-layout/lease.ts',
      'src/core/canvas-layout/refusals.ts',
      'src/shared/canvas-layout.ts',
      'src/shared/canvas-layout-rules.ts'
    ]) {
      expect(code(rel)).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
    }
  })

  it('the layout path never reaches a PTY — presentation is not authority', () => {
    for (const rel of [
      'src/core/canvas-layout/plan.ts',
      'src/core/canvas-layout/service.ts',
      'src/renderer/lib/layoutPlanApply.ts'
    ]) {
      // No transport verb, no session lifecycle, no input submission — the ops are canvas state.
      expect(code(rel)).not.toMatch(/\btransport\.|sendText|ptyManager|killSession|\bdestroy\(/)
    }
  })
})
