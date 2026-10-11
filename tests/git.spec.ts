/**
 * `git` wrapper tests — including the exact failure that a first `--push`
 * hits: a branch with a remote but no upstream.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitAll,
  currentBranch,
  isDirty,
  isGitWorkTree,
  pushSettingUpstream,
  remoteNames,
  upstreamOf,
} from '../src/git.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Create a work repo plus a bare remote it can push to. */
async function makePair(): Promise<{ work: string; bare: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-scion-git-'))
  roots.push(base)
  const work = join(base, 'work')
  const bare = join(base, 'bare.git')
  await writeFile(join(base, 'placeholder'), '')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await run('git', ['init', '--bare', '-b', 'main', bare], { cwd: base })
  await run('git', ['init', '-b', 'main', work], { cwd: base })
  await run('git', ['config', 'user.email', 'scion@test'], { cwd: work })
  await run('git', ['config', 'user.name', 'scion test'], { cwd: work })
  await run('git', ['remote', 'add', 'origin', bare], { cwd: work })
  return { work, bare }
}

describe('git wrapper', () => {
  it('reports repository state and configures the upstream on first push', async () => {
    const { work } = await makePair()
    expect(await isGitWorkTree(work)).toBe(true)
    expect(await isGitWorkTree(join(work, 'nope'))).toBe(false)
    // An unborn branch has no resolvable name yet.
    expect(await currentBranch(work)).toBeUndefined()
    expect(await remoteNames(work)).toEqual(['origin'])
    // The failure the user hit: a remote exists, but the branch has no upstream.
    expect(await upstreamOf(work)).toBeUndefined()

    await writeFile(join(work, 'file.txt'), 'hello\n')
    expect(await isDirty(work)).toBe(true)
    const first = await commitAll(work, 'first')
    expect(first.committed).toBe(true)
    expect(await currentBranch(work)).toBe('main')
    expect(await isDirty(work)).toBe(false)
    expect((await commitAll(work, 'noop')).committed).toBe(false)

    await pushSettingUpstream(work, 'main', 'origin')
    expect(await upstreamOf(work)).toBe('origin/main')
  })

  it('reports no remote for a fresh repository', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-scion-git-solo-'))
    roots.push(base)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: base })
    expect(await remoteNames(base)).toEqual([])
    expect(await upstreamOf(base)).toBeUndefined()
  })
})
