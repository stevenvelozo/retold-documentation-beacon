# retold-documentation-beacon

Bidirectional sync between a documentation folder tree and a Retold Docs Lake.

The beacon watches a folder of markdown (and adjacent images) with chokidar and
keeps it in step with a platform's Docs Lake over `/1.0/docs/*`. Edits can start
on either side. When the same file changes on both sides it runs a git 3-way
merge; clean merges apply automatically, and real conflicts are written back to
both sides with standard `<<<<<<< / ======= / >>>>>>>` markers so a human can
resolve them wherever they prefer. It runs standalone from the command line or
supervised by Ultravisor.

A typical setup is a documentation folder in a git repo kept in step with one
customer's Docs Lake on the platform, so the same docs can be edited from the
folder or from the platform and stay reconciled.

## How it reconciles

Each pass takes three snapshots of every path:

- **ours** - the folder on disk (hashed file by file)
- **theirs** - the platform's current Docs Lake tree (from `GET /1.0/docs/manifest`)
- **base** - the last version the two sides agreed on, stored locally under `.docsync/`

Per path it then decides:

| ours vs base | theirs vs base | action |
|---|---|---|
| same | same | in sync, nothing to do |
| same | changed | pull (write the platform copy into the folder) |
| changed | same | push (commit the folder copy to the platform) |
| changed | changed, same bytes | converged, just advance base |
| changed | changed, different bytes | 3-way merge |

A 3-way merge shells out to `git merge-file -p ours base theirs`. A clean merge
(the two sides touched different lines) is committed to both sides with no fuss.
A real conflict (the two sides touched the same lines) produces the merged file
with conflict markers; that marked file is written to the folder AND committed to
the platform, and the platform's `DocNode.ConflictState` is set so the doc is
flagged in the UI. Nothing is lost: a human deletes the markers on whichever side
they like and the next pass clears the flag.

The merge base is tracked as an atomic pair in `.docsync/`: `state.json` records
the platform commit hash and the tree, and `.docsync/base/` mirrors the agreed
content so the next merge has a real common ancestor. Steady state is
`ours == theirs == base`.

## Install

```bash
npm install
```

`chokidar` is the only required dependency (node's global `fetch` does the HTTP).
`ultravisor-beacon` and `fable` are optional and only loaded when you turn on
Ultravisor supervision.

## Run it

Standalone, watching a folder and reconciling on every change plus a poll timer:

```bash
node bin/retold-documentation-beacon.js \
    --folder ./docs \
    --server http://localhost:8190 \
    --user dev@local.test \
    --password devpass1234
```

One reconcile pass and exit (useful for cron or CI):

```bash
node bin/retold-documentation-beacon.js --folder ./docs --server http://localhost:8190 \
    --user dev@local.test --password devpass1234 --once
```

Supervised by Ultravisor (registers a `DocSync` capability with `Reconcile` and
`Status` actions):

```bash
node bin/retold-documentation-beacon.js --folder ./docs --server http://localhost:8190 \
    --user dev@local.test --password devpass1234 \
    --ultravisor http://localhost:8086 --name docs-beacon
```

### Configuration

CLI flags win, then a JSON config file (`--config beacon.json`), then env vars,
then defaults.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--folder` | `DOCSYNC_FOLDER` | `./docs` | the watched folder |
| `--server` | `DOCSYNC_SERVER` | `http://localhost:8190` | the platform base URL |
| `--user` | `DOCSYNC_USER` | (empty) | service account for `/1.0/Authenticate` |
| `--password` | `DOCSYNC_PASSWORD` | (empty) | service account password |
| `--poll-ms` | | `30000` | safety-net reconcile interval |
| `--ultravisor` | `DOCSYNC_ULTRAVISOR` | (off) | Ultravisor coordinator URL |
| `--name` | `DOCSYNC_NAME` | `retold-documentation-beacon` | mesh handle |
| `--once` | | | run one pass and exit |

The session belongs to one tenant: the beacon authenticates as a service
account, and the platform scopes every read and write to that account's customer.
Point two beacons with two accounts at the same server to sync two tenants.

## Ultravisor supervision

With `--ultravisor`, the beacon registers a `DocSync` capability on an
ultravisor-beacon service:

- **Reconcile** runs one `reconcileOnce()` as a supervised work item and returns
  the summary (`Pulled`, `Pushed`, `Conflicts`, `ConflictPaths`, `PlatformCommit`).
  A scheduled Reconcile is a safety net behind the file watch.
- **Status** returns the watched folder, the last reconcile summary, and the
  current platform commit.

Both handlers are thin wrappers over the same engine the standalone watch uses.
If `ultravisor-beacon` is not installed, or the coordinator is unreachable, the
beacon logs it and keeps running standalone.

## The platform side

The beacon talks to a Retold Docs Lake through four endpoints (served by the
platform's `DocLake-Endpoint`):

- `POST /1.0/Authenticate` - sign in, capture the session cookie
- `GET  /1.0/docs/manifest` - the current tree (`{ Commit, Tree: { path: { Hash, Size, Mime } } }`)
- `GET  /1.0/docs/<path>` - the bytes at a path
- `POST /1.0/docs/commit` - apply a `{ Puts, Deletes, Conflicts }` changeset as one commit

A commit on the platform is content-addressed and append-only, so both sides
produce the same kind of history. That is what makes the merge symmetric.

## Layout

```
bin/retold-documentation-beacon.js   CLI entry point
source/Documentation-Beacon.js       the reconcile engine (snapshot, merge, write back)
source/Platform-Client.js            the /1.0/docs/* HTTP client
source/Ultravisor-DocSync.js         optional DocSync capability (Reconcile / Status)
```

## License

MIT
