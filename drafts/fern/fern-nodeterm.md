# Local NodeTerm command access

Use this guide with the matching helper version and a compatible NodeTerm server.
The matching creation contract also records category, urgency, reason and independent/support
intent before save/launch. Pass `--task-planning-file` for explicit planning and evidence using
the schema in `docs/task-planning.md`; a supporting session names its exact parent task ID.
An older contract refuses before POST. Unknown roles enter an explained Needs classification
queue; never infer category, urgency or parent work from a title or model.
The helper and guide must be reviewed and installed together before activating the
assistant creation contract. Installation is coordinated by the operator; this
guide does not install files or authorize live actions. Prerequisites are Python 3,
the existing configured Ubuntu execution route, loopback management access and the
operator's protected credential file. No new dependency or permission setting is required.

The operator must explicitly authorize access to the selected local NodeTerm
instance and target nodes. Installing this helper grants no standing authority
to send input or change provider settings. Follow the operator's current task scope.

The Windows desktop Work executor is native. The NodeTerm server and its tmux
terminals run in Ubuntu. Invoke the local operator CLI from native PowerShell:

```powershell
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py nodes
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py health
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py pin --node-id EXACT_ID --output $env:USERPROFILE\AppData\Local\Temp\fern-target.json
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py send --target-file $env:USERPROFILE\AppData\Local\Temp\fern-target.json --body-file $env:USERPROFILE\AppData\Local\Temp\fern-input.txt --enter
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py capture --target-file $env:USERPROFILE\AppData\Local\Temp\fern-target.json
```

From Ubuntu, the same entry point is:

```bash
python3 "$HOME/.local/bin/fern-nodeterm.py" nodes
```

The Windows wrapper launches Ubuntu through the configured execution mode. A
platform denial is terminal for that action; do not change permission settings,
reroute execution, or substitute another conversation's identity.

`nodes` inventories all cards, including plain shell/helper nodes that are absent
from the agent-conversation API. `controlAvailable` identifies live terminal
panes on this local server. Groups and notes do not run commands. A remote SSH
backend without a local tmux pane is reported unavailable; it is never guessed.

`pin` returns a current terminal preview and saves a non-secret target containing
the server boot identity, tmux socket identity, session/pane identity and screen
hash. Read the preview before sending. Preserve human input already at the prompt:
do not append to an unrelated draft. A screen change or replaced session refuses
the send. Inspect again and create a new pin before retrying. Never silently
redirect to another node with the same title.

For an idle shell, `send --enter` executes the supplied shell text in that node's
existing context. For an agent terminal, text is an instruction to that agent;
verify its response/output rather than claiming the agent immediately ran it.
Prefer the existing verified-session conversation CLI for agent conversations:

```bash
node "$HOME/.local/share/nodeterm-updates/current/scripts/nodeterm-operator.mjs" \
  --url http://127.0.0.1:8443 \
  --credential-file "$HOME/.nodeterm-server/fern-operator.token" capabilities
```

Use its documented `sessions`, `read`, `send`, and receipt commands with the
current session generation. `--allow-busy` on the terminal CLI is only for an
intentional input to a busy/blocked agent after inspecting its screen. It does
not clear or interrupt an existing draft/process.

Keep command/message bodies in stdin or a UTF-8 file, never argv. UTF-8 files
with a Windows byte-order mark are accepted; the mark is removed before delivery. Terminal
control bytes are rejected. The CLI uses the same private tmux buffer and
bracketed-paste delivery as NodeTerm; it does not overwrite human paste buffers.
Tokens stay in the Linux owner's protected files and are never copied to Windows
or printed. Management HTTP uses loopback, refuses redirects, and bypasses proxy
configuration only for that loopback connection.

`bytesDelivered`/`enterSent` are delivery facts. `executionVerified` is deliberately
false until you capture a distinct output line or read the agent's response. For
a shell test use a harmless unique `printf` marker and require a standalone
marker line, not an echoed command containing the marker.
If delivery times out, capture the terminal before deciding whether to retry;
never automatically repeat a command whose execution outcome is uncertain.

`spawn` creates a visible shell with declared logical task ownership in an existing
project. The shared operator credential authenticates the request; it does not
authenticate the particular named assistant. An acknowledged private receipt binds that
verified principal, project, node, stable task ID, creation key and declared owner
before any save or launch.
Linux receipt publication flushes files and parent directories. Native Windows
uses exclusive publication and flushed-file visibility acknowledgment; it does
not claim directory or power-loss durability. Neither Windows nor copied/unknown
receipts can qualify a Linux node for automatic cleanup. Interrupted receipt
publication refuses retry or adoption and preserves private evidence.
`close` only removes an operator-created card after the shell has exited and its
pane is confirmed dead; it never forces a live node closed.

Every new assistant-created shell requires complete organization metadata,
an explicit stable task ID and one caller-provided stable creation key. Generate
the key once for a real logical creation,
keep it with the exact arguments, and retain both across any explicit retry:

```powershell
$creationKey = [guid]::NewGuid().ToString()
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py spawn --project-id EXACT_PROJECT_ID --title "Directory release checks" --cwd /tmp --task-id EXACT_STABLE_TASK_ID --owner "Fern" --workstream directory --functional-role directorychecks --idempotency-key $creationKey
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py receipt --idempotency-key $creationKey
```

Case-sensitive roles route only through the target project's existing policy.
This guide contains no live policy or column IDs.

