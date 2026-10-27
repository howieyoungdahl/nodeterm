import { expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

it('generates a server CPU weight for both install scopes without imposing a CPU quota', () => {
  const installer = readFileSync(path.resolve('scripts/install-server.sh'), 'utf8')
  const unit = installer.split('write_unit() {')[1].split('UNIT\n}')[0]
  expect(unit).toContain('[Service]\n# Prefer')
  expect(unit).toContain('CPUWeight=1000\nType=simple')
  expect(unit).toContain('KillMode=process')
  expect(unit).not.toContain('CPUQuota=')
  expect(installer).toContain('write_unit "$UNIT_PATH" "multi-user.target"')
  expect(installer).toContain('write_unit "$UNIT_PATH" "default.target"')
})
