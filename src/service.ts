/**
 * The `/scion` command executor.
 *
 * Every subcommand resolves its scion root from the invoking session's working
 * directory, so a command always acts on the checkout the user is talking
 * from. Nothing here reaches outside the public DSH service surface.
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
import { planPrune, pruneSessions } from './prune.ts'
import { importSessions } from './import.ts'
import { attachImported, ensureWorkspaceFor } from './workspace.ts'
import { commitAll, currentBranch, headCommit, initRepo, isDirty, isGitWorkTree, push as gitPush, pull as gitPull, pushSettingUpstream, remoteNames, upstreamOf } from './git.ts'
import { canonicalizeOrSelf, isDirectory } from './fs-util.ts'

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
   * @param agent - the invoking agent.
   * @param rawInput - text following `/scion`.
   * @returns the command result rendered by the dispatching UI.
   */
  async run(agent: Agent, rawInput: string): Promise<CommandResult> {
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
    try {
      return await this.dispatch(command, root)
    } catch (error: unknown) {
      return { kind: 'error', text: String((error as Error).message) }
    }
  }

  /**
   * Route a parsed command to its handler.
   * @param command - parsed command.
   * @param root - canonical session working directory.
   * @returns the command result.
   */
  private async dispatch(command: ScionCommand, root: string): Promise<CommandResult> {
    switch (command.kind) {
      case 'status':
        return await this.status(root)
      case 'init':
        return await this.init(root, command.name)
      case 'push':
        return await this.push(root, command.sessionIds, command.push)
      case 'pull':
        return await this.pull(root, command.sessionIds, command.git)
      case 'prune':
        return await this.prune(root, command.sessionIds, command.dryRun)
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
      `  remote    ${remotes.length === 0 ? '(none — run `git remote add origin <url>`)' : remotes.join(', ')}`,
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
   * @returns the init result.
   */
  private async init(root: string, name: string | undefined): Promise<CommandResult> {
    const existing = await readManifest(root)
    if (existing !== undefined) {
      return { kind: 'error', text: `already a scion: ${existing.name} (${existing.scionId})` }
    }
    const lines: string[] = []
    if (!(await isGitWorkTree(root))) {
      await initRepo(root)
      lines.push(`initialized a git repository in ${root}`)
    }
    const manifest = createManifest({
      name: name ?? basename(root),
      root,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
    })
    await writeManifest(root, manifest)
    lines.push(`scion "${manifest.name}" initialized (${manifest.scionId})`)
    lines.push('next: `/scion push` to export local sessions, then commit and push the repo')
    return success(lines.join('\n'))
  }

  /**
   * Export local sessions into the repo and commit them.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param alsoPush - whether to run `git push` afterwards.
   * @returns the push result.
   */
  private async push(
    root: string,
    sessionIds: readonly string[] | undefined,
    alsoPush: boolean,
  ): Promise<CommandResult> {
    const result = await exportSessions(this.ctx, {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
    })
    const lines = [
      `exported ${String(result.exported.length)} session(s), `
      + `${formatBytes(result.bytesWritten)} of plaintext JSONL`,
    ]
    for (const entry of result.exported) {
      lines.push(`  ${entry.id}  ${String(entry.eventCount)} events`)
    }
    for (const entry of result.skipped) lines.push(`  skipped ${entry.id}: ${entry.reason}`)
    if (sessionIds === undefined) {
      const candidates = await listCandidateSessions(this.ctx, root, this.ownership)
      const omitted = candidates.length - result.exported.length - result.skipped.length
      if (omitted > 0) {
        lines.push(`scoped to this DSH workspace: ${String(omitted)} session(s) share this cwd but are not members`)
        lines.push('  (subagent children / never attached; select one explicitly with `--sessions <id>`)')
      }
    }
    const commit = await commitAll(root, `scion: export ${String(result.exported.length)} session(s)`)
    lines.push(commit.summary)
    if (!alsoPush) {
      lines.push('run `git push` (or `/scion push --push`) to publish')
      return success(lines.join('\n'))
    }

    const remotes = await remoteNames(root)
    if (remotes.length === 0) {
      lines.push('no git remote is configured; run `git remote add origin <url>` first')
      return success(lines.join('\n'))
    }
    const branch = await currentBranch(root)
    if (branch === undefined) {
      lines.push('HEAD is unborn; commit something before pushing')
      return success(lines.join('\n'))
    }
    const upstream = await upstreamOf(root)
    if (upstream === undefined) {
      // A first `--push` has no upstream yet: publishing and recording it is
      // exactly what the user asked for, and is what `git push -u` does.
      const remote = remotes[0]!
      const output = await pushSettingUpstream(root, branch, remote)
      lines.push(`pushed and set upstream to ${remote}/${branch}`)
      if (output.trim().length > 0) lines.push(output.trim())
      return success(lines.join('\n'))
    }
    const output = await gitPush(root)
    lines.push(output.trim().length > 0 ? output.trim() : `pushed to ${upstream}`)
    return success(lines.join('\n'))
  }

  /**
   * Fetch the repo and import its sessions read-only.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param useGit - whether to run `git pull` first.
   * @returns the pull result.
   */
  private async pull(
    root: string,
    sessionIds: readonly string[] | undefined,
    useGit: boolean,
  ): Promise<CommandResult> {
    const lines: string[] = []
    if (useGit) {
      const output = await gitPull(root)
      lines.push(output.trim().length > 0 ? output.trim() : 'already up to date')
    }
    const result = await importSessions(this.ctx, {
      root,
      ownership: this.ownership,
      ...sessionIds === undefined ? {} : { sessionIds },
    })
    lines.push(`imported into ${root}`)
    lines.push(`  created   ${String(result.created.length)}`)
    lines.push(`  extended  ${String(result.appended.length)}`)
    lines.push(`  current   ${String(result.unchanged.length)}`)
    for (const id of [...result.created, ...result.appended]) lines.push(`    ${id}`)
    if (result.refused.length > 0) {
      lines.push(`  refused   ${String(result.refused.length)}`)
      for (const entry of result.refused) lines.push(`    ${entry.id}: ${entry.reason}`)
    }
    const touched = [...result.created, ...result.appended]
    if (touched.length > 0) {
      const attach = await attachImported(this.ctx, root, touched)
      if (attach.workspaceId === undefined) {
        lines.push('no workspace registry is composed; imported sessions are listed under Ungrouped')
      } else {
        lines.push(`attached ${String(attach.attached.length)} to workspace ${attach.workspaceId}`)
        for (const failure of attach.failed) lines.push(`    not attached ${failure.id}: ${failure.reason}`)
      }
      lines.push('imported sessions are read-only; fork one to continue working')
    }
    return success(lines.join('\n'))
  }

  /**
   * Drop exported sessions the workspace no longer owns, then commit.
   * @param root - canonical root.
   * @param sessionIds - optional explicit selection.
   * @param dryRun - whether to report the plan without deleting anything.
   * @returns the prune result.
   */
  private async prune(
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

    const plan = await pruneSessions(this.ctx, options)
    const lines = [
      `pruned ${String(plan.pruned.length)} session(s), ${String(plan.kept)} kept in the repo`,
    ]
    for (const entry of plan.pruned) {
      lines.push(`  ${entry.id}  ${String(entry.eventCount)} events  (${entry.reason})`)
    }
    for (const id of plan.unmanaged) lines.push(`  unmanaged, left alone: ${id}`)
    if (plan.pruned.length === 0) return success(lines.join('\n'))
    const commit = await commitAll(root, `scion: prune ${String(plan.pruned.length)} session(s)`)
    lines.push(commit.summary)
    lines.push('run `git push` to publish the prune')
    return success(lines.join('\n'))
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
