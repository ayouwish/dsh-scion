/**
 * The read-only gate.
 *
 * Three layers keep an imported session from accepting new work, in decreasing
 * strength:
 *
 * 1. **Filesystem** — every entry of the imported session, the directory and
 *    the session log included, is made unwritable, so appending events or
 *    rewriting the log (a rename needs a writable directory) fails with
 *    `EACCES`. One entry is deliberately left writable: the persistence lease
 *    file `session.lock`, which DSH opens for writing whenever it attaches a
 *    session, and its projection layer — the source of the titles a session
 *    list reads — only checkpoints **live** sessions. A fully unwritable import
 *    can therefore never be attached, which is exactly what leaves synced
 *    sessions unnamed and re-folding their log on every visit.
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
import { applyReadonlyImportModes } from './fs-util.ts'
import { locateSessionDir } from './locate.ts'

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
 * Re-apply the current read-only mode set to every import this machine owns.
 *
 * Imports made by an earlier version were fully 0555/0444, which blocks the
 * persistence lease and therefore DSH's projection checkpoints; running this on
 * plugin load repairs them in place, without a re-import. Best-effort: a
 * missing directory or a permission failure on one record never fails the boot.
 *
 * @param ownership - machine-local ownership index.
 * @returns the number of session directories the mode set was applied to.
 */
export async function refreshImportedModes(ownership: ScionOwnershipStore): Promise<number> {
  let refreshed = 0
  for (const record of ownership.all()) {
    try {
      const directory = await locateSessionDir(record.localRoot, record.sessionId)
      if (directory === undefined) continue
      await applyReadonlyImportModes(directory)
      refreshed += 1
    } catch {
      // A record whose directory is gone or unreachable is not a boot failure.
    }
  }
  return refreshed
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
