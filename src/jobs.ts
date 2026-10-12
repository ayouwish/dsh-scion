/**
 * Background-job adapter for long scion operations.
 *
 * `/scion push`, `/scion pull`, and `/scion prune` can take minutes (a measured
 * 147-session workspace is ≈ 394 MB, plus git). DSH's command contract returns
 * only text and the client awaits the handler, so a synchronous handler blocks
 * the conversation. When the deployment composes a job registry served by a
 * controller, scion runs the operation as a background job instead: the command
 * returns immediately with the job id, progress and detail stream into the
 * job's output ring, the owner can kill it, and `dsh-tool-jobs` announces
 * settlement in-session.
 *
 * Without a registry — or when no controller serves this agent — the caller runs
 * the same work synchronously, so jobs stay an optional capability.
 *
 * @module @asyouwish/dsh-scion/jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobChannel, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    scion: 'scion'
  }
}

/** Producer kind scion registers its jobs under. */
export const SCION_JOB_KIND = 'scion'

/** Per-notice byte cap, so a completion notice or model read stays bounded. */
const OUTPUT_LIMIT_BYTES = 32 * 1024

/** Producer face handed to a scion job's work function. */
export interface ScionJob {
  /** Append one chunk to the job's output ring. */
  readonly append: (text: string, channel?: JobChannel) => void
  /** Replace the job's live progress line. */
  readonly progress: (line: string) => void
  /** Aborted when the owner kills the job or the owning session goes away. */
  readonly signal: AbortSignal
}

/**
 * Start one scion operation as a background job.
 *
 * @param ctx - host context.
 * @param agent - owning agent; the job is fenced to its session.
 * @param label - one-line label shown in job listings.
 * @param work - the operation; its resolved summary becomes the job result.
 * @returns the job id, or `undefined` when background execution is unavailable.
 */
export function startScionJob(
  ctx: Context,
  agent: Agent,
  label: string,
  work: (job: ScionJob) => Promise<string>,
): string | undefined {
  const registry = ctx.get('jobs') as JobRegistry | undefined
  if (registry === undefined) return undefined
  try {
    return String(registry.start({
      kind: SCION_JOB_KIND,
      label,
      owner: agent.id,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: (job) => {
        const controller = new AbortController()
        let settle: (outcome: JobOutcome) => void = () => undefined
        const done = new Promise<JobOutcome>(resolve => { settle = resolve })
        void (async () => {
          try {
            const result = await work({
              append: (text, channel) => { job.append(text, channel === undefined ? {} : { channel }) },
              progress: line => { job.updateProgress(line) },
              signal: controller.signal,
            })
            // Work that observes the abort and returns normally is still a kill.
            settle(controller.signal.aborted ? { status: 'killed' } : { status: 'completed', result })
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            if (controller.signal.aborted) {
              settle({ status: 'killed' })
              return
            }
            // The ring is the human-visible record; `detail` is the status line.
            job.append(`scion failed: ${message}\n`, { channel: 'stderr' })
            settle({ status: 'failed', detail: message })
          }
        })()
        return { done, cancel: () => { controller.abort() } }
      },
    }))
  } catch {
    // No controller serves this agent, or the registry refused the spec: the
    // caller falls back to the synchronous path.
    return undefined
  }
}
