/**
 * The `/scion` command executor.
 *
 * Every subcommand resolves its scion root from the invoking session's working
 * directory, so a command always acts on the checkout the user is talking from.
 * Nothing here reaches outside the public DSH service surface.
 *
 * Quick subcommands (`status`, `init`, `forget`) answer inline. The long ones
 * (`push`, `pull`, `prune`) run as background jobs when the deployment composes
 * a job registry, so the conversation keeps flowing: the command returns a job
 * id immediately, detail and progress stream into the job's ring, and the owner
 * can kill it. Without a registry the same work runs synchronously and its
 * output becomes the command text.
 *
 * @module @asyouwish/dsh-scion/service
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ScionOwnershipStore } from './ownership.ts'
import { SCION_USAGE, parseScionCommand } from './commands.ts'
import type { ScionCommand } from './commands.ts'
import { createManifest, readManifest, writeManifest } from './manifest.ts'
import { exportSessions, listCandidateSessions, listLocalSessions } from './export.ts'
import { startScionJob } from './jobs.ts'
import type { ScionJob } from './jobs.ts'
import { planPrune, pruneSessions } from './prune.ts'
import { importSessions } from './import.ts'
import { attachImported, ensureWorkspaceFor } from './workspace.ts'
import { commitAll, currentBranch, headCommit, initRepo, isDirty, isGitWorkTree, maskRemoteUrl, push as gitPush, pull as gitPull, pushSettingUpstream, remoteNames, remoteUrl, setRemote, upstreamOf } from './git.ts'
import { canonicalizeOrSelf, isDirectory } from './fs-util.ts'

/** Sink for one operation's detail lines and its single live progress line. */
interface ScionSink {
  /** Append one human-readable detail line. */
  line(text: string): void
  /** Replace the operation's live progress line. */
  progress(text: string): void
}

/** Collect detail lines so a synchronous run can render them as command text. */
function collectingSink(): { readonly sink: ScionSink; readonly lines: string[] } {
  const lines: string[] = []
  return { sink: { line: text => { lines.push(text) }, progress: () => undefined }, lines }
}

/** Stream detail lines and progress into a background job's ring. */
function jobSink(job: ScionJob): ScionSink {
  return {
    line: text => { job.append(`${text}\n`) },
    progress: text => { job.progress(text) },
  }
}

/**
 * Build the result that reports a job submission.
 * @param label - the operation's job label.
 * @param jobId - the issued job id.
 * @returns the command result.
 */
function started(label: string, jobId: string): CommandResult {
  return {
    kind: 'success',
    text: [
      `${label} — started as job ${jobId}`,
      'progress and output stream into the job; completion arrives in this session as a notice',
    ].join('\n'),
  }
}

/** Executes parsed `/scion` commands against the host. */
export class ScionService {
  /**
   * @param ctx - host context.
   * @param ownership - machine-local ownership index.
   */
  constructor(
    private readonly ctx: Context,
    private readonly ownership: ScionOwnershipStore,
  ) {}

