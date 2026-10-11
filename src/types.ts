/**
 * Shared value types for the Scion plugin: the repo manifest, the durable
 * per-machine ownership index, and the repo session envelope.
 *
 * A **scion** is a git-carried unit of work: a workspace directory plus a
 * selected set of session logs. Sessions exported into the scion are
 * immutable; importing one materializes a read-only local copy that can be
 * read and forked but never written. Only the workspace content is merged.
 *
 * @module @asyouwish/dsh-scion/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Schema version of `.dsh/scion.json` written by this plugin. */
export const SCION_MANIFEST_SCHEMA_VERSION = 1

/** Schema version of one repo session file written by this plugin. */
export const SCION_SESSION_SCHEMA_VERSION = 1

/** Schema version of the durable ownership index. */
export const SCION_OWNERSHIP_SCHEMA_VERSION = 1

/** One session recorded in the repo manifest. */
export interface ScionManifestSession {
  /** Session id; stable across machines, which is what makes fork lineage resolve. */
  readonly id: string
  /** Exact fork-inherited prefix length, or 0 for a non-seeded session. */
  readonly inheritedEventCount: number
  /** Number of events in the exported log. */
  readonly eventCount: number
  /** Absolute root on the machine that exported this revision. */
  readonly originRoot: string
  /** ISO timestamp of the export. */
  readonly exportedAt: string
}

/** `.dsh/scion.json`: the repo-side manifest. */
export interface ScionManifest {
  readonly schemaVersion: number
  /** Random identity of this scion, stable across machines. */
  readonly scionId: string
  /** Human-readable name. */
  readonly name: string
  /** DSH session format version the repo contents were written with. */
  readonly sessionFormatVersion: number
  /** Absolute root of the exporting machine; informational, never authoritative. */
  readonly root: string
  readonly createdAt: string
  readonly sessions: readonly ScionManifestSession[]
}

/** One imported (read-only) session, as recorded on the importing machine. */
export interface ScionOwnershipRecord {
  readonly sessionId: string
  readonly scionId: string
  /** Local absolute root the session was localized to. */
  readonly localRoot: string
  /** Absolute root recorded by the exporting machine. */
  readonly sourceRoot: string
  readonly importedAt: string
  /** Event count of the local copy at import time, for extension detection. */
  readonly eventCount: number
}

/** Durable, machine-local ownership index. */
export interface ScionOwnershipFile {
  readonly schemaVersion: number
  readonly imported: Readonly<Record<string, ScionOwnershipRecord>>
}

/** One decoded repo session file. */
export interface ScionRepoSession {
  /** Raw header JSON as exported; the local cwd is substituted at import. */
  readonly header: Readonly<Record<string, unknown>>
  readonly inheritedEventCount: number
  readonly eventCount: number
  readonly sessionFormatVersion: number
  readonly originRoot: string
  /** Events in seq order, structurally validated at the durable boundary. */
  readonly events: readonly SessionEvent[]
}

/** How one repo session relates to the local store. */
export type ScionImportPlan =
  /** The id is absent locally: create it read-only. */
  | { readonly kind: 'create' }
  /** The id exists as an imported session that the repo extends: append the new events. */
  | { readonly kind: 'append'; readonly localEventCount: number }
  /** The id is already local and identical: nothing to do. */
  | { readonly kind: 'current' }
  /** The id is a local (owned) session: never overwrite local work. */
  | { readonly kind: 'local-owned' }
  /** The repo and local copies diverge: refuse and report. */
  | { readonly kind: 'divergent'; readonly reason: string }
