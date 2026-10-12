/**
 * Export scoping against the real JSONL backend.
 *
 * The default export set is what DSH itself accounts to the workspace for the
 * root — the record's session account (∩ canonical cwd, already projected by
 * `Workspace.sessionIds`) — so subagent children and never-attached sessions
 * stay out. An explicit selection may still reach any locally owned session
 * whose canonical cwd is the root, subagent children included.
 */
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { exportSessions, listCandidateSessions, listLocalSessions } from '../src/export.ts'
import { createManifest, listRepoSessionIds, readManifest, writeManifest } from '../src/manifest.ts'
import { planPrune, pruneSessions } from '../src/prune.ts'
import { repoSessionsDir } from '../src/paths.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { removeTree } from '../src/fs-util.ts'

const TOP_A = 'session-top-a'
const TOP_B = 'session-top-b'
const CHILD = 'session-child'
const ELSEWHERE = 'session-elsewhere'

let workdir: string
let home: string
let root: string
let rootReal: string
let ctx: Context
let previousHome: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-scion-scope-'))
  previousHome = process.env['DSH_HOME']
  home = join(workdir, 'home')
  root = join(workdir, 'repo-a')
  await mkdir(root, { recursive: true })
  rootReal = await realpath(root)
  process.env['DSH_HOME'] = home
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions'), compression: 'none' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await removeTree(workdir)
})

/**
 * Create one stored session with a fixed id, cwd, and origin.
 * @param id - session id.
 * @param cwd - recorded working directory.
 * @param origin - optional coarse product classification.
 */
