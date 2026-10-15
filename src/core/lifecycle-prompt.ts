import type { BlockedKind } from './lifecycle'

export const LIFECYCLE_PROMPT_SIGNATURE_VERSION = 1
/** Title plus numbered choices avoids treating transcript prose or composer suggestions as a modal. */
export const LIFECYCLE_PROMPT_SIGNATURES: readonly { provider: string; kind: BlockedKind; title: RegExp }[] = [
  { provider: 'codex', kind: 'codex-hooks-review', title: /^\s*Hooks need review\s*$/im },
  { provider: 'codex', kind: 'codex-dir-trust', title: /^\s*Do you trust the contents of this directory[^\n]*$/im },
  { provider: 'claude', kind: 'claude-folder-trust', title: /^\s*(?:Do you trust the files in this folder[^\n]*|(?:Do you )?trust this folder\??)\s*$/im },
  { provider: 'claude', kind: 'claude-resume-menu', title: /^\s*[❯›>]?\s*1\. Resume from summary[^\n]*$/im }
]

export function detectLifecyclePrompt(provider: string | null, capture: string): { kind: BlockedKind; detail: string } | null {
  // Dim completion suggestions are not typed input or active prompts. Drop them before stripping ANSI.
  const text = capture.replace(/\x1b\[2m[\s\S]*?\x1b\[(?:0|22)m/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  if (!/^\s*[❯›>●]?\s*1[.)]\s+\S/m.test(text)) return null
  for (const signature of LIFECYCLE_PROMPT_SIGNATURES) {
    if (signature.provider !== provider) continue
    const hit = text.match(signature.title)
    if (hit) return { kind: signature.kind, detail: hit[0].trim().slice(0, 160) }
  }
  return null
}
