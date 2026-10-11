/**
 * The durable, machine-local ownership index.
 *
 * Scion's read-only rule needs to know which local sessions were imported from
 * a repo rather than created here. That fact is machine-local (it never
 * travels with the repo), so it lives under `$DSH_HOME/scion/ownership.json`
 * and is owned by this plugin.
 *
 * @module @asyouwish/dsh-scion/ownership
 */

import { SCION_OWNERSHIP_SCHEMA_VERSION } from './types.ts'
import type { ScionOwnershipFile, ScionOwnershipRecord } from './types.ts'
import { ownershipPath } from './paths.ts'
import { pathExists, readText, writeTextAtomic } from './fs-util.ts'

/** An ownership index that exists but does not match the documented schema. */
export class ScionOwnershipError extends Error {
  /**
   * @param path - index path.
   * @param detail - what is wrong.
   */
  constructor(readonly path: string, readonly detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'ScionOwnershipError'
  }
}

/**
 * Load, mutate, and persist the ownership index.
 *
 * Writes are serialized through a promise chain so concurrent imports cannot
 * interleave read-modify-write cycles, and each save replaces the file
 * atomically.
 */
export class ScionOwnershipStore {
  private file: ScionOwnershipFile = { schemaVersion: SCION_OWNERSHIP_SCHEMA_VERSION, imported: {} }
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  /**
   * @param path - index path; defaults to the `$DSH_HOME` location.
   */
  constructor(private readonly path: string = ownershipPath()) {}

  /** Path of the backing file. */
  get filePath(): string {
    return this.path
  }

  /**
   * Load the index once; later calls are no-ops.
   * @throws {ScionOwnershipError} when the file exists but is malformed.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    if (!(await pathExists(this.path))) {
      this.loaded = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readText(this.path))
    } catch (error: unknown) {
      throw new ScionOwnershipError(this.path, `not valid JSON: ${String((error as Error).message)}`)
    }
    this.file = validate(parsed, this.path)
    this.loaded = true
  }

  /**
   * One record by session id.
   * @param sessionId - session id.
   * @returns the record, or `undefined` when the session is local.
   */
  get(sessionId: string): ScionOwnershipRecord | undefined {
    return this.file.imported[sessionId]
  }

  /**
   * Whether a session was imported (and is therefore read-only).
   * @param sessionId - session id.
   * @returns true when an ownership record exists.
   */
  isImported(sessionId: string): boolean {
    return this.file.imported[sessionId] !== undefined
  }

  /** Every ownership record. */
  all(): readonly ScionOwnershipRecord[] {
    return Object.values(this.file.imported)
  }

  /**
   * Record an imported session.
   * @param record - the record to persist.
   */
  async record(record: ScionOwnershipRecord): Promise<void> {
    await this.mutate(file => ({ ...file, imported: { ...file.imported, [record.sessionId]: record } }))
  }

  /**
   * Drop one ownership record. The session's files are left alone.
   * @param sessionId - session id.
   * @returns true when a record was removed.
   */
  async forget(sessionId: string): Promise<boolean> {
    if (!this.isImported(sessionId)) return false
    await this.mutate(file => {
      const imported = { ...file.imported }
      delete imported[sessionId]
      return { ...file, imported }
    })
    return true
  }

  /**
   * Apply one update and persist it, serialized against other updates.
   * @param update - pure update over the current file.
   */
  private async mutate(update: (file: ScionOwnershipFile) => ScionOwnershipFile): Promise<void> {
    const run = this.tail.then(async () => {
      await this.load()
      this.file = update(this.file)
      await writeTextAtomic(this.path, `${JSON.stringify(this.file, null, 2)}\n`)
    })
    this.tail = run.then(() => undefined, () => undefined)
    return await run
  }
}

/**
 * Validate a parsed ownership index.
 * @param value - parsed JSON.
 * @param path - index path for errors.
 * @returns the validated file.
 */
function validate(value: unknown, path: string): ScionOwnershipFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScionOwnershipError(path, 'ownership index must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (record['schemaVersion'] !== SCION_OWNERSHIP_SCHEMA_VERSION) {
    throw new ScionOwnershipError(
      path,
      `unsupported schemaVersion ${String(record['schemaVersion'])} (this plugin writes ${String(SCION_OWNERSHIP_SCHEMA_VERSION)})`,
    )
  }
  const raw = record['imported']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScionOwnershipError(path, 'imported must be an object')
  }
  const imported: Record<string, ScionOwnershipRecord> = {}
  for (const [sessionId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ScionOwnershipError(path, `imported["${sessionId}"] must be an object`)
    }
    const fields = entry as Record<string, unknown>
    imported[sessionId] = {
      sessionId,
      scionId: requireString(fields, 'scionId', path),
      localRoot: requireString(fields, 'localRoot', path),
      sourceRoot: requireString(fields, 'sourceRoot', path),
      importedAt: requireString(fields, 'importedAt', path),
      eventCount: requireCount(fields, 'eventCount', path),
    }
  }
  return { schemaVersion: SCION_OWNERSHIP_SCHEMA_VERSION, imported }
}

/**
 * Require a string field.
 * @param record - object to read.
 * @param key - field name.
 * @param path - index path for errors.
 * @returns the field value.
 */
function requireString(record: Readonly<Record<string, unknown>>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScionOwnershipError(path, `${key} must be a non-empty string`)
  }
  return value
}

/**
 * Require a non-negative safe integer field.
 * @param record - object to read.
 * @param key - field name.
 * @param path - index path for errors.
 * @returns the field value.
 */
function requireCount(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ScionOwnershipError(path, `${key} must be a non-negative safe integer`)
  }
  return value
}
