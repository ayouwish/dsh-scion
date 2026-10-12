# @asyouwish/dsh-scion

**Scion** (from the horticultural *scion*: a shoot cut from a parent plant and
grafted onto new rootstock) is a git-carried unit of work: a workspace plus a
selected set of session logs.

Export your local sessions into a git repository, import them on another
machine as **read-only** copies, and continue by **forking** them into new
sessions this machine owns. **Only the workspace is merged; sessions are forked,
never merged.**

English | [中文](README.zh.md)

## Why sessions cannot be merged

A session log is an append-only, self-describing record: sequence numbers are
dense from zero, and a fork cut is carried by an in-log `session/end-seed`
marker. Two machines appending to one id would collide on those sequence
numbers and produce a log the persistence backend refuses to load. Therefore:

- an imported session is **read-only by construction**;
- continuing foreign work means **forking** it into a new id this machine owns;
- `parentSession` lineage still resolves across machines, because ids are
  globally stable.

## Three read-only layers

| Layer | Mechanism | Scope |
|---|---|---|
| Filesystem | Imported directory `0555`, files `0444`. A write handle must first open `session.lock` for writing to take the kernel lease, so `EACCES` fails the write open outright. Read handles never touch the lock, so reading and forking are unaffected | POSIX; Windows ignores these bits |
| Ownership index | `$DSH_HOME/scion/ownership.json` records imported ids; export skips them and the command surface refuses them | All platforms |
| Model step | `agent/pre-step` returns `{ kind: 'reject' }` (the same mechanism as `ArchivedSessionGate`). Pre-step runs before any `user/message` is appended, so a veto writes no prompt content into the log | All platforms |

**Forking is unaffected at every layer**: a fork reads the source and creates a
new session id elsewhere.

## Commands

```
/scion status                            show the scion, branch/remote/upstream, local and imported sessions
/scion init [name]                       initialize the current directory as a scion (git init when needed)
/scion push [--sessions a,b] [--push]    export local sessions and commit (--push also publishes)
/scion pull [--sessions a,b] [--no-git]  git pull, then import repo sessions read-only
/scion prune [--sessions a,b] [--dry-run]  drop exported sessions the workspace no longer owns
/scion forget <session-id>               drop the read-only ownership record (files are left alone)
```

The scion root is the invoking session's working directory, so a command always
acts on the checkout you are talking from.

### First publish: remote and upstream

`/scion init` only runs `git init` and writes the manifest — it does **not**
configure a remote, because credentials are yours. Configure one once:

```sh
cd <scion-root>
git remote add origin git@your-host:you/demo-scion.git   # or user@server:~/scions/demo.git (a bare repo)
```

After that, **`/scion push --push` sets the upstream itself** with
`git push --set-upstream origin <branch>` when the branch has none, so a first
publish needs no manual `git push -u`. With no remote at all it says so and
tells you to run `git remote add`.

`/scion pull` uses `git pull --ff-only`: when both sides changed the workspace it
fails and asks you to merge explicitly. That is deliberate — **only the
workspace needs merging**; session files never conflict, because imports are
read-only copies.

### Choosing which sessions to export

`/scion push` with no arguments exports **the sessions DSH accounts to this
workspace** — the ids on the workspace record for that directory whose header
cwd is the root, the same two-condition membership the sidebar uses. Subagent
child sessions and sessions the workspace never attached are **not** exported by
default. That matters because plaintext JSONL is large (a measured 147-session
directory was ≈ 394 MB, of which 32 were workspace members):

```
/scion push --sessions <id1>,<id2> --push
```

An explicit selection is validated against every locally owned session whose
canonical cwd is the root, so a subagent child session *can* be exported on
request. On a host without a workspace registry, or before any record exists for
the directory, export falls back to that whole cwd-matching set. `/scion status`
prints both counts (`local` = exportable, `all` = cwd-matching).

Already-exported files are not removed automatically; `/scion prune` is the
explicit inverse. It deletes the sessions the workspace no longer owns (the
complement of the default export scope), drops their manifest records, and
commits; `/scion prune --dry-run` reports the same plan without deleting
anything. Only manifest-recorded sessions are considered — a `.jsonl` file with
no manifest record is reported as *unmanaged* and never touched — and a clone
with no local sessions prunes nothing. `--sessions <id>` prunes an exact
selection instead, which is also the way to drop a session whose local log is
already gone.

## Repository layout

```
<scion-root>/
  .dsh/scion.json                        manifest: scionId / name / sessionFormatVersion / sessions[]
  .dsh/sessions/<sessionId>.jsonl        plaintext JSONL envelope (diffable, reviewable)
  <workspace files...>                   the workspace itself — the only thing that merges
```

