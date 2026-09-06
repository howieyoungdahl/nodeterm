import os from 'os'
import path from 'path'
import { parseTrustedNets, DEFAULT_TRUSTED_NETS_SPEC, type TrustProxyConfig } from './proxy-trust'
import { DEFAULT_TMUX_SOCKET, TMUX_SOCKET, resolveTmuxSocketName } from '../core/tmux-naming'

/**
 * Fully-resolved server configuration. Produced by {@link resolveConfig} from the
 * process environment + CLI argv, then consumed by `startServer` (src/server/index.ts).
 */
export type ServerConfig = {
  port: number
  host: string
  dataDir: string
  rendererDir: string
  insecureHttp: boolean
  passwordSeed?: string
  /**
   * Headless notification-host mode (`NODETERM_HEADLESS=1`). When set, the server does NOT
   * bind the HTTP/WS listener at all — no renderer serving, no auth surface, no open port —
   * but boots every other core service exactly as usual (the loopback hook server, agent-status
   * mirror, usage poll, granted push senders, pending-approvals sweep). A phone that SSHes into
   * the host still gets full push / Live-Activity coverage as long as this process runs. See the
   * "Headless notification host" section of docs/SERVER.md.
   */
  headless: boolean
  /**
   * Merge the managed agent hooks into the user's real agent config dirs (~/.claude,
   * ~/.codex, ~/.gemini) at boot. Defaults to true — the server needs them to receive
   * agent status. Tests MUST pass false: installing rewrites the machine's REAL settings.json
   * (the script lives at the stable `~/.nodeterm/agent-hooks/<agent>.sh`, shared by every
   * instance), so a test run would silently take over the developer's own hooks — and, before
   * that path was stabilized, leave them pointing into a temp dataDir that gets removed after
   * the run, which is exactly how a machine ends up with hooks that quietly do nothing.
   */
  installHooks?: boolean
  /**
   * Enable the Server Edition `/control/*` canvas runtime. Defaults OFF so an upgrade cannot
   * silently grant agents a new local execution surface. Environment:
   * NODETERM_SERVER_CANVAS_CONTROL=1;
   * CLI: --canvas-control. Hook endpoint authentication and per-project capability gates still
   * apply when enabled. The server-process env name is deliberately distinct from the
   * per-session NODETERM_CANVAS_CONTROL discovery bit injected by HookServer.
   */
  canvasControl?: boolean
  /**
   * How often the Server calls the operator plane's conservative dead-card sweep engine.
   * Default 30 minutes; zero disables only the periodic trigger, not POST /opsapi/sweep.
   */
  deadCardReapMinutes?: number
  /**
   * Mass-sweep guard: dead terminal cards in a SINGLE sweep pass at or above which the sweep
   * refuses the whole pass, removes nothing, and logs one line. Default 5; zero disables this
   * rule (the fraction rule below still applies). `POST /opsapi/sweep {"force":true}` overrides.
   */
  deadCardReapMassLimit?: number
  /**
   * Mass-sweep guard, share form: dead-of-scanned ratio (0..1) at or above which the sweep
   * refuses. Default 0.5; zero disables this rule. Needs at least two dead cards to trip, so a
   * one-card canvas is still reapable.
   */
  deadCardReapMassFraction?: number
  /**
   * Reverse-proxy SSO trust (issue #29): requests whose TCP peer is inside `nets` and
   * which carry `header` (non-empty) are authenticated without a session cookie.
   * Absent = feature off (default). See src/server/proxy-trust.ts and docs/SERVER.md.
   */
  trustProxy?: TrustProxyConfig
  /**
   * tmux socket this instance's local sessions live on (`tmux -L <name>`). Defaults to
   * `node-terminal`, which is what every install has always used, so an upgrade changes nothing.
   *
   * Set it — `NODETERM_TMUX_SOCKET=<name>`, systemd `Environment=` — to give a production instance
   * a PRIVATE socket, so a developer running the test suite (or `tmux kill-server`) on the same
   * machine cannot reach the sessions behind the live canvas.
   *
   * Optional in the type because tests construct `ServerConfig` literals; `resolveConfig` always
   * sets it.
   */
  tmuxSocket?: string
}

