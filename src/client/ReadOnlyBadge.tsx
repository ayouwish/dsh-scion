/**
 * Read-only badge, browser half.
 *
 * A synced session is a read-only import on this machine: its log cannot be
 * appended to and an agent turn is refused. The conversation header should say
 * so rather than letting it look like ordinary local work, so this entry asks
 * the host (`GET /api/scion/session?session=<id>`) whether this machine holds
 * the id as an import and renders a chip when it does.
 *
 * The component renders nothing for ordinary sessions, and it speaks only DSH
 * design tokens so it follows the Web theme.
 */
import { createElement, useEffect, useState } from 'react'

/** Theme tokens the badge reads (same set as the scion panel). */
const T = {
  info: 'var(--dsw-alias-state-business-primary, #3b7ddd)',
  radiusSmall: 'var(--dsw-radius-sm, 4px)',
  code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  size: 'var(--dsh-content-font-size-secondary, 12px)',
} as const

/** What the host answers about one session. */
interface SessionState {
  readonly sessionId: string
  readonly readOnly: boolean
  readonly sourceRoot?: string
}

/** Props bound by the session-header utilities slot. */
export interface ReadOnlyBadgeProps {
  readonly sessionId: string
}

/** `originRoot` shortened to its last two segments. */
function machineLabel(root: string): string {
  const parts = root.split('/').filter(part => part.length > 0)
  return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`
}

/**
 * The read-only chip, or nothing when this machine owns the session.
 * @param props - slot-bound session identity.
 * @returns a chip for imported sessions, null otherwise.
 */
export function ReadOnlyBadge({ sessionId }: ReadOnlyBadgeProps): JSX.Element | null {
  const [state, setState] = useState<SessionState | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void fetch(`/api/scion/session?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) return undefined
        return await response.json().catch(() => undefined) as SessionState | undefined
      })
      .then((payload) => { if (!cancelled && payload !== undefined) setState(payload) })
      .catch(() => { /* the chip is decoration: a failed probe renders nothing */ })
    return () => { cancelled = true }
  }, [sessionId])

  if (state?.readOnly !== true) return null
  const from = state.sourceRoot === undefined ? 'another machine' : machineLabel(state.sourceRoot)
  return createElement('span', {
    title: `Read-only scion import synced from ${state.sourceRoot ?? 'another machine'}`,
    style: {
      fontFamily: T.code,
      fontSize: T.size,
      color: T.info,
      border: '1px solid currentColor',
      borderRadius: T.radiusSmall,
      padding: '0 5px',
      whiteSpace: 'nowrap',
      opacity: 0.92,
    },
  }, `只读 · ${from}`)
}
