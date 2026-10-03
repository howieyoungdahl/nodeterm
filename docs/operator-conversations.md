# External operator conversation CLI

This CLI is for an operator on the same machine as the Nodeterm Server. It calls only the loopback-only `/opsapi/v1/*` conversation API. It does not create a canvas node, assign `NODETERM_NODE_ID`, or use the management `ops-token`. The separate operator credential is supplied through a protected file and never appears in the command line.

Creating/organizing assistant cards uses the separate repository management client
`scripts/nodeterm-organization.mjs` and management `ops-token`; see
[Assistant Kanban organization](kanban-organization.md). Descriptive organization owner labels and
creation receipts never authorize transcript reads or message delivery. Extending an external
helper can call that client without editing its conversation credential, grants or policy.

## Commands

```sh
node scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /protected/path/fern-operator.token capabilities
node scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /protected/path/fern-operator.token sessions
node scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /protected/path/fern-operator.token --target-file /protected/path/target.json --limit 50 read
node scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /protected/path/fern-operator.token --target-file /protected/path/target.json --idempotency-key fern-20260930-01 send < message.txt
node scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /protected/path/fern-operator.token --id 00000000-0000-4000-8000-000000000000 receipt
```

The message comes from stdin, or from a protected `--message-file`; it is never an argument. `read` accepts `--cursor` and `--limit` (1 through 200). `send` requires an idempotency key, and repeats with the same principal/key/target/message return the original receipt. `--target-file` must contain exactly the target returned by `sessions`, including its current generation:

```json
{"projectId":"project-id","nodeId":"term-id","sessionId":"provider-session-id","generation":"server-session-generation"}
```

All successful responses are one JSON object on stdout. Errors are a JSON object with a stable `error` code on stderr. Exit codes: `2` for invalid input or API refusal, `3` for transport failure or timeout, and `4` for an unsupported protocol version. The CLI rejects non-loopback hosts, URL credentials, paths, query strings, fragments, and redirects. Requests time out after ten seconds. It does not print bearer tokens, request bodies, or message text. A `read` page contains actual transcript text, so callers should protect stdout and any file to which they redirect it.

For a Windows workstation using WSL, run the CLI inside the same WSL instance where Server Edition listens. Example from PowerShell, with `<distro>` and host paths replaced locally:

```powershell
$Distro = "Ubuntu"
wsl.exe -d $Distro --exec node /home/fern/nodeterm/scripts/nodeterm-operator.mjs --url http://127.0.0.1:8443 --credential-file /home/fern/.config/nodeterm/fern-operator.token sessions
```

In WSL, create the credential file on the Linux filesystem when possible, or on a Windows-mounted path whose ACL is private to the account. Windows does not expose POSIX mode bits, so the CLI's mode check is intentionally Linux-only; the Windows ACL remains the operator's responsibility. Pass WSL paths (`/mnt/c/...`), not `C:\...`, to a CLI process running inside WSL.

The server endpoint remains loopback-only. Do not change its bind address or expose it through a tunnel, proxy, or firewall rule for this task. Desktop and mobile companion are not supported surfaces; this external client targets Server Edition only. The documented providers are Claude and Codex. Unsupported or unavailable transcript providers return a refusal; terminal suggestions are not represented as submitted messages.

## Operator principal policy (proposed provisioning, not activated)

The server reads `operator-conversations.json` from its data directory on each request and again across asynchronous read, receipt, admission and submission boundaries. When the file is absent, unreadable, non-private, malformed, or invalid, access is denied. Provisioning is a manual operation only after the operator approves the specific principal and the read and message scopes independently. This draft and the CLI do not create credentials, write policy, change server settings, or activate the feature.

The policy shape is:

```json
{
  "version": 1,
  "principals": [
    {
      "id": "fern-external-task",
      "tokenSha256": "<64 lowercase hex characters from SHA-256 of the separately provisioned token>",
      "expiresAt": "<UTC expiry timestamp>",
      "read": [{"projectId":"<exact>","nodeId":"<exact>","sessionId":"<exact>"}],
      "message": [{"projectId":"<exact>","nodeId":"<exact>","sessionId":"<exact>"}]
    }
  ]
}
```

Version 1 retains independent exact target allowlists. Version 2 additionally accepts this exact tagged entry in either array:

```json
{"kind":"all-current-and-future-verified-sessions"}
```

