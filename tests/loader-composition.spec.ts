/**
 * Composition test: the plugin mounts through the real cordis Loader, exposes
 * `/scion`, and refuses a misconfigured entry loudly.
 *
 * This is the test that proves the plugin is a real plugin — configured from
 * `cordis.yml`, activated by service injection, and inert when disabled —
 * rather than a library that happens to export functions.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ScionPlugin from '../src/index.ts'
import { resolveConfig } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given scion config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-scion-loader-'))
  const sessions = join(root, 'sessions')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: '${sessions}'`,
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@asyouwish/dsh-scion'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@asyouwish/dsh-scion', ScionPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // `ctx.inject(['commands'])` mounts asynchronously once commands resolves.
  await new Promise(resolve => setImmediate(resolve))
  return ctx
}

/**
 * Command names visible to a synthetic agent.
 * @param ctx - booted context.
 * @returns the registered command names.
 */
function commandNames(ctx: Context): readonly string[] {
  const agent = {
    id: SessionId('loader-agent'),
    session: { header: { id: SessionId('loader-agent') } },
    options: {},
  }
  return ctx.commands.list(agent as never).map(descriptor => descriptor.name)
}

describe('dsh-scion real Loader composition', () => {
  it('registers /scion once persistence and commands are composed', async () => {
    expect(commandNames(await boot([]))).toContain('scion')
  })

  it('never activates with an unknown config key', async () => {
    // The Loader records an `apply` failure on the plugin's fiber instead of
    // rejecting `loader.await()`, so the observable contract is that a
    // misconfigured entry never activates. `resolveConfig` owns the precise
    // message, asserted in the unit suite.
    const ctx = await boot(['    nope: true'])
    expect(commandNames(ctx)).not.toContain('scion')
  })

  it('stays inert when disabled', async () => {
    expect(commandNames(await boot(['    enabled: false']))).not.toContain('scion')
  })

  it('validates configuration without a Loader', () => {
    expect(resolveConfig(undefined)).toEqual({ enabled: true, readonlyGate: true })
    expect(resolveConfig({ enabled: false })).toEqual({ enabled: false, readonlyGate: true })
    expect(() => resolveConfig({ enabled: 'yes' } as never)).toThrow(/must be a boolean/)
  })
})
