/**
 * Prune: drop repo sessions the current export scope no longer selects.
 *
 * Push makes the repo a superset over time — export never deletes, so a session
 * that stops being exportable (a subagent child the workspace never accounted,
 * or one the user detached) leaves its file behind forever. Prune is the
 * inverse of export and deliberately conservative, because the repo is a shared
 * transport rather than one machine's private store:
 *
 * - only manifest-recorded sessions are considered; `.jsonl` files with no
 *   manifest record are reported as *unmanaged* and never touched;
 * - by default a session is stale only when it is still a locally owned,
 *   cwd-matching session that the workspace record does not account — exactly
 *   the complement of the default export scope. A fresh clone with no local
 *   sessions, or a machine that imported these ids read-only, therefore prunes
 *   nothing;
 * - an explicit `--sessions` selection is honored for any recorded id, so a
 *   session whose local log is already gone can still be dropped on purpose.
 *
 * @module @asyouwish/dsh-scion/prune
 */

import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ScionOwnershipStore } from './ownership.ts'
import type { ScionManifest, ScionManifestSession } from './types.ts'
import { listRepoSessionIds, readManifest, removeManifestSession, writeManifest } from './manifest.ts'
import { repoSessionPath } from './paths.ts'
import { canonicalizeOrSelf } from './fs-util.ts'
import { listCandidateSessions, scopeToWorkspace } from './export.ts'

/** Why one repo session is being pruned. */
export type ScionPruneReason = 'not-workspace-owned' | 'requested'

/** One repo session this prune removes. */
export interface ScionPrunedSession {
  readonly id: string
  readonly eventCount: number
  readonly reason: ScionPruneReason
}

/** Inputs for {@link planPrune} and {@link pruneSessions}. */
export interface ScionPruneOptions {
  /** Scion root (the git repo). */
  readonly root: string
  /** Machine-local ownership index. */
  readonly ownership: ScionOwnershipStore
  /** Explicit ids to drop; omitted drops every recorded session the workspace no longer owns. */
  readonly sessionIds?: readonly string[]
  /** Optional cancellation observed between deletions. */
  readonly signal?: AbortSignal
  /** Called after each repo file is removed, for job progress narration. */
  readonly onProgress?: (done: number, total: number, id: string) => void
}

/** What a prune does, computed before anything is deleted. */
export interface ScionPrunePlan {
  readonly root: string
  readonly pruned: readonly ScionPrunedSession[]
  /** Recorded sessions this plan leaves in the repo. */
  readonly kept: number
  /** Repo session files with no manifest record; reported, never deleted. */
  readonly unmanaged: readonly string[]
}

/** A plan plus the manifest it was computed from. */
interface ScionComputedPrune {
  readonly plan: ScionPrunePlan
  readonly manifest: ScionManifest
}

/**
 * Compute what a prune would remove, without touching the filesystem.
 * @param ctx - host context.
 * @param options - root, ownership, and optional explicit selection.
 * @returns the plan.
 * @throws when the root is not an initialized scion, or a requested id is not recorded.
 */
export async function planPrune(ctx: Context, options: ScionPruneOptions): Promise<ScionPrunePlan> {
  return (await computePrune(ctx, options)).plan
}

/**
 * Delete the planned repo session files and drop their manifest records.
 *
 * The caller owns the commit, exactly as with export. A plan with nothing to
 * prune changes no file at all.
 *
 * @param ctx - host context.
 * @param options - root, ownership, and optional explicit selection.
 * @returns what was pruned.
 * @throws when the root is not an initialized scion, or a requested id is not recorded.
 */
export async function pruneSessions(ctx: Context, options: ScionPruneOptions): Promise<ScionPrunePlan> {
  const { plan, manifest } = await computePrune(ctx, options)
  if (plan.pruned.length === 0) return plan
  let next = manifest
  for (const [position, entry] of plan.pruned.entries()) {
    options.signal?.throwIfAborted()
    await rm(repoSessionPath(plan.root, entry.id), { force: true })
    next = removeManifestSession(next, entry.id)
    options.onProgress?.(position + 1, plan.pruned.length, entry.id)
  }
  await writeManifest(plan.root, next)
  return plan
}

/**
 * Compute a prune plan and keep the manifest it read.
 * @param ctx - host context.
 * @param options - root, ownership, and optional explicit selection.
 * @returns the plan and its source manifest.
 */
async function computePrune(ctx: Context, options: ScionPruneOptions): Promise<ScionComputedPrune> {
  const root = await canonicalizeOrSelf(options.root)
  const manifest = await readManifest(root)
  if (manifest === undefined) {
    throw new Error(`not an initialized scion (no .dsh/scion.json): ${root}`)
  }
  const recorded = new Map(manifest.sessions.map(entry => [entry.id, entry]))
  const selected: { readonly entry: ScionManifestSession; readonly reason: ScionPruneReason }[] = []

  if (options.sessionIds === undefined) {
    const candidates = await listCandidateSessions(ctx, root, options.ownership)
    const members = new Set((await scopeToWorkspace(ctx, root, candidates)).map(header => String(header.id)))
    for (const header of candidates) {
      const id = String(header.id)
      if (members.has(id)) continue
      const entry = recorded.get(id)
      if (entry !== undefined) selected.push({ entry, reason: 'not-workspace-owned' })
    }
  } else {
    const missing = options.sessionIds.filter(id => !recorded.has(id))
    if (missing.length > 0) {
      throw new Error(`not exported sessions of this scion: ${missing.join(', ')}`)
    }
    const wanted = new Set(options.sessionIds)
    for (const entry of manifest.sessions) {
      if (wanted.has(entry.id)) selected.push({ entry, reason: 'requested' })
    }
  }

  const prunedIds = new Set(selected.map(item => item.entry.id))
  const unmanaged = (await listRepoSessionIds(root)).filter(id => !recorded.has(id))
  return {
    manifest,
    plan: {
      root,
      pruned: selected.map(item => ({
        id: item.entry.id,
        eventCount: item.entry.eventCount,
        reason: item.reason,
      })),
      kept: manifest.sessions.length - prunedIds.size,
      unmanaged,
    },
  }
}
