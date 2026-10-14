/**
 * Scion panel, browser half.
 *
 * Two contributions:
 * - a session-header action that opens the scion tree panel ({@link ScionPanel});
 * - a read-only chip in the session-header utilities ({@link ReadOnlyBadge})
 *   that marks synced imports.
 *
 * Both fetch their own data from the host (`GET /api/scion/tree`,
 * `GET /api/scion/session`), so this plugin needs no generated remote contract
 * — only the slot registry.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ReadOnlyBadge } from './ReadOnlyBadge.tsx'
import { ScionPanel } from './ScionPanel.tsx'
import { SessionRowMark } from './SessionRowMark.tsx'

/** Client plugin name. */
export const name = 'scion-panel'

/** Required client services: the slot registry. */
export const inject = ['slots']

/**
 * Register the session-header action and the read-only chip.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'scion-tree',
    order: 30,
  }, ScionPanel))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'scion-readonly',
    order: 30,
  }, ReadOnlyBadge))

  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'scion-readonly-mark',
    order: 20,
  }, SessionRowMark))
}
