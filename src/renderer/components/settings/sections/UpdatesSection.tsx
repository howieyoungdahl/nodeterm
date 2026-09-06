import { useEffect, useRef, useState } from 'react'
import { E_UNSUPPORTED } from '@shared/rpc'
import type { UpdateApi } from '@shared/types'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'

const ROWS = {
  updates: { title: 'Updates', keywords: ['update', 'version', 'check', 'upgrade'] }
}
const ENTRIES = Object.values(ROWS)
const unsupported = (reason: unknown): boolean =>
  !!reason && typeof reason === 'object' && 'code' in reason && reason.code === E_UNSUPPORTED
type VersionRead = { kind: 'loading' | 'unavailable' | 'error' } |
  { kind: 'ready'; value: string; api: UpdateApi }

export function UpdatesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const api = window.nodeTerminal.updates
  const [version, setVersion] = useState<VersionRead>({ kind: 'loading' })
  const [check, setCheck] = useState<'idle' | 'pending' | 'unavailable' | 'error'>('idle')
  const generation = useRef(0)
  const checking = useRef(false)
  useEffect(() => {
    const mine = ++generation.current
    checking.current = false
    setVersion({ kind: 'loading' })
    setCheck('idle')
    // Adopt synchronous throws as well as promise rejection from either shell.
    void Promise.resolve().then(() => api.getVersion()).then((value) => {
      if (generation.current !== mine) return
      if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid version response')
      setVersion({ kind: 'ready', value, api })
    }).catch((reason: unknown) => {
      if (generation.current === mine) setVersion({ kind: unsupported(reason) ? 'unavailable' : 'error' })
    })
    return () => { generation.current++ }
  }, [api])
  const ready = version.kind === 'ready' && version.api === api
  const requestCheck = (): void => {
    if (!ready || checking.current || check === 'unavailable') return
    const mine = generation.current
    checking.current = true
    setCheck('pending')
    void (async () => {
      try {
        // Desktop currently returns void. Await also consumes a rejecting promise bridge,
        // without treating a failed invocation as a successful request to the update card.
        await api.check()
        if (generation.current !== mine) return
        setCheck('idle')
        window.dispatchEvent(new CustomEvent('nodeterm:update-checking'))
      } catch (reason: unknown) {
        if (generation.current === mine) setCheck(unsupported(reason) ? 'unavailable' : 'error')
      } finally {
        if (generation.current === mine) checking.current = false
      }
    })()
  }
  return (
    <SettingsSection id="updates" title="Updates" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.updates}>
        <div className="space-y-3">
          <FieldRow
            label="Current version"
            control={<span className="text-[13px] text-muted">{ready ? version.value : version.kind === 'loading' ? '…' : 'Unavailable'}</span>}
          />
          {version.kind === 'unavailable' || version.kind === 'error' ? (
            <p role="status" className="text-sm text-muted">
              {version.kind === 'unavailable' ? 'Version and update checks are unavailable here.' : 'Could not read the current version. Update checks are unavailable until the version can be read.'}
            </p>
          ) : null}
          {check === 'unavailable' || check === 'error' ? (
            <p role="status" className="text-sm text-muted">
              {check === 'unavailable' ? 'Update checks are unavailable here.' : 'Update check request failed. No update status is confirmed.'}
            </p>
          ) : null}
          <Button
            disabled={!ready || check === 'pending' || check === 'unavailable'}
            onClick={requestCheck}
          >
            {check === 'pending' ? 'Requesting check…' : 'Check for updates'}
          </Button>
          <p className="text-sm text-muted">Results appear in the update card at the bottom-right.</p>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
