/**
 * Browser-half smoke test: the built `lib/client.js` must satisfy DSH's client
 * bundle contract (a closure factory registered on `window.__ModuleLoader__`),
 * resolve its platform modules through the injected `require`, and expose a
 * client plugin that registers the scion tree action.
 *
 * The artifact is loaded in a VM rather than imported, because the contract is
 * a side-effectful `window` call, not a module export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(packageRoot, 'lib', 'client.js')
const built = existsSync(bundlePath)

/** The spec the artifact hands to `window.__ModuleLoader__.load`. */
interface RegisteredBundle {
  readonly id?: string
  readonly factory?: (require: (name: string) => unknown) => unknown
}

/** A React stand-in: the component only calls these inside render effects. */
const reactStub = {
  createElement: (): object => ({}),
  useState: (): [unknown, () => void] => [undefined, () => undefined],
  useEffect: (): void => undefined,
  useCallback: (callback: unknown): unknown => callback,
  useMemo: (factory: () => unknown): unknown => factory(),
  useRef: (): { current: unknown } => ({ current: undefined }),
  Fragment: {},
}

/** Load the built artifact and return the registration it performs. */
function loadBundle(): RegisteredBundle {
  let registered: RegisteredBundle | undefined
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec: RegisteredBundle) => { registered = spec } } },
    console,
  }
  vm.runInNewContext(readFileSync(bundlePath, 'utf8'), sandbox)
  if (registered === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load')
  return registered
}

describe.skipIf(!built)('browser bundle', () => {
  it('registers a closure factory for this package', () => {
    const source = readFileSync(bundlePath, 'utf8')
    expect(source.startsWith('window.__ModuleLoader__.load({ id: "@asyouwish/dsh-scion"')).toBe(true)
    // A factory resolves its dependencies through the injected require, so the
    // artifact must carry no top-level ESM import.
    expect(/^\s*import\s/m.test(source)).toBe(false)
    expect(source).toContain('require("react")')

    const registered = loadBundle()
    expect(registered.id).toBe('@asyouwish/dsh-scion')
    expect(typeof registered.factory).toBe('function')
  })

  it('exposes a client plugin that registers the session-header action', () => {
    const registered = loadBundle()
    const plugin = registered.factory!(name => name.startsWith('react') ? reactStub : {}) as {
      readonly name?: string
      readonly inject?: readonly string[]
      readonly apply?: (ctx: unknown) => void
    }

    expect(plugin.inject).toContain('slots')
    expect(typeof plugin.apply).toBe('function')

    const registrations: { definition?: Record<string, unknown>; component?: unknown }[] = []
    let injectedName: string | undefined
    const slots = {
      inject: (name: string, callback: () => unknown): void => { injectedName = name; callback() },
      register: (definition: Record<string, unknown>, component: unknown): (() => void) => {
        registrations.push({ definition, component })
        return () => undefined
      },
    }
    plugin.apply!({ slots })

    expect(injectedName).toBe('conversation.session.header.actions')
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.definition).toMatchObject({
      name: 'conversation.session.header.actions',
      id: 'scion-tree',
      order: 30,
    })
    expect(typeof registrations[0]!.component).toBe('function')
  })
})
