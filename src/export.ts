/**
 * Export: local sessions → the scion repo.
 *
 * Only sessions this machine **owns** are exported. Imported (read-only)
 * sessions are skipped, because the repo already carries a byte-faithful copy
 * of them and rewriting that copy is exactly what the read-only rule prevents.
 *
 * Membership follows DSH's own workspace rule, not bare directory equality: a
 * session belongs to the workspace registered for `root` only when it is on
 * that record's account **and** its header's canonical cwd equals `root` —
 * exactly what `Workspace.sessionIds` projects. Bare cwd equality would also
 * sweep in subagent child sessions and sessions the workspace never attached,
 * which DSH itself does not group under the workspace.
 *
 * @module @asyouwish/dsh-scion/export
 */

import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
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
  /** Explicit session selection; omitted exports every workspace-owned local session of this root. */
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
 * The candidate set is every stored session this machine owns whose canonical
 * cwd is the root; it is then narrowed to the sessions DSH accounts to the
 * workspace registered for that path. See {@link scopeToWorkspace} for the
 * fallback used when no workspace record is available.
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
  return await scopeToWorkspace(ctx, root, await listCandidateSessions(ctx, root, ownership))
}

/**
 * List every stored session this machine owns whose canonical cwd is the root.
 *
 * This is the raw directory-scoped set — subagent child sessions and sessions
 * DSH never grouped under the workspace included. An explicit selection may
 * draw from it, so a session that is not a workspace member can still be
 * exported on request.
 *
 * @param ctx - host context.
 * @param root - canonical scion root.
 * @param ownership - machine-local ownership index.
 * @returns headers of cwd-matching local sessions, ordered by id.
 */
export async function listCandidateSessions(
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
 * Narrow cwd-matching candidates to the sessions DSH accounts to `root`.
 *
 * DSH membership is two conditions — an id on the workspace record's account
 * and a header whose canonical cwd equals the workspace path — and
 * `Workspace.sessionIds` already projects both. Candidates no workspace claims
 * (subagent child sessions, never-attached sessions) are dropped.
 *
 * Falls back to every candidate when the host composes no workspace registry,
 * when no workspace is registered for `root`, or when that record's account is
 * empty: an empty account means DSH holds no ownership knowledge for this
 * directory yet, not that the directory owns nothing, and exporting nothing
 * would be the worse error.
 *
 * @param ctx - host context.
 * @param root - canonical scion root.
 * @param candidates - cwd-matching local sessions.
 * @returns the workspace-owned subset, or every candidate on fallback.
 */
export async function scopeToWorkspace(
  ctx: Context,
  root: string,
  candidates: readonly SessionHeader[],
): Promise<SessionHeader[]> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return [...candidates]
  const workspace: Workspace | undefined = await registry.resolveByPath(root)
  if (workspace === undefined) return [...candidates]
  const account = new Set(workspace.sessionIds.map(String))
  if (account.size === 0) return [...candidates]
  return candidates.filter(header => account.has(String(header.id)))
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
  const candidates = await listCandidateSessions(ctx, root, options.ownership)
  const local = await scopeToWorkspace(ctx, root, candidates)
  const selected = selectSessions(local, candidates, options.sessionIds)
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
 *
 * Without `sessionIds` the workspace-scoped default is exported. With them,
 * any locally owned session whose canonical cwd is the root may be chosen —
 * including a subagent child session the workspace record does not account —
 * so an explicit request is honored rather than silently narrowed to
 * workspace membership.
 *
 * @param local - workspace-scoped default export set.
 * @param candidates - every cwd-matching locally owned session.
 * @param sessionIds - requested ids, when any.
 * @returns the sessions to export.
 * @throws when a requested id is not a locally owned session of this root.
 */
function selectSessions(
  local: readonly SessionHeader[],
  candidates: readonly SessionHeader[],
  sessionIds: readonly string[] | undefined,
): readonly SessionHeader[] {
  if (sessionIds === undefined) return local
  const wanted = new Set(sessionIds)
  const available = new Set(candidates.map(header => String(header.id)))
  const missing = [...wanted].filter(id => !available.has(id))
  if (missing.length > 0) {
    throw new Error(
      `not local sessions owned by this scion: ${missing.join(', ')} `
      + '(imported sessions are read-only and are never re-exported)',
    )
  }
  return candidates.filter(header => wanted.has(String(header.id)))
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
