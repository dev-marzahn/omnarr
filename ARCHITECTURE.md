# Architecture

How omnarr is put together: the processes it runs, the data it keeps, and
the path a release takes from an indexer search to a file that plays in
Jellyfin. `CONTRIBUTING.md` has the build, test and engineering rules; this
file is the map.

## The rule everything follows

**Convex owns state; the worker owns effects.** Every change to the
library, the pipeline or the job queue is a Convex mutation. Every effect
outside Convex (files under `/data`, the download clients, ffmpeg,
Jellyfin) is done by the worker, either as a leased job or by its download
reconciler. The worker never writes state directly: it reports results
through worker functions, and those functions write the state.

## Components

```text
                        Browser (Nuxt + Nuxt UI)
                                 │  WebSocket: queries and mutations (admin session)
                                 ▼
┌───────────────────────── Convex backend ─────────────────────────┐
│ public queries/mutations: caller check, DTO out                  │
│ internal mutations: state machines, job queue, events, Issues    │
│ actions: indexers (Newznab, Torznab, Nyaa), TMDB, TheXEM,        │
│          Anime-Lists, GitHub releases                            │
│ crons: RSS, supervision, backfill, upgrades, metadata, retention │
└──────────────────────────────▲───────────────────────────────────┘
                               │  WebSocket: job queue subscription, claim,
                               │  heartbeat, complete, fail (worker token)
                     ┌─────────┴─────────┐
                     │      Worker       │── ffmpeg, ffprobe, unar
                     │ (one per install) │── /data
                     └─┬────────┬──────┬─┘
                       │        │      │   internal Docker network
                   NZBGet  qBittorrent  Jellyfin
                          (via gluetun in the VPN layout)
```

`compose.yml` runs these services:

| Service       | Image              | What it does                                                                                                     |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `setup`       | the worker image   | One-shot, before everything else: generates secrets, creates the `/data` tree, writes the clients' first config. |
| `backend`     | `packages/backend` | A self-hosted Convex deployment with omnarr's functions.                                                         |
| `worker`      | `apps/worker`      | Runs jobs, watches the download clients, talks to Jellyfin.                                                      |
| `web`         | `apps/web`         | The Nuxt app the user opens on port 3000.                                                                        |
| `nzbget`      | upstream           | Usenet downloads, configured and driven by the worker over its API.                                              |
| `qbittorrent` | upstream           | Torrent downloads, the same way over its WebUI API.                                                              |
| `jellyfin`    | upstream           | Playback. Set up, fed and polled by the worker.                                                                  |

`compose.vpn.yml` adds `gluetun` and puts qBittorrent inside its network
namespace, so torrent traffic stops when the tunnel drops.

### Convex backend (`packages/backend/convex`)

