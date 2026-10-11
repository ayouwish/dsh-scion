/**
 * End-to-end test of the Scion closed loop against the **real** JSONL
 * persistence backend.
 *
 * It simulates two machines: host A creates and exports a session, host B
 * imports it into a different absolute root and must end up with a read-only
 * copy whose history matches and whose working directory is localized.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as ScionPlugin from '../src/index.ts'
import { exportSessions } from '../src/export.ts'
import { importSessions } from '../src/import.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { createManifest, readManifest, readRepoSession, writeManifest } from '../src/manifest.ts'
import { locateSessionDir } from '../src/locate.ts'
import { removeTree } from '../src/fs-util.ts'

const SESSION_ID = 'session-scion-e2e'

let workdir: string
let home: string
let root: string
let contexts: Context[] = []
let previousHome: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-scion-e2e-'))
  previousHome = process.env['DSH_HOME']
  home = join(workdir, 'home')
  root = join(workdir, 'repo-a')
  await mkdir(root, { recursive: true })
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  // Imported session trees are read-only; restore write permission first.
  await removeTree(workdir)
})

/**
 * Boot a host with the real persistence backend plus the plugin.
 * @param dshHome - value for `DSH_HOME`.
 * @param scionRoot - directory holding the scion repo (the Loader base URL).
 * @returns the booted context.
 */
