import { describe, it, expect } from 'vitest'
import {
  LIST_FIELD_OPENED_BY,
  LIST_FIELD_TASK,
  listRowHelpLines,
  renderCanvasList,
  renderCanvasListRow
} from './canvas-list-row'

describe('renderCanvasListRow', () => {
  it('a node with no extras renders byte-identically to the pre-change row', () => {
    // The whole "shorter or equal in the common case" claim rests on this one: a canvas of
    // hand-opened nodes costs a reader exactly what it always did.
    expect(renderCanvasListRow({ id: 'term-1', kind: 'terminal', title: 'build' })).toBe(
      'term-1 [terminal] build'
    )
  })

  it('appends opened-by only when the opener is known', () => {
    expect(
      renderCanvasListRow({ id: 'term-2', kind: 'terminal', title: 'worker', openedBy: 'term-1' })
    ).toBe(`term-2 [terminal] worker ${LIST_FIELD_OPENED_BY}=term-1`)
  })

  it('appends task only when a registry named one, and never invents it', () => {
    expect(renderCanvasListRow({ id: 'n', kind: 'terminal', title: 't', taskId: 'T-9' })).toBe(
      `n [terminal] t ${LIST_FIELD_TASK}=T-9`
    )
    // No task source configured is the default, and the default is silence.
    expect(renderCanvasListRow({ id: 'n', kind: 'terminal', title: 't' })).not.toContain(
      LIST_FIELD_TASK
    )
  })

  it('treats an empty or whitespace value as absent', () => {
    // These reach the row from a git-shared, hand-editable canvas; `opened-by=` with nothing after
    // it is worse than no field, because it reads as a fact.
    expect(
      renderCanvasListRow({ id: 'n', kind: 'terminal', title: 't', openedBy: '  ', taskId: '' })
    ).toBe('n [terminal] t')
  })

  it('keeps the LAST TURN ERRORED marker at the end, after the optional fields', () => {
    // Existing readers were told the marker ENDS the row (#521). New fields must not get between.
    const row = renderCanvasListRow({
      id: 'n',
      kind: 'terminal',
      title: 't',
      openedBy: 'p',
      taskId: 'T-1',
      lastTurnErrored: true
    })
    expect(row.endsWith('LAST TURN ERRORED')).toBe(true)
    expect(row).toBe(`n [terminal] t ${LIST_FIELD_OPENED_BY}=p ${LIST_FIELD_TASK}=T-1 — LAST TURN ERRORED`)
  })

  it('survives a missing kind or title without emitting a trailing space', () => {
    expect(renderCanvasListRow({ id: 'n', kind: undefined, title: undefined })).toBe('n [node]')
    expect(renderCanvasListRow({ id: 'n', kind: 'sticky', title: undefined, openedBy: 'p' })).toBe(
      `n [sticky] ${LIST_FIELD_OPENED_BY}=p`
    )
  })

  it('renderCanvasList joins rows with newlines and is empty for an empty canvas', () => {
    expect(renderCanvasList([])).toBe('')
    expect(
      renderCanvasList([
        { id: 'a', kind: 'terminal', title: 'one' },
        { id: 'b', kind: 'sticky', title: 'two', openedBy: 'a' }
      ])
    ).toBe(`a [terminal] one\nb [sticky] two ${LIST_FIELD_OPENED_BY}=a`)
  })

  it('the help lines name both fields and say they are omitted rather than guessed', () => {
    const text = listRowHelpLines().join('\n')
    expect(text).toContain(`${LIST_FIELD_OPENED_BY}=`)
    expect(text).toContain(`${LIST_FIELD_TASK}=`)
    expect(text.toLowerCase()).toContain('omitted')
  })
})
