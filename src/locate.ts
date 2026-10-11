/**
 * Locate a session's artifact directory inside `$DSH_HOME/sessions`.
 *
 * The JSONL backend derives the directory from the header (`projectKey(cwd)`
 * plus the encoded session id) and exposes no path through the persistence
 * seam. The plugin needs the directory to apply the filesystem read-only
 * layer, so it mirrors the two pure name functions and **verifies** the
 * result: a mirror that ever drifts from the backend simply fails to find the
 * directory and falls back to a scan.
 *
 * The mirror is pinned by a test that materializes a real session through the
 * real backend and asserts the located directory is the one the backend used.
 *
 * @module @asyouwish/dsh-scion/locate
 */

import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isDirectory } from './fs-util.ts'

/**
 * Encode an arbitrary string as one filesystem-safe path segment.
 *
 * Mirrors `encodeSegment` in `@deepseek-ai/dsh-session-persistence-jsonl`
 * (`src/format.ts`).
 *
 * @param raw - string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project-directory key for a working directory.
 *
 * Mirrors `projectKey` in `@deepseek-ai/dsh-session-persistence-jsonl`
 * (`src/format.ts`).
 *
 * @param cwd - absolute working directory.
 * @returns one filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The sessions root the JSONL backend is composed with. */
export function sessionsRoot(): string {
  return dshHomePath('sessions')
}

/**
 * Find the artifact directory the backend used for a session.
 *
 * Tries the mirrored derivation first, then falls back to scanning the
 * sessions root for a directory whose name is the encoded id. Both paths
 * verify that the directory exists.
 *
 * @param cwd - the session's recorded working directory.
 * @param sessionId - session id.
 * @param root - sessions root; defaults to `$DSH_HOME/sessions`.
 * @returns the absolute directory, or `undefined` when neither strategy finds it.
 */
export async function locateSessionDir(
  cwd: string | undefined,
  sessionId: string,
  root: string = sessionsRoot(),
): Promise<string | undefined> {
  if (cwd !== undefined && cwd.length > 0) {
    const candidate = join(root, projectKey(cwd), encodeSegment(sessionId))
    if (await isDirectory(candidate)) return candidate
  }
  const encoded = encodeSegment(sessionId)
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, encoded)
    if (await isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * The session directory name a given id occupies, for diagnostics.
 * @param sessionId - session id.
 * @returns the encoded directory name.
 */
export function sessionDirName(sessionId: string): string {
  return basename(encodeSegment(sessionId))
}