  /**
   * Run one `/scion` invocation.
   *
   * The whole body is contained: a malformed command or a broken host must
   * surface as an error result, never as a rejected command call (a rejection
   * renders as nothing at all in the composer).
   *
   * @param agent - the invoking agent.
   * @param rawInput - text following `/scion`.
   * @returns the command result rendered by the dispatching UI.
   */
  async run(agent: Agent, rawInput: string): Promise<CommandResult> {
    try {
      const command = parseScionCommand(rawInput)
      if (command.kind === 'help') return success(SCION_USAGE)
      if (command.kind === 'error') return { kind: 'error', text: command.message }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        return { kind: 'error', text: 'this session has no working directory, so it cannot address a scion' }
      }
      const root = await canonicalizeOrSelf(cwd)
      if (!(await isDirectory(root))) {
        return { kind: 'error', text: `the session working directory does not exist: ${root}` }
      }
      return await this.dispatch(command, root, agent)
    } catch (error: unknown) {
      return { kind: 'error', text: `scion: ${String((error as Error).message)}` }
    }
  }

  /**
   * Route a parsed command to its handler.
   * @param command - parsed command.
   * @param root - canonical session working directory.
   * @param agent - the invoking agent, which owns any job this starts.
   * @returns the command result.
   */
  private async dispatch(command: ScionCommand, root: string, agent: Agent): Promise<CommandResult> {
    switch (command.kind) {
      case 'status':
        return await this.status(root)
      case 'init':
        return await this.init(root, command.name, command.remote)
      case 'remote':
        return await this.remote(root, command.url)
      case 'push':
        return await this.push(agent, root, command.sessionIds, command.push)
      case 'pull':
        return await this.pull(agent, root, command.sessionIds, command.git)
      case 'prune':
        return await this.prune(agent, root, command.sessionIds, command.dryRun)
      case 'forget':
        return await this.forget(command.sessionId)
      default:
        return { kind: 'error', text: SCION_USAGE }
    }
  }

  /**
   * Report the scion, its exported sessions, and this machine's imports.
   * @param root - canonical root.
   * @returns the status text.
   */
  private async status(root: string): Promise<CommandResult> {
    const manifest = await readManifest(root)
    if (manifest === undefined) {
      return success([
        `not an initialized scion: ${root}`,
        'run `/scion init` to initialize this directory',
      ].join('\n'))
    }
    const workspace = await ensureWorkspaceFor(this.ctx, root)
    const local = await listLocalSessions(this.ctx, root, this.ownership)
    const candidates = await listCandidateSessions(this.ctx, root, this.ownership)
    const imported = this.ownership.all().filter(record => record.localRoot === root)
    const head = await headCommit(root)
    const remotes = await remoteNames(root)
    const upstream = await upstreamOf(root)
    const dirty = await isDirty(root)
    const lines = [
      `scion ${manifest.name}`,
      `  root      ${root}`,
      `  id        ${manifest.scionId}`,
      `  format    v${String(manifest.sessionFormatVersion)} (this writer: v${String(SESSION_FORMAT_VERSION)})`,
      `  exported  ${String(manifest.sessions.length)} session(s) in the repo`,
      `  head      ${head ?? '(no commits yet)'}`,
      `  branch    ${await currentBranch(root) ?? '(unborn)'}`,
      `  remote    ${remotes.length === 0 ? '(none — run `/scion remote <url>`)' : remotes.join(', ')}`,
      `  upstream  ${upstream ?? '(none — `/scion push --push` sets it on first publish)'}`,
      `  worktree  ${dirty ? 'dirty (uncommitted changes)' : 'clean'}`,
      `  workspace ${workspace === undefined ? '(no workspace registry)' : String(workspace.id)}`,
      `  local     ${String(local.length)} session(s) exportable (workspace-owned)`,
      `  all       ${String(candidates.length)} session(s) with this cwd (subagent / unattached included)`,
      `  imported  ${String(imported.length)} read-only session(s)`,
    ]
    for (const header of local) lines.push(`    local     ${String(header.id)}`)
    for (const record of imported) {
      lines.push(`    readonly  ${record.sessionId}  ← ${record.sourceRoot} (${String(record.eventCount)} events)`)
    }
    return success(lines.join('\n'))
  }

  /**
   * Initialize the current directory as a scion.
   * @param root - canonical root.
   * @param name - optional display name.
   * @param remote - optional origin URL to configure in the same step.
   * @returns the init result.
   */
  private async init(root: string, name: string | undefined, remote: string | undefined): Promise<CommandResult> {
    const existing = await readManifest(root)
    if (existing !== undefined) {
      return { kind: 'error', text: `already a scion: ${existing.name} (${existing.scionId})` }
    }
    const lines: string[] = []
    if (!(await isGitWorkTree(root))) {
      await initRepo(root)
      lines.push(`initialized a git repository in ${root}`)
    }
    if (remote !== undefined) {
      lines.push(await configureRemote(root, remote))
    }
    const manifest = createManifest({
      name: name ?? basename(root),
      root,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
    })
    await writeManifest(root, manifest)
    lines.push(`scion "${manifest.name}" initialized (${manifest.scionId})`)
    lines.push('next: `/scion push` to export local sessions, then publish the repo')
    return success(lines.join('\n'))
  }

  /**
   * Show, or set, the origin repository URL.
   *
   * This is the surface that keeps repository plumbing out of the terminal:
   * one URL, and `push`/`pull` work from then on.
   *
   * @param root - canonical root.
   * @param url - repository URL to set, or undefined to report the current state.
   * @returns the remote result.
   */
  private async remote(root: string, url: string | undefined): Promise<CommandResult> {
    if (!(await isGitWorkTree(root))) {
      return {
        kind: 'error',
        text: `not a git repository: ${root}\nrun \`/scion init [name] --remote <url>\` first`,
      }
    }
    if (url !== undefined) {
      return success([
        await configureRemote(root, url),
        'push with `/scion push --push`, or fetch with `/scion pull`',
      ].join('\n'))
    }
    const remotes = await remoteNames(root)
    const lines = remotes.length === 0
      ? ['no git remote is configured', 'set one with `/scion remote <repository-url>`']
      : [`remote(s) ${String(remotes.length)}`]
    for (const name of remotes) {
      lines.push(`  ${name}      ${maskRemoteUrl((await remoteUrl(root, name)) ?? '(unset)')}`)
    }
    lines.push(`  upstream  ${await upstreamOf(root) ?? '(none — `/scion push --push` sets it on first publish)'}`)
    return success(lines.join('\n'))
  }

  /**
   * Export local sessions into the repo and commit them.
   * @param agent - owning agent.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param alsoPush - whether to run `git push` afterwards.
   * @returns the push result, or the job that now runs it.
   */
  private async push(
    agent: Agent,
    root: string,
    sessionIds: readonly string[] | undefined,
    alsoPush: boolean,
  ): Promise<CommandResult> {
    const label = `scion push${alsoPush ? ' --push' : ''} (${basename(root)})`
    const jobId = startScionJob(this.ctx, agent, label, job =>
      this.executePush(root, sessionIds, alsoPush, jobSink(job), job.signal))
    if (jobId !== undefined) return started(label, jobId)
    const { sink, lines } = collectingSink()
    return success([await this.executePush(root, sessionIds, alsoPush, sink, undefined), ...lines].join('\n'))
  }

  /**
   * The export-then-commit(-then-push) operation behind `/scion push`.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param alsoPush - whether to publish after committing.
   * @param sink - detail and progress sink.
   * @param signal - cancellation for the export loop.
   * @returns the one-line summary.
   */
  private async executePush(
    root: string,
    sessionIds: readonly string[] | undefined,
    alsoPush: boolean,
    sink: ScionSink,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await exportSessions(this.ctx, {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
      ...signal === undefined ? {} : { signal },
      onProgress: (done, total, id) => { sink.progress(`exporting ${String(done + 1)}/${String(total)} ${id}`) },
    })
    const summary = `exported ${String(result.exported.length)} session(s), `
      + `${formatBytes(result.bytesWritten)} of plaintext JSONL`
    for (const entry of result.exported) {
      sink.line(`  ${entry.id}  ${String(entry.eventCount)} events`)
    }
    for (const entry of result.skipped) sink.line(`  skipped ${entry.id}: ${entry.reason}`)
    if (sessionIds === undefined) {
      const candidates = await listCandidateSessions(this.ctx, root, this.ownership)
      const omitted = candidates.length - result.exported.length - result.skipped.length
      if (omitted > 0) {
        sink.line(`scoped to this DSH workspace: ${String(omitted)} session(s) share this cwd but are not members`)
        sink.line('  (subagent children / never attached; select one explicitly with `--sessions <id>`)')
      }
    }
    const commit = await commitAll(root, `scion: export ${String(result.exported.length)} session(s)`)
    sink.line(commit.summary)
    if (!alsoPush) {
      const next = 'run `git push` (or `/scion push --push`) to publish'
      sink.line(next)
      return `${summary}; ${commit.summary}`
    }

    const remotes = await remoteNames(root)
    if (remotes.length === 0) {
      const outcome = 'no git remote is configured; run `/scion remote <url>` first'
      sink.line(outcome)
      return `${summary}; ${commit.summary}; ${outcome}`
    }
    const branch = await currentBranch(root)
    if (branch === undefined) {
      const outcome = 'HEAD is unborn; commit something before pushing'
      sink.line(outcome)
      return `${summary}; ${commit.summary}; ${outcome}`
    }
    const upstream = await upstreamOf(root)
    if (upstream === undefined) {
      // A first `--push` has no upstream yet: publishing and recording it is
      // exactly what the user asked for, and is what `git push -u` does.
      const remote = remotes[0]!
      const output = await pushSettingUpstream(root, branch, remote)
      const outcome = `pushed and set upstream to ${remote}/${branch}`
      sink.line(outcome)
      if (output.trim().length > 0) sink.line(output.trim())
      return `${summary}; ${commit.summary}; ${outcome}`
    }
    const output = await gitPush(root)
    const outcome = output.trim().length > 0 ? output.trim() : `pushed to ${upstream}`
    sink.line(outcome)
    return `${summary}; ${commit.summary}; ${outcome}`
  }

  /**
   * Fetch the repo and import its sessions read-only.
   * @param agent - owning agent.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param useGit - whether to run `git pull` first.
   * @returns the pull result, or the job that now runs it.
   */
  private async pull(
    agent: Agent,
    root: string,
    sessionIds: readonly string[] | undefined,
    useGit: boolean,
  ): Promise<CommandResult> {
    const label = `scion pull${useGit ? '' : ' --no-git'} (${basename(root)})`
    const jobId = startScionJob(this.ctx, agent, label, job =>
      this.executePull(root, sessionIds, useGit, jobSink(job), job.signal))
    if (jobId !== undefined) return started(label, jobId)
    const { sink, lines } = collectingSink()
    return success([await this.executePull(root, sessionIds, useGit, sink, undefined), ...lines].join('\n'))
  }

  /**
   * The fetch-then-import operation behind `/scion pull`.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param useGit - whether to run `git pull` first.
   * @param sink - detail and progress sink.
   * @param signal - cancellation for the import loop.
   * @returns the one-line summary.
   */
  private async executePull(
    root: string,
    sessionIds: readonly string[] | undefined,
    useGit: boolean,
    sink: ScionSink,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (useGit) {
      const remotes = await remoteNames(root)
      if (remotes.length === 0) {
        // A local-only scion still imports its own repo; fetching needs a remote.
        sink.line('no git remote is configured; importing the local repo as-is '
          + '(set one with `/scion remote <url>`)')
      } else {
        const output = await gitPull(root)
        sink.line(output.trim().length > 0 ? output.trim() : 'already up to date')
      }
    }
    const result = await importSessions(this.ctx, {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
      ...signal === undefined ? {} : { signal },
      onProgress: (done, total, id) => { sink.progress(`importing ${String(done + 1)}/${String(total)} ${id}`) },
    })
    sink.line(`  created   ${String(result.created.length)}`)
    sink.line(`  extended  ${String(result.appended.length)}`)
    sink.line(`  current   ${String(result.unchanged.length)}`)
    for (const id of [...result.created, ...result.appended]) sink.line(`    ${id}`)
    if (result.refused.length > 0) {
      sink.line(`  refused   ${String(result.refused.length)}`)
      for (const entry of result.refused) sink.line(`    ${entry.id}: ${entry.reason}`)
    }
    const touched = [...result.created, ...result.appended]
    if (touched.length > 0) {
      const attach = await attachImported(this.ctx, root, touched)
      if (attach.workspaceId === undefined) {
        sink.line('no workspace registry is composed; imported sessions are listed under Ungrouped')
      } else {
        sink.line(`attached ${String(attach.attached.length)} to workspace ${attach.workspaceId}`)
        for (const failure of attach.failed) sink.line(`    not attached ${failure.id}: ${failure.reason}`)
      }
      sink.line('imported sessions are read-only; fork one to continue working')
    }
    return `imported into ${root}: created ${String(result.created.length)}, `
      + `extended ${String(result.appended.length)}, current ${String(result.unchanged.length)}`
      + (result.refused.length > 0 ? `, refused ${String(result.refused.length)}` : '')
  }

  /**
   * Drop exported sessions the workspace no longer owns, then commit.
   *
   * `--dry-run` only reads a plan, so it always answers inline; the real prune
   * runs as a job.
   *
   * @param agent - owning agent.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param dryRun - whether to report the plan without deleting anything.
   * @returns the prune result, or the job that now runs it.
   */
  private async prune(
    agent: Agent,
    root: string,
    sessionIds: readonly string[] | undefined,
    dryRun: boolean,
  ): Promise<CommandResult> {
    const options = {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
    }
    if (dryRun) {
      const plan = await planPrune(this.ctx, options)
      const lines = [
        `dry run: ${String(plan.pruned.length)} session(s) would be pruned, `
        + `${String(plan.kept)} kept in the repo`,
      ]
      for (const entry of plan.pruned) {
        lines.push(`  ${entry.id}  ${String(entry.eventCount)} events  (${entry.reason})`)
      }
      for (const id of plan.unmanaged) lines.push(`  unmanaged, left alone: ${id}`)
      lines.push(plan.pruned.length === 0
        ? 'nothing to prune'
        : 'run `/scion prune` without --dry-run to delete these files and commit')
      return success(lines.join('\n'))
    }

    const label = `scion prune (${basename(root)})`
    const jobId = startScionJob(this.ctx, agent, label, job =>
      this.executePrune(root, sessionIds, jobSink(job), job.signal))
    if (jobId !== undefined) return started(label, jobId)
    const { sink, lines } = collectingSink()
    return success([await this.executePrune(root, sessionIds, sink, undefined), ...lines].join('\n'))
  }

  /**
   * The plan-then-delete-then-commit operation behind `/scion prune`.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param sink - detail and progress sink.
   * @param signal - cancellation observed between deletions.
   * @returns the one-line summary.
   */
  private async executePrune(
    root: string,
    sessionIds: readonly string[] | undefined,
    sink: ScionSink,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const plan = await pruneSessions(this.ctx, {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
      ...signal === undefined ? {} : { signal },
      onProgress: (done, total, id) => { sink.progress(`pruning ${String(done)}/${String(total)} ${id}`) },
    })
    for (const entry of plan.pruned) {
      sink.line(`  ${entry.id}  ${String(entry.eventCount)} events  (${entry.reason})`)
    }
    for (const id of plan.unmanaged) sink.line(`  unmanaged, left alone: ${id}`)
    if (plan.pruned.length === 0) {
      return `nothing to prune; ${String(plan.kept)} session(s) kept in the repo`
    }
    const commit = await commitAll(root, `scion: prune ${String(plan.pruned.length)} session(s)`)
    sink.line(commit.summary)
    return `pruned ${String(plan.pruned.length)} session(s), `
      + `${String(plan.kept)} kept in the repo; ${commit.summary}`
  }

  /**
   * Drop one read-only ownership record.
   * @param sessionId - session id.
   * @returns the forget result.
   */
  private async forget(sessionId: string): Promise<CommandResult> {
    const removed = await this.ownership.forget(sessionId)
    return success(removed
      ? `forgot ${sessionId}; its files were left in place and it is no longer marked read-only`
      : `${sessionId} is not an imported session`)
  }
}

/**
 * Add or update `origin` and describe the change.
 * @param root - scion root inside a git work tree.
 * @param url - repository URL.
 * @returns the human-readable change line.
 */
async function configureRemote(root: string, url: string): Promise<string> {
  const state = await setRemote(root, 'origin', url)
  return `${state} remote origin → ${maskRemoteUrl(url)}`
}

/**
 * Build a success result.
 * @param text - rendered text.
 * @returns the command result.
 */
function success(text: string): CommandResult {
  return { kind: 'success', text }
}

/**
 * Render a byte count for humans.
 * @param bytes - byte count.
 * @returns a compact human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}
