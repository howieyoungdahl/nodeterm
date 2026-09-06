import { promises as fs } from 'node:fs'
import { ServerUpdater, systemUpdateRuntime, type UpdateConfig } from '../core/server-updater'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const configFile = args[0]
  if (!configFile || args.slice(1).some((arg) => !['--apply', '--retry'].includes(arg)))
    throw new Error('Usage: updater.cjs CONFIG.json [--apply] [--retry] (run under flock)')
  const config = JSON.parse(await fs.readFile(configFile, 'utf8')) as UpdateConfig
  const updater = new ServerUpdater(config, systemUpdateRuntime(config))
  const result = await updater.update(args.includes('--apply'), args.includes('--retry'))
  if (result.outcome === 'failed' || result.outcome === 'blocked') process.exitCode = 1
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
