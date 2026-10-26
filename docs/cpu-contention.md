# CPU contention

The Linux server installer emits `CPUWeight=1000` for the server service. This gives
its UI process and in-service tmux server more CPU share under contention than a
pane scope with the default weight of 100. It imposes no CPU quota and leaves pane
scope weights unchanged. An existing user service needs an operator to apply it:

```sh
systemctl --user set-property nodeterm-server.service CPUWeight=1000
```

Updating application code alone does not rewrite an existing service unit. This
command is an operator action, not part of the application update.

The installer uses the same unit generator for user and system installations.
The setting affects Linux Server Edition. Desktop and mobile clients receive no
protocol changes, and canvas and kanban remain consumers of the same server.

Hook throttling is deferred. The hooks must drain large stdin payloads without
breaking the provider's writer, preserve the forwarded body and retain identity,
subagent, question and lifecycle events. A full-body POSIX shell `read` before any
helper process exceeded the existing large-body
latency contracts on the CPU-saturated validation host. Retaining `cat` preserves those contracts but requires a process
before a payload-aware throttle can run. A future optimization needs an explicitly
revised process constraint or provider-supplied event metadata outside stdin.
