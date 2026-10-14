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

  it('follows the Web theme through DSH design tokens', () => {
    const source = readFileSync(bundlePath, 'utf8')
    // The popover reads the alias tokens with scheme-neutral fallbacks, so the
    // light theme stays readable instead of inheriting a pinned dark palette.
    for (const token of [
      'var(--dsw-alias-bg-layer-1',
      'var(--dsw-alias-label-primary',
      'var(--dsw-alias-label-tertiary',
      'var(--dsw-alias-border-l2',
      'var(--dsw-alias-state-success-primary',
      'var(--dsw-alias-state-error-primary',
      'var(--ds-font-family-code',
      'var(--dsh-content-font-size-secondary',
      'CanvasText',
    ]) {
      expect(source).toContain(token)
    }
    // The dark-pinned palette this panel used to carry must not come back.
    // (Neutral mid-gray fallbacks such as rgba(127,127,127,…) are fine: they
    // read on both schemes, and the tokens win whenever the theme provides them.)
    expect(source).not.toMatch(/#1e1e22|#3f9d63|#5b8dd6|#d97b7b/i)
    expect(source).not.toMatch(/rgba\(64,160,96|rgba\(64,120,200/i)
  })

  it('exposes a client plugin that registers the tree action, the header chip, and the row mark', () => {
    const registered = loadBundle()
    const plugin = registered.factory!(name => name.startsWith('react') ? reactStub : {}) as {
      readonly name?: string
      readonly inject?: readonly string[]
      readonly apply?: (ctx: unknown) => void
    }

    expect(plugin.inject).toContain('slots')
    expect(typeof plugin.apply).toBe('function')

    const registrations: { definition?: Record<string, unknown>; component?: unknown }[] = []
    const injectedNames: string[] = []
    const slots = {
      inject: (name: string, callback: () => unknown): void => { injectedNames.push(name); callback() },
      register: (definition: Record<string, unknown>, component: unknown): (() => void) => {
        registrations.push({ definition, component })
        return () => undefined
      },
    }
    plugin.apply!({ slots })

    expect(injectedNames).toEqual([
      'conversation.session.header.actions',
      'conversation.session.header.utilities',
      'sidebar.session.row.leading',
    ])
    expect(registrations).toHaveLength(3)
    expect(registrations[0]!.definition).toMatchObject({
      name: 'conversation.session.header.actions',
      id: 'scion-tree',
      order: 30,
    })
    expect(registrations[1]!.definition).toMatchObject({
      name: 'conversation.session.header.utilities',
      id: 'scion-readonly',
      order: 30,
    })
    expect(registrations[2]!.definition).toMatchObject({
      name: 'sidebar.session.row.leading',
      id: 'scion-readonly-mark',
      order: 20,
    })
    for (const registration of registrations) expect(typeof registration.component).toBe('function')
  })
})