The repo file format belongs to this plugin, not to DSH's physical persistence
format:

```
{"type":"scion/session","schemaVersion":1,"sessionFormatVersion":4,...}   first line: the envelope
{"type":"turn/start","seq":0,...}                                        then one raw event per line
```

Import goes through the public persistence API (`create` + `append` + `flush`),
so encoding, compression, framing, and validation stay the backend's job.

## L0: the transport never rewrites event content

The only value import substitutes is the header's `cwd`, which DSH requires to
be the local absolute workspace path (workspace membership, cross-session
authorization, sandbox roots, and `AGENTS.md` discovery all read it). **Event
payloads are carried verbatim — no path rewriting.**

The cost is that historical absolute paths still name the origin machine. A
plugin-contributed system-prompt note mitigates it; a placeholder transform was
evaluated and deliberately not adopted.

## Install

```sh
# 1. Install into the profile. Use the pnpm major that installed the profile:
#    `dsh plugin add` forwards to whatever pnpm is on PATH, and a store-version
#    mismatch fails with ERR_PNPM_UNEXPECTED_STORE.
cd ~/.dsh/profiles/web
npx --yes pnpm@10.33.2 add "file:/path/to/dsh-plugins/dsh-scion"

# 2. Mount it. A plain (non-bundle) plugin needs an explicit insert row; see
#    examples/cordis.patch.yml:
#      ~/.dsh/profiles/web/cordis.patch.yml
#      - insert:
#          - id: scion
#            name: '@asyouwish/dsh-scion'
#            config:
#              enabled: true

# 3. Restart `dsh web`. dsh-hmr ignores **/node_modules, so plugin *code*
#    changes are not hot-reloaded; only the profile patch file is watched.
```

Verify with `/scion status`: it prints `branch`, `remote`, `upstream`, and
`worktree` lines.

## Known limitations

- **Attachments are not carried**: images and files inside a session are
  content-addressed references and do not travel with the repo yet.
- **Cross-version imports are refused**: a repo session whose format version
  differs from the local writer is rejected; the migration chain is
  forward-only.
- **No `drop` subcommand**: `/scion prune` is the explicit inverse of push, but
  pruning is never automatic — export alone never deletes.
- **Subagent child sessions are not exported by default**: they are not on the
  workspace record; select one explicitly with `/scion push --sessions <id>`.
- **No Web UI**: only the `/scion` command; the sidebar does not distinguish
  local from read-only imported sessions.
- **Exports capture the current valid prefix**: exporting a running session
  reads its valid prefix, which may cut mid-turn.

## Development

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # 26 tests
pnpm verify     # build + test
```

Tests come in three tiers:

- `tests/unit.spec.ts` — command grammar, repo envelope, manifest, ownership
  index, directory-name mirrors (pure logic).
- `tests/closed-loop.spec.ts` — the full loop against the **real JSONL
  backend**: A exports → B imports at a different absolute path → read-only
  (asserted via mode bits) → idempotent re-import → A extends → B appends →
  write open refused; plus local-id collision and the version gate.
- `tests/export-scope.spec.ts` — export membership and prune against the real
  backend: the default set is the workspace record's account, an explicit
  `--sessions` selection still reaches a subagent child, the cwd-equality
  fallback applies when no workspace record is usable, prune drops exactly the
  complement, unmanaged files are left alone, and a clone with no local
  sessions prunes nothing.
- `tests/loader-composition.spec.ts` — mounting through the real cordis Loader,
  `/scion` registration, and inertness when disabled.
- `tests/git.spec.ts` — repository state and the first-push upstream flow.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: config validation, read-only gate, `/scion` registration |
| `src/service.ts` | Command executor (root resolved from the session cwd) |
| `src/commands.ts` | `/scion` argument grammar (pure, unit-tested) |
| `src/export.ts` | push: workspace-owned local sessions → plaintext repo envelopes |
| `src/prune.ts` | prune: drop repo sessions the workspace no longer owns |
| `src/import.ts` | pull: repo → read-only local sessions (cwd localization, ownership, mode bits) |
| `src/readonly.ts` | `agent/pre-step` gate |
| `src/ownership.ts` | Machine-local ownership index (serialized writes, atomic replace) |
| `src/manifest.ts` | `.dsh/scion.json` read/write with strict validation |
| `src/repo-format.ts` | Repo envelope codec (dense-seq validation) |
| `src/locate.ts` | Mirrors the backend's directory naming and **verifies** the result |
| `src/workspace.ts` | Local workspace synthesis and attach (doubles as the post-import self-check) |
| `src/git.ts` | `git` subprocess wrapper |
