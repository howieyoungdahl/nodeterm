import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: [
      'src/core/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/preload/**/*.test.ts',
      // .tsx too: component tests (jsdom via a per-file pragma; everything else stays node).
      'src/renderer/**/*.test.{ts,tsx}',
      'src/server/**/*.test.ts',
      'src/session-host/**/*.test.ts',
      'test/server/**/*.test.ts',
      'test/remote/**/*.test.ts',
      // Cross-layer acceptance chains (e.g. renderer store + main's pure gates in one flow):
      // production layering forbids these imports inside src/, so the chain lives here, like
      // test/server's cross-layer boots.
      'test/acceptance/**/*.test.ts',
      // Opt-in end-to-end tests against a real sshd in Docker. They self-skip unless
      // NODETERM_SSH_DOCKER is set, so a machine without Docker still runs a green suite.
      'test/ssh-docker/**/*.test.ts',
      // The setup file's own ordering proof (env set before the test file's static imports).
      'test/setup/**/*.test.ts'
    ],
    environment: 'node',
    // Every worker gets a PRIVATE tmux socket (`NODETERM_TMUX_SOCKET=nt-vitest-<pid>`) unless the
    // operator set one, so the `test/server/*` suites that boot a real PtyManager never touch the
    // `node-terminal` socket carrying this machine's live nodeterm sessions. Must run before the
    // test file's imports — see the file's header and its sibling test.
    setupFiles: ['test/setup/private-tmux-socket.ts'],
    // Issue #160: with the default (one worker per core), a 10-core Mac runs ~10 fs-heavy suites
    // at once and transient fd exhaustion (EMFILE) turns into silent test flakiness — probes like
    // `fs.existsSync` swallow the error and answer false, so whole files fail in ways that never
    // reproduce alone and vanish with --no-file-parallelism. Half the cores keeps wall-clock
    // close (the suite is fs/IO-bound, not CPU-bound) while halving peak fd pressure. CI's 2-core
    // runners resolve to 1 worker, which is what they effectively ran anyway.
    maxWorkers: '50%'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
