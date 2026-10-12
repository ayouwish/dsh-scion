/**
 * The in-surface repository flow: `/scion init --remote` and `/scion remote`
 * configure origin so a user never has to run `git remote add` by hand.
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ScionService } from '../src/service.ts'
import { remoteUrl } from '../src/git.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { removeTree } from '../src/fs-util.ts'

let workdir: string
let root: string
let previousHome: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-scion-remote-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = join(workdir, 'home')
  root = join(workdir, 'repo')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await removeTree(workdir)
})

/** `remote` and `init` need neither persistence nor a workspace registry. */
const host = { get: () => undefined } as unknown as Context

/** An agent whose session works in the temp root. */
function agentAt(directory: string): Agent {
  return {
    id: SessionId('session-remote'),
    session: { header: { id: SessionId('session-remote'), cwd: directory } },
  } as unknown as Agent
}

/** A service over the bare host. */
async function service(): Promise<ScionService> {
  const ownership = new ScionOwnershipStore()
  await ownership.load()
  return new ScionService(host, ownership)
}

/** The rendered text of a command result. */
function text(result: CommandResult): string {
  return result.text ?? ''
}

describe('/scion remote surface', () => {
  it('initializes a scion with its repository URL in one step', async () => {
    const secret = 'https://user:secret@example.com/team/repo.git'
    const result = await (await service()).run(agentAt(root), `init my-scion --remote ${secret}`)

    expect(result.kind).toBe('success')
    expect(text(result)).toContain('added remote origin → https://***@example.com/team/repo.git')
    expect(text(result)).not.toContain('secret')
    expect(await remoteUrl(root, 'origin')).toBe(secret)
    const manifest = JSON.parse(await readFile(join(root, '.dsh', 'scion.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe('my-scion')
  })

  it('adds, then updates, then reports origin', async () => {
    const svc = await service()
    await svc.run(agentAt(root), 'init')

    expect(text(await svc.run(agentAt(root), 'remote https://example.com/team/repo.git')))
      .toContain('added remote origin')
    expect(text(await svc.run(agentAt(root), 'remote https://example.com/team/other.git')))
      .toContain('updated remote origin')

    const shown = text(await svc.run(agentAt(root), 'remote'))
    expect(shown).toContain('origin      https://example.com/team/other.git')
    expect(shown).toContain('upstream  (none')
  })

  it('reports the missing remote and refuses outside a git work tree', async () => {
    const svc = await service()
    await svc.run(agentAt(root), 'init')
    expect(text(await svc.run(agentAt(root), 'remote'))).toContain('no git remote is configured')

    const plain = join(workdir, 'plain')
    await mkdir(plain)
    const result = await svc.run(agentAt(plain), 'remote https://example.com/x.git')
    expect(result.kind).toBe('error')
    expect(text(result)).toContain('not a git repository')
  })
})