Workstream remains independent. No title/model classifier, policy write, new
column or old-card adoption occurs. Unknown roles or missing columns remain
Ungrouped. Metadata must be complete, including an explicit functional role;
partial/invalid inputs reject locally before a POST. Keys contain 8 to 128 ASCII
letters, digits, periods, underscores or hyphens. The helper never replaces a key.
Missing task/owner/workstream/role/key fields reject locally before any POST.
The `/tmp` cwd default and fixed `exec bash --noprofile --norc` command remain.

Before every creation POST, the helper performs an authenticated read-only
`GET /opsapi/creation-contract` and requires version 1, explicit task/key/metadata
requirements, verified creator source and a private receipt before save/spawn.
It also requires the explicit version 1 `receiptPublication` platform/guarantee
pair: Windows `file-flush-visibility`, other admitted platforms
`file-and-directory-sync`. Missing or inconsistent publication capabilities refuse.
An old server, unavailable check, weaker promise or malformed contract stops
before POST and does not trigger a receipt recovery read. Compatibility is never
probed by creating a card. Older PR59 helper versions without the task envelope
and capability check cannot create against this contract. Upgrade the helper and
guide as one reviewed pair before enabling assistant creation; a mixed-version
helper/server pairing must refuse before POST. Manual browser creation remains
available through its ordinary workspace/terminal route.

Creation uses a 35-second HTTP timeout to allow the server's 30-second external
launch deadline to report its result; existing requests and receipt GETs retain
their 20-second timeout. HTTP timeouts apply to network operations, not a promise
that the entire server transaction finishes within that time. A transport timeout,
invalid success response or uncertain keyed server result triggers exactly one
read-only GET for the same key and still exits with an uncertainty error. Output
includes the key, receipt stage/outcome/node ID, or a receipt-read failure. There
is no second POST, automatic retry, new key, or inferred launch success. Ordinary
4xx rejections, including authoritative `409 idempotency_key_reused`, fail normally.

Receipt stages are `reserved`, `launch_claimed` and `finished`; outcomes are
`success`, `spawn_failed`, `command_failed`, `uncertain` or null while unresolved.
A missing/unreadable receipt is not proof that creation never happened. Even a
`finished`/`success` GET exposes no fingerprint and cannot prove it belongs to
your requested body. The helper never recovers success from it. Reconcile before
deciding whether any explicit retry is appropriate; retain identical arguments
and key so the server's POST fingerprint check remains authoritative. A different
body with an existing key must be rejected, never accepted through a GET receipt.

Browser visibility is separate: this CLI does not establish that Fern can see or
control Chrome. Use the browser's normal approval flow for visual browser work.

## Recoverable routine cleanup

After the reviewed Server rollout, use `cleanup` (alias `archive`) for ordinary
authorized card cleanup. It calls the existing reviewed-preview and archive API,
hides only an exact cohort, and keeps card records, history, session identities,
bindings and backend processes. `close` remains a separate permanent removal;
cleanup never falls back to Close, sweep, process termination or permission changes.

Use the current task outcome and authorized scope to select cards. Unknown work,
working tasks, missing private ownership and user-owned cards stay held unless
the current request explicitly covers them. A title or dead pane never supplies
an obsolete disposition. The request packet contains exactly `projectId` and
1 to 100 unique `entries`; each entry carries `nodeId`, an explicit disposition
(`obsolete-completed`, `obsolete-superseded`, `obsolete-paused`, or `obsolete-shell`),
the current `ownerDigest`, and the recorded task-decision `evidenceDigest`.
Both digests are SHA-256. Reuse the repository's offline review-packet helper
described in `docs/session-cleanup.md`; do not manufacture ownership or completed
task evidence. Existing user authorization can supply task disposition within
its scope; reversible archive does not require a separate permanent-loss approval.

```powershell
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py cleanup-preview
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py cleanup --request-file C:\absolute\current-review.json --receipt-file C:\absolute\archive-outcome.json
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py cleanup-receipt --receipt-id EXACT_RECEIPT_UUID
py $env:USERPROFILE\.codex\scripts\fern-nodeterm.py cleanup-undo --receipt-id EXACT_RECEIPT_UUID --receipt-file C:\absolute\undo-outcome.json
```

The helper reserves a new private outcome file before submitting the reviewed
preview, flushes and reopens each saved stage, and archives only a fresh five-minute
plan whose entire cohort, project, dispositions, owner digests and generations
match the request. Success requires the exact applied receipt. Undo reads that
receipt first, verifies the exact inverse acknowledgment, and changes no later
title/position edits. An already-undone receipt needs no second POST.

Timeouts, partial responses and invalid acknowledgments remain unknown. The helper
makes at most one recovery read (`cleanup-receipt` when the UUID is known, otherwise
`cleanup-receipts`) and never repeats a mutation or claims success from that read.
Authorization refusal stops immediately without a secondary read. Inspect the
retained outcome file and server receipt before any explicit recovery action;
the output file must never be overwritten. Requests stay within the existing
64,000-byte limit; responses and receipt listings are bounded. The existing
management credential is unchanged, remains on Linux and never rides argv.

The Windows wrapper runs this on the Linux Server host. Native Windows Server
archive remains unsupported by the existing retained-publication contract;
the helper adds no fallback. An older served build lacking reviewed archive
refuses without deleting a card. Upgrade the helper and guide as a reviewed pair;
no archive is run as an installation or verification test on the live board.
