/**
 * The repo manifest (`.dsh/scion.json`) and repo-side session listing.
 * @module @asyouwish/dsh-scion/manifest
 */

import { readdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SCION_MANIFEST_SCHEMA_VERSION } from './types.ts'
import type { ScionManifest, ScionManifestSession, ScionRepoSession } from './types.ts'
import { manifestPath, repoSessionsDir, repoSessionPath } from './paths.ts'
import { decodeScionSession } from './repo-format.ts'
import { pathExists, readText, writeTextAtomic } from './fs-util.ts'

/** A repo manifest that does not match the documented schema. */
export class ScionManifestError extends Error {
  /**
   * @param path - manifest path.
   * @param detail - what is wrong.
   */
  constructor(readonly path: string, readonly detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'ScionManifestError'
  }
}

const MANIFEST_KEYS = new Set([
  'schemaVersion', 'scionId', 'name', 'sessionFormatVersion', 'root', 'createdAt', 'sessions',
])
const SESSION_KEYS = new Set(['id', 'inheritedEventCount', 'eventCount', 'originRoot', 'exportedAt'])

/**
 * Build a fresh manifest for a scion root.
 * @param options - name, root, and session format version.
 * @returns a manifest with no exported sessions.
 */
export function createManifest(options: {
  readonly name: string
  readonly root: string
  readonly sessionFormatVersion: number
}): ScionManifest {
  return {
    schemaVersion: SCION_MANIFEST_SCHEMA_VERSION,
    scionId: randomUUID(),
    name: options.name,
    sessionFormatVersion: options.sessionFormatVersion,
    root: options.root,
    createdAt: new Date().toISOString(),
    sessions: [],
  }
}

/**
 * Read and validate the repo manifest.
 * @param root - scion root.
 * @returns the manifest, or `undefined` when the file is absent.
 * @throws {ScionManifestError} when the file exists but is malformed.
 */
export async function readManifest(root: string): Promise<ScionManifest | undefined> {
  const path = manifestPath(root)
  if (!(await pathExists(path))) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(await readText(path))
  } catch (error: unknown) {
    throw new ScionManifestError(path, `not valid JSON: ${String((error as Error).message)}`)
  }
  return validateManifest(parsed, path)
}

/**
 * Write the repo manifest atomically.
 * @param root - scion root.
 * @param manifest - manifest to persist.
 */
export async function writeManifest(root: string, manifest: ScionManifest): Promise<void> {
  await writeTextAtomic(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Replace or insert one exported-session record.
 * @param manifest - current manifest.
 * @param entry - session record to upsert.
 * @returns a new manifest.
 */
export function upsertManifestSession(
  manifest: ScionManifest,
  entry: ScionManifestSession,
): ScionManifest {
  const sessions = manifest.sessions.filter(session => session.id !== entry.id)
  sessions.push(entry)
  sessions.sort((left, right) => left.id.localeCompare(right.id))
  return { ...manifest, sessions }
}

/**
 * Drop one exported-session record.
 * @param manifest - current manifest.
 * @param sessionId - id to remove.
 * @returns a new manifest.
 */
export function removeManifestSession(manifest: ScionManifest, sessionId: string): ScionManifest {
  return { ...manifest, sessions: manifest.sessions.filter(session => session.id !== sessionId) }
}

/**
 * List the session ids the repo carries files for.
 * @param root - scion root.
 * @returns session ids derived from filenames, sorted.
 */
export async function listRepoSessionIds(root: string): Promise<string[]> {
  const dir = repoSessionsDir(root)
  if (!(await pathExists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => basename(entry.name, '.jsonl'))
    .sort()
}

/**
 * Read and decode one exported session.
 * @param root - scion root.
 * @param sessionId - session id.
 * @returns the decoded session.
 */
export async function readRepoSession(root: string, sessionId: string): Promise<ScionRepoSession> {
  const path = repoSessionPath(root, sessionId)
  return decodeScionSession(await readText(path), path)
}

/**
 * Validate a parsed manifest value.
 * @param value - parsed JSON.
 * @param path - manifest path for errors.
 * @returns the validated manifest.
 */
function validateManifest(value: unknown, path: string): ScionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScionManifestError(path, 'manifest must be a JSON object')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, MANIFEST_KEYS, path, 'manifest')
  if (record['schemaVersion'] !== SCION_MANIFEST_SCHEMA_VERSION) {
    throw new ScionManifestError(
      path,
      `unsupported schemaVersion ${String(record['schemaVersion'])} (this plugin writes ${String(SCION_MANIFEST_SCHEMA_VERSION)})`,
    )
  }
  const scionId = requireString(record, 'scionId', path)
  const name = requireString(record, 'name', path)
  const root = requireString(record, 'root', path)
  const createdAt = requireString(record, 'createdAt', path)
  const sessionFormatVersion = requireCount(record, 'sessionFormatVersion', path)
  const rawSessions = record['sessions']
  if (!Array.isArray(rawSessions)) throw new ScionManifestError(path, 'sessions must be an array')
  const sessions = rawSessions.map((entry, index) => validateManifestSession(entry, path, index))
  return { schemaVersion: SCION_MANIFEST_SCHEMA_VERSION, scionId, name, sessionFormatVersion, root, createdAt, sessions }
}

/**
 * Validate one manifest session entry.
 * @param value - raw entry.
 * @param path - manifest path for errors.
 * @param index - entry position for errors.
 * @returns the validated entry.
 */
function validateManifestSession(value: unknown, path: string, index: number): ScionManifestSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScionManifestError(path, `sessions[${String(index)}] must be an object`)
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, SESSION_KEYS, path, `sessions[${String(index)}]`)
  return {
    id: requireString(record, 'id', path),
    inheritedEventCount: requireCount(record, 'inheritedEventCount', path),
    eventCount: requireCount(record, 'eventCount', path),
    originRoot: requireString(record, 'originRoot', path),
    exportedAt: requireString(record, 'exportedAt', path),
  }
}

/**
 * Reject unexpected keys so a hand-edited manifest fails loudly.
 * @param record - object to inspect.
 * @param allowed - permitted key names.
 * @param path - manifest path for errors.
 * @param what - object description for errors.
 */
function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  what: string,
): void {
  const unknown = Object.keys(record).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ScionManifestError(path, `${what} has unknown key(s) ${unknown.join(', ')}`)
  }
}

/**
 * Require a string field.
 * @param record - object to read.
 * @param key - field name.
 * @param path - manifest path for errors.
 * @returns the field value.
 */
function requireString(record: Readonly<Record<string, unknown>>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScionManifestError(path, `${key} must be a non-empty string`)
  }
  return value
}

/**
 * Require a non-negative safe integer field.
 * @param record - object to read.
 * @param key - field name.
 * @param path - manifest path for errors.
 * @returns the field value.
 */
function requireCount(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ScionManifestError(path, `${key} must be a non-negative safe integer`)
  }
  return value
}
