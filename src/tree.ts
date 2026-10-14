/**
 * The panel snapshot: what the scion repo carries, grouped by the machine that
 * exported each session, plus what this machine owns locally.
 *
 * The manifest is the repo's authority for what it carries, so the tree needs
 * no session decoding: ids, event counts, export timestamps, and `originRoot`
 * are already recorded per exported session. Local flags come from the
 * persistence roster and the ownership index.
 *
 * @module @asyouwish/dsh-scion/tree
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ScionOwnershipStore } from './ownership.ts'
import { readManifest } from './manifest.ts'
import { repoSessionPath } from './paths.ts'
import { listCandidateSessions, scopeToWorkspace } from './export.ts'
import { canonicalizeOrSelf } from './fs-util.ts'
import { currentBranch, isDirty, remoteNames, remoteUrl, upstreamOf } from './git.ts'

/** One exported session as the panel shows it. */
export interface ScionTreeSession {
  readonly id: string
  readonly events: number
  readonly inheritedEvents: number
  readonly exportedAt: string
  /** The session still exists on this machine. */
  readonly local: boolean
  /** This machine holds the id as a read-only import. */
  readonly readOnly: boolean
  /** The session is on this machine's workspace account (export selects it by default). */
  readonly exportable: boolean
  /** Bytes the repo file occupies, when it is present. */
  readonly bytes: number | undefined
}

/** Exported sessions grouped by the machine that exported them. */
export interface ScionTreeMachine {
  /** The exporting machine's root path, as recorded in the manifest. */
  readonly originRoot: string
  readonly sessions: readonly ScionTreeSession[]
}

/** Everything the scion panel renders. */
export interface ScionTreeSnapshot {
  readonly scion: {
    readonly name: string
    readonly id: string
    readonly root: string
    readonly sessionFormatVersion: number
  }
  readonly git: {
    readonly branch: string | undefined
    readonly upstream: string | undefined
    readonly dirty: boolean
    readonly remotes: readonly { readonly name: string; readonly url: string | undefined }[]
  }
  readonly repo: {
    readonly sessions: number
    readonly bytes: number
  }
  readonly machines: readonly ScionTreeMachine[]
  readonly local: {
    /** Locally owned sessions whose canonical cwd is this root. */
    readonly sessionsWithCwd: number
    /** Of those, the ones the workspace accounts for. */
    readonly exportable: number
    /** Read-only imports recorded on this machine against this root. */
    readonly imported: readonly {
      readonly id: string
      readonly sourceRoot: string
      readonly events: number
    }[]
  }
  readonly generatedAt: string
}

/**
 * Build the panel snapshot for one scion root.
 * @param ctx - host context.
 * @param root - scion root.
 * @param ownership - machine-local ownership index.
 * @returns the snapshot.
 * @throws when the root is not an initialized scion.
 */
export async function buildScionTree(
  ctx: Context,
  root: string,
  ownership: ScionOwnershipStore,
): Promise<ScionTreeSnapshot> {
  const canonicalRoot = await canonicalizeOrSelf(root)
  const manifest = await readManifest(canonicalRoot)
  if (manifest === undefined) {
    throw new Error(`not an initialized scion (no .dsh/scion.json): ${canonicalRoot}`)
  }

  const candidates = await listCandidateSessions(ctx, canonicalRoot, ownership)
  const exportable = await scopeToWorkspace(ctx, canonicalRoot, candidates)
  const localIds = new Set(candidates.map(header => String(header.id)))
  const exportableIds = new Set(exportable.map(header => String(header.id)))

  const remotes: { name: string; url: string | undefined }[] = []
  for (const name of await remoteNames(canonicalRoot)) {
    remotes.push({ name, url: await remoteUrl(canonicalRoot, name) })
  }

  const byMachine = new Map<string, ScionTreeSession[]>()
  let bytes = 0
  for (const entry of manifest.sessions) {
    const size = await fileSize(repoSessionPath(canonicalRoot, entry.id))
    bytes += size ?? 0
    const session: ScionTreeSession = {
      id: entry.id,
      events: entry.eventCount,
      inheritedEvents: entry.inheritedEventCount,
      exportedAt: entry.exportedAt,
      local: localIds.has(entry.id),
      readOnly: ownership.isImported(entry.id),
      exportable: exportableIds.has(entry.id),
      bytes: size,
    }
    const group = byMachine.get(entry.originRoot)
    if (group === undefined) byMachine.set(entry.originRoot, [session])
    else group.push(session)
  }

  const machines = [...byMachine.entries()]
    .map(([originRoot, sessions]) => ({
      originRoot,
      sessions: [...sessions].sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => right.sessions.length - left.sessions.length
      || left.originRoot.localeCompare(right.originRoot))

  const imported = ownership.all()
    .filter(record => record.localRoot === canonicalRoot)
    .map(record => ({ id: record.sessionId, sourceRoot: record.sourceRoot, events: record.eventCount }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    scion: {
      name: manifest.name,
      id: manifest.scionId,
      root: canonicalRoot,
      sessionFormatVersion: manifest.sessionFormatVersion,
    },
    git: {
      branch: await currentBranch(canonicalRoot),
      upstream: await upstreamOf(canonicalRoot),
      dirty: await isDirty(canonicalRoot),
      remotes,
    },
    repo: { sessions: manifest.sessions.length, bytes },
    machines,
    local: {
      sessionsWithCwd: candidates.length,
      exportable: exportable.length,
      imported,
    },
    generatedAt: new Date().toISOString(),
  }
}

/**
 * One repo session file's size, or undefined when it is absent.
 * @param path - absolute repo file path.
 * @returns the byte size, or undefined.
 */
async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}
