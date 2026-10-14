/**
 * The panel's host half: the snapshot builder and the `/api/scion/tree` route
 * handler, exercised against the real JSONL backend and a real git repository.
 */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { buildScionTree } from '../src/tree.ts'
import { SCION_TREE_PATH, createTreeHandler } from '../src/route.ts'
import { createManifest, upsertManifestSession, writeManifest } from '../src/manifest.ts'
import { repoSessionsDir } from '../src/paths.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { removeTree } from '../src/fs-util.ts'

const run = promisify(execFile)

let workdir: string
let root: string
let rootReal: string
let ctx: Context
let previousHome: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-scion-tree-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = join(workdir, 'home')
  root = join(workdir, 'repo')
  await mkdir(root, { recursive: true })
  rootReal = await realpath(root)
  await run('git', ['init', '-b', 'main'], { cwd: rootReal })
  await run('git', ['config', 'user.email', 'scion@test'], { cwd: rootReal })
  await run('git', ['config', 'user.name', 'scion test'], { cwd: rootReal })
  await run('git', ['remote', 'add', 'origin', 'https://user:token@example.com/team/repo.git'], { cwd: rootReal })
  await writeFile(join(rootReal, 'README.md'), 'seed\n')
  await run('git', ['add', '-A'], { cwd: rootReal })
  await run('git', ['commit', '-m', 'seed'], { cwd: rootReal })
  ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(workdir, 'home', 'sessions'), compression: 'none' })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await removeTree(workdir)
})

