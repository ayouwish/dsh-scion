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
 * Recursively apply permission bits to a directory tree.
 *
 * On Windows the mode is effectively ignored, so the caller must treat this as
 * a POSIX-only defense; the plugin's API-level and pre-step gates remain.
 *
 * @param root - directory to chmod.
 * @param dirMode - mode for directories.
 * @param fileMode - mode for files.
 */
export async function chmodTree(root: string, dirMode: number, fileMode: number): Promise<void> {
  const { chmod, readdir } = await import('node:fs/promises')
  await chmod(root, dirMode)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(root, entry.name)
    if (entry.isDirectory()) await chmodTree(child, dirMode, fileMode)
    else await chmod(child, fileMode)
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