For example, an approved standing read grant with no message authority is `"read": [{"kind":"all-current-and-future-verified-sessions"}], "message": []` under `"version": 2`. To grant standing message authority independently, put the same entry in `message`. Exact entries may remain alongside it, and exact-only v2 policies keep their previous meaning. Wildcards, other tags, extra fields on the tagged entry, and standing entries under v1 reject the entire policy.

A standing grant applies across projects to every current and future session verified by this Server's authenticated hooks. Persisted cards, status files and unverified hook reports do not establish session identity. Every read and new message still requires the exact target and current generation returned by `sessions`; stale or ambiguous bindings refuse. Unsupported transcript providers and message transports retain their existing refusals. A standing grant creates no canvas-control ownership, management or lifecycle permission. Keep grants time-bounded. The on-disk policy stores only the token hash, never the token. The separate raw bearer belongs only in a locally protected credential file (mode `0600` on Linux/WSL); never put it in source control, a prompt, shell history, argv, or logs. The existing management `ops-token` cannot authenticate to this API and must not be reused. Do not include a real hash or credential in a reviewed draft.

Authenticated native parent hooks establish identity and attach a jailed transcript path together, before UI status normalization. The first `SessionStart` and a same-ID resume therefore need no later `Stop` to make their transcript readable. Recognized hooks that produce no UI state transition also establish identity. Codex child hooks cannot attach their rollout to the parent. A missing or rejected path leaves the new generation unreadable until its own authenticated path arrives; it never borrows the old generation's path. The first accepted path stays fixed for that generation, so a delayed same-ID hook cannot switch a resumed target back to its previous rollout. A legitimate path replacement requires a fresh authenticated `SessionStart` or changed session/provider identity.

After a Server restart, saved cards and mirrors remain discovery hints only. The first new authenticated parent hook establishes a fresh boot generation, including a hook with no UI state transition. Idle sessions that emit no authenticated hook remain unavailable. This code does not scan private sessions, wake providers, or derive authority from a saved title, status or transcript file. Re-enumerate when fresh hook evidence arrives.

## Lifecycle, receipts, and rollback

Policy edits take effect without a restart. Removing the last applicable read grant denies later reads. Removing the last applicable message grant denies receipt retrieval and unsent deliveries, including queued messages. Removing the principal revokes both operations. Remaining exact grants continue to apply after a standing tag is removed. An async operation retains the original principal id as well as the bearer and target. Revocation during durable admission records a failed receipt while preserving deduplication; it never dispatches that message. Revocation cannot retract bytes already submitted to a provider. An acknowledgement arriving later may still update the durable receipt as historical evidence, but callers lacking current message authority cannot retrieve it. Restarting the server changes session generations; operators must call `sessions` again, obtain the fresh exact target, and submit a new idempotency key only for a genuinely new message. There is no queued-message replay after restart.

An `accepted` receipt means the request was admitted and durably recorded. It does not prove that the target received or understood the text. `queued` means it is awaiting delivery. `acknowledged` requires an authenticated submission event matching both the pinned session and the SHA-256 of the exact operator envelope, not an unrelated working/next-turn event. Claude's exact full native `<pasted_content>` scaffold is unwrapped before hashing; extra text, mismatched IDs and ambiguous/nested wrappers do not match. Even an acknowledgement proves submission, not comprehension or completion. Providers without the full authenticated submitted prompt cannot produce this acknowledgement. Poll `receipt` when necessary. A missing terminal suggestion is never evidence that text was submitted; the transcript endpoint exposes submitted conversation records, while capability output reports that terminal suggestions are disabled.

For rollback, revoke/remove the affected principal's policy entry first. Preserve `operator-message-receipts.json` and `operator-conversation-audit.jsonl` during rollback and migration. Do not delete or reset idempotency records: doing so can make a retry submit the same message again. Old exact-only servers reject a v2 policy in full, denying all principals rather than interpreting standing authority. Before a downgrade, remove every standing entry and validate an exact-only v1 policy, preserving the other principals and their approved exact grants. Keep the affected principal revoked until reapproved. Use the host's approved activation procedure to restore the previous build, then re-query `sessions` because generations may have changed. No server activation, credential provisioning, live request, transcript read, or message send is part of preparing this documentation/CLI draft.

## API and fern integration

All routes require the separate bearer credential and return `version: 1`. Browser cookies, the management token, non-loopback peers and browser Origin headers are rejected. Ordinary canvas-agent creator ownership rules are unchanged.

