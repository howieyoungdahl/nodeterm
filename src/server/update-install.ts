import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { writeFileAtomic } from '../core/fs-atomic'
import { validateUpdateConfig, type UpdateConfig } from '../core/server-updater'

/** systemd quotes, not shell quotes. Percent specifiers must remain literal path characters. */
export function unitPath(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Newlines are not allowed in service paths')
  return JSON.stringify(value.replace(/%/g, '%%'))
}

export function updaterUnits(config: UpdateConfig, node: string) {
  validateUpdateConfig(config)
  const q = unitPath
  return {
    // Unlike ExecStart's word parser, WorkingDirectory treats quotes as literal path bytes.
    override: `[Service]\nWorkingDirectory=${path.join(config.stateDir, 'current').replace(/%/g, '%%')}\nExecStart=\nExecStart=${q(node)} ${q(path.join(config.stateDir, 'current/out/server/main.cjs'))}\nKillMode=process\n`,
    service: `[Unit]\nDescription=Build and deploy verified Nodeterm integration changes\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/flock -n ${q(path.join(config.stateDir, 'update.lock'))} ${q(node)} ${q(path.join(config.stateDir, 'updater.cjs'))} ${q(path.join(config.stateDir, 'config.json'))} --apply\nTimeoutStartSec=20min\nNice=10\nCPUQuota=200%\nMemoryMax=6G\n`,
    timer: `[Unit]\nDescription=Check Nodeterm integration changes every five minutes\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=5min\nUnit=nodeterm-browser-update.service\n[Install]\nWantedBy=timers.target\n`
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Browser updater requires Linux user systemd')
  const [configFile, liveDirectory] = process.argv.slice(2)
  if (!configFile || !liveDirectory) throw new Error('Usage: update-install.cjs CONFIG.json CURRENT_LIVE_DIRECTORY')
  const config = JSON.parse(await fs.readFile(configFile, 'utf8')) as UpdateConfig
  validateUpdateConfig(config)
  const live = await fs.realpath(liveDirectory)
  await fs.access(path.join(live, 'out/server/main.cjs'))
  const node = process.execPath
  const units = updaterUnits(config, node)
  const unitDirectory = path.join(os.homedir(), '.config/systemd/user')
  const overrideDirectory = path.join(unitDirectory, `${config.service}.d`)
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  const current = path.join(config.stateDir, 'current')
  try { await fs.symlink(live, current) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await fs.mkdir(overrideDirectory, { recursive: true })
  await writeFileAtomic(path.join(config.stateDir, 'config.json'), JSON.stringify(config, null, 2))
  const bundle = await fs.readFile(path.join(path.dirname(process.argv[1]), 'updater.cjs'), 'utf8')
  await writeFileAtomic(path.join(config.stateDir, 'updater.cjs'), bundle)
  // Existing installations can have named drop-ins such as canvas-control.conf. A numeric "99"
  // sorts BEFORE those; use a trailing name and verify the effective service config on activation.
  await writeFileAtomic(path.join(overrideDirectory, 'zz-managed-updates.conf'), units.override)
  await writeFileAtomic(path.join(unitDirectory, 'nodeterm-browser-update.service'), units.service)
  await writeFileAtomic(path.join(unitDirectory, 'nodeterm-browser-update.timer'), units.timer)
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit', timeout: 30_000 })
  const effectiveDirectory = execFileSync('systemctl', ['--user', 'show', config.service, '-p', 'WorkingDirectory', '--value'], {
    encoding: 'utf8', timeout: 30_000
  }).trim()
  if (effectiveDirectory !== current) throw new Error('Managed release override was not accepted; updater timer was not enabled')
  execFileSync('systemctl', ['--user', 'enable', '--now', 'nodeterm-browser-update.timer'], { stdio: 'inherit', timeout: 30_000 })
  console.log('Automatic updates enabled. The running server was not restarted. Open browsers defer activation.')
}

// Kept importable for unit-file tests; the bundled CLI is the only execution entry point.
if (process.argv[1]?.endsWith('/update-install.cjs'))
  void main().catch((error) => { console.error(error); process.exitCode = 1 })
