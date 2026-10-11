/**
 * Local DSH workspace synthesis.
 *
 * A scion's identity cannot live in DSH's workspace registry: that registry is
 * machine-local (`$DSH_HOME/storages/workspace.json`), keys membership on the
 * canonical absolute path, and builds its canonical header index at startup.
 * So the plugin owns the scion, and the DSH workspace is a per-machine
 * projection of it: each machine registers a workspace for its own clone path
 * and attaches the sessions it imports there.
 *
 * @module @asyouwish/dsh-scion/workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { canonicalizeOrSelf } from './fs-util.ts'

/** Outcome of attaching imported sessions to the local workspace. */
export interface ScionAttachOutcome {
  readonly workspaceId: string | undefined
  readonly attached: readonly string[]
  readonly failed: readonly { readonly id: string; readonly reason: string }[]
}

/**
 * Find the workspace whose canonical path is this root, creating one when absent.
 *
 * @param ctx - host context.
 * @param localRoot - canonical local root.
 * @returns the workspace, or `undefined` when no workspace registry is composed.
 */
export async function ensureWorkspaceFor(ctx: Context, localRoot: string): Promise<Workspace | undefined> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  const root = await canonicalizeOrSelf(localRoot)
  const existing = registry.list().find(workspace => workspace.path === root)
  if (existing !== undefined) return existing
  return await registry.create(root)
}

/**
 * Attach imported sessions to the local workspace.
 *
 * This is also the plugin's post-import self-check: `attachSession` validates
 * the stored header cwd against the workspace path and publishes the id into
 * the registry's canonical index, so a session that fails to attach is
 * reported with its concrete reason instead of leaving the user to restart.
 *
 * @param ctx - host context.
 * @param localRoot - canonical local root.
 * @param sessionIds - imported session ids.
 * @returns what attached and what did not.
 */
export async function attachImported(
  ctx: Context,
  localRoot: string,
  sessionIds: readonly string[],
): Promise<ScionAttachOutcome> {
  const workspace = await ensureWorkspaceFor(ctx, localRoot)
  if (workspace === undefined) {
    return { workspaceId: undefined, attached: [], failed: [] }
  }
  const attached: string[] = []
  const failed: { id: string; reason: string }[] = []
  for (const id of sessionIds) {
    try {
      await workspace.attachSession(id as Parameters<Workspace['attachSession']>[0])
      attached.push(id)
    } catch (error: unknown) {
      failed.push({ id, reason: String((error as Error).message) })
    }
  }
  return { workspaceId: String(workspace.id), attached, failed }
}

/**
 * Confirm that a session is visible inside the local workspace after import.
 * @param ctx - host context.
 * @param localRoot - canonical local root.
 * @param sessionId - session to check.
 * @returns whether the workspace accounts for the session.
 */
export async function isAttached(
  ctx: Context,
  localRoot: string,
  sessionId: string,
): Promise<boolean> {
  const workspace = await ensureWorkspaceFor(ctx, localRoot)
  if (workspace === undefined) return false
  return workspace.sessionIds.some(id => String(id) === sessionId)
}
