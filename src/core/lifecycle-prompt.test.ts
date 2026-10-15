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
  it.each(['38;2;120;180;240', '38;5;2', '48;2;2;10;20', '58;5;2'])('preserves extended color %s as visible text', sgr => {
    expect(detectLifecyclePrompt('codex', `\x1b[${sgr}mHooks need review\x1b[0m\n1. Trust these hooks`)?.kind).toBe('codex-hooks-review')
  })
  it.each(['0', '22', ''])('ends real dim text at SGR %s', reset => {
    expect(detectLifecyclePrompt('codex', `\x1b[2mSuggestion\x1b[${reset}mHooks need review\n1. Trust these hooks`)?.kind).toBe('codex-hooks-review')
    expect(detectLifecyclePrompt('codex', `\x1b[38;2;100;200;50;2mHooks need review\n1. Trust these hooks\x1b[${reset}m`)).toBeNull()
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
