/**
 * POSIX-sh identity prelude shared by local commands and managed hooks.
 *
 * WHY IT EXISTS: with the shared app-server, the shell a Codex TOOL runs in is spawned by that
 * server, not by the TUI client NodeTerm launched. It carries `CODEX_THREAD_ID`, but its ambient
 * `NODETERM_*` can be absent, incomplete OR a complete foreign identity left in a reused daemon.
 * Always compare the exact thread binding before a consumer can use that ambient capability.
 *
 * The mapping file is parsed as DATA (`awk`), never sourced as shell code, and both recovered
 * fields are re-validated before they are exported. The record itself is HMAC-signed by
 * `codex-identity-proxy.ts`; this prelude cannot verify that signature (no key in an agent's
 * shell), which is why the charset re-validation below is not redundant.
 *
 * ACCOUNT SCOPING (S6): a SYSTEM record lives at the bare root (`<root>/<threadId>`) and a MANAGED
 * record under `<root>/<accountId>/<threadId>`. This prelude reads `NODETERM_CODEX_ACCOUNT_ID` from
 * the daemon's env to pick the scope:
 *   - a known, safe account id ⇒ read ONLY that account's record, and require the record's
 *     `accountId=` line to agree with the daemon scope;
 *   - an explicitly EMPTY account id ⇒ system only (`codexSessionEnv` clears managed scope this
 *     way); UNSET ⇒ unknown, scan system + managed scopes and require exactly one valid candidate.
 * Missing records preserve a complete direct `codex exec` context. Existing invalid/unreadable
 * evidence, ambiguity, or a complete context disagreeing with its binding refuses by name.
 *
 * WHAT IT EXPORTS IS WHAT THE RECORD SAYS — it does not decide. `NODETERM_AGENT_ID` and
 * `NODETERM_CANVAS_CONTROL` used to be constants here (`codex`, granted), and both are facts only
 * `hookServer.buildPtyEnv` knows: it labels the node with its OWN agent id, which for a custom
 * agent inheriting the codex harness is `custom:<uuid>`, and it gates the grant on
 * `canControlCanvas`. Asserting them here mislabelled every such node, and asserted a grant that
 * agrees with the pane today only because `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a
 * coincidence that list's own comment invites the next shared-identity agent to break. So the pair
 * is recorded at bind time and read back here. A PRE-AGENT record (written before those fields
 * existed) carries neither and means `codex` with the grant, which is precisely what it meant when
 * it was written; a record that names an agent is exported as it stands, grant included, and never
 * falls back to the guess.
 *
 * Inert for every other agent: without `CODEX_THREAD_ID` the whole block is skipped. A machine with
 * no managed accounts has no subdirs, so unknown-scope lookup reduces to the bare-root S4 layout.
 *
 * Deliberately free of Node/Electron imports beyond the path it is given: the generated-script
 * cores are shared by the desktop and the Server Edition.
 */
import { posixQuote } from '../shared/ssh'

/**
 * @param identityRoot absolute path of the thread → node record directory
 *   (`codexThreadIdentityRoot()`, i.e. under `CorePlatform.userDataDir` — NOT `~`).
 * @param caller commands fail with status 1; hooks must drain stdin then exit 0, preserving the
 *   existing telemetry-hook contract without EPIPEing a writer of a payload larger than a pipe.
 */
