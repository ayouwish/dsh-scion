/**
 * Scion panel, browser half: a session-header action that renders the current
 * scion's session tree — which machines exported what, and what is local or
 * read-only here.
 *
 * The component is deliberately dependency-free (React + inline styles) and
 * speaks only DSH design tokens (`--dsw-alias-*`, `--ds-font-family-code`,
 * `--dsh-content-font-size-secondary`), so it follows the Web theme in light
 * and dark alike instead of pinning a palette. Fallbacks are scheme-neutral
 * (`Canvas`/`CanvasText`, mid-gray borders) so an unknown token still renders.
 */
import { createElement, useCallback, useEffect, useState } from 'react'

/** Theme tokens the panel reads. */
const T = {
  /** Popover surface (layer 1 is the standard raised card). */
  surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
  /** Primary label color. */
  text: 'var(--dsw-alias-label-primary, CanvasText)',
  /** Secondary label color. */
  secondary: 'var(--dsw-alias-label-secondary, #808080)',
  /** Tertiary/caption color. */
  muted: 'var(--dsw-alias-label-tertiary, #808080)',
  /** Standard border. */
  border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
  /** Hairline divider. */
  divider: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
  /** Raised shadow. */
  shadow: 'var(--dsw-shadow-lv2, 0 8px 28px rgba(0,0,0,0.22))',
  /** Card radius. */
  radius: 'var(--dsw-radius-lg, 10px)',
  /** Chip radius. */
  radiusSmall: 'var(--dsw-radius-sm, 4px)',
  /** State colors. */
  success: 'var(--dsw-alias-state-success-primary, #2f9e63)',
  info: 'var(--dsw-alias-state-business-primary, #3b7ddd)',
  warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
  error: 'var(--dsw-alias-state-error-primary, #c0392b)',
  /** Monospace stack and the user-adjustable secondary content size. */
  code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  size: 'var(--dsh-content-font-size-secondary, 12px)',
} as const

/** One exported session in the snapshot. */
interface TreeSession {
  readonly id: string
  readonly events: number
  readonly inheritedEvents: number
  readonly exportedAt: string
  readonly local: boolean
  readonly readOnly: boolean
  readonly exportable: boolean
  readonly bytes?: number
}

/** Exported sessions grouped by the machine that exported them. */
interface TreeMachine {
  readonly originRoot: string
  readonly sessions: readonly TreeSession[]
}

/** The host snapshot behind the panel. */
interface TreeSnapshot {
  readonly scion: { readonly name: string; readonly id: string; readonly root: string }
  readonly git: {
    readonly branch?: string
    readonly upstream?: string
    readonly dirty: boolean
    readonly remotes: readonly { readonly name: string; readonly url?: string }[]
  }
  readonly repo: { readonly sessions: number; readonly bytes: number }
  readonly machines: readonly TreeMachine[]
  readonly local: {
    readonly sessionsWithCwd: number
    readonly exportable: number
    readonly imported: readonly { readonly id: string; readonly sourceRoot: string; readonly events: number }[]
  }
}

/** Props bound by the session-header action slot. */
export interface ScionPanelProps {
  readonly sessionId: string
}

/** Bytes rendered for humans. */
function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