/** Create one local session in the root. */
async function createSession(id: string): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_700_000_000_000,
    cwd: rootReal,
    isSeeded: false,
  }
  const handle = await ctx.sessionPersistence.create(header)
  try {
    await handle.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** A manifest carrying two machines' exports plus one local read-only import. */
async function seed(): Promise<void> {
  await createSession('session-local')
  let manifest = createManifest({ name: 'repo', root: rootReal, sessionFormatVersion: SESSION_FORMAT_VERSION })
  manifest = upsertManifestSession(manifest, {
    id: 'session-local',
    inheritedEventCount: 0,
    eventCount: 2,
    originRoot: rootReal,
    exportedAt: '2026-10-12T00:00:00.000Z',
  })
  manifest = upsertManifestSession(manifest, {
    id: 'session-other-machine',
    inheritedEventCount: 0,
    eventCount: 9,
    originRoot: '/home/alice/project/repo',
    exportedAt: '2026-10-11T00:00:00.000Z',
  })
  await writeManifest(rootReal, manifest)
  await mkdir(repoSessionsDir(rootReal), { recursive: true })
  await writeFile(join(repoSessionsDir(rootReal), 'session-local.jsonl'), '{}\n')
  // `session-other-machine` deliberately has no repo file: its size is unknown.
}

/** Ownership index recording one read-only import of the foreign session. */
async function ownershipWithImport(): Promise<ScionOwnershipStore> {
  const store = new ScionOwnershipStore()
  await store.load()
  await store.record({
    sessionId: 'session-other-machine',
    scionId: 'scion-1',
    localRoot: rootReal,
    sourceRoot: '/home/alice/project/repo',
    importedAt: '2026-10-11T00:00:00.000Z',
    eventCount: 9,
  })
  return store
}

/** Plain ownership index with no imports. */
async function ownership(): Promise<ScionOwnershipStore> {
  const store = new ScionOwnershipStore()
  await store.load()
  return store
}

/** A request with a URL and method. */
function request(url: string, method = 'GET'): IncomingMessage {
  return { method, url } as IncomingMessage
}

/** A response that captures status, headers, and body. */
function response(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0
  let body = ''
  const res = {
    set statusCode(value: number) { status = value },
    get statusCode(): number { return status },
    setHeader: () => res,
    end: (chunk?: string) => { body += chunk ?? '' },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => body }
}

/** A context whose `connection` service admits or rejects by the given status. */
function hostWith(rejection: number | undefined): Context {
  return {
    sessionPersistence: ctx.sessionPersistence,
    get: (name: string) => name === 'connection' ? { requestRejection: () => rejection } : undefined,
  } as unknown as Context
}

describe('buildScionTree', () => {
  it('groups exported sessions by exporting machine and flags local state', async () => {
    await seed()
    const snapshot = await buildScionTree(hostWith(undefined), rootReal, await ownershipWithImport())

    expect(snapshot.scion).toMatchObject({ name: 'repo', root: rootReal })
    expect(snapshot.repo.sessions).toBe(2)
    expect(snapshot.machines.map(machine => machine.originRoot))
      .toEqual([rootReal, '/home/alice/project/repo'].sort())
    const localGroup = snapshot.machines.find(machine => machine.originRoot === rootReal)!
    expect(localGroup.sessions).toHaveLength(1)
    expect(localGroup.sessions[0]).toMatchObject({
      id: 'session-local', events: 2, local: true, readOnly: false, exportable: true, bytes: 3,
    })
    const foreignGroup = snapshot.machines.find(machine => machine.originRoot === '/home/alice/project/repo')!
    expect(foreignGroup.sessions[0]).toMatchObject({
      id: 'session-other-machine', events: 9, local: false, readOnly: true, exportable: false, bytes: undefined,
    })
    expect(snapshot.local).toMatchObject({ sessionsWithCwd: 1, exportable: 1 })
    expect(snapshot.local.imported).toEqual([
      { id: 'session-other-machine', sourceRoot: '/home/alice/project/repo', events: 9 },
    ])
    expect(snapshot.git.branch).toBe('main')
    expect(snapshot.git.dirty).toBe(true)
    expect(snapshot.git.remotes).toEqual([
      { name: 'origin', url: 'https://user:token@example.com/team/repo.git' },
    ])
  })

  it('refuses a directory that is not a scion', async () => {
    await expect(buildScionTree(hostWith(undefined), rootReal, await ownership()))
      .rejects.toThrow(/not an initialized scion/u)
  })
})

describe('the tree route handler', () => {
  it('answers a session-addressed snapshot', async () => {
    await seed()
    const handler = createTreeHandler(hostWith(undefined), await ownership())
    const { res, status, body } = response()
    await handler(request(`${SCION_TREE_PATH}?session=${String(SessionId('session-local'))}`), res)

    expect(status()).toBe(200)
    const payload = JSON.parse(body()) as { scion: { name: string }; repo: { sessions: number } }
    expect(payload.scion.name).toBe('repo')
    expect(payload.repo.sessions).toBe(2)
  })

  it('answers an explicit root and rejects malformed requests', async () => {
    await seed()
    const handler = createTreeHandler(hostWith(undefined), await ownership())

    const rooted = response()
    await handler(request(`${SCION_TREE_PATH}?root=${encodeURIComponent(rootReal)}`), rooted.res)
    expect(rooted.status()).toBe(200)

    const missing = response()
    await handler(request(SCION_TREE_PATH), missing.res)
    expect(missing.status()).toBe(400)

    const unknown = response()
    await handler(request(`${SCION_TREE_PATH}?session=session-nope`), unknown.res)
    expect(unknown.status()).toBe(400)

    const wrongMethod = response()
    await handler(request(SCION_TREE_PATH, 'POST'), wrongMethod.res)
    expect(wrongMethod.status()).toBe(405)
  })

  it('fails closed without a connection and forwards its rejection', async () => {
    await seed()
    const bare = createTreeHandler({ sessionPersistence: ctx.sessionPersistence, get: () => undefined } as unknown as Context, await ownership())
    const unauthenticated = response()
    await bare(request(`${SCION_TREE_PATH}?root=${encodeURIComponent(rootReal)}`), unauthenticated.res)
    expect(unauthenticated.status()).toBe(403)

    const rejected = createTreeHandler(hostWith(401), await ownership())
    const denied = response()
    await rejected(request(`${SCION_TREE_PATH}?root=${encodeURIComponent(rootReal)}`), denied.res)
    expect(denied.status()).toBe(401)
  })
})
