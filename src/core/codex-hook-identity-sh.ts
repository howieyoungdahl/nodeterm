import { posixQuote } from '../shared/ssh'

/**
 * Codex command hooks receive their session in JSON on stdin. Unlike tool commands, the shared
 * daemon does not promise CODEX_THREAD_ID in a hook's environment. Read the body once, before the
 * node gate, and use its top-level session_id only as a lookup key for the existing scoped record
 * resolver. Neither the payload nor this bootstrap grants node authority.
 *
 * jq is preferred; standalone Codex installations need not have Node on PATH. Node is the fallback
 * on Server Edition. If neither parser exists, preserve an already supplied identity but never
 * guess one from JSON with a regex. No body, endpoint or credential is placed on process argv.
 */
export function codexHookIdentityBootstrapSh(): string {
  const nodeParser = `try {
    const value = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) process.exit(1);
    if (!Object.hasOwn(value, 'session_id')) process.exit(0);
    const id = value.session_id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || /[^A-Za-z0-9._-]/.test(id) || id === '.' || id === '..') process.exit(1);
    process.stdout.write(id);
  } catch { process.exit(1); }`
  const jqParser = 'select(length == 1) | .[0] | select(type == "object") | if has("session_id") then .session_id | select(type == "string") | select(length > 0 and length <= 128 and (test("[^A-Za-z0-9._-]") | not) and . != "." and . != "..") else "" end'
  return `# A Codex hook's session_id lives in stdin, not necessarily in its daemon environment.
payload=$(cat)
[ -n "$payload" ] || exit 0
nt_codex_payload_recovered=0
nt_codex_payload_status=0
if command -v jq >/dev/null 2>&1; then
  nt_codex_payload_thread=$(printf %s "$payload" | jq -ser ${posixQuote(jqParser)} 2>/dev/null) || nt_codex_payload_status=1
elif command -v node >/dev/null 2>&1; then
  nt_codex_payload_thread=$(printf %s "$payload" | node -e ${posixQuote(nodeParser)} 2>/dev/null) || nt_codex_payload_status=1
else
  # Existing direct launches retain their old path; payload-only recovery must fail closed.
  if [ -z "\${NODETERM_NODE_ID-}" ] && [ -z "\${CODEX_THREAD_ID-}" ]; then
    printf 'Nodeterm Codex hook identity unavailable: a JSON parser (jq or node) is required.\\n' >&2
    exit 0
  fi
  nt_codex_payload_status=2
fi
if [ "$nt_codex_payload_status" = 1 ]; then
  printf 'Nodeterm Codex hook identity refused: invalid session payload.\\n' >&2
  exit 0
fi
if [ "$nt_codex_payload_status" = 0 ]; then
  if [ -z "$nt_codex_payload_thread" ]; then
    # Older envelopes can omit session_id. Keep their existing direct/env path, not a guessed ID.
    if [ -z "\${NODETERM_NODE_ID-}" ] && [ -z "\${CODEX_THREAD_ID-}" ]; then
      printf 'Nodeterm Codex hook identity refused: missing session identity.\\n' >&2
      exit 0
    fi
  elif [ -n "\${CODEX_THREAD_ID-}" ] && [ "$CODEX_THREAD_ID" != "$nt_codex_payload_thread" ]; then
    printf 'Nodeterm Codex hook identity refused: session context conflict.\\n' >&2
    exit 0
  else
    if [ -z "\${CODEX_THREAD_ID-}" ] && [ -z "\${NODETERM_NODE_ID-}" ]; then
      nt_codex_payload_recovered=1
    fi
    CODEX_THREAD_ID="$nt_codex_payload_thread"
    export CODEX_THREAD_ID
  fi
fi`
}
