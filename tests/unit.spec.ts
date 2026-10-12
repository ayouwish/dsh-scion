/**
 * Pure unit tests: the command grammar, the repo envelope, the manifest, the
 * ownership index, and the directory-name mirrors.
 *
 * These run without a host so a grammar or format regression fails in
 * milliseconds rather than through a booted composition.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseScionCommand } from '../src/commands.ts'
import { decodeScionSession, encodeScionSession, ScionRepoFormatError } from '../src/repo-format.ts'
import { createManifest, readManifest, upsertManifestSession, writeManifest } from '../src/manifest.ts'
import { ScionOwnershipStore } from '../src/ownership.ts'
import { encodeSegment, projectKey } from '../src/locate.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scion-unit-'))
  roots.push(root)
  return root
}

describe('command grammar', () => {
  it('parses the documented subcommands', () => {
    expect(parseScionCommand('')).toEqual({ kind: 'help' })
    expect(parseScionCommand('status')).toEqual({ kind: 'status' })
    expect(parseScionCommand('init')).toEqual({ kind: 'init', name: undefined, remote: undefined })
    expect(parseScionCommand('init my-work')).toEqual({ kind: 'init', name: 'my-work', remote: undefined })
    expect(parseScionCommand('init --remote git@host:you/repo.git')).toEqual({
      kind: 'init', name: undefined, remote: 'git@host:you/repo.git',
    })
    expect(parseScionCommand('init my-work --remote https://host/you/repo.git')).toEqual({
      kind: 'init', name: 'my-work', remote: 'https://host/you/repo.git',
    })
    expect(parseScionCommand('remote')).toEqual({ kind: 'remote', url: undefined })
    expect(parseScionCommand('remote https://host/you/repo.git')).toEqual({
      kind: 'remote', url: 'https://host/you/repo.git',
    })
    expect(parseScionCommand('push')).toEqual({ kind: 'push', sessionIds: undefined, push: false })
    expect(parseScionCommand('push --push')).toEqual({ kind: 'push', sessionIds: undefined, push: true })
    expect(parseScionCommand('pull')).toEqual({ kind: 'pull', sessionIds: undefined, git: true })
    expect(parseScionCommand('pull --no-git')).toEqual({ kind: 'pull', sessionIds: undefined, git: false })
    expect(parseScionCommand('prune')).toEqual({ kind: 'prune', sessionIds: undefined, dryRun: false })
    expect(parseScionCommand('prune --dry-run')).toEqual({ kind: 'prune', sessionIds: undefined, dryRun: true })
    expect(parseScionCommand('forget session-a')).toEqual({ kind: 'forget', sessionId: 'session-a' })
  })

  it('parses a comma-separated session selection', () => {
    expect(parseScionCommand('push --sessions a,b,c')).toEqual({
      kind: 'push', sessionIds: ['a', 'b', 'c'], push: false,
    })
    expect(parseScionCommand('prune --sessions a,b --dry-run')).toEqual({
      kind: 'prune', sessionIds: ['a', 'b'], dryRun: true,
    })
    // The list is one token: spaces around commas are not part of the grammar.
    expect(parseScionCommand('push --sessions a, b')).toMatchObject({ kind: 'error' })
  })

  it('rejects unknown subcommands, options, and arity', () => {
    expect(parseScionCommand('nope')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('push --wat')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('push --sessions')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('prune --push')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('status extra')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('init --remote')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('remote a b')).toMatchObject({ kind: 'error' })
    expect(parseScionCommand('forget')).toMatchObject({ kind: 'error' })
  })
})

describe('repo session envelope', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: { kind: 'completed' } } },
  ]

  it('round-trips header, cut, origin, and events', () => {
    const body = encodeScionSession({
      header: { version: 4, id: 'session-a', createdAt: 1, cwd: '/a/b', isSeeded: false },
      sessionFormatVersion: 4,
      inheritedEventCount: 0,
      originRoot: '/a/b',
      events,
    })
    const decoded = decodeScionSession(body, 'session-a.jsonl')
    expect(decoded.sessionFormatVersion).toBe(4)
    expect(decoded.inheritedEventCount).toBe(0)
    expect(decoded.originRoot).toBe('/a/b')
    expect(decoded.eventCount).toBe(2)
    expect(decoded.header).toMatchObject({ cwd: '/a/b' })
    expect(decoded.events).toEqual(events)
  })

  it('is stable across repeated encodes of the same input', () => {
    const input = {
      header: { version: 4, id: 'session-a', createdAt: 1, cwd: '/a/b', isSeeded: false },
      sessionFormatVersion: 4,
      inheritedEventCount: 0,
      originRoot: '/a/b',
      events,
    }
    expect(encodeScionSession(input)).toBe(encodeScionSession(input))
  })

  it('rejects a torn, renumbered, or mismatched file', () => {
    const good = encodeScionSession({
      header: { version: 4, id: 'session-a', createdAt: 1, isSeeded: false },
      sessionFormatVersion: 4,
      inheritedEventCount: 0,
      originRoot: '/a',
      events,
    })
    expect(() => decodeScionSession('', 'x')).toThrow(ScionRepoFormatError)
    expect(() => decodeScionSession('{"type":"other"}\n', 'x')).toThrow(/envelope type/)
    expect(() => decodeScionSession(good.replace('"eventCount":2', '"eventCount":3'), 'x'))
      .toThrow(/declares 3 event\(s\) but the file carries 2/)
    // Dense-seq invariant: an event renumbered away from its line index is refused.
    const renumbered = good.replace('"seq":1', '"seq":7')
    expect(() => decodeScionSession(renumbered, 'x')).toThrow(/dense from 0/)
  })

  it('rejects a newer repo schema version', () => {
    const good = encodeScionSession({
      header: { version: 4, id: 'a', createdAt: 1, isSeeded: false },
      sessionFormatVersion: 4,
      inheritedEventCount: 0,
      originRoot: '/a',
      events: [],
    })
    expect(() => decodeScionSession(good.replace('"schemaVersion":1', '"schemaVersion":9'), 'x'))
      .toThrow(/unsupported repo schema version/)
  })
})

describe('manifest', () => {
  it('round-trips through disk and rejects unknown keys', async () => {
    const root = await tempRoot()
    const manifest = createManifest({ name: 'demo', root, sessionFormatVersion: 4 })
    await writeManifest(root, manifest)
    expect(await readManifest(root)).toEqual(manifest)
    expect(await readManifest(join(root, 'elsewhere'))).toBeUndefined()

    const withSession = upsertManifestSession(manifest, {
      id: 'session-a', inheritedEventCount: 0, eventCount: 2, originRoot: root, exportedAt: 'now',
    })
    expect(withSession.sessions).toHaveLength(1)
    expect(upsertManifestSession(withSession, {
      id: 'session-a', inheritedEventCount: 0, eventCount: 5, originRoot: root, exportedAt: 'later',
    }).sessions[0]?.eventCount).toBe(5)

    const path = join(root, '.dsh', 'scion.json')
    await writeFile(path, JSON.stringify({ ...manifest, extra: true }))
    await expect(readManifest(root)).rejects.toThrow(/unknown key/)
  })
})

describe('ownership index', () => {
  it('records, reads, and forgets imports', async () => {
    const root = await tempRoot()
    const store = new ScionOwnershipStore(join(root, 'ownership.json'))
    await store.load()
    expect(store.isImported('session-a')).toBe(false)

    await store.record({
      sessionId: 'session-a', scionId: 'scion-1', localRoot: '/local', sourceRoot: '/remote',
      importedAt: 'now', eventCount: 3,
    })
    expect(store.isImported('session-a')).toBe(true)
    expect(store.get('session-a')?.sourceRoot).toBe('/remote')

    // A fresh store reads the same file back.
    const reopened = new ScionOwnershipStore(join(root, 'ownership.json'))
    await reopened.load()
    expect(reopened.all()).toHaveLength(1)

    expect(await reopened.forget('session-a')).toBe(true)
    expect(await reopened.forget('session-a')).toBe(false)
  })
})

describe('directory-name mirrors', () => {
  it('matches the backend naming convention', () => {
    // Pinned against `projectKey`/`encodeSegment` in the JSONL backend.
    expect(projectKey('/home/a/proj')).toBe('--home-a-proj--')
    // A trailing separator is preserved: the transform is intentionally lossy.
    expect(projectKey('/home/a/proj/')).toBe('--home-a-proj---')
    expect(projectKey('/')).toBe('--root--')
    expect(projectKey('/home/a/my proj')).toBe('--home-a-my~0020proj--')
    expect(projectKey(`/x/${'y'.repeat(300)}`)).toHaveLength(251 + 4)
    expect(encodeSegment('session-a')).toBe('session-a')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })
})