The backend holds the library and every pipeline state machine. Public
functions live in `api/` and are the only entry points the web app uses;
each one checks its caller (an admin session, or the worker token for the
worker's functions) and returns a DTO declared in `packages/contracts`. The
wrappers that enforce this are in `lib/functions.ts`.

Convex actions make only these outside calls: indexer searches, RSS and
connection tests (`indexers/`), TMDB requests (`metadata/`), numbering data
from TheXEM and Anime-Lists (`mapping/`), and the update check against
GitHub releases (`updates.ts`). They never reach the worker, a download
client, Jellyfin or `/data`.

Scheduled work is in `crons.ts`: RSS every 5 minutes, job supervision
every 30 seconds, a daily backfill search, a weekly upgrade search, the
hourly metadata tick, the daily site-definition sync, the update check, and
retention for candidates, artifacts and finished runs.

Schema changes ship with migrations in `migrations/`; default data such as
the shipped release profiles ships as reference seeds in `referenceSeeds/`.

### Worker (`apps/worker`)

The only component that touches `/data`, the download clients, ffmpeg and
Jellyfin. One worker runs per installation. It:

- connects with a handshake that checks its protocol version against the
  backend's (`worker.ts`); on a mismatch it claims nothing and retries
  every minute, and the web app shows a banner;
- subscribes to a reactive job queue and claims jobs per class, with a
  lease that its heartbeat renews every 20 seconds (`runtime/lease.ts`,
  `runtime/heartbeat.ts`);
- runs each job class's handler in `jobs/`: `download.submit`, `import`,
  `prepare`, `publish`, `maintenance`, and `indexer` (a request for a
  site-definition indexer);
- polls NZBGet and qBittorrent every 30 seconds and reports only changes
  (`runtime/reconcile.ts`); the same reconciler is the only code that
  writes the clients' configuration;
- watches the VPN through gluetun's control API (`runtime/vpnMonitor.ts`)
  and Jellyfin's active plays (`runtime/playbackWatch.ts`).

Everything the worker writes lives on one `/data` volume, which must be a
single filesystem so imports can hard-link and rename instead of copying:
downloads, `staging/`, the libraries under `library/`, and `originals/`,
which sits outside every Jellyfin library so Jellyfin only sees the
prepared file. The worker checks this on every heartbeat and raises an
Issue when the areas don't share a filesystem.

Client adapters are in `clients/`, Jellyfin's in `jellyfin/` behind the
`PlaybackTarget` port (`targets/playbackTarget.ts`), media tools in
`media/`, the `/data` layout and placement in `fs/`, the site-definition
engine in `sites/`, and the existing-media walk in `scan/`. The worker image
also carries the setup container's code (`setup/`).

### Web app (`apps/web`)

Nuxt with Nuxt UI, talking to Convex over a WebSocket with a Better Auth
session. Pages are in `pages/` (library, items, scan, issues, settings,
system, the first-run setup); the formatting and state logic the pages
share lives in `lib/`, with its unit tests in `test/`. The web app reads
only DTOs and calls only public functions.

### Shared packages

- `packages/contracts`: the Zod schemas for everything that crosses a
  process boundary: DTOs, job payloads and results, states and their
  transitions, failure codes with their retry policy and limits, and the
  protocol version. Convex validators are derived from these schemas, so
  the backend, worker and web app can't drift apart.
- `packages/parser`: the release-title parser. It turns a release name into
  a `ParsedRelease` (title, episodes, quality, codecs, languages, group).
  Its golden corpus is in `test/golden/`.
- `packages/scoring`: matching a parsed release to Units, evaluating it
  against a release profile, ranking candidates, upgrade decisions, and
  predicting how much preparation a release will need.

## The library data model

The tables are defined in `packages/backend/convex/schema.ts`. The core of
the model:

- **Library**: two of them, Series (`/data/library/series`, which also
  holds anime) and Movies (`/data/library/movies`). Each has a playback
  profile (the format its devices direct-play) and a default release
  profile.
- **Work**: one series or movie (`works`). Anime is a numbering scheme on a
  series, not a separate kind. A Work's folder is set once, by its first
  import or by the scan, and never recomputed, so a title change at TMDB
  never splits a series in Jellyfin.
- **Unit**: one episode, special or movie (`units`). Its document ID is its
  identity; TMDB, TVDB, IMDb and AniDB IDs are lookups in `externalIds`,
  never keys. `unitMappings` maps a Unit to the other numberings releases
  use (scene, TVDB, absolute, AniDB), filled from TMDB, TheXEM and
  Anime-Lists. Each Unit carries a `derivedState` (wanted, searching,
  downloading, ready, notInTargetFormat and so on), written only by
  `recomputeUnits` in `lib/derivedState.ts`.
- **Search attempt and candidate**: each search writes a `searchAttempts`
  row and one `candidates` row per release it saw, with its parsed title,
  score breakdown, and the reason it was picked or rejected. This is the
  decision record behind "why this release?".
- **Grab**: a release the pipeline acts on (`grabs`, with `grabUnits` for
  the Units it covers). One Grab is one workflow run. A Unit has at most one
  active Grab.
- **Download, import, rendition, publication**: the steps of a Grab
  (`downloads`, `importJobs`), the preparation of a file (`renditions`),
  and its appearance in Jellyfin (`publications`). Each has its own small
  state machine.
- **File**: one file on disk (`files`), linked to the Units it holds
  through `fileUnits` (multi-episode files and packs). `fileVersions` says
  what a file is to a Unit: `primary` (the one Jellyfin plays), `staged`
  (waiting for a publish or a preparation), or `original` (a source kept
  under `/data/originals` when the profile keeps originals). A file records
  where it came from (`download`, `scan` or `prepared`) and whether it fits
  the library's playback profile.

Around the core: `jobs` (the worker's queue) with `jobProgress` and
`workerSessions`; `events`, an append-only log that every state change
writes to and the timelines read; `issues`, the failures raised to the
user with their fix actions; `blocklist`, per Work; and the configuration
tables for indexers, download clients, release and playback profiles,
metadata and Jellyfin.

**State changes.** Only `transition()` (`lib/stateMachine.ts`) changes a
state field, against the transitions declared in
`packages/contracts/src/states.ts`, and every change appends an event in
the same transaction.

## The pipeline: from search to Jellyfin

### Searching

A search has five triggers: subscribing to a Work, RSS, the daily backfill,
"Search now", and a next-best search after a bad release. The code is in
`packages/backend/convex/pipeline/`.

1. **Search** (`search.ts`, `searchAction.ts`). The wanted Units are
   grouped (a whole season when every Unit of it is wanted, else one group
   per episode), and an action per group asks each indexer, following a
   request plan that tries the most precise query first
   (`indexers/requestPlan.ts`). Each page of results is parsed, matched to
   Units and scored, and written as candidates.
2. **Pick** (`pick.ts`). When the last page is in, the candidates are
   ranked with `selectCandidates` from `packages/scoring`, and the ranking
   is walked: a candidate is taken when none of its Units is already taken
   or has an active Grab. One search can start several Grabs on disjoint
   Units, such as a season pack plus single episodes it doesn't cover.
   "Search and pick" stops here and lets the user choose.
3. **RSS** (`rss.ts`, `rssAction.ts`) reads each indexer's feed on its
   interval and matches new items against monitored Units, with no
   per-Unit search. **Backfill** (`backfill.ts`) searches up to 200 wanted
   Units a day, those searched longest ago first.

Indexers are adapters in `indexers/`: Newznab, Torznab and Nyaa run as
Convex actions. Indexers defined by Prowlarr-format site definitions run in
the worker's engine instead: the backend's relay (`indexers/relay.ts`)
enqueues an `indexer` job per request and waits for its answer.

### The run

Each Grab starts one durable workflow run, `pipelineRun` in
`pipeline/workflow.ts`. Each worker step is a mutation that enqueues a job,
followed by a wait for that job's event:

```text
pipelineRun(grabId)
  steps.submitDownload   enqueue download.submit  → wait for the job
  (wait)                                          → wait for the download to finish
  steps.startImport      enqueue import           → wait for the job
  steps.startPublish     enqueue publish          → wait for the job
  steps.finish           file versions, Unit outcomes, clear the active Grab,
                         resolve Issues, decide preparation
```

- **download.submit** (`apps/worker/src/jobs/downloadSubmit.ts`) fetches
  the NZB or torrent and hands it to NZBGet or qBittorrent, tagged with the
  Grab's ID so a re-run finds it instead of submitting twice. The
  reconciler then reports the download's progress until it completes,
  fails or stalls.
- **import** (`jobs/import.ts`) extracts archives into `staging/<jobId>`,
  asks the backend which Units each file holds, and hard-links the chosen
  files into the library under their final names. The download stays whole
  so torrents keep seeding.
- **publish** (`jobs/publish.ts`) has Jellyfin index the files and reads
  back what Jellyfin took each file for; the backend checks that against
  the Unit, so a file Jellyfin would misread is caught.

`pipeline/steps.ts` holds the step mutations, and `jobs/results.ts`
applies each job's result to its entity.

**Preparation runs outside the run.** `steps.finish` calls
`preparation.decide` (`pipeline/preparation.ts`), which compares the file
with the library's playback profile. If the file doesn't direct-play, it
starts a Rendition and enqueues a `prepare` job: the worker remuxes,
re-encodes audio, converts subtitles or transcodes video with ffmpeg
(`apps/worker/src/media/`), verifies the output with ffprobe, and the new
file is published in place of the old. If preparation fails, the original
stays playable.

**Upgrades** (`pipeline/upgrades.ts`). RSS and a weekly search look for a
better release of a Unit that already plays; a candidate that isn't an
upgrade for every Unit it covers is rejected. An upgrade is an ordinary
Grab whose new file replaces the primary once it is visible in Jellyfin.

**Cancel and delete.** `cancelGrab` (`pipeline/grabs.ts`) is the one way to stop a run,
whether the user cancelled, unmonitored the Units or deleted the Work
(`library/deleteWork.ts`). It ends the run wherever it waits and cleans up
the client item and staging.

### Jobs and failures

The job queue is in `packages/backend/convex/jobs/queue.ts`. A claim takes
the queued jobs of a class in priority order and leases them with an epoch;
any call with a stale epoch is refused, so a worker that lost its lease
can't complete a job twice. Supervision returns jobs with an expired lease
to the queue, and raises "worker offline" when no worker has been seen for
a minute.

Every failure has a code in `packages/contracts/src/failures.ts` with its
class, its retry policy and the fix actions the user is offered. Transient
failures back off and retry up to the class's attempt limit. A bad release
(missing articles, a failed repair, a stalled torrent, the wrong content)
ends the run: the release is blocklisted and a next-best search starts a
new Grab, up to three bad releases before an Issue asks the user. A run
never loops internally; each retry is a new Grab with its own run.

The limits (attempts, concurrency per job class, timeouts, the bad-release
count) are `DEFAULT_LIMITS` in the same file.

## Existing media and metadata

**Metadata** (`packages/backend/convex/metadata/`) syncs each Work from
TMDB on the hourly tick, through a small pool so requests stay within
TMDB's limits, and reconciles its Units. Numbering data from TheXEM,
Anime-Lists and Sonarr's scene mappings (`mapping/`) is projected into `unitMappings`, so a
release numbered differently from TMDB still matches the right episode.
Each installation fetches these sources itself; none of their data is in
the repository.

**The scan** (`packages/backend/convex/scan/`, `apps/worker/src/scan/`)
walks the library folders for files omnarr doesn't know, matches them to
Works and Units, and lets the user review and import them. A scanned file
keeps its name unless Jellyfin would misread it.

## Where things are

```text
apps/web               Nuxt + Nuxt UI: pages, components, lib/ and its tests
apps/worker            the worker and the setup container
packages/backend       convex/ (schema, functions, migrations, seeds) and test/
packages/contracts     Zod: DTOs, job payloads and results, states, failures, protocol
packages/parser        the release-title parser and its golden corpus
packages/scoring       matching, profile evaluation, ranking, upgrades
scripts/               codegen, checks, licence notices, the smoke test
e2e/                   the end-to-end scenarios, their compose overrides and fakes
docs/install.md        installing, upgrading and backing up
```
