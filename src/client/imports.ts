/**
 * The machine's imported sessions, cached once per page.
 *
 * The sidebar renders one row per session, so the read-only mark must not cost
 * one request per row: `GET /api/scion/imports` returns the whole (small) map
 * once, and every row reads it through {@link useImports}.
 *
 * @module @asyouwish/dsh-scion/client/imports
 */
import { useEffect, useState } from 'react'

/** One machine-local import, as the host reports it. */
export interface ImportRecord {
  readonly sourceRoot: string
  readonly importedAt: string
  readonly eventCount: number
}

/** Parsed body of `GET /api/scion/imports`. */
interface ImportsPayload {
  readonly imports?: Record<string, ImportRecord>
}

const EMPTY: ReadonlyMap<string, ImportRecord> = new Map()

let pending: Promise<ReadonlyMap<string, ImportRecord>> | undefined

/**
 * Load the import map, once per page.
 * @returns imported sessions keyed by session id (empty when the host has none
 * or the probe fails — the marks are decoration, never a blocking read).
 */
export function loadImports(): Promise<ReadonlyMap<string, ImportRecord>> {
  pending ??= fetch('/api/scion/imports', { headers: { accept: 'application/json' } })
    .then(async (response) => response.ok ? await response.json() as ImportsPayload : undefined)
    .then(payload => new Map(Object.entries(payload?.imports ?? {})))
    .catch(() => EMPTY)
  return pending
}

/**
 * Selector hook over the cached import map.
 * @returns the map, or undefined until the first read resolves.
 */
export function useImports(): ReadonlyMap<string, ImportRecord> | undefined {
  const [imports, setImports] = useState<ReadonlyMap<string, ImportRecord> | undefined>(undefined)
  useEffect(() => {
    let mounted = true
    void loadImports().then((map) => { if (mounted) setImports(map) })
    return () => { mounted = false }
  }, [])
  return imports
}