async function createSession(id: string, cwd: string, origin?: 'subagent'): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    ...origin === undefined ? {} : { origin },
  }
  const handle = await ctx.sessionPersistence.create(header)
  try {
    await handle.append(closedTurn())
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** A minimal closed turn: turns and steps are 1-based in the log vocabulary. */
function closedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

/** Two workspace members that ran in the root, a subagent child, and an outsider. */
async function seed(): Promise<void> {
  await createSession(TOP_A, rootReal)
  await createSession(TOP_B, rootReal)
  await createSession(CHILD, rootReal, 'subagent')
  const other = join(workdir, 'other')
  await mkdir(other, { recursive: true })
  await createSession(ELSEWHERE, await realpath(other))
  await writeManifest(rootReal, createManifest({
    name: 'repo',
    root: rootReal,
    sessionFormatVersion: SESSION_FORMAT_VERSION,
  }))
}

/**
 * Wrap the real host so `workspaceRegistry` resolves through a stub record.
 * @param resolveByPath - stub resolution against the requested path.
 * @returns a host context exposing the real persistence backend.
 */
function hostWith(
  resolveByPath: (path: string) => Promise<{ sessionIds: readonly ReturnType<typeof SessionId>[] } | undefined>,
): Context {
  const registry = { resolveByPath }
  return {
    sessionPersistence: ctx.sessionPersistence,
    get: (name: string) => name === 'workspaceRegistry' ? registry : undefined,
  } as unknown as Context
}

/** Machine-local ownership index with no imported records. */
async function ownership(): Promise<ScionOwnershipStore> {
  const store = new ScionOwnershipStore()
  await store.load()
  return store
}

/** Ids of a header list, for compact assertions. */
function ids(headers: readonly SessionHeader[]): string[] {
  return headers.map(header => String(header.id))
}

describe('export scoping', () => {
  it('defaults to the sessions DSH accounts to the workspace', async () => {
    await seed()
    const store = await ownership()
    const host = hostWith(async path => path === rootReal
      ? { sessionIds: [SessionId(TOP_A), SessionId(TOP_B)] }
      : undefined)

    // Every cwd-matching locally owned session is a candidate...
    expect(ids(await listCandidateSessions(host, rootReal, store))).toEqual([CHILD, TOP_A, TOP_B])
    // ...but only workspace members are exportable by default.
    expect(ids(await listLocalSessions(host, rootReal, store))).toEqual([TOP_A, TOP_B])

    const result = await exportSessions(host, { root: rootReal, ownership: store })
    expect(result.exported.map(entry => entry.id)).toEqual([TOP_A, TOP_B])
    expect(result.skipped).toEqual([])
  })

  it('lets an explicit selection reach a session the workspace does not account', async () => {
    await seed()
    const store = await ownership()
    const host = hostWith(async path => path === rootReal
      ? { sessionIds: [SessionId(TOP_A)] }
      : undefined)

    expect((await exportSessions(host, { root: rootReal, ownership: store }))
      .exported.map(entry => entry.id)).toEqual([TOP_A])

    const explicit = await exportSessions(host, {
      root: rootReal,
      ownership: store,
      sessionIds: [CHILD],
    })
    expect(explicit.exported.map(entry => entry.id)).toEqual([CHILD])

    await expect(exportSessions(host, {
      root: rootReal,
      ownership: store,
      sessionIds: [ELSEWHERE],
    })).rejects.toThrow(/not local sessions owned by this scion/)
  })

  it('falls back to cwd equality when no workspace record is usable', async () => {
    await seed()
    const store = await ownership()
    const all = [CHILD, TOP_A, TOP_B]

    // No workspace registry composed at all.
    expect(ids(await listLocalSessions(ctx, rootReal, store))).toEqual(all)
    // A registry that does not know this directory.
    const stranger = hostWith(async () => undefined)
    expect(ids(await listLocalSessions(stranger, rootReal, store))).toEqual(all)
    // A record with an empty account holds no ownership knowledge yet.
    const empty = hostWith(async () => ({ sessionIds: [] }))
    expect(ids(await listLocalSessions(empty, rootReal, store))).toEqual(all)
    // Sessions outside the root are never candidates.
    const result = await exportSessions(stranger, { root: rootReal, ownership: store })
    expect(result.exported.map(entry => entry.id)).toEqual(all)
  })
})

describe('prune', () => {
  /** Export all three cwd-matching sessions the way an unscoped host would. */
  async function exportAll(store: ScionOwnershipStore): Promise<void> {
    const unscoped = hostWith(async () => undefined)
    const result = await exportSessions(unscoped, { root: rootReal, ownership: store })
    expect(result.exported.map(entry => entry.id)).toEqual([CHILD, TOP_A, TOP_B])
  }

  it('drops recorded sessions the workspace no longer owns', async () => {
    await seed()
    const store = await ownership()
    await exportAll(store)
    const host = hostWith(async path => path === rootReal
      ? { sessionIds: [SessionId(TOP_A), SessionId(TOP_B)] }
      : undefined)

    // Planning is read-only: the child's file survives until the prune runs.
    const plan = await planPrune(host, { root: rootReal, ownership: store })
    expect(plan.pruned).toEqual([{ id: CHILD, eventCount: 4, reason: 'not-workspace-owned' }])
    expect(plan.kept).toBe(2)
    expect(plan.unmanaged).toEqual([])
    expect(await listRepoSessionIds(rootReal)).toEqual([CHILD, TOP_A, TOP_B])

    const result = await pruneSessions(host, { root: rootReal, ownership: store })
    expect(result.pruned.map(entry => entry.id)).toEqual([CHILD])
    expect(await listRepoSessionIds(rootReal)).toEqual([TOP_A, TOP_B])
    expect((await readManifest(rootReal))?.sessions.map(entry => entry.id)).toEqual([TOP_A, TOP_B])
  })

  it('honors an explicit selection and rejects ids the repo does not record', async () => {
    await seed()
    const store = await ownership()
    await exportAll(store)
    const host = hostWith(async () => undefined)

    const result = await pruneSessions(host, {
      root: rootReal,
      ownership: store,
      sessionIds: [TOP_A],
    })
    expect(result.pruned).toEqual([{ id: TOP_A, eventCount: 4, reason: 'requested' }])
    expect(result.kept).toBe(2)
    expect(await listRepoSessionIds(rootReal)).toEqual([CHILD, TOP_B])

    await expect(pruneSessions(host, {
      root: rootReal,
      ownership: store,
      sessionIds: ['session-nope'],
    })).rejects.toThrow(/not exported sessions of this scion/)
  })

  it('reports unmanaged repo files and leaves them alone', async () => {
    await seed()
    const store = await ownership()
    await exportAll(store)
    await writeFile(join(repoSessionsDir(rootReal), 'session-handmade.jsonl'), '{}\n')
    const host = hostWith(async path => path === rootReal
      ? { sessionIds: [SessionId(TOP_A), SessionId(TOP_B)] }
      : undefined)

    const plan = await pruneSessions(host, { root: rootReal, ownership: store })
    expect(plan.unmanaged).toEqual(['session-handmade'])
    expect(await listRepoSessionIds(rootReal)).toEqual(['session-handmade', TOP_A, TOP_B])
  })

  it('prunes nothing on a clone that has no local sessions', async () => {
    await seed()
    const store = await ownership()
    await exportAll(store)
    const clone = join(workdir, 'repo-clone')
    await mkdir(clone, { recursive: true })
    await cp(join(rootReal, '.dsh'), join(clone, '.dsh'), { recursive: true })

    // No stored session has this clone's cwd, so nothing is locally stale.
    const plan = await pruneSessions(ctx, { root: clone, ownership: store })
    expect(plan.pruned).toEqual([])
    expect(plan.kept).toBe(3)
    expect(await listRepoSessionIds(clone)).toEqual([CHILD, TOP_A, TOP_B])
  })
})
