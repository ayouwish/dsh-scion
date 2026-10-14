/**
 * Scion panel, browser half.
 *
 * One contribution: a session-header action that opens the scion tree panel
 * (see {@link ScionPanel}). The panel fetches its own data from the host's
 * `GET /api/scion/tree`, so this plugin needs no generated remote contract —
 * only the slot registry.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ScionPanel } from './ScionPanel.tsx'

/** Client plugin name. */
export const name = 'scion-panel'

/** Required client services: the slot registry. */
export const inject = ['slots']

/**
 * Register the session-header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'scion-tree',
    order: 30,
  }, ScionPanel))
}
