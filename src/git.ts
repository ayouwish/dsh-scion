/**
 * Minimal `git` subprocess wrapper.
 *
 * Scion owns no VCS implementation; `git` is the transport and is invoked as
 * an external command. Every call runs with the scion root as its working
 * directory, and a non-zero exit becomes a {@link ScionGitError} carrying the
 * captured stderr so command output stays actionable.
 *
 * @module @asyouwish/dsh-scion/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A `git` invocation that exited non-zero. */
export class ScionGitError extends Error {
  /**
   * @param args - the `git` arguments that failed.
   * @param stderr - captured standard error.
   * @param code - process exit code when one was reported.
   */
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly code: number | undefined,
  ) {
    super(`git ${args.join(' ')} failed${code === undefined ? '' : ` (exit ${String(code)})`}: ${stderr.trim()}`)
    this.name = 'ScionGitError'
  }
}

/**
 * Run one `git` command inside a directory.
 * @param cwd - directory the command runs in.
 * @param args - `git` arguments, excluding the program name.
 * @returns captured standard output.
 * @throws {ScionGitError} when `git` exits non-zero.
 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (error: unknown) {
    const failure = error as { stderr?: unknown; code?: unknown; message?: unknown }
    const stderr = typeof failure.stderr === 'string' && failure.stderr.length > 0
      ? failure.stderr
      : String(failure.message ?? 'unknown git failure')
    const code = typeof failure.code === 'number' ? failure.code : undefined
    throw new ScionGitError(args, stderr, code)
  }
}

/**
 * Whether a directory is inside a git work tree.
 * @param root - directory to test.
 * @returns true when `git rev-parse --is-inside-work-tree` succeeds.
 */
export async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Initialize a repository at the scion root.
 * @param root - directory to initialize.
 */
export async function initRepo(root: string): Promise<void> {
  await git(root, ['init'])
}

/** Current `HEAD` commit, or `undefined` on an unborn branch. */
export async function headCommit(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return undefined
  }
}

/** Outcome of a `git add` + `git commit` attempt. */
export interface ScionCommitResult {
  /** Whether a commit was created (false when nothing changed). */
  readonly committed: boolean
  /** Short human-readable summary. */
  readonly summary: string
}

/**
 * Stage everything and commit when the index is dirty.
 * @param root - scion root.
 * @param message - commit message.
 * @returns whether a commit was created.
 */
export async function commitAll(root: string, message: string): Promise<ScionCommitResult> {
  await git(root, ['add', '-A'])
  const staged = (await git(root, ['diff', '--cached', '--name-only'])).trim()
  if (staged.length === 0) return { committed: false, summary: 'nothing to commit' }
  await git(root, ['commit', '-m', message])
  const count = staged.split('\n').length
  return { committed: true, summary: `committed ${String(count)} changed path(s)` }
}

/**
 * Fetch and integrate the configured upstream.
 * @param root - scion root.
 * @returns captured output.
 */
export async function pull(root: string): Promise<string> {
  return await git(root, ['pull', '--ff-only'])
}

/**
 * Push the current branch to its upstream.
 * @param root - scion root.
 * @returns captured output.
 */
export async function push(root: string): Promise<string> {
  return await git(root, ['push'])
}

/** Current branch name, or `undefined` on an unborn branch. */
export async function currentBranch(root: string): Promise<string | undefined> {
  try {
    const name = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return name.length === 0 || name === 'HEAD' ? undefined : name
  } catch {
    return undefined
  }
}

/**
 * Configured remote names, in `git remote` order (alphabetical).
 * @param root - scion root.
 * @returns remote names; empty when none is configured.
 */
export async function remoteNames(root: string): Promise<string[]> {
  const output = await git(root, ['remote'])
  return output.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * One remote's configured URL.
 * @param root - scion root.
 * @param name - remote name.
 * @returns the URL, or `undefined` when the remote is absent.
 */
export async function remoteUrl(root: string, name: string): Promise<string | undefined> {
  try {
    const url = (await git(root, ['remote', 'get-url', name])).trim()
    return url.length === 0 ? undefined : url
  } catch {
    return undefined
  }
}

/**
 * Add a remote, or point an existing one at a new URL.
 *
 * This is the whole point of the command surface: a user hands scion a
 * repository URL and never has to run `git remote add`/`set-url` by hand.
 *
 * @param root - scion root.
 * @param name - remote name.
 * @param url - repository URL.
 * @returns whether the remote was created or updated.
 */
export async function setRemote(root: string, name: string, url: string): Promise<'added' | 'updated'> {
  if ((await remoteNames(root)).includes(name)) {
    await git(root, ['remote', 'set-url', name, url])
    return 'updated'
  }
  await git(root, ['remote', 'add', name, url])
  return 'added'
}

/**
 * Hide credentials embedded in a repository URL for display.
 *
 * Only URL forms carry userinfo (`https://user:token@host/...`); scp-like
 * spellings (`git@host:path`) are shown unchanged.
 *
 * @param url - repository URL.
 * @returns the URL with any userinfo replaced by `***`.
 */
export function maskRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, '$1***@')
}

/**
 * The branch's configured upstream, when one exists.
 * @param root - scion root.
 * @returns e.g. `origin/master`, or `undefined` without an upstream.
 */
export async function upstreamOf(root: string): Promise<string | undefined> {
  try {
    const name = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
    return name.length === 0 ? undefined : name
  } catch {
    return undefined
  }
}

/**
 * Push and record the upstream, which is what a first `--push` needs.
 * @param root - scion root.
 * @param branch - branch to publish.
 * @param remote - remote to publish to.
 * @returns captured output.
 */
export async function pushSettingUpstream(
  root: string,
  branch: string,
  remote: string,
): Promise<string> {
  return await git(root, ['push', '--set-upstream', remote, branch])
}

/**
 * Whether the work tree has uncommitted changes.
 * @param root - scion root.
 * @returns true when `git status --porcelain` reports anything.
 */
export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain'])).trim().length > 0
}
