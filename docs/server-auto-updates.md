# Automatic browser-server updates

The browser server can follow one configured integration branch. Feature-branch pushes remain
separate until merged. Every new commit is built in a detached release worktree; the live checkout
is never pulled, reset, or rebuilt in place.

The updater checks every five minutes. It installs dependencies from the lockfile, patches and
rebuilds node-pty for Node's ABI, then runs typecheck, the full test suite with two workers, and
renderer/server builds. Builds use a 4 GiB heap, require 6 GiB available host memory, and inherit an
allowlist of basic environment variables rather than provider credentials or node identity.

Activation waits until **no browsers are connected** and the server reports no active/queued
spawns or message deliveries. It backs up the saved workspace/project files and records every
card id and tmux pane id/PID, then checks inactivity again before switching. Open canvases are not
reloaded by the updater. Save changes and close browser tabs when you want a staged release to
activate; reopening later uses the new renderer with the same saved layout and running terminals.
This is not coordinated hot deployment: a new connection can still race the final check. Updates
while keeping browser tabs open require a future save/prepare handshake and admission lock.

The server service must use `KillMode=process`. The updater swaps its `current` release symlink,
restarts that service, checks a new server startup time and verifies the original panes and cards.
A failed startup or continuity check switches back to the previous release and checks it again.
Workspace backups are retained for recovery; rollback never overwrites potentially newer user
data with an old snapshot. If continuity also fails after rollback, the update is marked failed
and requires attention. It cannot recreate an agent process a defective release terminated.

One commit that fails validation or deployment is quarantined until a newer commit arrives or
an explicit retry is requested. Fetch/preflight failures and active viewers defer to the next tick.
Three verified releases are retained, plus the current/previous release and any release still used
as a terminal cwd. Clean generated worktrees alone are removed; edited or failed worktrees and
workspace snapshots are retained for inspection.

## Install on a Linux user-systemd host

Build the updater with `npm run updater:build`. Write a local configuration file:

```json
{
  "repo": "/absolute/path/to/nodeterm",
  "remote": "fork",
  "branch": "integration/server-fixes-2026-08-31",
  "stateDir": "/absolute/path/to/nodeterm-updates",
  "dataDir": "/absolute/path/to/.nodeterm-server",
  "service": "nodeterm-server.service",
  "opsUrl": "http://127.0.0.1:8443"
}
```

The configured remote/branch is a trusted code source: its package scripts execute as the user.
Keep credentials out of the URL; the existing Git credential helper supplies authentication.

Run `node out/server/update-install.cjs CONFIG.json CURRENT_LIVE_DIRECTORY`. Installation copies
the updater bundle into `stateDir`, adds a `zz-managed-updates.conf` service override pointing at
`stateDir/current`, and enables `nodeterm-browser-update.timer`. The initial symlink targets the
existing live directory, so installation does not restart or change the running build. Existing
service settings such as loopback binding, canvas control, and data directory remain in effect.
Releases with an updater build also replace the installed worker with their tested bundle for the
next timer tick. Older application releases without that build keep the installed worker.

The timer runs under `flock`, has a 20-minute deadline, two-core CPU quota and 6 GiB memory limit.
Start a check with `systemctl --user start nodeterm-browser-update.service`. For stage-only or an
explicit retry, use the same lock:

```sh
flock -n /PATH/TO/STATE/update.lock node /PATH/TO/STATE/updater.cjs /PATH/TO/STATE/config.json
flock -n /PATH/TO/STATE/update.lock node /PATH/TO/STATE/updater.cjs /PATH/TO/STATE/config.json --apply --retry
```

Read `stateDir/status.json` for `building`, `staged`, `deferred`, `deployed`, `current`, `failed`
or `blocked`; `deployed.json` records the installed commit and previous release. Full build output
and every terminal outcome go to `journalctl --user -u nodeterm-browser-update.service`.

Disable future checks with `systemctl --user disable --now nodeterm-browser-update.timer`.
This does not stop an already-running update job. Do not kill it during activation; let its bounded
verification/rollback finish. To revert code through the normal path, merge a revert commit.
Force-pushing the deployment branch behind the installed commit is refused.

Desktop Electron and the mobile app are not deployed by this updater. The existing headless-host
installer has its own daily timer and is not changed by this browser-server workflow.
