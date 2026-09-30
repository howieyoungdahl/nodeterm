# External operator conversation CLI

This CLI is for an operator on the same machine as the Nodeterm Server. It calls only the loopback-only `/opsapi/v1/*` conversation API. It does not create a canvas node, assign `NODETERM_NODE_ID`, or use the management `ops-token`. The separate operator credential is supplied through a protected file and never appears in the command line.

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

The server reads `operator-conversations.json` from its data directory on each request. When the file is absent, unreadable, non-private, malformed, or invalid, access is denied. Provisioning is a manual operation only after the operator approves the specific principal and exact scope. This draft and the CLI do not create credentials, write policy, change server settings, or activate the feature.

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

`read` and `message` are independent exact target allowlists. Keep grants minimal and time-bounded. The on-disk policy stores only the token hash, never the token. The separate raw bearer belongs only in a locally protected credential file (mode `0600` on Linux/WSL); never put it in source control, a prompt, shell history, argv, or logs. The existing management `ops-token` cannot authenticate to this API and must not be reused. Do not include a real hash or credential in a reviewed draft.

## Lifecycle, receipts, and rollback

Policy edits take effect on the next request. Removing a principal or target grant revokes later reads and deliveries, but cannot unsend an already admitted message. Restarting the server changes session generations; operators must call `sessions` again, obtain the fresh exact target, and submit a new idempotency key only for a genuinely new message. There is no queued-message replay after restart.

An `accepted` receipt means the request was admitted and durably recorded. It does not prove that the target received or understood the text. `queued` means it is awaiting delivery. `acknowledged` requires an authenticated submission event matching both the pinned session and the SHA-256 of the exact operator envelope, not an unrelated working/next-turn event. Claude's exact full native `<pasted_content>` scaffold is unwrapped before hashing; extra text, mismatched IDs and ambiguous/nested wrappers do not match. Even an acknowledgement proves submission, not comprehension or completion. Providers without the full authenticated submitted prompt cannot produce this acknowledgement. Poll `receipt` when necessary. A missing terminal suggestion is never evidence that text was submitted; the transcript endpoint exposes submitted conversation records, while capability output reports that terminal suggestions are disabled.

For rollback, revoke/remove the principal policy entry first. Preserve `operator-message-receipts.json` and `operator-conversation-audit.jsonl` during rollback and migration. Do not delete or reset idempotency records: doing so can make a retry submit the same message again. Restore the previous compatible server build, leaving the policy revoked until reapproved; then re-query `sessions` because generations may have changed. No server activation, credential provisioning, live request, transcript read, or message send is part of preparing this documentation/CLI draft.

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

For fern: check capabilities, enumerate approved targets, store the exact returned target, read through `nextCursor`, then send only when message scope is separately approved. Persist one idempotency key per intended message before sending; after a timeout retry the identical request/key and poll its receipt. Never invent a node ID or substitute a new session for a stale target. Messages use the normal busy-session queue, shared target lock and settled-envelope transport; an existing human composer draft must be preserved and refused. Authorization and target generation are rechecked at actual submission. No implicit interrupt, restart or overwrite is allowed.

Errors are sanitized codes: `unauthorized` (401), `scope_denied` (403), `stale_target`/`ambiguous_target`/`idempotency_conflict` (409), transcript/provider/cursor refusals, `read_capacity` (429), and audit/receipt storage unavailability (503). Re-enumerate after stale targets; restart pagination after stale cursors; obtain a new grant after revocation. Never rotate the idempotency key just to bypass a delivery failure. Failed or stalled transport may have uncertain submission: inspect its evidence before a genuinely new send.

## Migration and approval checklist

There is no database migration or automatic credential provisioning. On an approved compatible Server build, the absent policy keeps this API unavailable. Before activation the operator must approve the principal, expiry and exact read/message scopes separately; a local administrator then provisions a fresh random token and its hash in private files. Never reuse the existing management credential. No wildcard or whole-canvas grant exists.

Version 1 requires both a Server build containing these routes and a matching CLI. Older servers return an unavailable route; unknown response versions fail closed. Receipt schema mismatches or corrupt/non-private files deny sends, not reset history. At 2,000 retained receipts admission stops; archival/retention changes need a reviewed design preserving deduplication. A restart fails pending receipts as `server_restarted` with `delivery_unknown_no_replay`; it does not automatically send them again. The audit file contains IDs, operation, time and outcome only, never message bodies or credentials.

Use the standalone CLI from the approved build's commit, not an unrelated source checkout; test with `capabilities` before integration. Disposable Linux/WSL sessions have exercised Claude Code 2.1.286 (Opus 5.5 xhigh) and Codex CLI 0.159.2 (GPT-6.1 Sol xhigh), with human-draft preservation and authenticated correlated receipts. A real Codex same-ID resume rotated generation and refused stale reads/sends without pane writes. The Windows CI selection includes the operator API/CLI, reader, policy, receipts, queue, authenticated generation and composer tests; a green job from an older selection is not evidence for these suites.

Message transport currently requires local tmux styled current-screen capture and a recognized composer layout. Unknown or unstyled layouts (including `NO_COLOR`), different footer formats, and the native Windows session-host backend refuse submission. Running the external Windows task through WSL is the supported delivery path; Windows API/CLI unit coverage is not proof of real provider delivery on a native Windows backend. This does not authorize changing a live session's settings to make it compatible.

## Disposable real-provider acceptance test

This opt-in test makes real provider calls using the local authenticated accounts. It is excluded from ordinary CI and must never target a live node. It creates a private Server, temporary exact grants, a setup-minted private tmux socket, isolated hook discovery and a disposable Codex profile. Claude runs with custom temporary settings, no tools and no MCP servers. Codex runs without the shared daemon. Only the disposable providers are stopped during cleanup; neither live Server settings nor provider hook settings are rewritten.

```sh
env -u CODEX_THREAD_ID NODETERM_REAL_PROVIDER_TEST=1 npx vitest run test/server/operator-real-provider.test.ts --maxWorkers=1
```

Optionally set `NODETERM_REAL_PROVIDER=claude` or `codex` to exercise one provider. Unsupported selections fail, not pass with zero sessions. The test verifies paginated public conversation content/provenance, zero pane writes on an unsent draft refusal, a verified full-envelope receipt, duplicate-send deduplication and actual same-ID Codex resume rejection. It logs synthetic metadata only. Revalidate this contract with disposable sessions after provider changes, before activation; never use a live worker for acceptance checks.
