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
/scion init [name] [--remote <url>]      initialize this directory as a scion (git init when needed)
/scion remote [<url>]                    show, or set, the origin repository URL
/scion push [--sessions a,b] [--push]    export local sessions and commit (--push also publishes)
/scion pull [--sessions a,b] [--no-git]  git pull, then import repo sessions read-only
/scion prune [--sessions a,b] [--dry-run]  drop exported sessions the workspace no longer owns
/scion forget <session-id>               drop the read-only ownership record (files are left alone)
```

The scion root is the invoking session's working directory, so a command always
acts on the checkout you are talking from.

`status`, `init`, and `forget` answer inline. `push`, `pull`, and `prune` do real
work — a measured 147-session directory is ≈ 394 MB, plus git — so with a job
registry composed they run as **background jobs**: the command answers
immediately with a job id, per-session progress and detail stream into the job's
output ring, the owning session can kill it, and completion arrives in-session as
a notice (`job_output <id>` reads it on demand). Without a job registry — no
`dsh-jobs` composed, or no controller serving the agent — the same work runs
synchronously and its output becomes the command text.

### First publish: remote and upstream

The repository URL is given to scion, not to a shell — nothing here needs the
`git` CLI. Configure the remote once, either at init time or later:

```
/scion init my-work --remote git@your-host:you/demo-scion.git
/scion remote git@your-host:you/demo-scion.git     # add or update origin
/scion remote                                      # show remotes and upstream
```

Any URL form git accepts works (`https://…`, `git@host:path`, `ssh://…`, a local
path). A URL carrying credentials is stored verbatim but always **displayed
masked** (`https://***@host/…`).

After that, **`/scion push --push` sets the upstream itself** with
`git push --set-upstream origin <branch>` when the branch has none, so a first
publish needs no manual `git push -u`. With no remote at all it says so and
tells you to run `/scion remote <url>`.

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

dsh-scion is a **bundle**: installing the package *is* the mount step.
`dsh plugin` appends it to the profile's `dsh.profile.bundles`, and the
package's own `cordis.patch.yml` inserts the `/scion` row — no hand-written
profile entry.

```sh
# Published package, packaged DSH app:
dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
# From a source checkout, reach the same launcher through its script:
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
# Add --registry=https://registry.npmjs.org/ when your default registry is a
# mirror that may lag behind a just-published version.

# To develop against a local checkout instead:
#   dsh plugin --profile web add "file:/path/to/dsh-plugins/dsh-scion"
# A `file:` directory dependency is *hard-linked*, so rebuilding the repo
# rewrites the installed plugin in place and a file added later (lib/prune.js)
# stays invisible until the install is re-run. For an independent copy, pack a
# tarball first:
#   pnpm pack && dsh plugin --profile web add /path/to/asyouwish-dsh-scion-0.4.0.tgz

# Then restart `dsh web`. dsh-hmr ignores **/node_modules, so plugin *code*
# changes are not hot-reloaded.
```

Override the bundle's configuration with an id-targeted row in the profile's own
patch (that layer is applied after every bundle layer, so the bundle still owns
the row — never repeat it with `insert:`, which would mount the plugin twice):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: scion
  config:
    enabled: true
    readonlyGate: true
```

**Upgrading from 0.2.0**, which was mounted by a hand-written row: `dsh plugin`
only activates a *newly added* dependency, so re-install rather than upgrade in
place, and delete the old `insert:` row at the same time:

```sh
dsh plugin --profile web remove @asyouwish/dsh-scion
dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
```

`dsh plugin` reports success even when it merely reinstalled the package, and a
`remove` can exit non-zero transiently (retry it). Either way, check afterwards
that `dsh.profile.bundles` in the profile's `package.json` gained
`@asyouwish/dsh-scion` — that list entry, not the dependency, is what mounts the
plugin. Without it the install succeeds and `/scion` stays absent.

**One pnpm per profile.** `dsh plugin` forwards to a pnpm: the one on `PATH` for
a source checkout, an installation-bundled one for the packaged apps. A profile's
`node_modules` belongs to the store of whichever pnpm last wrote it —
`~/.dsh/profiles/web/node_modules/.modules.yaml` records `packageManager` and
`storeDir`, and pnpm 10/11 use `store/v10`/`store/v11`. Point a different major
at it and pnpm wants to purge and rebuild `node_modules` (non-interactively that
aborts as `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Read the recorded major
and keep using it; to move a profile onto another major, run one install with the
target pnpm and `--config.confirmModulesPurge=false`.

Verify with `/scion status`: it prints `branch`, `remote`, `upstream`,
`worktree`, plus the `local` (exportable) and `all` (cwd-matching) counts.

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
pnpm test       # 40 tests
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
- `tests/loader-composition.spec.ts` — mounting through the real cordis Loader:
  the shipped `dsh.bundle` patch layer alone mounts `/scion`, a profile layer
  overrides it, and a bad config stays inert.
- `tests/git.spec.ts` — repository state, the first-push upstream flow, and
  remote add/update plus credential masking.
- `tests/remote.spec.ts` — the in-surface repository flow: `/scion init
  --remote` in one step, `/scion remote` add/update/report, and the refusal
  outside a git work tree.
- `tests/jobs.spec.ts` — the background-job adapter (registration, streaming,
  cancel-to-kill, failure settlement, no-registry fallback) and the service
  routes: `push` submits a job when a registry is composed and runs
  synchronously when it is not.

## Modules

| File | Responsibility |
|---|---|
| `cordis.patch.yml` | The bundle layer: inserts the `/scion` row into every profile that lists this package |
| `src/index.ts` | Plugin entry: config validation, read-only gate, `/scion` registration |
| `src/service.ts` | Command executor (root resolved from the session cwd) |
| `src/commands.ts` | `/scion` argument grammar (pure, unit-tested) |
| `src/export.ts` | push: workspace-owned local sessions → plaintext repo envelopes |
| `src/prune.ts` | prune: drop repo sessions the workspace no longer owns |
| `src/jobs.ts` | background-job adapter for push/pull/prune (optional `dsh-jobs` peer) |
| `src/import.ts` | pull: repo → read-only local sessions (cwd localization, ownership, mode bits) |
| `src/readonly.ts` | `agent/pre-step` gate |
| `src/ownership.ts` | Machine-local ownership index (serialized writes, atomic replace) |
| `src/manifest.ts` | `.dsh/scion.json` read/write with strict validation |
| `src/repo-format.ts` | Repo envelope codec (dense-seq validation) |
| `src/locate.ts` | Mirrors the backend's directory naming and **verifies** the result |
| `src/workspace.ts` | Local workspace synthesis and attach (doubles as the post-import self-check) |
| `src/git.ts` | `git` subprocess wrapper, incl. remote configuration (`/scion remote`) |
