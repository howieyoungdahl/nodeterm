# Project recovery history

Ordinary publications preserve deletion tombstones permanently. Existing tombstones are read and
validated, but are not written and synced again on every save. Reads use at most 32 concurrent
file operations. A restored raw file still cannot resurrect an ID in that evidence.

An acknowledged `ProjectCommitStore` publication registers a file for asynchronous maintenance.
Read-only coordinators never register maintenance. One process-wide worker starts
after 60 seconds and handles one due file per tick. It plans outside publication and performs at
most 64 removals per pass. No save awaits pruning. A drained file is checked again after an hour;
backlogs continue on subsequent ticks. No live writer lock is acquired, removed or recovered by
maintenance. A busy writer defers the pass.

The default keeps all versions from the last seven days and at least the newest 200, plus the
current published revision regardless of age. Operations newer than the oldest retained version
are kept. Older operation directories are eligible only with a completed `committed` or
`already-applied` receipt. Interrupted, refused, unknown and unconfirmed evidence, tombstones and
publication locks are never age-pruned. Current bytes and candidate modification times are
rechecked at deletion. Pruning never rewrites the project or publishes content.

Expired operation receipts no longer provide operation-ID deduplication, and expired bases cause
the existing stale-base refusal. Clients must reload and submit a fresh operation in that case.
Deleting history is irreversible. Disabling maintenance stops further removal; reverting code
does not restore expired history. No migration or live cleanup command is required.

Configuration is process environment on Desktop and Server Edition:

| Variable | Default | Allowed values |
| --- | --- | --- |
| `NODETERM_RECOVERY_RETENTION` | enabled | `0` disables maintenance |
| `NODETERM_RECOVERY_RETENTION_DAYS` | 7 | 1 to 3650 |
| `NODETERM_RECOVERY_MIN_VERSIONS` | 200 | 1 to 100000 |
| `NODETERM_RECOVERY_PRUNE_BATCH` | 64 | 1 to 256 entries per pass |
| `NODETERM_RECOVERY_PRUNE_INTERVAL_MS` | 5000 | 1000 to 3600000 |

The renderer shows loading until the initial workspace read succeeds. Six failed attempts use
bounded backoff, then offer manual retry. Failed reads do not hydrate an empty workspace or start
autosave. A successful empty read still opens the welcome screen. Both canvas and kanban use this
same startup gate. The private mobile client needs equivalent loading/error presentation in its
own repository; the host retention rules already apply to its publications.

## Disposable measurements

Copy the entire project `.nodeterm` directory into a private scratch `project/` directory. Never
point the benchmark at a live project. Mark that scratch root with a `.nodeterm-benchmark-copy`
file containing exactly `private-copy` followed by a newline. Run:

```sh
NODETERM_RECOVERY_BENCH_ROOT=/private/scratch \
  nice -n 15 npm test -- test/server/recovery-history-benchmark.test.ts --maxWorkers=1
```

The fixture starts its own authenticated Server on an ephemeral port, disables hook installation
and periodic reaping, and uses the suite's private tmux socket. It writes synthetic sticky content
only to the copy, measures boot, initial load, save and authenticated operator removal, verifies
removal after reload, and writes `metrics.json` in scratch. It stops its own Server in `finally`.

On a Linux/WSL2 private copy measured on 2026-10-25:

| History and code | Initial load | Save | Operator removal |
| --- | ---: | ---: | ---: |
| Full history, before fix | 13.84 ms | 18463.65 ms | 18902.55 ms |
| Seven-day trim, before fix | 12.49 ms | 18186.80 ms | 17653.13 ms |
| Full history, after fix | 20.58 ms | 720.98 ms | 643.30 ms |

The copy had 11013 versions. The seven-day experiment retained 6844 versions and removed 4167
completed operations, freeing 3173990692 bytes. This estimates the first maintenance backlog for
that snapshot; a seven-day window does not remove the entire roughly 8 GB history. The timings
measure uncontended reads, not a live incident trace. The startup tests separately hold the read
pending and exercise rejected reads with the mounted welcome/loading components.
