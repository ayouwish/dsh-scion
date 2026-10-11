/**
 * Repo layout and durable-store paths for Scion.
 *
 * The repo layout is owned by this plugin, not by the DSH persistence backend:
 * importing goes through the public persistence API, so the transport format
 * is free to be a plain, diffable JSONL envelope.
 *
 * @module @asyouwish/dsh-scion/paths
 */

import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Directory inside the scion root that holds all Scion metadata. */
export const SCION_DIR = '.dsh'

/** Manifest filename inside {@link SCION_DIR}. */
export const SCION_MANIFEST_FILENAME = 'scion.json'

/** Sessions subdirectory inside {@link SCION_DIR}. */
export const SCION_SESSIONS_DIR = 'sessions'

/** Durable ownership index filename under `$DSH_HOME/scion`. */
export const SCION_OWNERSHIP_FILENAME = 'ownership.json'

/** Directory inside the scion root holding Scion metadata. */
export function scionDir(root: string): string {
  return join(root, SCION_DIR)
}

/** Absolute path of the repo manifest. */
export function manifestPath(root: string): string {
  return join(scionDir(root), SCION_MANIFEST_FILENAME)
}

/** Directory holding exported session files. */
export function repoSessionsDir(root: string): string {
  return join(scionDir(root), SCION_SESSIONS_DIR)
}

/**
 * Absolute path of one exported session file.
 * @param root - scion root.
 * @param sessionId - exported session id.
 * @returns the repo-side file path.
 */
export function repoSessionPath(root: string, sessionId: string): string {
  return join(repoSessionsDir(root), `${sessionId}.jsonl`)
}

/** Directory under `$DSH_HOME` holding machine-local Scion state. */
export function scionHomeDir(): string {
  return dshHomePath('scion')
}

/** Absolute path of the durable ownership index. */
export function ownershipPath(): string {
  return join(scionHomeDir(), SCION_OWNERSHIP_FILENAME)
}