export function codexThreadIdentityResolverSh(
  identityRoot: string,
  caller: 'command' | 'hook' = 'command'
): string {
  return `# A reused Codex daemon can carry a foreign NODETERM_* context, even a complete one.
# These protected records are shape/scope checked here, NOT HMAC-verified by the shell.
if [ -n "\${CODEX_THREAD_ID-}" ]; then
  nt_codex_clear_transport() {
    unset NODETERM_HOOK_SOCK NODETERM_HOOK_PORT NODETERM_HOOK_TOKEN NODETERM_HOOK_VERSION \\
      NODETERM_NODE_TOKEN_DIR NODETERM_CODEX_NODE_TOKEN
  }
  nt_codex_refuse() {
    unset NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_AGENT_ID NODETERM_CANVAS_CONTROL
    nt_codex_clear_transport
    # Only a fixed reason is printed: never an identity, endpoint, credential or hook payload.
    printf 'Nodeterm Codex identity refused: %s.\\n' "$1" >&2
    ${caller === 'hook' ? 'cat >/dev/null 2>&1 || :\n    exit 0' : 'exit 1'}
  }
  nt_codex_safe_id() {
    case "$1" in ''|.|..|*[!A-Za-z0-9._-]*) return 1 ;; esac
    [ "\${#1}" -le 128 ]
  }
  nt_codex_safe_endpoint() {
    case "$1" in /|[!/]*) return 1 ;; /*) ;; *) return 1 ;; esac
    [ "$(printf %s "$1" | tr -cd 'A-Za-z0-9._/ -')" = "$1" ]
  }
  nt_codex_safe_account() {
    case "$1" in ''|system|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) return 1 ;; esac
  }
  nt_codex_safe_id "$CODEX_THREAD_ID" || nt_codex_refuse invalid-thread-id
  nt_codex_complete=0
  # buildPtyEnv supplies node + endpoint + a client capability. Every NONEMPTY capability value
  # opens the existing command gate (even '0'); agent-role metadata is optional, not authority.
  if nt_codex_safe_id "\${NODETERM_NODE_ID-}" && \\
     nt_codex_safe_endpoint "\${NODETERM_HOOK_ENDPOINT-}" && \\
     [ -n "\${NODETERM_CANVAS_CONTROL-}" ]; then
    nt_codex_complete=1
  fi
  nt_codex_root=${posixQuote(identityRoot)}
  nt_codex_matches=0
  nt_codex_node=''
  nt_codex_endpoint=''
  nt_codex_check_dir() {
    if [ -e "$1" ] || [ -L "$1" ]; then
      [ -d "$1" ] && [ -r "$1" ] && [ -x "$1" ] || nt_codex_refuse unreadable-binding
    fi
  }
  # Absence is different from an existing unreadable/malformed record. One bad candidate also
  # prevents an unknown-scope lookup from treating a second, readable candidate as unique.
  nt_codex_try() {
    [ -e "$1" ] || [ -L "$1" ] || return 0
    [ -f "$1" ] && [ ! -L "$1" ] || nt_codex_refuse invalid-binding
    [ -r "$1" ] || nt_codex_refuse unreadable-binding
    nt_fields=$(awk '
      /^[[:space:]]*$/ { next }
      {
        eq = index($0, "="); key = substr($0, 1, eq - 1)
        if (eq < 1 || key !~ /^(accountId|nodeId|endpoint|signature|agentId|canvasControl)$/ || ++seen[key] > 1) bad = 1
        value[key] = substr($0, eq + 1)
      }
      END {
        if (bad || seen["nodeId"] != 1 || seen["endpoint"] != 1 || seen["signature"] != 1) exit 1
        printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n", value["accountId"], value["nodeId"], value["endpoint"], value["signature"], value["agentId"], value["canvasControl"], seen["agentId"]
      }
    ' "$1" 2>/dev/null) || nt_codex_refuse invalid-binding
    nt_a=$(printf '%s\\n' "$nt_fields" | sed -n '1p')
    nt_n=$(printf '%s\\n' "$nt_fields" | sed -n '2p')
    nt_e=$(printf '%s\\n' "$nt_fields" | sed -n '3p')
    nt_s=$(printf '%s\\n' "$nt_fields" | sed -n '4p')
    nt_g=$(printf '%s\\n' "$nt_fields" | sed -n '5p')
    nt_c=$(printf '%s\\n' "$nt_fields" | sed -n '6p')
    nt_has_agent=$(printf '%s\\n' "$nt_fields" | sed -n '7p')
    if [ "$nt_has_agent" = 1 ]; then
      case "$nt_g" in ''|*[!A-Za-z0-9._:-]*) nt_codex_refuse invalid-binding ;; esac
      case "$nt_c" in ''|0|1) ;; *) nt_codex_refuse invalid-binding ;; esac
    else
      nt_g=codex
      nt_c=1
    fi
    case "$2" in
      '') case "$nt_a" in ''|system) ;; *) nt_codex_refuse invalid-binding ;; esac ;;
      *) [ "$nt_a" = "$2" ] || nt_codex_refuse invalid-binding ;;
    esac
    nt_codex_safe_id "$nt_n" && nt_codex_safe_endpoint "$nt_e" || nt_codex_refuse invalid-binding
    case "$nt_s" in ''|*[!A-Za-z0-9_-]*) nt_codex_refuse invalid-binding ;; esac
    nt_codex_node=$nt_n
    nt_codex_endpoint=$nt_e
    nt_codex_agent=$nt_g
    nt_codex_grant=$nt_c
    nt_codex_matches=$((nt_codex_matches + 1))
  }
  nt_codex_check_dir "$nt_codex_root"
  if [ "\${NODETERM_CODEX_ACCOUNT_ID+x}" = x ]; then
    # Explicit empty is the system launch contract; 'system' is reserved, not a managed id.
    case "$NODETERM_CODEX_ACCOUNT_ID" in
      '') nt_codex_try "$nt_codex_root/$CODEX_THREAD_ID" '' ;;
      *)
        nt_codex_safe_account "$NODETERM_CODEX_ACCOUNT_ID" || nt_codex_refuse invalid-account-scope
        nt_codex_check_dir "$nt_codex_root/$NODETERM_CODEX_ACCOUNT_ID"
        nt_codex_try "$nt_codex_root/$NODETERM_CODEX_ACCOUNT_ID/$CODEX_THREAD_ID" "$NODETERM_CODEX_ACCOUNT_ID"
        ;;
    esac
  else
    nt_codex_try "$nt_codex_root/$CODEX_THREAD_ID" ''
    for nt_codex_dir in "$nt_codex_root"/*/; do
      [ -d "$nt_codex_dir" ] || continue
      nt_codex_scope=\${nt_codex_dir%/}
      nt_codex_scope=\${nt_codex_scope##*/}
      nt_codex_safe_account "$nt_codex_scope" || continue
      nt_codex_check_dir "$nt_codex_dir"
      nt_codex_try "$nt_codex_dir$CODEX_THREAD_ID" "$nt_codex_scope"
    done
  fi
  case "$nt_codex_matches" in
    0) [ "$nt_codex_complete" = 1 ] || nt_codex_refuse missing-binding ;;
    1)
      # Compare the signed strings byte-for-byte. Resolving symlinks or normalizing path aliases
      # could hide a disagreement; a complete direct context with NO record stays untouched above.
      if [ "$nt_codex_complete" = 1 ] && \\
         { [ "$NODETERM_NODE_ID" != "$nt_codex_node" ] || [ "$NODETERM_HOOK_ENDPOINT" != "$nt_codex_endpoint" ]; }; then
        nt_codex_refuse complete-context-conflict
      fi
      # An inherited socket wins over a newly sourced port in all three consumers. Clear every
      # derived transport/credential field before they source THIS binding's endpoint file.
      nt_codex_clear_transport
      NODETERM_NODE_ID="$nt_codex_node"
      NODETERM_HOOK_ENDPOINT="$nt_codex_endpoint"
      NODETERM_AGENT_ID="$nt_codex_agent"
      unset NODETERM_CANVAS_CONTROL
      if [ "$nt_codex_grant" = 1 ]; then
        NODETERM_CANVAS_CONTROL=1
        export NODETERM_CANVAS_CONTROL
      fi
      export NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_AGENT_ID
      ;;
    *) nt_codex_refuse ambiguous-binding ;;
  esac
fi`
}