| Method and path | Purpose |
| --- | --- |
| `GET /opsapi/v1/capabilities` | Protocol and independent read/message availability |
| `GET /opsapi/v1/sessions` | Approved, verified targets with boot/session generation |
| `GET /opsapi/v1/conversation?projectId=…&nodeId=…&sessionId=…&generation=…&limit=50&cursor=…` | Ordered snapshot page |
| `POST /opsapi/v1/messages` | JSON `{ "target": {…}, "text": "…" }`; required `Idempotency-Key` header |
| `GET /opsapi/v1/receipts/<receipt-id>` | That caller's receipt, requiring current message scope |

A conversation page contains `target`, `items` and `nextCursor`. Each item has an ordered `sequence`, stable snapshot `id`, timestamp (or `null` if unavailable), kind (`user`, `agent`, `tool_call`, `tool_result`), text and provenance (`source`, `agentId`, `submitted`). Long blocks are split into ordered chunks without dropping text. Only public Claude/Codex conversation records are supported; thinking/private channels and provider metadata are omitted. Terminal suggestions are intentionally not captured or mixed into submitted content. Pages are snapshot- and credential-context-bound: appends do not change a continuation; file replacement, prefix mutation, target replacement, credential rotation or restart invalidates it. Never infer that a null timestamp means the current time.

Credential masking covers known token, authorization, cookie, secret-assignment, URL-password and private-key forms. Arbitrary unlabeled secrets cannot be reliably identified; long-token masking can also hide harmless text. This is an authorized sensitive-data surface, not a guarantee that every conversation is safe to publish. Protect outputs and do not feed them into public logs. Unsafe paths and oversized records/snapshots fail explicitly rather than exposing raw files or silently dropping content.

Raw JSONL records are bounded to 16 MiB, with at most 64 nesting levels and 100,000 structural units (quotes, containers and separators). The scanner enforces these budgets before JSON parsing, even for private records, and malformed JSON still fails. Public text is filtered and redacted before splitting into items of at most 12,000 characters. Whole files remain capped at 256 MiB, snapshot text at 96 MiB, and page text at 128 KiB; item, cache and concurrent-read limits also remain active. Overbudget records return `transcript_record_too_large` or `transcript_record_too_complex`, never an apparently complete partial conversation. Desktop, mobile, canvas and board UI have no new controls on this Server-only operator path.

For fern: check capabilities, enumerate approved targets, store the exact returned target, read through `nextCursor`, then send only when message scope is separately approved. Persist one idempotency key per intended message before sending; after a timeout retry the identical request/key and poll its receipt. Never invent a node ID or substitute a new session for a stale target. Messages use the normal busy-session queue, shared target lock and settled-envelope transport; an existing human composer draft must be preserved and refused. Authorization and target generation are rechecked at actual submission. No implicit interrupt, restart or overwrite is allowed.

Errors are sanitized codes: `unauthorized` (401), `scope_denied` (403), `stale_target`/`ambiguous_target`/`idempotency_conflict` (409), transcript/provider/cursor refusals, `read_capacity` (429), and audit/receipt storage unavailability (503). Re-enumerate after stale targets; restart pagination after stale cursors; obtain a new grant after revocation. Never rotate the idempotency key just to bypass a delivery failure. Failed or stalled transport may have uncertain submission: inspect its evidence before a genuinely new send.

## Migration and approval checklist

There is no database migration or automatic credential provisioning. On an approved compatible Server build, the absent policy keeps this API unavailable. Before activation the operator must approve the principal, expiry and read/message scopes separately, including whether each is exact or standing. Standing grants require policy version 2. Existing v1 policies work unchanged on this build. Never reuse the existing management credential.

The HTTP API, CLI response protocol and receipt format remain version 1, independently of the policy file's version 2. No CLI change is needed for standing grants: it still enumerates verified targets and uses their exact generations. Older servers without the routes return unavailable; unknown response versions fail closed. Receipt schema mismatches or corrupt/non-private files deny sends, not reset history. At 2,000 retained receipts admission stops; archival/retention changes need a reviewed design preserving deduplication. A restart fails pending receipts as `server_restarted` with `delivery_unknown_no_replay`; it does not automatically send them again. The audit file contains IDs, operation, time and outcome only, never message bodies or credentials.

## Administrator activation and revocation (documentation only)

This procedure is for the administrator to run after an approved build is active. It changes a principal's standing scopes once, without session-by-session grants, a restart or changes to other principals. Obtain separate approval for standing read and standing message, the principal id and its expiry. With `bootstrap = false`, the existing credential is preserved. With `bootstrap = true`, it can start from an absent policy or add a new principal: it generates a fresh separate bearer in a new private file and refuses to overwrite an existing credential or principal. Preparing this documentation executes neither path. Never paste bearer bytes into a command, a prompt or a log.

