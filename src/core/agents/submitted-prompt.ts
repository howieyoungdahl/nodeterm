/**
 * Remove Claude Code's native wrapper around a multiline terminal paste only when the entire
 * prompt has the exact provider scaffold and a matching, bounded paste id. The body is returned
 * byte-for-byte (apart from the caller's existing CRLF normalization). All ambiguous or malformed
 * inputs remain untouched so they cannot satisfy a receipt for the inner body accidentally.
 */
export function submittedPromptForHash(agentId: string, prompt: string): string {
  if (agentId !== 'claude') return prompt
  const match = /^\n\n<pasted_content id="([A-Za-z0-9_-]{1,64})">\n([\s\S]*)\n<\/pasted_content id="([A-Za-z0-9_-]{1,64})">\n$/.exec(prompt)
  if (!match || match[0].length !== prompt.length || match[1] !== match[3]) return prompt
  const body = match[2]
  if (body.includes('<pasted_content') || body.includes('</pasted_content')) return prompt
  return body
}
