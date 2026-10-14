/**
 * The panel's data route.
 *
 * `GET /api/scion/tree` answers the Web panel with a {@link ScionTreeSnapshot}.
 * The root comes from the calling session (`?session=<id>`, resolved through
 * persistence) or from an explicit absolute `?root=<path>`. Requests are
 * admitted exactly like every other Host API route: the browser connection
 * decides, and an unknown connection fails closed.
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
 * Build the request handler the route registers.
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
    const connection = ctx.get('connection') as ConnectionAdmission | undefined
    if (connection === undefined) {
      sendJson(res, 403, { error: 'no browser connection authorizes this request' })
      return
    }
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
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
 * Register the tree route once a web server is composed.
 *
 * The route is inert on hosts without the browser HTTP carrier (Electron loads
 * the built files and bridges fetches over IPC instead), and it is an exact
 * route inside `/api`, so it is matched before the connection's `/api` prefix.
 *
 * @param ctx - host context.
 * @param ownership - machine-local ownership index.
 */
export function installTreeRoute(ctx: Context, ownership: ScionOwnershipStore): void {
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
  })
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
