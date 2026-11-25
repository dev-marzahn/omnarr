# Contributing

## Setup

You need Bun 1.4.4, Node 22.18 or later, and Docker (codegen and the smoke test start a throwaway Convex backend).

```sh
bun install
bun run ready     # build, then vp check (format, lint, types), then every test
```

Other scripts:

| Script                                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run codegen`                                                                         | Rewrites `packages/backend/convex/_generated/` and convex-release's `migrations/_generated.ts` and `seeds/_generated.ts`, against a throwaway backend. Commit the result.                                                                                                                                                                                              |
| `bun run check-ports`                                                                     | Fails if a compose file publishes a port a download client or gluetun mustn't: anything of NZBGet's or gluetun's, and anything of qBittorrent's but its peer port, which only the direct layout publishes. In the shipped `compose.yml` and `compose.vpn.yml` it also allows only the backend's, Jellyfin's and the web app's ports and requires every image's digest. |
| `bun run smoke`                                                                           | Deploys the backend to a throwaway backend and runs the built worker against it, with a matching and a mismatched protocol version. Run `bun run build` first.                                                                                                                                                                                                         |
| `bun run auth:schema`                                                                     | Regenerates the Better Auth component's schema after a change to `convex/authOptions.ts`, with the CLI's absolute path stripped from its header.                                                                                                                                                                                                                       |
| `bun run collect-titles -- --url <indexer> --categories 5000,2000 --pages 5 --out <file>` | Reads release titles and categories from your own Newznab or Torznab indexer (key in `COLLECT_INDEXER_KEY`) into a file outside the repository, for the parser corpus. It writes no GUID, URL or key.                                                                                                                                                                  |

`bun run test` runs every workspace's tests (`scripts/` and `e2e/` are workspaces too). Run a single test file with `bunx vp test run <file>` in its workspace.

`bun run e2e` runs every end-to-end scenario in Docker; `node e2e/run.ts <scenario>` runs one. The `vpn` scenario runs gluetun and a WireGuard test server, so its Docker host must allow `NET_ADMIN` and `/dev/net/tun` (Docker Desktop 7 does). Each checkout gets its own compose project, `omnarr-e2e-<folder>` (`E2E_PROJECT` overrides it), so two worktrees' runs on one host stay apart. A run takes one of the host's `E2E_SLOTS` (default 2, a `mkdir` lock under `~/.cache/omnarr-e2e/slots/`) before it brings up a stack, and says so while it waits for one; a stack kept with `E2E_KEEP=1` holds its slot until its `down()` or until its containers are gone. The pipeline scenario's generated media is made once per host, in `~/.cache/omnarr-e2e/media/` (`E2E_CACHE` moves it), and linked into each checkout. Timeouts are about twice a passing run's slowest time, and a test that needs an earlier one skips when it failed, so a broken scenario fails in minutes.

The `install` scenario (`node e2e/run.ts install`) checks the install and the first run on the shipped `compose.yml` and `compose.vpn.yml`. Every scenario runs on those files with `e2e/compose.test.yml` as an override, in a temporary project folder, and builds the three images first.

The `stackUpgrade` scenario (`node e2e/run.ts stackUpgrade`) runs an upgrade with a migration and a downgrade by restore: it builds an older commit's images (`E2E_FROM_COMMIT`, default `62f05fc`, as `0.1.0-p1`), this checkout's as `0.2.0-p2`, and a fixture backend with a migration that fails on purpose from `HEAD`, so commit first. With `E2E_FROM_VERSION` it starts from that GitHub release's files and images instead, as the release workflow does.

## Images and releases

The project ships three images. Build them from the repository root:

```sh
docker build -f packages/backend/Dockerfile -t omnarr-backend .
docker build -f apps/worker/Dockerfile -t omnarr-worker .
docker build -f apps/web/Dockerfile -t omnarr-web .
```

- **`omnarr-backend`** is convex-release's combined image with the platform's bundle. On every start convex-release runs two hooks (`packages/backend/image/hooks.ts`): `pre-push` sets the deployment variables from `.env` and `backend-secrets` before the first push, and `post-apply` runs the reference seeds. It manages only its own variables, never convex-release's `CONVEX_RELEASE_*`. The image also carries `reset-admin-password` (`image/reset.ts`). Its base tag equals the catalog's `@dev-marzahn/convex-release` version; bump both together.
- **`omnarr-worker`** also runs the one-shot `setup` service: `setup` (secrets, the setup password, the `/data` tree and `./definitions`, `setup-clients`, owners) and `show-setup-password` (`apps/worker/src/setup/setup.ts`).
- **`omnarr-web`** serves the built app from Nuxt's Node server. It reads the URLs from its environment when it starts, never at build.

**Releases.** `.github/workflows/release.yml`, run by hand with a version (`0.1.0-p1` for a pre-release), builds the three images for amd64 and arm64, pushes them by digest, runs the `stackUpgrade` e2e from the newest GitHub release to those digests (skipped while there is none; a failure stops the release), tags them, writes their digests into `compose.yml` with `node scripts/pin-images.ts`, rewrites `compose.vpn.merged.yml`, commits "Release <version>" on top of the commit it started from, pushes that commit at once to `main`, to the `release` branch (not for a pre-release) and as the tag `v<version>`, and creates the GitHub release with `compose.yml`, `compose.vpn.yml`, `compose.vpn.merged.yml` and `.env.example`, uploaded as `env.example` because GitHub renames an asset whose name starts with a dot. It runs only on `main` and pushes with a deploy key, which `main`'s ruleset lets past its required checks; that push starts CI on `main`. If `main` moved while it ran, the push is refused and nothing moves: start a new run (a re-run of the old one builds on the same commit and is refused again). `release` always holds the newest release, for an install that follows a branch (Coolify, in `docs/install.md`), so `main`'s compose files may need images that aren't released yet.

The release's push, set up once by a repository admin:

1. `ssh-keygen -t ed25519 -N "" -C omnarr-release -f release_key`.
2. Settings › Deploy keys › Add deploy key: `release_key.pub`, with write access.
3. Settings › Environments › New environment `release`; under Deployment branches and tags, allow only the branch `main`. Add the environment secret `RELEASE_DEPLOY_KEY` with the contents of `release_key` (`gh secret set RELEASE_DEPLOY_KEY --env release < release_key`), then delete both key files. Only jobs on `main` that name the environment can read it.
4. Settings › Rules › the ruleset on `main` › Bypass list: add Deploy keys, Always allow.
5. Settings › Rules › New branch ruleset on `release`: Restrict updates, Restrict deletions and Block force pushes, with Deploy keys on its bypass list, so only the release moves it.

**`compose.vpn.merged.yml`** is `compose.yml` with `compose.vpn.yml` merged over it, the VPN layout in one file for front ends that ignore `COMPOSE_FILE`. It is generated: change the two source files, then run `node scripts/merge-vpn-compose.ts`. A test fails while it is out of date or differs from what `docker compose -f compose.yml -f compose.vpn.yml config` resolves to.

**A third-party pin** (NZBGet, qBittorrent, gluetun, Jellyfin) changes its tag and digest together in `compose.yml` and `compose.vpn.yml` (then regenerate `compose.vpn.merged.yml`), in its own pull request, with the adapter's fixtures re-recorded (see "Download-client fixtures"). `bun run check-ports` fails on an image without a digest in the shipped files.

**Two rules keep any v1.x upgrade safe**: no migration is removed or squashed within v1.x, and the switch from the interim reference-seed runner (`seeds/_reference.ts`) to convex-release's `defineReferenceSeed` carries the runner's records over.

## Metadata in development

- **No built-in TMDB token in source builds.** Release CI puts it into the backend image as a build secret; it is never in the repository. To run the backend against TMDB, set your own API Read Access Token as `TMDB_API_TOKEN` on the deployment. To run without TMDB, start the fake (`node e2e/fakes/tmdb/server.ts`) and point `TMDB_API_URL` at it.
- **Never commit upstream data.** TMDB responses, XEM maps and Anime-Lists files must not be copied into the repository or an image: their terms don't allow it. Tests use hand-written fixtures in the sources' shapes, with made-up titles and IDs: `e2e/fakes/tmdb/fixtures.ts` and `packages/backend/test/fixtures/`.
- **Tests never call upstream services.** `useMetadataFakes` in `packages/backend/test/setup.ts` serves TMDB, TheXEM and Anime-Lists to the backend from those fixtures.

## The contracts rule

`packages/contracts` holds every Zod (v4) schema that crosses a process boundary: DTOs, job payloads and results, the protocol version, and the state and failure enums. Convex validators are derived from these schemas with `convex-helpers/server/zod4` (`zodToConvex`, `zodToConvexFields`, `zCustomQuery`, `zCustomMutation`); never write a validator twice. Don't use `zod/v3` or the deprecated `convex-helpers/server/zod`.

Every public Convex function is built from `adminQuery`, `adminMutation`, `adminAction`, `workerQuery` or `workerMutation` (`convex/lib/functions.ts`) and declares a `returns` schema. `adminAction` is only for admin calls that make an outside HTTP request (metadata and indexers), or that read a whole table in pages, too much for one query (`system.librarySize`). Secret fields never appear in a DTO.

Any breaking change to `packages/contracts` raises `PROTOCOL_VERSION` (from v1 on).

## Parser corpus

`packages/parser/test/golden/` holds the release-title parser's golden corpus; its `README.md` has the line format. To add a case:

- Put one line in the file for its kind of release, with the title, `kind`, the `expected` fields it checks (`null` for "must be absent"), `source` (`indexer` for a title from your own indexer, `handwritten` otherwise) and `addedIn` (the milestone).
- Write the expected fields by hand from what the title says, never by copying the parser's output.
- Collect `indexer` titles with `bun run collect-titles` into a file outside the repository and pick from it.
- Never take titles from another project's tests (Sonarr, Radarr or any other).
- A parser bug fix adds the failing title first.

`@ctrl/video-filename-parser` is pinned exactly. A bump is its own pull request, in which the corpus passes unchanged or each changed expectation is edited by hand and reviewed.

## Shipped profiles

The release profiles the platform ships live in `packages/scoring/src/shipped/v<N>/`, one frozen module set per version. A content change is a new `shipped/v<N>/` version and a new reference seed file in `packages/backend/convex/referenceSeeds/`; applied seeds and old version modules are never edited. The group-tier names in `shipped/groupTiers.ts` are the only data taken from TRaSH Guides: names only, transcribed by hand, with the commit they were read at in the file's header.

## Changing `pipelineRun`

The pipeline workflow is defined through `@dev-marzahn/convex-workflow-migrations`. Before v1 is tagged it changes freely. From v1 on, runs in flight must survive every upgrade:

- Each change to the step sequence ships a `migration(id, …)` in `define({ migrations })` that rewrites a run's recorded history into the shape the current code expects.
- The migration list is append-only: never remove, rename or reorder a migration, and never roll a release back below an applied migration. Roll forward instead.
- A step function is referenced by its Convex function path. Renaming one needs an `h.rename` migration plus an alias export of the old name, kept for all of v1.x. The workflow's own name, `pipeline/workflow:pipelineRun`, is permanent.
- Arguments of a step that may already be queued only gain optional fields.
- Add a hand-built history for each new wait point to `packages/backend/test/histories/pipelineRun.ts`; the replay and fingerprint tests must pass.

## Architecture

Convex owns state; the worker owns effects. The components, the library data model, the pipeline from search to Jellyfin and where each lives in the tree are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Engineering rules

Each rule comes from a bug that review caught.

- **A request plan puts its most precise request first.** `nextRequest` (`convex/indexers/requestPlan.ts`) stops at the first request whose results match the title, so a broad query placed before a precise one hides it: an in-season `<title> 04` also returns other seasons' episode 4, whose titles match, and the ID request that names the season is never sent. Order requests from precise to broad, and test a plan against a page that matches, not only against empty pages.
- **A data migration is frozen once it ships.** It runs on installations you never see, possibly releases later, so it can't depend on code that a later change may alter, and it has to fit Convex's transaction limits on the largest rows it touches: the default batch of 100 rows over rows of up to 900 KB passes 16 MiB per transaction and never finishes. Set `batchSize` from the largest row the migration reads, and write with `ctx.db` inside the migration instead of calling a shared helper.
- **A stored enum value never changes meaning.** Tables like `searchAttempts` have no retention, so old rows stay on screen for good, and a value given a narrower meaning makes them say something false. Give a new meaning a new value. Keep the old value in a stored schema in `packages/contracts` (`Stored…`: the live enum plus the legacy literal, like `StoredIndexerSkip`), used by `schema.ts` and the DTOs, show it with its old wording, and test a legacy row.
- **A query over a table that only grows is capped.** A `collect()` over a blocklist or a log reads more on every call until it passes Convex's read limits. Read `order('desc').take(CAP)` with the cap in `packages/contracts`, say on the page when the cap is reached, and add a case to `packages/backend/test/queryCost.test.ts` (its counter files `db.get` reads under `get`).
- **A retry loop ends, and a purge pages by rows written.** A self-rescheduling mutation with no end runs forever without anyone seeing it, and a delete paged by parent records can pass Convex's write limit on one large parent and then fail on every retry. Every self-rescheduling mutation carries its start time, stops at a limit kept in `packages/contracts` and raises a dismissable Issue with a fix action. A delete that walks a tree charges a row budget per transaction and stops at a point in its step order it can resume from.
- **A step that deletes library files runs last and checks every earlier file.** Deleting a file that still plays loses the user's media. Run the delete after every other step, once the new Publication is visible (after the misread check), and check each earlier file before it goes: never a file with `origin: 'scan'`, one from the same `candidateId`, or one that ever played. Test a scanned, a misread and a misread-new-file case.

## Dependency licences

The platform's own code is GPL-3.0. Each project image carries `/licenses`: the platform's `LICENSE` and `THIRD_PARTY_NOTICES.md`, written by `node scripts/notices.ts --workspace <name> --out <file>` in its build stage from `bun.lock` and each bundled package's licence file. The worker's also holds `packages.txt` (its Debian packages by `dpkg-query -W`, with the source offer) and `ffmpeg-configure.txt`.

| Package                                                                                                                                                                                                                 | Licence                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `convex`, `convex-helpers`, `convex-test`, `@convex-dev/workflow`, `@convex-dev/workpool`, `@convex-dev/migrations`, `@convex-dev/better-auth`                                                                          | Apache-2.0                                                                                                           |
| `@dev-marzahn/convex-release`                                                                                                                                                                                           | MPL-2.0                                                                                                              |
| `@dev-marzahn/convex-workflow-migrations`                                                                                                                                                                               | MPL-2.0 AND Apache-2.0                                                                                               |
| `better-auth`, `auth` (its CLI), `zod`, `nuxt`, `@nuxt/ui`, `vue`, `tailwindcss`, `vite-plus`                                                                                                                           | MIT                                                                                                                  |
| `typescript`                                                                                                                                                                                                            | Apache-2.0                                                                                                           |
| `yaml`                                                                                                                                                                                                                  | ISC                                                                                                                  |
| `fast-xml-parser` (Anime-Lists' XML, indexer feeds)                                                                                                                                                                     | MIT                                                                                                                  |
| `htmlparser2` (Nyaa's HTML listing), and its `dom-serializer`                                                                                                                                                           | MIT                                                                                                                  |
| `css-select` (the listing's rows), and `domhandler`, `domutils`, `domelementtype`, `entities`, `css-what`, `nth-check` (theirs)                                                                                         | BSD-2-Clause                                                                                                         |
| `boolbase` (`css-select`'s)                                                                                                                                                                                             | ISC                                                                                                                  |
| `cheerio` (the definition engine's HTML and XML selectors), and its `parse5`, `parse5-htmlparser2-tree-adapter`, `parse5-parser-stream`, `undici`, `whatwg-mimetype`, `encoding-sniffer`, `iconv-lite`, `safer-buffer`  | MIT                                                                                                                  |
| `cheerio-select` (`cheerio`'s), and `domhandler` 5, `domutils`, `css-select` 5 (its versions)                                                                                                                           | BSD-2-Clause                                                                                                         |
| `fflate` (the definitions package)                                                                                                                                                                                      | MIT                                                                                                                  |
| `re2js` (the scorer: scene-mapping release filters, matched in linear time)                                                                                                                                             | MIT                                                                                                                  |
| `yaml` in the worker (definition files)                                                                                                                                                                                 | ISC                                                                                                                  |
| **Ported from Prowlarr** (`apps/worker/src/sites/`: template, filters, dates, sizes, selectors, JSON paths, request, parse, download; each file names its Prowlarr source at commit `46c468c` and says it was modified) | GPL-3.0                                                                                                              |
| Prowlarr's site definitions: **never in the repository or an image**; each instance downloads them at run time. The tests' definitions are written for omnarr.                                                          | (not distributed)                                                                                                    |
| `@ctrl/video-filename-parser`                                                                                                                                                                                           | MIT                                                                                                                  |
| TRaSH Guides release-group names (data transcribed into `packages/scoring/src/shipped/groupTiers.ts`)                                                                                                                   | MIT                                                                                                                  |
| The Convex backend (in the backend image)                                                                                                                                                                               | FSL-1.1-Apache-2.0                                                                                                   |
| ffmpeg 7.1 (Debian trixie's build in the worker image: `--enable-gpl`, no `--enable-nonfree`, no fdk-aac; GPL-3.0 if built with `--enable-version3`)                                                                    | GPL-2.0-or-later as built                                                                                            |
| libx264, libx265 (ffmpeg's H.264 and HEVC encoders)                                                                                                                                                                     | GPL-2.0-or-later                                                                                                     |
| libsvtav1 (ffmpeg's AV1 encoder, with the AOM patent licence; that Debian enables it is to verify in the image)                                                                                                         | BSD-3-Clause-Clear                                                                                                   |
| libopus (ffmpeg's Opus encoder)                                                                                                                                                                                         | BSD-3-Clause                                                                                                         |
| libmp3lame (ffmpeg's MP3 encoder)                                                                                                                                                                                       | LGPL-2.0-or-later                                                                                                    |
| zimg (ffmpeg's `zscale` filter)                                                                                                                                                                                         | WTFPL (to verify)                                                                                                    |
| libass (ffmpeg's `subtitles` filter)                                                                                                                                                                                    | ISC                                                                                                                  |
| `unar`, `lsar` (The Unarchiver, Debian package `unar` 1.10.8, in the worker image; per its Debian copyright file, a few files BSD-3-Clause or ISC)                                                                      | LGPL-2.1-or-later                                                                                                    |
| NZBGet, its own image `nzbgetcom/nzbget:v26.3@sha256:f451d98066cbc0c108146420a61a60f7638de50e067738951461e0105eeaa56d`, called over its API only                                                                        | GPL-2.0                                                                                                              |
| qBittorrent, its own image `qbittorrentofficial/qbittorrent-nox:5.3.0-2@sha256:43b2d352cf76330a7ca34c7320b9b74227d6f31e662e0e123d0457206b09a7ea`, called over its WebUI API only                                        | GPL-2.0-or-later (source), GPL-3.0-or-later (binaries), with an OpenSSL linking exception; image build files GPL-3.0 |
| Gluetun, its own image `qmcgaw/gluetun:v3.41.3@sha256:fa19cc76b2af13d57a8d3dc3066f2ada061b1c761b8aecf989b3877c0486e027`, given config files and read over its control API only                                          | MIT                                                                                                                  |
| Node.js (the runtime of the worker and web images, and of the backend's base image)                                                                                                                                     | MIT                                                                                                                  |
| convex-release's entrypoint and health check (the backend's base image `ghcr.io/dev-marzahn/convex-release`, unchanged)                                                                                                 | MPL-2.0                                                                                                              |
| The worker's Debian trixie packages, by exact version in `/licenses/packages.txt`; source offer through `snapshot.debian.org`, copyright files kept in `/usr/share/doc`                                                 | per package (GPL-2.0-or-later, LGPL, BSD, MIT and others)                                                            |
| Jellyfin, its own image `jellyfin/jellyfin:12.4@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771`, unchanged, called over HTTP only, with jellyfin-ffmpeg inside it                              | GPL-2.0                                                                                                              |
| WireGuard test server, e2e only and never shipped: `linuxserver/wireguard:1.0.20260223-r0-ls129@sha256:236f9a9a89c701bc83f6d41007157dc77361114d14e56a08e846bb4499622e97` (`e2e/compose.wireguard.test.yml`)             | GPL-3.0                                                                                                              |

## Download-client fixtures

The NZBGet and qBittorrent adapters' tests run against fixtures recorded from the pinned images (`apps/worker/test/fixtures/nzbget/`, `apps/worker/test/fixtures/qbittorrent/`). A version bump of a client image is its own pull request, which:

- re-records the fixtures from the new version as the fixtures' `README.md` describes (a throwaway NZBGet with the NNTP fake as its only news server; a throwaway qBittorrent on an internal network with a local web seed, never a public tracker), with each case added the way the adapter adds it, and marks hand-written entries as derived or synthetic;
- checks the info hashes the new version reports for the recorded `.torrent` files (`release/torrent.ts`);
- changes the client's state table (`apps/worker/src/failures.ts`) together with its fixtures, never one without the other: a status the new version adds stays `unknownClientFailure` until a row maps it;
- bumps the tag and the digest together.

## Media fixtures

The worker's media tests run real ffmpeg, ffprobe, `lsar` and `unar` against committed fixtures in `apps/worker/test/fixtures/media/`. Its `README.md` has every file, how it was made and what the tools do with it.

- **Generated media** come from `scripts/make-media-fixtures.ts` (`bun run --cwd scripts make-media-fixtures`), which uses ffmpeg's test sources. Commit its outputs; CI never runs it.
- **RAR sets** were made once with RARLAB's `rar` in a throwaway container. `rar` is non-free and only makes the fixtures; nothing in the repository or an image runs it, and only the free `unar` reads the sets.
- **Dolby Vision and HDR10+ ffprobe JSON** is hand-written in ffprobe's shape with invented values, because ffmpeg can't make that metadata from a test source. Files named `handwritten-*` say so; replace them with recordings from real samples when one is at hand.
- **Missing tools** make those tests skip with a `NOTICE:` line. Set `OMNARR_REQUIRE_MEDIA_TOOLS=1`, as CI's worker-image job does, to make a missing tool fail them instead.
