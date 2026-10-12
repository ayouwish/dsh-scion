/**
 * Background-job integration: the long `/scion` subcommands register DSH jobs
 * when a registry is composed, and fall back to synchronous execution when it
 * is not.
 */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHandle, JobHooks, JobSpec } from '@deepseek-ai/dsh-jobs'
import { startScionJob } from '../src/jobs.ts'
import { ScionService } from '../src/service.ts'
import { createManifest, listRepoSessionIds, writeManifest } from '../src/manifest.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { removeTree } from '../src/fs-util.ts'

const run = promisify(execFile)

/** A minimal host exposing only the services the operation under test reads. */
function hostWith(registry: unknown, ctx?: Context): Context {
  return {
    ...ctx === undefined ? {} : { sessionPersistence: ctx.sessionPersistence },
    get: (name: string) => name === 'jobs' ? registry : undefined,
  } as unknown as Context
}

describe('startScionJob', () => {
  const agent = { id: SessionId('session-owner') } as unknown as Agent

  it('registers scion work, streams output, and settles with the summary', async () => {
    const appends: string[] = []
    const progress: string[] = []
    const hooks: JobHooks[] = []
    let captured: JobSpec | undefined
    const registry = {
      start(spec: JobSpec): string {
        captured = spec
        const handle: JobHandle = {
          id: JobId('scion-1'),
          append: text => { appends.push(text) },
          updateProgress: line => { progress.push(line) },
        }
        hooks.push(spec.run(handle))
        return String(handle.id)
      },
    }

    const id = startScionJob(hostWith(registry), agent, 'scion push (demo)', async job => {
      job.progress('exporting 1/2')
      job.append('detail\n', 'stdout')
      return 'exported 2 session(s)'
    })

    expect(id).toBe('scion-1')
    expect(captured?.kind).toBe('scion')
    expect(captured?.label).toBe('scion push (demo)')
    expect(captured?.owner).toBe('session-owner')
    expect(progress).toEqual(['exporting 1/2'])
    expect(appends).toEqual(['detail\n'])
    await expect(hooks[0]!.done).resolves.toEqual({ status: 'completed', result: 'exported 2 session(s)' })
  })

  it('aborts the work signal on cancel and settles killed', async () => {
    let hooks: JobHooks | undefined
    const registry = {
      start(spec: JobSpec): string {
        hooks = spec.run({
          id: JobId('scion-2'),
          append: () => undefined,
          updateProgress: () => undefined,
        })
        return 'scion-2'
      },
    }
    let aborted = false
    const id = startScionJob(hostWith(registry), agent, 'scion pull (demo)', async job => {
      await new Promise<void>(resolve => {
        job.signal.addEventListener('abort', () => { aborted = true; resolve() })
      })
      return 'unreachable summary'
    })

    expect(id).toBe('scion-2')
    hooks!.cancel('stop')
    await expect(hooks!.done).resolves.toEqual({ status: 'killed' })
    expect(aborted).toBe(true)
  })

  it('settles failed and records the error when the work throws', async () => {
    const appends: string[] = []
    let hooks: JobHooks | undefined
    const registry = {
      start(spec: JobSpec): string {
        hooks = spec.run({
          id: JobId('scion-3'),
          append: text => { appends.push(text) },
          updateProgress: () => undefined,
        })
        return 'scion-3'
      },
    }
    startScionJob(hostWith(registry), agent, 'scion prune (demo)', async () => {
      throw new Error('git failed')
    })

    await expect(hooks!.done).resolves.toEqual({ status: 'failed', detail: 'git failed' })
    expect(appends.join('')).toContain('scion failed: git failed')
  })

  it('returns undefined without a registry, or when starting is refused', () => {
    expect(startScionJob(hostWith(undefined), agent, 'scion push', async () => 'x')).toBeUndefined()
    const refusing = { start(): string { throw new Error('no controller serves this agent') } }
    expect(startScionJob(hostWith(refusing), agent, 'scion push', async () => 'x')).toBeUndefined()
  })
})

describe('/scion long subcommands', () => {
  let workdir: string
  let root: string
  let rootReal: string
  let ctx: Context
  let previousHome: string | undefined

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-scion-jobs-'))
    previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(workdir, 'home')
    root = join(workdir, 'repo')
    await mkdir(root, { recursive: true })
    rootReal = await realpath(root)
    await run('git', ['init', '-b', 'main'], { cwd: rootReal })
    await run('git', ['config', 'user.email', 'scion@test'], { cwd: rootReal })
    await run('git', ['config', 'user.name', 'scion test'], { cwd: rootReal })
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: join(workdir, 'home', 'sessions'), compression: 'none' })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    await removeTree(workdir)
  })

  /** One workspace-owned session plus an initialized scion. */
  async function seed(): Promise<void> {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-job-seed'),
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
    await writeManifest(rootReal, createManifest({
      name: 'repo',
      root: rootReal,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
    }))
  }

  /** An agent whose session works in the scion root. */
  function agent(): Agent {
    return {
      id: SessionId('session-job-agent'),
      session: { header: { id: SessionId('session-job-agent'), cwd: rootReal } },
    } as unknown as Agent
  }

  /** Ownership index with no imported records. */
  async function ownership(): Promise<ScionOwnershipStore> {
    const store = new ScionOwnershipStore()
    await store.load()
    return store
  }

  it('submits push as a job and exports nothing inline', async () => {
    await seed()
    let captured: JobSpec | undefined
    const registry = {
      start(spec: JobSpec): string {
        captured = spec
        return 'scion-9'
      },
    }
    const service = new ScionService(hostWith(registry, ctx), await ownership())

    const result = await service.run(agent(), 'push')

    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('started as job scion-9')
    expect(captured?.kind).toBe('scion')
    expect(captured?.owner).toBe('session-job-agent')
    expect(captured?.label).toContain('scion push')
    // The work has not run yet: the job owns it.
    expect(await listRepoSessionIds(rootReal)).toEqual([])
  })

  it('runs the job work to completion, committing the export', async () => {
    await seed()
    const hooks: JobHooks[] = []
    const appends: string[] = []
    const registry = {
      start(spec: JobSpec): string {
        hooks.push(spec.run({
          id: JobId('scion-10'),
          append: text => { appends.push(text) },
          updateProgress: () => undefined,
        }))
        return 'scion-10'
      },
    }
    const service = new ScionService(hostWith(registry, ctx), await ownership())
    await service.run(agent(), 'push')

    await expect(hooks[0]!.done).resolves.toMatchObject({ status: 'completed' })
    expect(await listRepoSessionIds(rootReal)).toEqual(['session-job-seed'])
    expect(appends.join('')).toContain('session-job-seed')
  })

  it('falls back to synchronous execution without a job registry', async () => {
    await seed()
    const service = new ScionService(hostWith(undefined, ctx), await ownership())

    const result = await service.run(agent(), 'push')

    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('exported 1 session(s)')
    expect(await listRepoSessionIds(rootReal)).toEqual(['session-job-seed'])
  })
})
