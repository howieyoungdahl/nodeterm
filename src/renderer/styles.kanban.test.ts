import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const VIEW = readFileSync(join(__dirname, 'components/kanban/KanbanView.tsx'), 'utf8')

describe('Kanban column row layout', () => {
  it('stretches empty columns to the height of the tallest column without filling the viewport', () => {
    expect(VIEW).toContain('className="kanban-board__columns"')
    expect(CSS).toMatch(
      /\.kanban-board__columns\s*{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;[^}]*height:\s*fit-content;/s
    )
  })
})

describe('Kanban card modal terminal scrollbar', () => {
  it('hides the emulator scrollbar in the card modal, as the canvas node does', () => {
    // tmux paints the alternate screen, so the emulator holds no scrollback: its bar was a dead
    // control down the modal's right edge. The wheel (tmux copy-mode, or the full-screen app)
    // is the scroll control in both views.
    expect(CSS).toMatch(/\.kanban-modal__term \.xterm-viewport\s*{[^}]*scrollbar-width:\s*none;/s)
    expect(CSS).toMatch(
      /\.kanban-modal__term \.xterm-viewport::-webkit-scrollbar\s*{[^}]*width:\s*0;/s
    )
  })
})
