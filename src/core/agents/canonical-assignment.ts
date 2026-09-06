import { execFile } from 'node:child_process'
import path from 'node:path'
import type { AssignmentValidator } from './message-integrity'

/** Operator startup configuration only. Never read paths or executable names from a message. */
export interface CanonicalAssignmentConfig {
  pythonPath: string
  modulePath: string
  moduleSha256: string
  ledgerPath: string
}

export function assignmentConfig(env: NodeJS.ProcessEnv): CanonicalAssignmentConfig | undefined {
  const values = [env.NODETERM_ASSIGNMENT_PYTHON, env.NODETERM_ASSIGNMENT_MODULE,
    env.NODETERM_ASSIGNMENT_SHA256, env.NODETERM_ASSIGNMENT_LEDGER]
  if (values.every((value) => !value)) return
  const config = { pythonPath: values[0]!, modulePath: values[1]!,
    moduleSha256: values[2]!, ledgerPath: values[3]! }
  checkConfig(config)
  return config
}

function checkConfig(config: CanonicalAssignmentConfig): void {
  if (![config.pythonPath, config.modulePath, config.ledgerPath].every((value) =>
    typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(config.moduleSha256)) {
    throw new Error('Invalid explicit canonical assignment configuration')
  }
}

// The public D15 read/validate API is the sole authority. No copied state validator, mutating
// command, shell, provider, ambient registry, or inherited credentials. D15 takes its cooperative
// sibling lock even on reads; require both existing files, never bootstrap a registry here.
const READ_ASSIGNMENT = String.raw`
import hashlib, json, pathlib, sys, types
try:
    module_path, digest, registry = sys.argv[1:]
    with pathlib.Path(module_path).open('rb') as handle:
        source = handle.read(1048577)
    if len(source) > 1048576 or hashlib.sha256(source).hexdigest() != digest:
        raise ValueError()
    target = pathlib.Path(registry)
    if not target.is_file() or not target.with_name(target.name + '.lock').is_file():
        raise ValueError()
    module = types.ModuleType('nodeterm_canonical_assignment')
    module.__file__ = module_path
    sys.modules[module.__name__] = module
    exec(compile(source, module_path, 'exec'), module.__dict__)
    binding = json.loads(sys.stdin.read(16385))
    result = module.assignment_validate(target, task_id=binding['task_id'],
        expected_epoch=binding['assignment_epoch'], actor=binding['actor'],
        contract_ref=binding['contract_ref'], policy_ref=binding['policy_ref'])
    code = result.get('code', 'assignment-unverifiable')
    ok = result.get('ok') is True
    if ok and any(result.get('assignment', {}).get(k) != v for k, v in binding.items()):
        ok, code = False, 'assignment-binding-mismatch'
    print(json.dumps({'ok': ok, 'code': code}))
except Exception:
    print(json.dumps({'ok': False, 'code': 'assignment-source-unavailable'}))
`

export function canonicalAssignmentValidator(config?: CanonicalAssignmentConfig): AssignmentValidator {
  if (!config) return async () => ({ ok: false, code: 'assignment-validator-unavailable' })
  checkConfig(config)
  const pinned = { ...config }
  return async (binding) => new Promise((resolve) => {
    const fail = (): void => resolve({ ok: false, code: 'assignment-source-unavailable' })
    const input = JSON.stringify(binding)
    if (Buffer.byteLength(input) > 16_384) { fail(); return }
    const child = execFile(pinned.pythonPath, ['-I', '-B', '-c', READ_ASSIGNMENT,
      pinned.modulePath, pinned.moduleSha256, pinned.ledgerPath], {
      env: { LC_ALL: 'C.UTF-8' }, timeout: 1500, maxBuffer: 4096, windowsHide: true
    }, (error, stdout) => {
      if (error) { fail(); return }
      try {
        const result = JSON.parse(stdout)
        if (typeof result.ok !== 'boolean' || typeof result.code !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,96}$/.test(result.code)) { fail(); return }
        resolve({ ok: result.ok, code: result.code })
      } catch { fail() }
    })
    child.stdin?.on('error', fail)
    child.stdin?.end(input)
  })
}
