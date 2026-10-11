/**
 * The read-only gate.
 *
 * Three layers keep an imported session unwritable, in decreasing strength:
 *
 * 1. **Filesystem** — the imported session directory and its files are made
 *    unwritable. A write handle must first open `session.lock` for writing to
 *    take the kernel lease, so `EACCES` there fails the write open outright.
 *    Read handles never touch the lock, so reading and forking are unaffected.
 *    POSIX-only: Windows ignores these bits.
 * 2. **Ownership** — the plugin's durable index marks the id imported; the
 *    command surface refuses to export it and reports it as read-only.
 * 3. **Model step** — this gate vetoes `agent/pre-step`, the same mechanism
 *    `ArchivedSessionGate` uses. Pre-step runs before any `user/message` is
 *    appended, so a veto writes no prompt content into the log.
 *
 * Forking is deliberately unaffected at every layer: a fork reads the source
 * through `observeSession` and creates a new session id elsewhere.
 *
 * @module @asyouwish/dsh-scion/readonly
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ScionOwnershipStore } from './ownership.ts'

/**
 * Whether a session id is an imported, read-only scion session.
 * @param ownership - machine-local ownership index.
 * @param sessionId - session id to test.
 * @returns true when the session was imported.
 */
export function isReadOnlySession(ownership: ScionOwnershipStore, sessionId: string): boolean {
  return ownership.isImported(sessionId)
}

/**
 * Register the pre-step veto for imported sessions.
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 */
export function installReadOnlyGate(ctx: Context, ownership: ScionOwnershipStore): void {
  ctx.on('agent/pre-step', ({ agent }, next): Promise<PreStepDecision> => {
    return isReadOnlySession(ownership, String(agent.session.header.id))
      ? Promise.resolve({ kind: 'reject' as const })
      : next()
  })
}
