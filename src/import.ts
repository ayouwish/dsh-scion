/**
 * Import: the scion repo → read-only local sessions.
 *
 * Import never rewrites history. Event payloads are carried verbatim; the only
 * substituted value is the header's `cwd`, which DSH requires to be the local
 * absolute workspace path (workspace membership, cross-session authorization,
 * sandbox roots, and `AGENTS.md` discovery all read it). Everything physical —
 * encoding, compression, framing, validation — is left to the persistence
 * backend through its public `create`/`open`/`append`/`flush` API.
 *
 * The imported copy is read-only by construction: its directory is made
 * unwritable, its id is recorded in the machine-local ownership index, and the
 * plugin's pre-step gate refuses to run a model step for it. Forking is
 * unaffected — a fork reads the source and creates a new local session.
 *
 * @module @asyouwish/dsh-scion/import
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'

import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ScionOwnershipStore } from './ownership.ts'
import type { ScionImportPlan, ScionRepoSession } from './types.ts'
import { listRepoSessionIds, readManifest, readRepoSession } from './manifest.ts'
import {
  canonicalizeOrSelf,
  chmodTree,
  READONLY_DIR_MODE,
  READONLY_FILE_MODE,
  WRITABLE_DIR_MODE,
  WRITABLE_FILE_MODE,
} from './fs-util.ts'
import { locateSessionDir } from './locate.ts'

/** Inputs for {@link importSessions}. */
export interface ScionImportOptions {
  /** Scion root (the git repo). */
  readonly root: string
  /** Explicit session selection; omitted imports every repo session. */
  readonly sessionIds?: readonly string[]
  /** Machine-local ownership index. */
  readonly ownership: ScionOwnershipStore
  readonly signal?: AbortSignal
}

/** Outcome of one import. */
export interface ScionImportResult {
  /** Canonical local root every imported session was localized to. */
  readonly root: string
  /** Scion identity the imported sessions were recorded against. */
  readonly scionId: string
  readonly created: readonly string[]
  readonly appended: readonly string[]
  readonly unchanged: readonly string[]
  readonly refused: readonly { readonly id: string; readonly reason: string }[]
}

/** One repo session that failed a structural, version, or ownership check. */
export class ScionImportRefusal extends Error {
  /**
   * @param sessionId - offending session.
   * @param detail - why it was refused.
   */
  constructor(readonly sessionId: string, readonly detail: string) {
    super(`${sessionId}: ${detail}`)
    this.name = 'ScionImportRefusal'
  }
}

/** Everything one import run needs after the root has been resolved. */
interface ImportTarget {
  readonly ctx: Context
  readonly localRoot: string
  readonly ownership: ScionOwnershipStore
  readonly scionId: string
  readonly signal: AbortSignal | undefined
}

/**
 * Import repo sessions into the local store, read-only.
 *
 * @param ctx - host context.
 * @param options - root, selection, ownership, and cancellation.
 * @returns what was created, extended, left alone, or refused.
 * @throws when the root is not an initialized scion.
 */
export async function importSessions(
  ctx: Context,
  options: ScionImportOptions,
): Promise<ScionImportResult> {
  const localRoot = await canonicalizeOrSelf(options.root)
  const manifest = await readManifest(localRoot)
  if (manifest === undefined) {
    throw new Error(`not an initialized scion (no .dsh/scion.json): ${localRoot}`)
  }
  const target: ImportTarget = {
    ctx,
    localRoot,
    ownership: options.ownership,
    scionId: manifest.scionId,
    signal: options.signal,
  }
  const ids = selectIds(await listRepoSessionIds(localRoot), options.sessionIds)

  const created: string[] = []
  const appended: string[] = []
  const unchanged: string[] = []
  const refused: { id: string; reason: string }[] = []

  for (const id of ids) {
    try {
      const session = await readRepoSession(localRoot, id)
      assertVersion(id, session)
      const plan = await planImport(ctx, id, session, options.ownership)
      switch (plan.kind) {
        case 'current':
          unchanged.push(id)
          break
        case 'create':
          await createReadOnly(target, id, session)
          created.push(id)
          break
        case 'append':
          await appendToImported(target, id, session, plan.localEventCount)
          appended.push(id)
          break
        case 'local-owned':
        case 'divergent':
          refused.push({
            id,
            reason: plan.kind === 'local-owned'
              ? 'a local session already uses this id; Scion never overwrites local work'
              : plan.reason,
          })
          break
      }
    } catch (error: unknown) {
      refused.push({ id, reason: String((error as Error).message) })
    }
  }
  return { root: localRoot, scionId: manifest.scionId, created, appended, unchanged, refused }
}

