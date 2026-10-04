/** Capture the posting Codex ancestor BEFORE its hook POST is backgrounded. A late POST
 * must retain its old process identity, never acquire the next CLI's identity at receipt.
 * No provider JSON is modified. Missing /proc or unfamiliar ancestry leaves an empty stamp. */
export const CLEANUP_PROCESS_STAMP_SH = [
  'nt_cleanup_process=""',
  'nt_cp_cursor=$$',
  'nt_cp_n=0',
  'while [ "$nt_cp_n" -lt 32 ]; do',
  '  nt_cp_n=$((nt_cp_n + 1))',
  '  case "$nt_cp_cursor" in ""|*[!0-9]*) break ;; esac',
  '  [ "$nt_cp_cursor" -gt 1 ] || break',
  '  nt_cp_stat=$(cat "/proc/$nt_cp_cursor/stat" 2>/dev/null) || break',
  '  nt_cp_comm=$(cat "/proc/$nt_cp_cursor/comm" 2>/dev/null) || break',
  '  nt_cp_tail=${nt_cp_stat##*) }',
  '  set -f',
  '  set -- $nt_cp_tail',
  '  set +f',
  '  [ "$#" -ge 20 ] || break',
  '  nt_cp_parent=$2',
  '  nt_cp_birth=${20}',
  '  case "$nt_cp_birth" in ""|*[!0-9]*) break ;; esac',
  '  case "$nt_cp_comm" in',
  '    codex|nodeterm-codex)',
  '      nt_cleanup_process="$nt_cp_cursor:$nt_cp_birth"',
  '      break ;;',
  '  esac',
  '  [ "$nt_cp_parent" != "$nt_cp_cursor" ] || break',
  '  nt_cp_cursor=$nt_cp_parent',
  'done'
].join('\n')
