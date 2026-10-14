/**
 * Read-only mark for a sidebar session row.
 *
 * A synced session looks exactly like local work in the workspace list, which is
 * misleading: it cannot be continued (its log is immutable and the pre-step gate
 * rejects turns). This mark renders a `只读` chip on imported rows, from the
 * cached `GET /api/scion/imports` map — one request per page, not per row.
 */
import { createElement } from 'react'
import { useImports } from './imports.ts'

/** Theme tokens the mark reads (shared with the header badge). */
const T = {
  info: 'var(--dsw-alias-state-business-primary, #3b7ddd)',
  radiusSmall: 'var(--dsw-radius-sm, 4px)',
  code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  size: 'var(--dsh-content-font-size-secondary, 12px)',
} as const

/** Props bound by the sidebar session-row leading slot. */
export interface SessionRowMarkProps {
  readonly sessionId: string
}

/** `originRoot` shortened to its last two segments. */
function machineLabel(root: string): string {
  const parts = root.split('/').filter(part => part.length > 0)
  return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`
}

/**
 * The row mark, or nothing for a locally owned session.
 * @param props - slot-bound session identity.
 * @returns the chip for imported rows, null otherwise.
 */
export function SessionRowMark({ sessionId }: SessionRowMarkProps): JSX.Element | null {
  const imports = useImports()
  const record = imports?.get(sessionId)
  if (record === undefined) return null
  return createElement('span', {
    title: `只读：scion 从 ${record.sourceRoot} 同步的副本，不能继续对话`,
    'data-scion-readonly': '',
    // The row itself is the activation target; a press on the mark must not open
    // (and thereby try to resume) the read-only session.
    onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation() },
    style: {
      fontFamily: T.code,
      fontSize: T.size,
      color: T.info,
      border: '1px solid currentColor',
      borderRadius: T.radiusSmall,
      padding: '0 4px',
      marginRight: 6,
      whiteSpace: 'nowrap',
      opacity: 0.92,
      flex: '0 0 auto',
    },
  }, `只读·${machineLabel(record.sourceRoot)}`)
}
