import { describe, expect, it } from 'vitest'
import { submittedPromptForHash } from './submitted-prompt'

describe('submittedPromptForHash', () => {
  it('unwraps only the exact full Claude native paste scaffold and preserves the body', () => {
    const body = 'first line\r\nsecond line\n--- NODETERM MESSAGE abc ---'
    expect(submittedPromptForHash('claude', `\n\n<pasted_content id="bc79">\n${body}\n</pasted_content id="bc79">\n`)).toBe(body)
  })

  it.each([
    ['prefix text', 'prefix\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\n'],
    ['suffix text', '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\nextra'],
    ['extra LF suffix', '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\n\n'],
    ['extra CR suffix', '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\n\r'],
    ['mismatched ids', '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc80">\n'],
    ['partial opener', '\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\n'],
    ['partial closer', '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">'],
    ['nested structure', '\n\n<pasted_content id="bc79">\n<pasted_content id="inner">\nbody\n</pasted_content id="inner">\n</pasted_content id="bc79">\n'],
    ['invalid id', '\n\n<pasted_content id="bad id">\nbody\n</pasted_content id="bad id">\n'],
    ['oversized id', `\n\n<pasted_content id="${'a'.repeat(65)}">\nbody\n</pasted_content id="${'a'.repeat(65)}">\n`]
  ])('leaves %s untouched', (_name, prompt) => {
    expect(submittedPromptForHash('claude', prompt)).toBe(prompt)
  })

  it('leaves plain Claude prompts and all Codex prompts unchanged', () => {
    const prompt = '\n\n<pasted_content id="bc79">\nbody\n</pasted_content id="bc79">\n'
    expect(submittedPromptForHash('claude', 'plain')).toBe('plain')
    expect(submittedPromptForHash('codex', prompt)).toBe(prompt)
  })
})
