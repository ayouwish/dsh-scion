/**
 * Small filesystem helpers used by Scion.
 * @module @asyouwish/dsh-scion/fs-util
 */

import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Create a directory and every missing parent.
 * @param path - directory to create.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * Whether a path exists.
 * @param path - path to probe.
 * @returns true when `stat` succeeds.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a path exists and is a directory.
 * @param path - path to probe.
 * @returns true when the path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve a path to its canonical absolute spelling.
 * @param path - path to canonicalize.
 * @returns the `realpath` of the path.
 */
export async function canonicalize(path: string): Promise<string> {
  return await realpath(path)
}

/**
 * Canonicalize a path, falling back to the input when it does not resolve.
 *
 * A session may record a working directory that no longer exists; membership
 * checks then compare spellings rather than failing outright.
 *
 * @param path - path to canonicalize.
 * @returns the canonical path, or the input unchanged.
 */
export async function canonicalizeOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Read a UTF-8 text file.
 * @param path - file to read.
 * @returns the file contents.
 */
export async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8')
}

/**
 * Write a file atomically: a sibling temporary file is renamed into place.
 * @param path - destination path.
 * @param content - UTF-8 content.
 */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path))
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Permission bits for a session directory that must never be written. */
export const READONLY_DIR_MODE = 0o555

/** Permission bits for a file that must never be written. */
export const READONLY_FILE_MODE = 0o444

/** Permission bits restoring a directory the plugin itself must rewrite. */
export const WRITABLE_DIR_MODE = 0o755

/** Permission bits restoring a file the plugin itself must rewrite. */
export const WRITABLE_FILE_MODE = 0o644

/**
 * Name of the persistence kernel-lease file inside a session directory.
 *
 * `@deepseek-ai/dsh-session-persistence-jsonl` opens `<dir>/session.lock` for
 * writing whenever any session is attached, live or read-only, so an imported
 * session whose lease file is unwritable can never become live — and DSH's
 * projection layer only checkpoints live sessions, which is what a listing
 * reads titles from. The file is therefore the one entry a read-only import
 * leaves writable (see `applyReadOnly`).
 */
export const SESSION_LOCK_FILENAME = 'session.lock'

/**
 * Apply the read-only mode set of an imported session.
 *
 * Every entry becomes unwritable — the directory included, so a log rewrite by
 * rename fails — with one exception: `session.lock` stays writable (and is
 * created when absent), because that is the file DSH opens for writing to take
 * its kernel lease on any attach. Without a usable lease file the session can
 * never become live, and DSH's projection layer only checkpoints live sessions,
 * which is where session lists read their titles from.
 *
 * The directory is momentarily writable so the lease file can be created; the
 * strict set is applied in the same call and is what callers observe.
 *
 * @param directory - session directory to lock down.
 */
export async function applyReadonlyImportModes(directory: string): Promise<void> {
  const { chmod, open } = await import('node:fs/promises')
  await chmod(directory, WRITABLE_DIR_MODE)
  const lease = join(directory, SESSION_LOCK_FILENAME)
  await chmod(lease, WRITABLE_FILE_MODE).catch(() => undefined)
  const handle = await open(lease, 'w', WRITABLE_FILE_MODE).catch(() => undefined)
  await handle?.close()
  await chmodTree(directory, READONLY_DIR_MODE, READONLY_FILE_MODE, [SESSION_LOCK_FILENAME])
}

/**
 * Recursively apply permission bits to a directory tree.
 *
 * On Windows the mode is effectively ignored, so the caller must treat this as
 * a POSIX-only defense; the plugin's API-level and pre-step gates remain.
 *
 * @param root - directory to chmod.
 * @param dirMode - mode for directories.
 * @param fileMode - mode for files.
 * @param keepWritable - entry names that keep their own mode (the persistence
 * lease file a read-only import must still let DSH open for writing).
 */
export async function chmodTree(
  root: string,
  dirMode: number,
  fileMode: number,
  keepWritable: readonly string[] = [],
): Promise<void> {
  const { chmod, readdir } = await import('node:fs/promises')
  await chmod(root, dirMode)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(root, entry.name)
    if (entry.isDirectory()) await chmodTree(child, dirMode, fileMode, keepWritable)
    else if (!keepWritable.includes(entry.name)) await chmod(child, fileMode)
  }
}

/**
 * Remove a directory tree, restoring write permission first when needed.
 * @param path - directory to remove.
 */
export async function removeTree(path: string): Promise<void> {
  await chmodTree(path, WRITABLE_DIR_MODE, WRITABLE_FILE_MODE).catch(() => undefined)
  await rm(path, { recursive: true, force: true })
}