Use the source and dependencies from the approved build. Ensure the Server data directory and this shell are owned by the Server account and private (`0700` on Linux/WSL). Only one administrator edits policy at a time; the comparison before publication detects changes but is not a concurrency lock. Replace the paths below locally; none is a credential. The compiled helpers use the production parser and atomic publication implementation.

```sh
umask 077
export OPERATOR_ADMIN_DATA_DIR=/protected/path/to/nodeterm-server
export OPERATOR_ADMIN_HELPERS=$(mktemp -d)
./node_modules/.bin/esbuild src/server/operator-conversation-policy.ts src/core/fs-atomic.ts \
  --bundle --platform=node --format=cjs --outbase=src --outdir="$OPERATOR_ADMIN_HELPERS"
node --input-type=module <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID, randomBytes } from 'node:crypto'
const require = createRequire(import.meta.url)
const { loadOperatorPrincipals, tokenDigest, OPERATOR_POLICY_FILE, OPERATOR_STANDING_SCOPE_KIND } =
  require(path.join(process.env.OPERATOR_ADMIN_HELPERS, 'server/operator-conversation-policy.js'))
const { writeFileAtomic } = require(path.join(process.env.OPERATOR_ADMIN_HELPERS, 'core/fs-atomic.js'))

// Edit only these non-secret choices. Approval must cover each selected operation.
const principalId = 'fern-external-task'
const bootstrap = false // true only for an explicitly approved new principal and new private credential
const action = 'activate' // 'revoke-standing' removes selected tags; 'revoke-principal' removes all its authority
const operations = ['read', 'message'] // use ['read'] or ['message'] for independent selection
const approvedExpiry = '2026-12-31T00:00:00Z' // activation only, use the actually approved date
if (!['activate', 'revoke-standing', 'revoke-principal'].includes(action) ||
    !operations.length || operations.some((op) => !['read', 'message'].includes(op))) throw Error('invalid_choices')
const dataDir = process.env.OPERATOR_ADMIN_DATA_DIR
const credentialFile = path.join(dataDir, 'fern-operator.token') // bootstrap only; never overwrite
const dir = fs.lstatSync(dataDir)
if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== 'win32' &&
    ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid()))) throw Error('private_directory_required')
const file = path.join(dataDir, OPERATOR_POLICY_FILE)
let original
try {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw Error('private_policy_required')
  original = fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
} catch (error) {
  if (error.code !== 'ENOENT' || !bootstrap || action !== 'activate') throw error
}
const policy = original === undefined ? { version: 1, principals: [] } : JSON.parse(original)
if (Object.keys(policy).length !== 2 || ![1, 2].includes(policy.version) || !Array.isArray(policy.principals) || (original !== undefined &&
    loadOperatorPrincipals(file).length !== policy.principals.length)) throw Error('invalid_existing_policy')
let principal = policy.principals.find((p) => p.id === principalId)
let freshToken
if (bootstrap) {
  if (principal || action !== 'activate') throw Error('bootstrap_requires_new_principal')
  freshToken = randomBytes(32).toString('base64url')
  principal = { id: principalId, tokenSha256: tokenDigest(freshToken), expiresAt: approvedExpiry, read: [], message: [] }
  policy.principals.push(principal)
} else if (!principal) throw Error('existing_principal_required')
if (action === 'revoke-principal') policy.principals = policy.principals.filter((p) => p.id !== principalId)
else {
  if (action === 'activate') {
    if (!Number.isFinite(Date.parse(approvedExpiry)) || Date.parse(approvedExpiry) <= Date.now()) throw Error('future_expiry_required')
    principal.expiresAt = approvedExpiry
    policy.version = 2
  }
  for (const op of operations) {
    principal[op] = principal[op].filter((scope) => scope.kind !== OPERATOR_STANDING_SCOPE_KIND)
    if (action === 'activate') principal[op].push({ kind: OPERATOR_STANDING_SCOPE_KIND })
  }
}
const candidate = path.join(dataDir, `.operator-policy-candidate-${randomUUID()}`)
const backup = path.join(dataDir, `.operator-policy-backup-${randomUUID()}`)
const credentialStaging = path.join(dataDir, `.operator-credential-${randomUUID()}`)
let credentialCreated = false
let published = false
try {
  await writeFileAtomic(candidate, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 })
  if (loadOperatorPrincipals(candidate).length !== policy.principals.length) throw Error('invalid_candidate')
  if (original === undefined ? fs.existsSync(file) : fs.readFileSync(file, 'utf8') !== original) throw Error('policy_changed_retry_review')
  if (original !== undefined) fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  if (freshToken) {
    await writeFileAtomic(credentialStaging, freshToken + '\n', { mode: 0o600 })
    // Atomic, exclusive publication: a pre-existing credential causes EEXIST, never replacement.
    fs.linkSync(credentialStaging, credentialFile)
    credentialCreated = true
  }
  await writeFileAtomic(file, fs.readFileSync(candidate), { mode: 0o600 })
  published = true
  console.log('Policy published; private backup:', original === undefined ? 'none (new policy)' : backup)
} finally {
  fs.rmSync(candidate, { force: true })
  fs.rmSync(credentialStaging, { force: true })
  if (credentialCreated && !published) fs.rmSync(credentialFile, { force: true })
}
NODE
rm -rf -- "$OPERATOR_ADMIN_HELPERS"
unset OPERATOR_ADMIN_HELPERS OPERATOR_ADMIN_DATA_DIR
```

