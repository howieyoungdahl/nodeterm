import type { BlockedKind } from './lifecycle'

export const LIFECYCLE_PROMPT_SIGNATURE_VERSION = 1
/** Extended-color components can equal 2 without enabling dim (38;2;r;g;b, 38;5;2). */
function visiblePromptText(capture: string): string {
  let dim = false
  let end = 0
  let text = ''
  for (const match of capture.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    if (!dim) text += capture.slice(end, match.index)
    const params = match[1].split(';')
    for (let i = 0; i < params.length; i++) {
      // Colon-separated SGR color subparameters are one parameter, never dim toggles.
      if (params[i].includes(':')) continue
      const code = Number(params[i])
      if (code === 38 || code === 48 || code === 58) {
        const mode = params[++i]
        if (mode === '2') i += 3
        else if (mode === '5') i += 1
      } else if (code === 0 || code === 22) dim = false
      else if (code === 2) dim = true
    }
    end = match.index + match[0].length
  }
  if (!dim) text += capture.slice(end)
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}
/** Title plus numbered choices avoids treating transcript prose or composer suggestions as a modal. */
export const LIFECYCLE_PROMPT_SIGNATURES: readonly { provider: string; kind: BlockedKind; title: RegExp }[] = [
  { provider: 'codex', kind: 'codex-hooks-review', title: /^\s*Hooks need review\s*$/im },
  { provider: 'codex', kind: 'codex-dir-trust', title: /^\s*Do you trust the contents of this directory[^\n]*$/im },
  { provider: 'claude', kind: 'claude-folder-trust', title: /^\s*(?:Do you trust the files in this folder[^\n]*|(?:Do you )?trust this folder\??)\s*$/im },
  { provider: 'claude', kind: 'claude-resume-menu', title: /^\s*[❯›>]?\s*1\. Resume from summary[^\n]*$/im }
]

export function detectLifecyclePrompt(provider: string | null, capture: string): { kind: BlockedKind; detail: string } | null {
  // Dim completion suggestions are not typed input or active prompts. Drop them before stripping ANSI.
  const text = visiblePromptText(capture)
  if (!/^\s*[❯›>●]?\s*1[.)]\s+\S/m.test(text)) return null
  for (const signature of LIFECYCLE_PROMPT_SIGNATURES) {
    if (signature.provider !== provider) continue
    const hit = text.match(signature.title)
    if (hit) return { kind: signature.kind, detail: hit[0].trim().slice(0, 160) }
  }
  return null
}
