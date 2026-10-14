/**
 * The panel's data routes.
 *
 * - `GET /api/scion/tree` answers the Web panel with a {@link ScionTreeSnapshot}.
 *   The root comes from the calling session (`?session=<id>`, resolved through
 *   persistence) or from an explicit absolute `?root=<path>`.
 * - `GET /api/scion/session` answers the read-only badge with this machine's
 *   ownership record for one session (`?session=<id>`), so a synced import is
 *   visibly read-only in the conversation header instead of looking ordinary.
 *
 * Requests are admitted exactly like every other Host API route: the browser
 * connection decides, and an unknown connection fails closed.
 *
 * @module @asyouwish/dsh-scion/route
 */

import { isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScionOwnershipStore } from './ownership.ts'
import { buildScionTree } from './tree.ts'
import { canonicalizeOrSelf } from './fs-util.ts'

/** Exact path the panel fetches. */
export const SCION_TREE_PATH = '/api/scion/tree'

/** Exact path the read-only badge fetches. */
export const SCION_SESSION_PATH = '/api/scion/session'

/** Exact path the sidebar read-only mark fetches (the whole small map, once). */
export const SCION_IMPORTS_PATH = '/api/scion/imports'

/** One machine-local import as the sidebar mark renders it. */
export interface ScionImportEntry {
  readonly sourceRoot: string
  readonly importedAt: string
  readonly eventCount: number
}

/** Body of `GET /api/scion/imports`. */
export interface ScionImportsPayload {
  readonly generatedAt: string
  readonly imports: Readonly<Record<string, ScionImportEntry>>
}

/** One session's machine-local scion state, as the badge renders it. */
export interface ScionSessionState {
  readonly sessionId: string
  /** This machine holds the session as a read-only import. */
  readonly readOnly: boolean
  /** The machine that exported it, when it is an import. */
  readonly sourceRoot?: string
  /** The local root the import was localized to. */
  readonly scionRoot?: string
  readonly importedAt?: string
  readonly eventCount?: number
}

/** The browser HTTP carrier's registration face (structural: the carrier is optional). */
interface WebServerLike {
  /**
   * Register one named route.
   * @param route - kind, path, and handler.
   * @returns the disposer removing the route.
   */
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The admission face the browser connection exposes to Host routes. */
interface ConnectionAdmission {
  /**
   * Rejection status for the request, or undefined when it may proceed.
   * @param req - incoming request.
   * @returns an HTTP status to reject with, or undefined.
   */
  requestRejection(req: IncomingMessage): number | undefined
}

/**
 * Build the request handler the tree route registers.
 *
 * Exported for tests: it depends only on the host context, the ownership index,
 * and the Node request/response pair.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 * @returns the route handler.
 */
export function createTreeHandler(
  ctx: Context,
  ownership: ScionOwnershipStore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admitted(ctx, req, res)) return
    try {
      const url = new URL(req.url ?? SCION_TREE_PATH, 'http://localhost')
      const root = await resolveRoot(ctx, url)
      if (root === undefined) {
        sendJson(res, 400, { error: 'pass ?session=<id> or an absolute ?root=<path>' })
        return
      }
      sendJson(res, 200, await buildScionTree(ctx, root, ownership))
    } catch (error: unknown) {
      sendJson(res, 404, { error: String((error as Error).message) })
    }
  }
}

/**
 * Build the read-only badge's handler.
 *
 * Exported for tests, like {@link createTreeHandler}. A session this machine
 * owns locally answers `readOnly: false`; an unknown id answers the same, so
 * the badge simply renders nothing.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 * @returns the route handler.
 */
export function createSessionStateHandler(
  ctx: Context,
  ownership: ScionOwnershipStore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admitted(ctx, req, res)) return
    const sessionId = new URL(req.url ?? SCION_SESSION_PATH, 'http://localhost').searchParams.get('session')
    if (sessionId === null || sessionId.length === 0) {
      sendJson(res, 400, { error: 'pass ?session=<id>' })
      return
    }
    const record = ownership.get(sessionId)
    const state: ScionSessionState = {
      sessionId,
      readOnly: record !== undefined,
      ...(record === undefined ? {} : {
        sourceRoot: record.sourceRoot,
        scionRoot: record.localRoot,
        importedAt: record.importedAt,
        eventCount: record.eventCount,
      }),
    }
    sendJson(res, 200, state)
  }
}