/**
 * Minimal `--flag value` / `--bool` argv parser. Only understands the flags we
 * define below; anything else is ignored. A flag whose next token is another
 * flag (or missing) is treated as a boolean.
 */
function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) continue
    const key = tok.slice(2)
    if (key === 'insecure-http') {
      out[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Resolve the server config from `env` + `argv`. Precedence is argv > env > default.
 * Binding a non-loopback host without `--insecure-http` throws: plain HTTP on a
 * public interface would leak the session cookie, so the server insists on being
 * kept behind a TLS-terminating reverse proxy (loopback) unless explicitly overridden.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const args = parseArgv(argv)

  const pick = (argKey: string, envKey: string, def: string): string => {
    if (typeof args[argKey] === 'string') return args[argKey] as string
    const ev = env[envKey]
    if (ev !== undefined && ev !== '') return ev
    return def
  }

  const port = Number(pick('port', 'NODETERM_PORT', '8443'))
  const host = pick('host', 'NODETERM_HOST', '127.0.0.1')
  const dataDir = pick('data-dir', 'NODETERM_DATA_DIR', path.join(os.homedir(), '.nodeterm-server'))
  const rendererDir = pick('renderer-dir', 'NODETERM_RENDERER_DIR', path.resolve('out/renderer'))
  const insecureHttp = args['insecure-http'] === true
  const passwordSeed = env.NODETERM_SERVER_PASSWORD || undefined
  // Headless mode is env-only (a deployment/systemd knob, not an interactive flag). Accept the two
  // truthy spellings the install script + systemd unit emit.
  const headlessEnv = (env.NODETERM_HEADLESS || '').trim().toLowerCase()
  const headless = headlessEnv === '1' || headlessEnv === 'true'
  const truthy = (value: unknown): boolean => {
    if (value === true) return true
    if (typeof value !== 'string') return false
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  const canvasControl =
    args['canvas-control'] !== undefined
      ? truthy(args['canvas-control'])
      : truthy(env.NODETERM_SERVER_CANVAS_CONTROL)
  const rawDeadCardReapMinutes = pick(
    'dead-card-reap-minutes',
    'NODETERM_DEAD_CARD_REAP_MINUTES',
    '30'
  ).trim()
  const parsedDeadCardReapMinutes = Number(rawDeadCardReapMinutes)
  // Hand-edited service env must degrade to the safe documented default, never to a tighter or
  // disabled cleanup policy by accident. Cap at one week so a typo cannot effectively turn it off.
  const deadCardReapMinutes =
    rawDeadCardReapMinutes !== '' &&
    Number.isFinite(parsedDeadCardReapMinutes) &&
    parsedDeadCardReapMinutes >= 0
      ? Math.min(parsedDeadCardReapMinutes, 7 * 24 * 60)
      : 30

  // The guard's two thresholds. Same degrade-to-default rule as the interval above: a hand-edited
  // service env that cannot be read as a number must never end up SWEEPING MORE than the shipped
  // default, so anything unparseable, negative, or (for the fraction) outside 0..1 falls back.
  const massLimitRaw = pick(
    'dead-card-reap-mass-limit',
    'NODETERM_DEAD_CARD_REAP_MASS_LIMIT',
    '5'
  ).trim()
  const massLimitParsed = Number(massLimitRaw)
  const deadCardReapMassLimit =
    massLimitRaw !== '' && Number.isFinite(massLimitParsed) && massLimitParsed >= 0
      ? Math.floor(massLimitParsed)
      : 5
  const massFractionRaw = pick(
    'dead-card-reap-mass-fraction',
    'NODETERM_DEAD_CARD_REAP_MASS_FRACTION',
    '0.5'
  ).trim()
  const massFractionParsed = Number(massFractionRaw)
  const deadCardReapMassFraction =
    massFractionRaw !== '' &&
    Number.isFinite(massFractionParsed) &&
    massFractionParsed >= 0 &&
    massFractionParsed <= 1
      ? massFractionParsed
      : 0.5

  // Headless binds nothing, so the "plain HTTP on a public interface" hazard the loopback refusal
  // guards against does not apply — a stray NODETERM_HOST must not fail a headless boot.
  if (!isLoopback(host) && !insecureHttp && !headless) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" over plain HTTP. Run nodeterm-server ` +
        `behind a TLS-terminating reverse proxy and keep it bound to a loopback address ` +
        `(127.0.0.1 / localhost / ::1), or pass --insecure-http to acknowledge you are ` +
        `serving plain HTTP directly on this interface.`
    )
  }

  // Throws on a typo: see resolveTmuxSocketName. A misconfigured socket name must fail the boot,
  // not silently put this instance back on the shared socket.
  const tmuxSocket = resolveTmuxSocketName(
    pick('tmux-socket', 'NODETERM_TMUX_SOCKET', DEFAULT_TMUX_SOCKET)
  )

  // Reverse-proxy SSO trust. `pick` with an empty default so "unset" and "" coincide.
  const trustHeader = pick('trust-proxy-header', 'NODETERM_TRUST_PROXY_HEADER', '')
  const trustNetsSpec = pick('trust-proxy-nets', 'NODETERM_TRUST_PROXY_NETS', '')
  let trustProxy: TrustProxyConfig | undefined
  if (trustHeader !== '') {
    // parseTrustedNets throws on a typo — a bad trust config must fail the boot, not
    // silently change who is trusted.
    trustProxy = {
      header: trustHeader,
      nets: parseTrustedNets(trustNetsSpec || DEFAULT_TRUSTED_NETS_SPEC)
    }
  } else if (trustNetsSpec !== '') {
    throw new Error(
      `--trust-proxy-nets / NODETERM_TRUST_PROXY_NETS is set but no trust header is configured. ` +
        `Set NODETERM_TRUST_PROXY_HEADER (or --trust-proxy-header) to the identity header your ` +
        `reverse proxy asserts (e.g. Cf-Access-Authenticated-User-Email), or unset the nets.`
    )
  }

  return {
    port,
    host,
    dataDir,
    rendererDir,
    insecureHttp,
    passwordSeed,
    trustProxy,
    headless,
    canvasControl,
    deadCardReapMinutes,
    deadCardReapMassLimit,
    deadCardReapMassFraction,
    tmuxSocket
  }
}

/**
 * Refuse a `--tmux-socket` that cannot take effect.
 *
 * `TMUX_SOCKET` is bound when `src/core/tmux-naming.ts` loads, which happens on the first import —
 * before argv is parsed. So a CLI flag naming a different socket is not a configuration, it is a
 * lie: the process would answer "running on my-private-socket" while every pty it spawns lands on
 * `node-terminal`. Called from `main.ts` after `resolveConfig`; `bound` is injectable so the check
 * itself is testable without re-importing the module under a different environment.
 */
export function assertTmuxSocketBound(cfg: ServerConfig, bound: string = TMUX_SOCKET): void {
  const want = cfg.tmuxSocket ?? DEFAULT_TMUX_SOCKET
  if (want === bound) return
  throw new Error(
    `tmux socket "${want}" cannot take effect: this process bound "${bound}" at startup. ` +
      `The name is read from NODETERM_TMUX_SOCKET once, when the module loads, so a --tmux-socket ` +
      `flag arrives too late. Start the server with NODETERM_TMUX_SOCKET=${want} in the ` +
      `environment (systemd: Environment=NODETERM_TMUX_SOCKET=${want}).`
  )
}