/** Timestamp rendered as `MM-DD HH:mm`, or the raw value when unparsable. */
function stamp(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  const date = new Date(parsed)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `originRoot` shortened to its last two segments. */
function machineLabel(root: string): string {
  const parts = root.split('/').filter(part => part.length > 0)
  return parts.length <= 2 ? root : `…/${parts.slice(-2).join('/')}`
}

/** Code-font text at the content's secondary size. */
const CODE: React.CSSProperties = { fontFamily: T.code, fontSize: T.size }
/** Dimmed code-font text. */
const DIM: React.CSSProperties = { ...CODE, color: T.muted }

/** One badge chip: state-colored text and border, no background fill. */
function Badge({ text, color }: { readonly text: string; readonly color: string }): JSX.Element {
  return createElement('span', {
    style: {
      ...CODE,
      color,
      border: '1px solid currentColor',
      borderRadius: T.radiusSmall,
      padding: '0 5px',
      marginLeft: 6,
      whiteSpace: 'nowrap',
      opacity: 0.92,
    },
  }, text)
}

/** One session row. */
function SessionRow({ session }: { readonly session: TreeSession }): JSX.Element {
  return createElement('div', { style: { ...CODE, display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0 2px 18px' } },
    createElement('span', { style: { color: T.muted } }, '└'),
    createElement('span', { style: { flex: '0 0 auto', color: T.text } }, session.id),
    createElement('span', { style: DIM }, `${String(session.events)} events`),
    createElement('span', { style: DIM }, stamp(session.exportedAt)),
    session.bytes === undefined ? null : createElement('span', { style: DIM }, bytes(session.bytes)),
    session.exportable ? createElement(Badge, { text: '本机·可导出', color: T.success })
      : session.readOnly ? createElement(Badge, { text: '只读导入', color: T.info })
        : session.local ? createElement(Badge, { text: '本机·未挂载', color: T.secondary })
          : createElement(Badge, { text: '他机', color: T.secondary }),
  )
}

/** One machine group with its sessions. */
function MachineGroup({ machine }: { readonly machine: TreeMachine }): JSX.Element {
  const [open, setOpen] = useState(true)
  return createElement('div', null,
    createElement('div', {
      style: { ...CODE, display: 'flex', alignItems: 'baseline', gap: 6, cursor: 'pointer', padding: '3px 0', color: T.text },
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: { color: T.muted } }, open ? '▾' : '▸'),
      createElement('span', null, machineLabel(machine.originRoot)),
      createElement('span', { style: DIM }, `${String(machine.sessions.length)} session(s)`),
    ),
    open ? createElement('div', { style: { paddingLeft: 6 } },
      ...machine.sessions.map(session => createElement(SessionRow, { key: session.id, session }))) : null,
  )
}

/**
 * The header action and its popover panel.
 * @param props - slot-bound session identity.
 * @returns the action button plus the panel while open.
 */
export function ScionPanel({ sessionId }: ScionPanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<TreeSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const close = useCallback(() => { setOpen(false) }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void fetch(`/api/scion/tree?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
      .then(async response => {
        const payload = await response.json().catch(() => undefined) as (TreeSnapshot & { error?: string }) | undefined
        if (cancelled) return
        if (!response.ok || payload === undefined || payload.error !== undefined) {
          setError(payload?.error ?? `HTTP ${String(response.status)}`)
          setSnapshot(undefined)
          return
        }
        setSnapshot(payload)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, sessionId])

  return createElement('span', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', {
      type: 'button',
      title: 'Scion: sessions in this workspace repo',
      onClick: () => { setOpen(value => !value) },
      style: {
        ...CODE,
        padding: '2px 8px',
        borderRadius: T.radiusSmall,
        cursor: 'pointer',
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: 'inherit',
      },
    }, 'Scion'),
    !open ? null : createElement('div', {
      style: {
        position: 'fixed', top: 56, right: 16, width: 'min(560px, 92vw)', maxHeight: '72vh', overflow: 'auto',
        zIndex: 60, padding: 12, borderRadius: T.radius,
        border: `1px solid ${T.border}`, background: T.surface, color: T.text, boxShadow: T.shadow,
      },
    },
      createElement('div', { style: { ...CODE, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
        createElement('strong', null, snapshot === undefined ? 'scion' : `scion ${snapshot.scion.name}`),
        createElement('button', {
          type: 'button', onClick: close,
          style: { ...CODE, border: 'none', background: 'transparent', color: T.muted, cursor: 'pointer' },
        }, '✕'),
      ),
      snapshot === undefined ? null : createElement('div', { style: { ...CODE, color: T.muted, marginTop: 4 } },
        createElement('div', null,
          createElement('span', { style: { color: snapshot.git.dirty ? T.warn : T.secondary } },
            `${snapshot.git.branch ?? '(unborn)'}`
            + (snapshot.git.upstream === undefined ? '' : ` → ${snapshot.git.upstream}`)
            + (snapshot.git.dirty ? ' · dirty' : ' · clean'),
          ),
        ),
        snapshot.git.remotes.length === 0 ? null
          : createElement('div', null, snapshot.git.remotes.map(remote => `${remote.name} ${remote.url ?? '(unset)'}`).join(' · ')),
        createElement('div', { style: { marginTop: 4 } },
          `repo ${String(snapshot.repo.sessions)} session(s) · ${bytes(snapshot.repo.bytes)}`
          + ` · local ${String(snapshot.local.sessionsWithCwd)} cwd-matching, ${String(snapshot.local.exportable)} exportable`
          + `, readonly ${String(snapshot.local.imported.length)}`,
        ),
      ),
      createElement('div', { style: { marginTop: 8, borderTop: `1px solid ${T.divider}`, paddingTop: 6 } },
        loading ? createElement('div', { style: DIM }, 'loading…') : null,
        error === undefined ? null : createElement('div', { style: { ...CODE, color: T.error } }, error),
        snapshot === undefined ? null : (snapshot.machines.length === 0
          ? createElement('div', { style: DIM }, 'this repo carries no exported sessions yet')
          : createElement('div', null, ...snapshot.machines.map(machine =>
            createElement(MachineGroup, { key: machine.originRoot, machine })))),
      ),
    ),
  )
}