/**
 * Build the sidebar mark's handler: every import this machine holds.
 *
 * The sidebar renders one row per session, so the mark reads this map once per
 * page instead of asking per row. Exported for tests.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 * @returns the route handler.
 */
export function createImportsHandler(
  ctx: Context,
  ownership: ScionOwnershipStore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!admitted(ctx, req, res)) return
    const imports: Record<string, ScionImportEntry> = {}
    for (const record of ownership.all()) {
      imports[record.sessionId] = {
        sourceRoot: record.sourceRoot,
        importedAt: record.importedAt,
        eventCount: record.eventCount,
      }
    }
    const payload: ScionImportsPayload = { generatedAt: new Date().toISOString(), imports }
    sendJson(res, 200, payload)
  }
}

/**
 * Register the scion Host routes once a web server is composed.
 *
 * The routes are inert on hosts without the browser HTTP carrier (Electron loads
 * the built files and bridges fetches over IPC instead), and they are exact
 * routes inside `/api`, so they are matched before the connection's `/api`
 * prefix.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 */
export function installScionRoutes(ctx: Context, ownership: ScionOwnershipStore): void {
  ctx.inject(['webServer'], webCtx => {
    const webServer = webCtx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    webCtx.effect(
      () => webServer.register({
        kind: 'exact',
        path: SCION_TREE_PATH,
        handler: createTreeHandler(ctx, ownership),
      }),
      `scion: GET ${SCION_TREE_PATH}`,
    )
    webCtx.effect(
      () => webServer.register({
        kind: 'exact',
        path: SCION_SESSION_PATH,
        handler: createSessionStateHandler(ctx, ownership),
      }),
      `scion: GET ${SCION_SESSION_PATH}`,
    )
    webCtx.effect(
      () => webServer.register({
        kind: 'exact',
        path: SCION_IMPORTS_PATH,
        handler: createImportsHandler(ctx, ownership),
      }),
      `scion: GET ${SCION_IMPORTS_PATH}`,
    )
  })
}

/**
 * Register the tree route alone. Kept for callers of the 0.5.0 name; new code
 * should use {@link installScionRoutes}, which also serves the read-only badge.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 */
export function installTreeRoute(ctx: Context, ownership: ScionOwnershipStore): void {
  installScionRoutes(ctx, ownership)
}

/**
 * Admit one Host request: browser-connection authorization, then method.
 * @param ctx - host context.
 * @param req - incoming request.
 * @param res - response, written and ended when the request is rejected.
 * @returns true when the handler may proceed.
 */
function admitted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const connection = ctx.get('connection') as ConnectionAdmission | undefined
  if (connection === undefined) {
    sendJson(res, 403, { error: 'no browser connection authorizes this request' })
    return false
  }
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return false
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return false
  }
  return true
}

/**
 * Resolve which scion root the request asks about.
 * @param ctx - host context.
 * @param url - parsed request URL.
 * @returns the canonical root, or undefined when the request names none.
 */
async function resolveRoot(ctx: Context, url: URL): Promise<string | undefined> {
  const sessionId = url.searchParams.get('session')
  if (sessionId !== null && sessionId.length > 0) {
    const snapshot = await ctx.sessionPersistence.stat(SessionId(sessionId))
    const cwd = snapshot?.header.cwd
    return cwd === undefined ? undefined : await canonicalizeOrSelf(cwd)
  }
  const requested = url.searchParams.get('root')
  if (requested !== null && requested.length > 0 && isAbsolute(requested)) {
    return await canonicalizeOrSelf(requested)
  }
  return undefined
}

/**
 * Answer with JSON, never cached: the tree reflects live repository state.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}