async function boot(dshHome: string, scionRoot: string): Promise<Context> {
  const configPath = join(scionRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: '${join(dshHome, 'sessions')}'`,
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@asyouwish/dsh-scion'",
    '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(scionRoot).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@asyouwish/dsh-scion', ScionPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // `ctx.inject(['commands'])` mounts asynchronously once commands resolves.
  await new Promise(resolve => setImmediate(resolve))
  return ctx
}

/**
 * Create one local session with a minimal valid lifecycle.
 * @param ctx - host context.
 * @param cwd - recorded working directory.
 */
async function createSession(ctx: Context, cwd: string): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(SESSION_ID),
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
  }
  const handle = await ctx.sessionPersistence.create(header)
  try {
    await handle.append(baseEvents())
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** A minimal closed turn: turns and steps are 1-based in the log vocabulary. */
function baseEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

/** One more closed turn, continuing the log from `from`. */
function nextTurnEvents(from: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: from, time: 5, data: { turn: 2 } },
    { type: 'step/start', seq: from + 1, time: 6, data: { turn: 2, step: 1 } },
    { type: 'step/end', seq: from + 2, time: 7, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: from + 3, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

/**
 * Read one session's stored header and events through a read handle.
 * @param ctx - host context.
 * @param id - session id.
 * @returns the header and its events.
 */
async function readLog(
  ctx: Context,
  id: string,
): Promise<{ header: SessionHeader; events: readonly SessionEvent[] }> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
  try {
    const slice = await handle.read(0)
    return { header: handle.header, events: slice.events }
  } finally {
    await handle.close()
  }
}

/**
 * Initialize the scion repo the way `/scion init` does.
 * @param scionRoot - root to initialize.
 */
async function initScion(scionRoot: string): Promise<void> {
  await writeManifest(scionRoot, createManifest({
    name: 'repo',
    root: scionRoot,
    sessionFormatVersion: SESSION_FORMAT_VERSION,
  }))
}

describe('scion closed loop across two machines', () => {
  it('exports on A, imports read-only on B, and extends idempotently', async () => {
    const ctxA = await boot(home, root)
    await ScionPlugin.apply(ctxA, {})
    await createSession(ctxA, root)
    await initScion(root)

    const ownershipA = new ScionOwnershipStore()
    await ownershipA.load()
    const exported = await exportSessions(ctxA, { root, ownership: ownershipA })
    expect(exported.skipped).toEqual([])
    expect(exported.exported).toEqual([{ id: SESSION_ID, eventCount: 4 }])
    expect((await readManifest(root))?.sessions).toHaveLength(1)

    // ---- machine B: a clone at a different absolute path, its own home ----
    const rootB = join(workdir, 'repo-b')
    const homeB = join(workdir, 'home-b')
    await mkdir(rootB, { recursive: true })
    await cp(join(root, '.dsh'), join(rootB, '.dsh'), { recursive: true })

    process.env['DSH_HOME'] = homeB
    const ctxB = await boot(homeB, rootB)
    await ScionPlugin.apply(ctxB, {})

    const ownershipB = new ScionOwnershipStore()
    await ownershipB.load()
    const imported = await importSessions(ctxB, { root: rootB, ownership: ownershipB })
    expect(imported.refused).toEqual([])
    expect(imported.created).toEqual([SESSION_ID])

    // History matches, and the working directory is localized.
    const stored = await readLog(ctxB, SESSION_ID)
    expect(stored.header.cwd).toBe(rootB)
    expect(stored.header.parentSession).toBeUndefined()
    expect(stored.events).toEqual(baseEvents())

    // Ownership is recorded, and the copy is read-only on disk.
    expect(ownershipB.isImported(SESSION_ID)).toBe(true)
    expect(ownershipB.get(SESSION_ID)?.sourceRoot).toBe(root)
    const directory = await locateSessionDir(rootB, SESSION_ID)
    expect(directory).toBeDefined()
    expect((await stat(directory!)).mode & 0o222).toBe(0)
    for (const entry of await readdir(directory!)) {
      expect((await stat(join(directory!, entry))).mode & 0o222).toBe(0)
    }

    // Re-import is a no-op.
    const again = await importSessions(ctxB, { root: rootB, ownership: ownershipB })
    expect(again.created).toEqual([])
    expect(again.unchanged).toEqual([SESSION_ID])

    // ---- A keeps working: B must extend its read-only copy ----
    const handle = await ctxA.sessionPersistence.open(SessionId(SESSION_ID), 'write')
    try {
      await handle.append(nextTurnEvents(4))
      await handle.flush()
    } finally {
      await handle.close()
    }
    const reExported = await exportSessions(ctxA, { root, ownership: ownershipA })
    expect(reExported.exported).toEqual([{ id: SESSION_ID, eventCount: 8 }])

    await cp(join(root, '.dsh', 'sessions'), join(rootB, '.dsh', 'sessions'), { recursive: true, force: true })
    const extended = await importSessions(ctxB, { root: rootB, ownership: ownershipB })
    expect(extended.appended).toEqual([SESSION_ID])

    const after = await readLog(ctxB, SESSION_ID)
    expect(after.events).toHaveLength(8)
    expect(after.events.at(-1)).toMatchObject({ type: 'turn/end', seq: 7 })
    // The read-only layer is re-applied after the append.
    expect((await stat((await locateSessionDir(rootB, SESSION_ID))!)).mode & 0o222).toBe(0)

    // A write open on the imported copy is refused by the filesystem layer.
    await expect(ctxB.sessionPersistence.open(SessionId(SESSION_ID), 'write')).rejects.toThrow()
  })

  it('never overwrites a local session that shares the id', async () => {
    const ctx = await boot(home, root)
    await ScionPlugin.apply(ctx, {})
    await initScion(root)
    await createSession(ctx, root)
    const ownership = new ScionOwnershipStore()
    await ownership.load()
    await exportSessions(ctx, { root, ownership })

    // The local session exists but is not claimed as imported: local work wins.
    const refused = await importSessions(ctx, { root, ownership })
    expect(refused.created).toEqual([])
    expect(refused.refused[0]?.id).toBe(SESSION_ID)
    expect(refused.refused[0]?.reason).toMatch(/local session already uses this id/)
  })

  it('refuses a repo session written by another session format version', async () => {
    const ctx = await boot(home, root)
    await ScionPlugin.apply(ctx, {})
    await initScion(root)
    await createSession(ctx, root)
    const ownership = new ScionOwnershipStore()
    await ownership.load()
    await exportSessions(ctx, { root, ownership })

    const path = join(root, '.dsh', 'sessions', `${SESSION_ID}.jsonl`)
    const body = await readFile(path, 'utf8')
    await writeFile(path, body.replace(
      `"sessionFormatVersion":${String(SESSION_FORMAT_VERSION)}`,
      '"sessionFormatVersion":99',
    ))
    expect((await readRepoSession(root, SESSION_ID)).sessionFormatVersion).toBe(99)

    const imported = await importSessions(ctx, { root, ownership })
    expect(imported.refused[0]?.reason).toMatch(/does not match this writer/)
  })
})
