/**
 * Export: local sessions → the scion repo.
 *
 * Only sessions this machine **owns** are exported. Imported (read-only)
 * sessions are skipped, because the repo already carries a byte-faithful copy
 * of them and rewriting that copy is exactly what the read-only rule prevents.
 *
 * @module @asyouwish/dsh-scion/export
 */

import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ScionOwnershipStore } from './ownership.ts'
import type { ScionManifest } from './types.ts'
import { readManifest, upsertManifestSession, writeManifest } from './manifest.ts'
import { repoSessionPath, repoSessionsDir } from './paths.ts'
import { encodeScionSession } from './repo-format.ts'
import { canonicalizeOrSelf, ensureDir, writeTextAtomic } from './fs-util.ts'

/** Inputs for {@link exportSessions}. */
export interface ScionExportOptions {
  /** Scion root (the git repo). */
  readonly root: string
  /** Explicit session selection; omitted exports every local-owned session of this root. */
  readonly sessionIds?: readonly string[]
  /** Machine-local ownership index. */
  readonly ownership: ScionOwnershipStore
  readonly signal?: AbortSignal
}

/** One exported session. */
export interface ScionExportedSession {
  readonly id: string
  readonly eventCount: number
}

/** Outcome of one export. */
export interface ScionExportResult {
  readonly root: string
  readonly exported: readonly ScionExportedSession[]
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
  /** Total plaintext bytes written into the repo by this run. */
  readonly bytesWritten: number
}

/**
 * List the local sessions that belong to a scion root and are owned here.
 *
 * Membership is the canonical-cwd equality DSH itself uses for workspaces;
 * imported sessions are excluded so a replica never re-exports foreign work.
 *
 * @param ctx - host context.
 * @param root - canonical scion root.
 * @param ownership - machine-local ownership index.
 * @returns headers of exportable local sessions.
 */
export async function listLocalSessions(
  ctx: Context,
  root: string,
  ownership: ScionOwnershipStore,
): Promise<SessionHeader[]> {
  const snapshots = await ctx.sessionPersistence.list()
  const selected: SessionHeader[] = []
  for (const snapshot of snapshots) {
    const header = snapshot.header
    if (ownership.isImported(header.id)) continue
    const cwd = header.cwd
    if (cwd === undefined) continue
    if (!isUnder(cwd, root)) continue
    if (await canonicalizeOrSelf(cwd) !== root) continue
    selected.push(header)
  }
  selected.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  return selected
}

/**
 * Export sessions into the scion repo.
 * @param ctx - host context.
 * @param options - root, selection, ownership, and cancellation.
 * @returns what was exported.
 * @throws when the root is not an initialized scion.
 */
export async function exportSessions(
  ctx: Context,
  options: ScionExportOptions,
): Promise<ScionExportResult> {
  const root = await canonicalizeOrSelf(options.root)
  const manifest = await readManifest(root)
  if (manifest === undefined) {
    throw new Error(`not an initialized scion (no .dsh/scion.json): ${root}`)
  }
  const local = await listLocalSessions(ctx, root, options.ownership)
  const selected = selectSessions(local, options.sessionIds)
  await ensureDir(repoSessionsDir(root))

  let next: ScionManifest = manifest
  let bytesWritten = 0
  const exported: ScionExportedSession[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const header of selected) {
    const id = String(header.id)
    try {
      // A read handle never takes write ownership, so exporting a session that
      // another machine is still writing is safe and reads its valid prefix.
      const handle = await ctx.sessionPersistence.open(header.id, 'read', openOptions(options.signal))
      let eventCount = 0
      let inheritedEventCount = 0
      let body: string
      try {
        const slice = await handle.read(0)
        eventCount = slice.events.length
        inheritedEventCount = Number(handle.inheritedEventCount)
        body = encodeScionSession({
          header: handle.header,
          sessionFormatVersion: SESSION_FORMAT_VERSION,
          inheritedEventCount,
          originRoot: root,
          events: slice.events,
        })
      } finally {
        await handle.close()
      }
      await writeTextAtomic(repoSessionPath(root, id), body)
      bytesWritten += Buffer.byteLength(body, 'utf8')
      exported.push({ id, eventCount })
      next = upsertManifestSession(next, {
        id,
        inheritedEventCount,
        eventCount,
        originRoot: root,
        exportedAt: new Date().toISOString(),
      })
    } catch (error: unknown) {
      skipped.push({ id, reason: String((error as Error).message) })
    }
  }
  await writeManifest(root, next)
  return { root, exported, skipped, bytesWritten }
}

/**
 * Apply an explicit selection to the exportable set.
 * @param local - exportable local sessions.
 * @param sessionIds - requested ids, when any.
 * @returns the sessions to export.
 * @throws when a requested id is not an exportable local session.
 */
function selectSessions(
  local: readonly SessionHeader[],
  sessionIds: readonly string[] | undefined,
): readonly SessionHeader[] {
  if (sessionIds === undefined) return local
  const wanted = new Set(sessionIds)
  const available = new Set(local.map(header => String(header.id)))
  const missing = [...wanted].filter(id => !available.has(id))
  if (missing.length > 0) {
    throw new Error(
      `not local sessions owned by this scion: ${missing.join(', ')} `
      + '(imported sessions are read-only and are never re-exported)',
    )
  }
  return local.filter(header => wanted.has(String(header.id)))
}

/**
 * Cheap containment test before the canonicalizing check.
 * @param path - candidate path.
 * @param root - canonical root.
 * @returns true when the path is the root or below it.
 */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Build open options without an explicit `undefined` signal.
 * @param signal - optional cancellation.
 * @returns options for `sessionPersistence.open`.
 */
function openOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}
