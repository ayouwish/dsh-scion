/**
 * `/scion` argument parsing.
 *
 * Pure and total: the parser never throws and never touches the filesystem, so
 * the command surface's grammar is unit-testable without a host.
 *
 * @module @asyouwish/dsh-scion/commands
 */

/** One parsed `/scion` invocation. */
export type ScionCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'init'; readonly name: string | undefined; readonly remote: string | undefined }
  | { readonly kind: 'remote'; readonly url: string | undefined }
  | { readonly kind: 'push'; readonly sessionIds: readonly string[] | undefined; readonly push: boolean }
  | { readonly kind: 'pull'; readonly sessionIds: readonly string[] | undefined; readonly git: boolean }
  | { readonly kind: 'prune'; readonly sessionIds: readonly string[] | undefined; readonly dryRun: boolean }
  | { readonly kind: 'forget'; readonly sessionId: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }

/** Usage text shown for `/scion`, `/scion help`, and bad input. */
export const SCION_USAGE = [
  'Scion — a git-carried workspace + session unit.',
  '',
  '/scion status                     show this scion, local sessions, and imported sessions',
  '/scion init [name] [--remote <url>]  initialize this directory as a scion and optionally set origin',
  '/scion remote [<url>]             show, or set, the origin repository URL',
  '/scion push [--sessions a,b] [--push]   export local sessions into the repo (commit; --push also pushes)',
  '/scion pull [--sessions a,b] [--no-git]  git pull, then import repo sessions read-only',
  '/scion prune [--sessions a,b] [--dry-run]  drop exported sessions the workspace no longer owns',
  '/scion forget <session-id>        drop the read-only ownership record (files are left alone)',
].join('\n')

/**
 * Parse the text following `/scion`.
 * @param rawInput - raw command input.
 * @returns the parsed command, or an `error` carrying usage.
 */
export function parseScionCommand(rawInput: string): ScionCommand {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token.length > 0)
  const [subcommand, ...rest] = tokens
  switch (subcommand) {
    case undefined:
    case 'help':
    case '--help':
      return { kind: 'help' }
    case 'status':
      return rest.length === 0 ? { kind: 'status' } : unexpected(rest[0], 'status')
    case 'init': {
      let name: string | undefined
      let remote: string | undefined
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index]!
        if (token === '--remote') {
          const value = rest[index + 1]
          if (value === undefined) return { kind: 'error', message: '--remote needs a repository URL' }
          remote = value
          index++
          continue
        }
        if (token.startsWith('-') || name !== undefined) return unexpected(token, 'init')
        name = token
      }
      return { kind: 'init', name, remote }
    }
    case 'remote': {
      if (rest.length === 0) return { kind: 'remote', url: undefined }
      if (rest.length === 1 && !rest[0]!.startsWith('-')) return { kind: 'remote', url: rest[0] }
      return unexpected(rest[0], 'remote')
    }
    case 'push': {
      const selection = parseSelection(rest, ['--sessions', '--push'])
      if ('message' in selection) return { kind: 'error', message: selection.message }
      return { kind: 'push', sessionIds: selection.sessionIds, push: selection.flags.has('--push') }
    }
    case 'pull': {
      const selection = parseSelection(rest, ['--sessions', '--no-git'])
      if ('message' in selection) return { kind: 'error', message: selection.message }
      return { kind: 'pull', sessionIds: selection.sessionIds, git: !selection.flags.has('--no-git') }
    }
    case 'prune': {
      const selection = parseSelection(rest, ['--sessions', '--dry-run'])
      if ('message' in selection) return { kind: 'error', message: selection.message }
      return { kind: 'prune', sessionIds: selection.sessionIds, dryRun: selection.flags.has('--dry-run') }
    }
    case 'forget': {
      if (rest.length !== 1) return { kind: 'error', message: 'usage: /scion forget <session-id>' }
      return { kind: 'forget', sessionId: rest[0]! }
    }
    default:
      return { kind: 'error', message: `unknown subcommand "${subcommand}"\n\n${SCION_USAGE}` }
  }
}

/** Result of parsing the shared option tail. */
type SelectionParse =
  | { readonly sessionIds: readonly string[] | undefined; readonly flags: ReadonlySet<string> }
  | { readonly message: string }

/**
 * Parse the option tail shared by `push` and `pull`.
 * @param tokens - option tokens.
 * @param allowed - accepted flags.
 * @returns the selection, or an error message.
 */
function parseSelection(tokens: readonly string[], allowed: readonly string[]): SelectionParse {
  const flags = new Set<string>()
  let sessionIds: string[] | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--sessions') {
      const value = tokens[index + 1]
      if (value === undefined) return { message: '--sessions needs a comma-separated id list' }
      const ids = value.split(',').map(part => part.trim()).filter(part => part.length > 0)
      if (ids.length === 0) return { message: '--sessions needs at least one id' }
      sessionIds = ids
      index++
      continue
    }
    if (!allowed.includes(token)) return { message: `unknown option "${token}"` }
    flags.add(token)
  }
  return { sessionIds, flags }
}

/**
 * Build an unknown-argument error.
 * @param token - offending token.
 * @param subcommand - subcommand it appeared under.
 * @returns the error command.
 */
function unexpected(token: string | undefined, subcommand: string): ScionCommand {
  return { kind: 'error', message: `unexpected argument "${String(token)}" for "${subcommand}"\n\n${SCION_USAGE}` }
}
