/**
 * dsh-scion — portable workspace + session units carried by git.
 *
 * A **scion** is a git repository that carries a workspace plus a selected set
 * of session logs. Export writes local sessions into `.dsh/sessions/` in a
 * plain, diffable envelope; import materializes foreign ones as **read-only**
 * local sessions whose working directory is localized to this machine's clone
 * path. Only the workspace content is merged — session logs are append-only
 * records that are forked, never merged.
 *
 * Why the log itself is never rewritten: a session log is an append-only,
 * self-describing record with dense sequence numbers and a fork cut carried by
 * an in-log marker. Two machines appending to one id would collide on those
 * sequence numbers and produce a log the backend refuses to load. So an
 * imported session is unwritable by construction, and continuing foreign work
 * means forking it into a new id that this machine owns.
 *
 * Composition:
 * - the plugin activates once `sessionPersistence` and `sessionQuery` exist;
 * - the `/scion` command registers only when a command registry is composed;
 * - the workspace registry is optional — without it, imported sessions are
 *   still listed (they appear under Ungrouped).
 *
 * @module @asyouwish/dsh-scion
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { ScionOwnershipStore } from './ownership.ts'
import { installReadOnlyGate } from './readonly.ts'
import { ScionService } from './service.ts'

export * from './types.ts'
export * from './commands.ts'
export * from './paths.ts'
export * from './repo-format.ts'
export { ScionManifestError, createManifest, listRepoSessionIds, readManifest, readRepoSession, removeManifestSession, upsertManifestSession, writeManifest } from './manifest.ts'
export { ScionOwnershipError, ScionOwnershipStore } from './ownership.ts'
export { ScionGitError, commitAll, headCommit, initRepo, isDirty, isGitWorkTree, pull, push } from './git.ts'
export { exportSessions, listCandidateSessions, listLocalSessions, scopeToWorkspace } from './export.ts'
export { ScionImportRefusal, importSessions, planImport } from './import.ts'
export { planPrune, pruneSessions } from './prune.ts'
export { installReadOnlyGate, isReadOnlySession } from './readonly.ts'
export { attachImported, ensureWorkspaceFor, isAttached } from './workspace.ts'
export { encodeSegment, locateSessionDir, projectKey, sessionsRoot } from './locate.ts'
export { ScionService } from './service.ts'

/** Plugin name. */
export const name = 'scion'

/** Services the plugin needs before it can act. */
export const inject = ['sessionPersistence']

/** Raw plugin configuration. */
export interface Config {
  /** Whether the plugin is active. @default true */
  readonly enabled?: boolean
  /** Whether the pre-step veto for imported sessions is installed. @default true */
  readonly readonlyGate?: boolean
}

/** Configuration schema shared with the cordis Loader. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  readonlyGate: z.boolean().default(true),
})

const CONFIG_KEYS: ReadonlySet<string> = new Set(['enabled', 'readonlyGate'])

/**
 * Validate and detach plugin configuration.
 *
 * Unknown keys and non-boolean values fail loudly at load rather than being
 * silently ignored, matching the rest of the harness's configuration posture.
 *
 * @param config - untrusted plugin configuration.
 * @returns the validated configuration.
 */
export function resolveConfig(config: Config | undefined): Required<Config> {
  const candidate: unknown = config ?? {}
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('dsh-scion: configuration must be an object')
  }
  const record = candidate as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`dsh-scion: unknown config key(s) ${unknown.join(', ')} — config is { enabled?, readonlyGate? }`)
  }
  for (const key of CONFIG_KEYS) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`dsh-scion: \`${key}\` must be a boolean when supplied`)
    }
  }
  return {
    enabled: record['enabled'] !== false,
    readonlyGate: record['readonlyGate'] !== false,
  }
}

/**
 * Mount the plugin.
 * @param ctx - host context.
 * @param config - untrusted plugin configuration.
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const ownership = new ScionOwnershipStore()
  await ownership.load()

  if (resolved.readonlyGate) installReadOnlyGate(ctx, ownership)

  const service = new ScionService(ctx, ownership)
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'scion',
      description: 'Portable workspace + session units carried by git',
      input: { hint: '[status|init|push|pull|forget]' },
      handler: (invocation: CommandInvocation): Promise<CommandResult> =>
        service.run(invocation.agent, invocation.rawInput),
    })
  })
}
