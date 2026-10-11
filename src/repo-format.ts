/**
 * The repo session envelope: encode a session log for transport, decode it
 * back.
 *
 * This format belongs to Scion, not to the DSH persistence backend. Import
 * goes through the public persistence API (`create` + `append` + `flush`), so
 * the backend still owns physical encoding, compression, framing, and
 * validation; the repo file only has to be a faithful, diffable carrier.
 *
 * Layout — one JSON object per line:
 *
 * ```
 * {"type":"scion/session","schemaVersion":1,...}   first line: the envelope
 * {"type":"user/message","seq":0,...}              then one raw event per line
 * ```
 *
 * **L0 invariant:** event payloads are carried verbatim. Nothing in the log is
 * rewritten — not paths, not text. The only value the importer substitutes is
 * the header's `cwd`, which DSH itself requires to be the local absolute
 * workspace path.
 *
 * @module @asyouwish/dsh-scion/repo-format
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SCION_SESSION_SCHEMA_VERSION } from './types.ts'
import type { ScionRepoSession } from './types.ts'

/** First-line discriminant of a repo session file. */
export const SCION_SESSION_ENVELOPE_TYPE = 'scion/session'

/** A repo file that does not decode into the documented envelope. */
export class ScionRepoFormatError extends Error {
  /**
   * @param source - human-readable file identity.
   * @param detail - what is wrong.
   */
  constructor(readonly source: string, readonly detail: string) {
    super(`${source}: ${detail}`)
    this.name = 'ScionRepoFormatError'
  }
}

/** Inputs for {@link encodeScionSession}. */
export interface EncodeScionSessionInput {
  /** Header JSON exactly as observed locally. */
  readonly header: unknown
  /** Session format version of the running writer. */
  readonly sessionFormatVersion: number
  readonly inheritedEventCount: number
  readonly originRoot: string
  /** Raw event JSON in seq order. */
  readonly events: readonly unknown[]
}

/**
 * Serialize one session into the repo envelope.
 * @param input - header, format version, cut, origin root, and events.
 * @returns the file body, newline-terminated.
 */
export function encodeScionSession(input: EncodeScionSessionInput): string {
  const envelope = {
    type: SCION_SESSION_ENVELOPE_TYPE,
    schemaVersion: SCION_SESSION_SCHEMA_VERSION,
    sessionFormatVersion: input.sessionFormatVersion,
    inheritedEventCount: input.inheritedEventCount,
    eventCount: input.events.length,
    originRoot: input.originRoot,
    header: input.header,
  }
  const lines = [JSON.stringify(envelope)]
  for (const event of input.events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Parse one repo session file.
 * @param text - file body.
 * @param source - file identity used in error messages.
 * @returns the decoded session.
 * @throws {ScionRepoFormatError} when the envelope or an event is malformed.
 */
export function decodeScionSession(text: string, source: string): ScionRepoSession {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const [first, ...rest] = lines
  if (first === undefined) throw new ScionRepoFormatError(source, 'file is empty')

  const envelope = parseLine(first, source, 'envelope line')
  if (envelope['type'] !== SCION_SESSION_ENVELOPE_TYPE) {
    throw new ScionRepoFormatError(source, `envelope type must be ${SCION_SESSION_ENVELOPE_TYPE}`)
  }
  if (envelope['schemaVersion'] !== SCION_SESSION_SCHEMA_VERSION) {
    throw new ScionRepoFormatError(
      source,
      `unsupported repo schema version ${String(envelope['schemaVersion'])} (this plugin writes ${String(SCION_SESSION_SCHEMA_VERSION)})`,
    )
  }
  const header = asObject(envelope['header'], source, 'envelope header')
  const inheritedEventCount = parseCount(envelope['inheritedEventCount'], source, 'inheritedEventCount')
  const eventCount = parseCount(envelope['eventCount'], source, 'eventCount')
  const sessionFormatVersion = parseCount(envelope['sessionFormatVersion'], source, 'sessionFormatVersion')
  const originRoot = envelope['originRoot']
  if (typeof originRoot !== 'string') throw new ScionRepoFormatError(source, 'originRoot must be a string')

  if (rest.length !== eventCount) {
    throw new ScionRepoFormatError(
      source,
      `envelope declares ${String(eventCount)} event(s) but the file carries ${String(rest.length)}`,
    )
  }
  const events: Readonly<Record<string, unknown>>[] = []
  for (const [index, line] of rest.entries()) {
    const event = parseLine(line, source, `event line ${String(index + 1)}`)
    if (typeof event['type'] !== 'string') {
      throw new ScionRepoFormatError(source, `event line ${String(index + 1)} lacks a string "type"`)
    }
    if (event['seq'] !== index) {
      throw new ScionRepoFormatError(
        source,
        `event line ${String(index + 1)} has seq ${String(event['seq'])}; logs must be dense from 0`,
      )
    }
    if (!Number.isSafeInteger(event['time'])) {
      throw new ScionRepoFormatError(source, `event line ${String(index + 1)} lacks an integer "time"`)
    }
    asObject(event['data'], source, `event line ${String(index + 1)} data`)
    events.push(event)
  }
  // Durable-boundary cast: every event line was just checked for the envelope's
  // structural fields (type, dense seq, integer time, object data). The
  // persistence backend re-validates each event against the current format
  // before it is stored, so this cast cannot smuggle an unvalidated value in.
  return {
    header,
    inheritedEventCount,
    eventCount,
    sessionFormatVersion,
    originRoot,
    events: events as unknown as readonly SessionEvent[],
  }
}

/**
 * Parse one line into a JSON object.
 * @param line - raw line.
 * @param source - file identity for errors.
 * @param what - line description for errors.
 * @returns the parsed object.
 */
function parseLine(line: string, source: string, what: string): Readonly<Record<string, unknown>> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error: unknown) {
    throw new ScionRepoFormatError(source, `${what} is not valid JSON: ${String((error as Error).message)}`)
  }
  return asObject(value, source, what)
}

/**
 * Require an already-parsed value to be a JSON object.
 * @param value - parsed value.
 * @param source - file identity for errors.
 * @param what - value description for errors.
 * @returns the value as a plain object.
 */
function asObject(value: unknown, source: string, what: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScionRepoFormatError(source, `${what} must be a JSON object`)
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * Validate one non-negative safe integer field.
 * @param value - raw value.
 * @param source - file identity for errors.
 * @param field - field name for errors.
 * @returns the validated count.
 */
function parseCount(value: unknown, source: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ScionRepoFormatError(source, `${field} must be a non-negative safe integer`)
  }
  return value
}
