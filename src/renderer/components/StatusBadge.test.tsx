import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { deriveNodeStatus, rollUpNodeStatus, NODE_STATUS_STALE_MS } from '@shared/node-status'
import { GroupStatusBadge, StatusBadge } from './StatusBadge'

const NOW = 1_800_000_000_000

describe('StatusBadge', () => {
  it('renders the word, not only a colour', () => {
    const html = renderToStaticMarkup(
      <StatusBadge view={deriveNodeStatus({ state: 'blocked', updatedAt: NOW, now: NOW })} />
    )
    expect(html).toContain('BLOCKED')
    expect(html).toContain('!')
  })

  it('renders `unknown` as a visible word for a node with no status event', () => {
    const html = renderToStaticMarkup(<StatusBadge view={deriveNodeStatus({ now: NOW })} />)
    expect(html).toContain('UNKNOWN')
  })

  it('renders the freshness age', () => {
    const html = renderToStaticMarkup(
      <StatusBadge view={deriveNodeStatus({ state: 'working', updatedAt: NOW - 300_000, now: NOW })} />
    )
    expect(html).toContain('5m')
  })

  it('says stale in a word, not only in a colour', () => {
    const html = renderToStaticMarkup(
      <StatusBadge
        view={deriveNodeStatus({
          state: 'waiting',
          updatedAt: NOW - (NODE_STATUS_STALE_MS + 1000),
          now: NOW
        })}
      />
    )
    expect(html).toContain('stale')
  })

  it('carries the hook event reason so the terminal need not be opened', () => {
    const html = renderToStaticMarkup(
      <StatusBadge
        view={deriveNodeStatus({
          state: 'blocked',
          updatedAt: NOW,
          now: NOW,
          reason: 'Allow Bash(git push)?'
        })}
      />
    )
    expect(html).toContain('Allow Bash(git push)?')
  })

  it('shows the state alone when the event carried no reason', () => {
    const html = renderToStaticMarkup(
      <StatusBadge view={deriveNodeStatus({ state: 'waiting', updatedAt: NOW, now: NOW })} />
    )
    expect(html).toContain('WAITING')
    expect(html).not.toContain('nt-status__reason')
  })
})

describe('GroupStatusBadge', () => {
  it('shows the worst member state and how many members are in it', () => {
    const rollUp = rollUpNodeStatus([
      { id: 'a', kind: 'working' },
      { id: 'b', kind: 'failed' },
      { id: 'c', kind: 'failed' }
    ])!
    const html = renderToStaticMarkup(<GroupStatusBadge rollUp={rollUp} />)
    expect(html).toContain('FAILED')
    expect(html).toContain('2/3')
  })
})