/**
 * Decide how one repo session relates to the local store.
 *
 * @param ctx - host context.
 * @param id - session id.
 * @param session - decoded repo session.
 * @param ownership - machine-local ownership index.
 * @returns the plan.
 */
export async function planImport(
  ctx: Context,
  id: string,
  session: ScionRepoSession,
  ownership: ScionOwnershipStore,
): Promise<ScionImportPlan> {
  const owned = ownership.get(id)
  const existing = await ctx.sessionPersistence.stat(SessionId(id))
  if (owned === undefined) {
    return existing === undefined ? { kind: 'create' } : { kind: 'local-owned' }
  }
  if (existing === undefined) {
    return {
      kind: 'divergent',
      reason: 'the ownership index lists this session but the local store does not hold it',
    }
  }
  const localCount = existing.eventCount
  if (localCount !== undefined && localCount !== owned.eventCount) {
    return {
      kind: 'divergent',
      reason: `the local copy holds ${String(localCount)} event(s) but the ownership index recorded ${String(owned.eventCount)}`,
    }
  }
  if (session.eventCount === owned.eventCount) return { kind: 'current' }
  if (session.eventCount < owned.eventCount) {
    return {
      kind: 'divergent',
      reason: `the repo holds ${String(session.eventCount)} event(s), fewer than the ${String(owned.eventCount)} already imported`,
    }
  }
  return { kind: 'append', localEventCount: owned.eventCount }
}

/**
 * Materialize one repo session as a new read-only local session.
 * @param target - resolved import target.
 * @param id - session id.
 * @param session - decoded repo session.
 */
