import { useTerminalAvailability } from '../state/terminalAvailability'
import { terminalKey } from '../terminal/terminal-config'

export function CardRoleChip({
  sessionId, parentId, parentTitle, childIds, onOpenParent
}: {
  sessionId: string
  parentId?: string
  parentTitle?: string
  childIds?: readonly string[]
  onOpenParent?: (id: string) => void
}): JSX.Element | null {
  const director = useTerminalAvailability(s =>
    childIds?.some(id => !s.unavailable.has(terminalKey(sessionId, id))) === true
  )
  if (!director && !parentId) return null
  const worker = parentTitle ? `Worker · ${parentTitle}` : 'Worker'
  return <>
    {director && <span className="node-account-chip">Director</span>}
    {parentId && (parentTitle !== undefined && onOpenParent
      ? <button type="button" className="node-account-chip card-role-chip nodrag nopan"
          title={worker} onClick={event => {
            event.stopPropagation()
            onOpenParent(parentId)
          }}>{worker}</button>
      : <span className="node-account-chip" title={worker}>{worker}</span>)}
  </>
}
