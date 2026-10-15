import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectLifecyclePrompt, LIFECYCLE_PROMPT_SIGNATURE_VERSION } from './lifecycle-prompt'
import prompts from './__fixtures__/lifecycle/prompts.json'

describe('lifecycle prompt signatures', () => {
  it.each(Object.entries(prompts))('matches %s', (kind, capture) => {
    expect(detectLifecyclePrompt(kind.startsWith('codex') ? 'codex' : 'claude', capture)?.kind).toBe(kind)
    expect(detectLifecyclePrompt(kind.startsWith('codex') ? 'claude' : 'codex', capture)).toBeNull()
  })
  it('accepts Claude alternate folder trust heading', () => {
    expect(detectLifecyclePrompt('claude', 'Trust this folder?\n❯ 1. Yes\n  2. No')?.kind).toBe('claude-folder-trust')
  })
  it.each([
    'Done.\n❯ Write tests for @filename',
    'Which implementation?\n❯ 1. Use defaults\n  2. Customize',
    'The error says Hooks need review.\n1. First fix\n2. Another fix',
    '❯ Hooks need review\n  1. Trust these hooks',
    '\x1b[2mHooks need review\n1. Trust these hooks\x1b[0m',
    '❯ \x1b[0;2mExplain this prompt:\nHooks need review\n1. Trust these hooks\x1b[22m',
    ''
  ])('does not match normal input or quoted prose: %s', capture => {
    expect(detectLifecyclePrompt('claude', capture)).toBeNull()
    expect(detectLifecyclePrompt('codex', capture)).toBeNull()
  })
  it('does not match a captured Claude dim composer suggestion', () => {
    const capture = fs.readFileSync(path.join(__dirname, '__fixtures__/lifecycle/claude-dim-suggestion.ansi'), 'utf8')
    expect(detectLifecyclePrompt('claude', capture.replace(/\\u001b/g, '\x1b'))).toBeNull()
  })
  it('versions the signature contract', () => expect(LIFECYCLE_PROMPT_SIGNATURE_VERSION).toBe(1))
})
