/**
 * Build the browser half.
 *
 * DSH's client-bundle contract is a closure factory: the artifact calls
 * `window.__ModuleLoader__.load({ id, factory: (require) => { … } })` and
 * resolves the platform modules (react, cordis, the client UI packages)
 * through the injected `require`, so every one of them is external here.
 *
 * esbuild comes from the harness checkout, because the harness's own client
 * build preset is repository-internal rather than a published package. Set
 * `DSH_HARNESS_DIR` when the checkout is not a sibling of this package.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const harness = process.env['DSH_HARNESS_DIR'] ?? join(root, '..', '..', 'deepseek-harness')
const esbuild = join(harness, 'node_modules', '.bin', 'esbuild')
if (!existsSync(esbuild)) {
  console.error(`build-client: no esbuild at ${esbuild}`)
  console.error('build-client: set DSH_HARNESS_DIR to the deepseek-harness checkout that provides it')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const id = manifest.name
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
  + ' var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

execFileSync(esbuild, [
  join(root, 'src', 'client', 'index.tsx'),
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  `--outfile=${join(root, 'lib', 'client.js')}`,
  '--external:react',
  '--external:react/jsx-runtime',
  '--external:react-dom',
  '--external:react-dom/client',
  '--external:@deepseek-ai/*',
  `--banner:js=${banner}`,
  `--footer:js=${footer}`,
  '--log-level=warning',
], { stdio: 'inherit' })