The existing principal's token hash stays unchanged. Exact grants and all other principals are preserved. Receipt and audit files are never touched. `revoke-standing` removes only the selected standing tags, leaving any old exact grants active; use `revoke-principal` for full revocation of that principal. Unsent queued messages and subsequent receipt reads are denied only when the caller loses all applicable message authority. Read revocation independently denies transcript reads. No receipt history is replayed or deleted. Read-only `capabilities` and `sessions` with the private credential can confirm the selected authority after publication; they never send a test message. Do not add a send as an activation probe. Bootstrap publishes the raw bearer in `fern-operator.token`, with `0600` mode and an atomic exclusive hard link from private staging. A filesystem without hard-link support refuses before policy publication; use a private local filesystem supporting this primitive. Configure fern with that file path, never copy its contents into argv or logs.

On Windows, the administrator must enforce equivalent private ACLs on the directory, policy, backup and helper directory. The parser does not attest Windows ACLs. For downgrade, while the affected principal remains revoked, remove standing tags from every remaining principal, set `version` to `1`, validate with the old build's parser and atomically publish before downgrading. Do not restore a backup containing the standing principal automatically: doing so reactivates authority and requires approval. Keep backups private and out of source control.

Use the standalone CLI from the approved build's commit, not an unrelated source checkout; test with `capabilities` before integration. Disposable Linux/WSL sessions have exercised Claude Code 2.1.286 (Opus 5.5 xhigh) and Codex CLI 0.159.2 (GPT-6.1 Sol xhigh), with human-draft preservation and authenticated correlated receipts. A real Codex same-ID resume rotated generation and refused stale reads/sends without pane writes. The Windows CI selection includes the operator API/CLI, reader, policy, receipts, queue, authenticated generation and composer tests; a green job from an older selection is not evidence for these suites.

Message transport currently requires local tmux styled current-screen capture and a recognized composer layout. Unknown or unstyled layouts (including `NO_COLOR`), different footer formats, and the native Windows session-host backend refuse submission. Running the external Windows task through WSL is the supported delivery path; Windows API/CLI unit coverage is not proof of real provider delivery on a native Windows backend. This does not authorize changing a live session's settings to make it compatible.

## Disposable real-provider acceptance test

This opt-in test makes real provider calls using the local authenticated accounts. It is excluded from ordinary CI and must never target a live node. It creates a private Server, temporary exact grants, a setup-minted private tmux socket, isolated hook discovery and a disposable Codex profile. Claude runs with custom temporary settings, no tools and no MCP servers. Codex runs without the shared daemon. Only the disposable providers are stopped during cleanup; neither live Server settings nor provider hook settings are rewritten.

```sh
env -u CODEX_THREAD_ID NODETERM_REAL_PROVIDER_TEST=1 npx vitest run test/server/operator-real-provider.test.ts --maxWorkers=1
```

Optionally set `NODETERM_REAL_PROVIDER=claude` or `codex` to exercise one provider. Unsupported selections fail, not pass with zero sessions. The test verifies paginated public conversation content/provenance, zero pane writes on an unsent draft refusal, a verified full-envelope receipt, duplicate-send deduplication and actual same-ID Codex resume rejection. It logs synthetic metadata only. Revalidate this contract with disposable sessions after provider changes, before activation; never use a live worker for acceptance checks.