async function createReadOnly(
  target: ImportTarget,
  id: string,
  session: ScionRepoSession,
): Promise<void> {
  const header = localizeHeader(session.header, target.localRoot, id)
  const seeded = session.header['isSeeded'] === true
  const handle = await target.ctx.sessionPersistence.create(
    header,
    seeded ? { inheritedEventCount: session.inheritedEventCount as SessionLogOffset } : {},
  )
  try {
    await handle.append(session.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  await applyReadOnly(target.localRoot, id)
  await record(target, id, session)
}

/**
 * Extend an already-imported local copy with the repo's new events.
 *
 * The local copy is a strict prefix of the repo copy, so this is a plain
 * append — no local content can be lost, because the local copy is read-only
 * by construction.
 *
 * @param target - resolved import target.
 * @param id - session id.
 * @param session - decoded repo session.
 * @param localEventCount - events the local copy already holds.
 */
async function appendToImported(
  target: ImportTarget,
  id: string,
  session: ScionRepoSession,
  localEventCount: number,
): Promise<void> {
  const next = session.events[localEventCount]
  if (next === undefined || next.seq !== localEventCount) {
    throw new ScionImportRefusal(id, 'the repo log does not continue the local copy at a contiguous seq')
  }
  const directory = await locateSessionDir(target.localRoot, id)
  if (directory !== undefined) await chmodTree(directory, WRITABLE_DIR_MODE, WRITABLE_FILE_MODE)
  const handle = await target.ctx.sessionPersistence.open(SessionId(id), 'write')
  try {
    await handle.append(session.events.slice(localEventCount))
    await handle.flush()
  } finally {
    await handle.close()
  }
  await applyReadOnly(target.localRoot, id)
  await record(target, id, session)
}

/**
 * Apply the filesystem read-only layer to an imported session.
 * @param localRoot - canonical local root.
 * @param id - session id.
 */
async function applyReadOnly(localRoot: string, id: string): Promise<void> {
  const directory = await locateSessionDir(localRoot, id)
  if (directory === undefined) return
  await chmodTree(directory, READONLY_DIR_MODE, READONLY_FILE_MODE)
}

/**
 * Persist the ownership record for an imported session.
 * @param target - resolved import target.
 * @param id - session id.
 * @param session - decoded repo session.
 */
async function record(target: ImportTarget, id: string, session: ScionRepoSession): Promise<void> {
  await target.ownership.record({
    sessionId: id,
    scionId: target.scionId,
    localRoot: target.localRoot,
    sourceRoot: session.originRoot,
    importedAt: new Date().toISOString(),
    eventCount: session.eventCount,
  })
}

/**
 * Refuse a repo session written by a different session format version.
 *
 * Importing across versions is not attempted: the migration chain runs on
 * stored logs and is not part of the public persistence API, and DSH's
 * published policy is forward-only. Re-export from a machine on the same
 * version instead.
 *
 * @param id - session id.
 * @param session - decoded repo session.
 */
function assertVersion(id: string, session: ScionRepoSession): void {
  if (session.sessionFormatVersion !== SESSION_FORMAT_VERSION) {
    throw new ScionImportRefusal(
      id,
      `repo session format v${String(session.sessionFormatVersion)} does not match this writer's `
      + `v${String(SESSION_FORMAT_VERSION)}; re-export it from a machine running the same dsh version`,
    )
  }
}

/**
 * Rebuild a header with the local working directory.
 *
 * This is the whole of the import transform: every other field is carried
 * through, and no event payload is touched.
 *
 * @param raw - header JSON as exported.
 * @param localRoot - canonical local root.
 * @param id - session id, for error messages.
 * @returns a validated header for the local store.
 */
function localizeHeader(
  raw: Readonly<Record<string, unknown>>,
  localRoot: string,
  id: string,
): SessionHeader {
  const version = raw['version']
  if (version !== SESSION_FORMAT_VERSION) {
    throw new ScionImportRefusal(id, `header version ${String(version)} is not ${String(SESSION_FORMAT_VERSION)}`)
  }
  const createdAt = raw['createdAt']
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new ScionImportRefusal(id, 'header createdAt must be a non-negative safe integer')
  }
  const isSeeded = raw['isSeeded']
  if (typeof isSeeded !== 'boolean') {
    throw new ScionImportRefusal(id, 'header isSeeded must be a boolean')
  }
  const parentSession = raw['parentSession']
  if (parentSession !== undefined && typeof parentSession !== 'string') {
    throw new ScionImportRefusal(id, 'header parentSession must be a string when present')
  }
  const origin = raw['origin']
  if (origin !== undefined && origin !== 'subagent') {
    throw new ScionImportRefusal(id, 'header origin must be "subagent" when present')
  }
  const delegationDepth = raw['delegationDepth']
  if (delegationDepth !== undefined
    && (typeof delegationDepth !== 'number' || !Number.isSafeInteger(delegationDepth))) {
    throw new ScionImportRefusal(id, 'header delegationDepth must be a safe integer when present')
  }
  const agentPreset = raw['agentPreset']
  if (agentPreset !== undefined && typeof agentPreset !== 'string') {
    throw new ScionImportRefusal(id, 'header agentPreset must be a string when present')
  }
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    cwd: localRoot,
    isSeeded,
    ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
    ...origin === undefined ? {} : { origin },
    ...delegationDepth === undefined ? {} : { delegationDepth },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/**
 * Apply an explicit id selection.
 * @param available - ids present in the repo.
 * @param sessionIds - requested ids, when any.
 * @returns the ids to import.
 * @throws when a requested id is absent from the repo.
 */
function selectIds(
  available: readonly string[],
  sessionIds: readonly string[] | undefined,
): readonly string[] {
  if (sessionIds === undefined) return available
  const known = new Set(available)
  const missing = sessionIds.filter(id => !known.has(id))
  if (missing.length > 0) throw new Error(`not sessions of this scion repo: ${missing.join(', ')}`)
  return available.filter(id => sessionIds.includes(id))
}
