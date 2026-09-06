import { createPortal } from 'react-dom'
import { useSshServers } from '../state/sshServers'
import type { SshServer } from '@shared/ssh'

interface RemotePickerProps {
  x: number
  y: number
  onPick: (server: SshServer) => void
  onManage: () => void
  onClose: () => void
}

/** A small portal menu listing saved SSH servers; picking one opens a remote terminal. */
export function RemotePicker({ x, y, onPick, onManage, onClose }: RemotePickerProps) {
  const servers = useSshServers((s) => s.servers)
  const readError = useSshServers((s) => s.readError)
  return createPortal(
    <>
      <div className="ctx-backdrop" onClick={onClose} />
      <div className="ctx-menu" style={{ top: y, left: x }} onClick={(e) => e.stopPropagation()}>
        {readError ? <div role="status" className="ctx-item">{readError}</div> : servers.length === 0 ? (
          <button
            className="ctx-item"
            onClick={() => {
              onManage()
              onClose()
            }}
          >
            Add SSH server…
          </button>
        ) : (
          <>
            {servers.map((s) => (
              <button
                key={s.id}
                className="ctx-item"
                title={`${s.user}@${s.host}`}
                onClick={() => {
                  onPick(s)
                  onClose()
                }}
              >
                {s.label}
              </button>
            ))}
            <div className="ctx-sep" />
            <button
              className="ctx-item"
              onClick={() => {
                onManage()
                onClose()
              }}
            >
              Manage SSH servers…
            </button>
          </>
        )}
      </div>
    </>,
    document.body
  )
}
