/**
 * Scion panel, browser half: a session-header action that renders the current
 * scion's session tree — which machines exported what, and what is local or
 * read-only here.
 *
 * The component is deliberately dependency-free (React + inline styles): the
 * panel's data arrives as JSON from `GET /api/scion/tree`, so no client service
 * or generated contract is involved.
 */
import { createElement, useCallback, useEffect, useState } from 'react'

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

const MUTED: React.CSSProperties = { opacity: 0.62 }
const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
}

/** One badge chip. */
function Badge({ text, tone }: { readonly text: string; readonly tone: 'local' | 'readonly' | 'plain' }): JSX.Element {
  const background = tone === 'local' ? 'rgba(64,160,96,0.18)' : tone === 'readonly' ? 'rgba(64,120,200,0.18)' : 'rgba(127,127,127,0.16)'
  const color = tone === 'local' ? '#3f9d63' : tone === 'readonly' ? '#5b8dd6' : 'inherit'
  return createElement('span', {
    style: { ...MONO, padding: '0 5px', borderRadius: 4, background, color, marginLeft: 6, whiteSpace: 'nowrap' },
  }, text)
}

/** One session row. */
function SessionRow({ session }: { readonly session: TreeSession }): JSX.Element {
  return createElement('div', { style: { ...MONO, display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0 2px 18px' } },
    createElement('span', { style: { opacity: 0.55 } }, '└'),
    createElement('span', { style: { flex: '0 0 auto' } }, session.id),
    createElement('span', { style: MUTED }, `${String(session.events)} events`),
    createElement('span', { style: MUTED }, stamp(session.exportedAt)),
    session.bytes === undefined ? null : createElement('span', { style: MUTED }, bytes(session.bytes)),
    session.exportable ? createElement(Badge, { text: '本机·可导出', tone: 'local' })
      : session.readOnly ? createElement(Badge, { text: '只读导入', tone: 'readonly' })
        : session.local ? createElement(Badge, { text: '本机·未挂载', tone: 'plain' })
          : createElement(Badge, { text: '他机', tone: 'plain' }),
  )
}

/** One machine group with its sessions. */
function MachineGroup({ machine }: { readonly machine: TreeMachine }): JSX.Element {
  const [open, setOpen] = useState(true)
  return createElement('div', null,
    createElement('div', {
      style: { ...MONO, display: 'flex', alignItems: 'baseline', gap: 6, cursor: 'pointer', padding: '3px 0' },
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: MUTED }, open ? '▾' : '▸'),
      createElement('span', null, machineLabel(machine.originRoot)),
      createElement('span', { style: MUTED }, `${String(machine.sessions.length)} session(s)`),
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
      style: { ...MONO, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit' },
    }, 'Scion'),
    !open ? null : createElement('div', {
      style: {
        position: 'fixed', top: 56, right: 16, width: 'min(560px, 92vw)', maxHeight: '72vh', overflow: 'auto',
        zIndex: 60, padding: 12, borderRadius: 10, border: '1px solid rgba(127,127,127,0.28)',
        background: 'var(--dsh-surface, #1e1e22)', color: 'inherit', boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
      },
    },
      createElement('div', { style: { ...MONO, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 } },
        createElement('strong', null, snapshot === undefined ? 'scion' : `scion ${snapshot.scion.name}`),
        createElement('button', {
          type: 'button', onClick: close,
          style: { ...MONO, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.7 },
        }, '✕'),
      ),
      snapshot === undefined ? null : createElement('div', { style: { ...MONO, ...MUTED, marginTop: 4 } },
        createElement('div', null,
          `${snapshot.git.branch ?? '(unborn)'}`
          + (snapshot.git.upstream === undefined ? '' : ` → ${snapshot.git.upstream}`)
          + (snapshot.git.dirty ? ' · dirty' : ' · clean'),
        ),
        snapshot.git.remotes.length === 0 ? null
          : createElement('div', null, snapshot.git.remotes.map(remote => `${remote.name} ${remote.url ?? '(unset)'}`).join(' · ')),
        createElement('div', { style: { marginTop: 4 } },
          `repo ${String(snapshot.repo.sessions)} session(s) · ${bytes(snapshot.repo.bytes)}`
          + ` · local ${String(snapshot.local.sessionsWithCwd)} cwd-matching, ${String(snapshot.local.exportable)} exportable`
          + `, readonly ${String(snapshot.local.imported.length)}`,
        ),
      ),
      createElement('div', { style: { marginTop: 8, borderTop: '1px solid rgba(127,127,127,0.22)', paddingTop: 6 } },
        loading ? createElement('div', { style: { ...MONO, ...MUTED } }, 'loading…') : null,
        error === undefined ? null : createElement('div', { style: { ...MONO, color: '#d97b7b' } }, error),
        snapshot === undefined ? null : (snapshot.machines.length === 0
          ? createElement('div', { style: { ...MONO, ...MUTED } }, 'this repo carries no exported sessions yet')
          : createElement('div', null, ...snapshot.machines.map(machine =>
            createElement(MachineGroup, { key: machine.originRoot, machine })))),
      ),
    ),
  )
}
