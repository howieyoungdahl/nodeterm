// @vitest-environment jsdom
//
// The badge has a real data source: the live agent-status table, per node id. A component that
// renders a plausible badge from props nobody wires is the same bug in a nicer place.
//
// jsdom rather than `renderToStaticMarkup`: zustand's server snapshot is the store's INITIAL state,
// so an SSR render would report UNKNOWN for every node however the table is set up — which would
// have made this test pass for the wrong reason if it asserted the other way round.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { _resetStatusClockForTest } from '../lib/statusClock'
import { NodeStatusBadge } from './NodeStatusBadge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(el: React.ReactElement): string {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host.innerHTML
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  useAgentStatus.setState({ byId: {} })
  _resetStatusClockForTest()
})

describe('NodeStatusBadge', () => {
  it('renders the live state of the node it is given', () => {
    act(() =>
      useAgentStatus.getState().setState('n1', 'blocked', 'claude', false, undefined, true, {
        reason: 'Allow Bash(git push)?'
      })
    )
    const html = render(<NodeStatusBadge nodeId="n1" agentId="claude" />)
    expect(html).toContain('BLOCKED')
    expect(html).toContain('Allow Bash(git push)?')
  })

  it('says UNKNOWN for a node the table has never heard of, rather than rendering nothing', () => {
    expect(render(<NodeStatusBadge nodeId="never-seen" />)).toContain('UNKNOWN')
  })

  it('renders FAILED off a latched failure', () => {
    act(() => {
      const s = useAgentStatus.getState()
      s.setState('n2', 'working', 'claude', true)
      s.markFailed('n2', Date.now() - 60_000)
    })
    expect(render(<NodeStatusBadge nodeId="n2" />)).toContain('FAILED')
  })

  it('drops the inline reason in compact mode (a kanban card row), keeping the state', () => {
    act(() =>
      useAgentStatus.getState().setState('n3', 'waiting', 'claude', false, undefined, true, {
        reason: 'Which branch should I use?'
      })
    )
    const html = render(<NodeStatusBadge nodeId="n3" compact />)
    expect(html).toContain('WAITING')
    expect(html).not.toContain('nt-status__reason')
  })
})
