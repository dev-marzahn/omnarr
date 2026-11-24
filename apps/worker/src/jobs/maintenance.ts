// `maintenance`: a removed download
// goes with its data, a provider login is tested through NZBGet; staging and
// library deletions stay inside their own folders, and the playback target
// is told about library deletions. Jellyfin's setup and password push go to
// its adapter. A retitled file is renamed in place, and the
// untracked-media scan reads the library roots (scan/walk.ts). The
// support bundle is built and uploaded by supportBundle.ts.
import { mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { type ClientKind, type JobResult, MaintenancePayload, SetupStep, type Sidecar } from '@omnarr/contracts';

import type { DownloadClient } from '../clients/downloadClient.ts';
import type { NzbgetClient } from '../clients/nzbget.ts';
import { type DataLayout, inside, toData, toLocal } from '../fs/layout.ts';
import { libraryTarget, moveSidecars, placeAt, placedAt } from '../fs/place.ts';
import { inodeOf } from '../fs/space.ts';
import type { JellyfinClient } from '../jellyfin/client.ts';
import type { ClientRuntimeStore } from '../runtime/clientRuntime.ts';
import { type JobHandler, JobFailure } from '../runtime/lease.ts';
import { type CheckFilesDeps, checkLibraryFiles } from '../scan/checkFiles.ts';
import { type ScanDeps, scanLibrary } from '../scan/walk.ts';
import { type SyncDeps, syncDefinitions } from '../sites/sync.ts';
import { type BundleDeps, buildSupportBundle } from '../supportBundle.ts';
import type { PlaybackTarget } from '../targets/playbackTarget.ts';

export type MaintenanceDeps = {
  layout: DataLayout;
  clients: Partial<Record<ClientKind, DownloadClient>>;
  /** The typed NZBGet adapter, for its provider test. */
  nzbget?: NzbgetClient;
  /** Its lock keeps a remove apart from a config apply. */
  runtime: ClientRuntimeStore;
  /** The Jellyfin adapter for setup and the password push; absent without `JELLYFIN_URL`. */
  jellyfin?: Pick<JellyfinClient, 'setup' | 'pushPassword'>;
  /** The playback target `deleteLibraryFiles` tells about deletions. */
  target?: Pick<PlaybackTarget, 'forget'>;
  /** Job IDs and codes only, never payloads. */
  log?: (message: string) => void;
  /** The support bundle's worker part. */
  bundle?: Omit<BundleDeps, 'backend'>;
  backend: ScanDeps['backend'] & CheckFilesDeps['backend'] & BundleDeps['backend'];
  /** The definitions sync: the backend's writes, OMNARR_DEFINITIONS_URL, the /definitions folder and the outside GET. */
  definitions?: Omit<SyncDeps, 'lease' | 'log' | 'signal'>;
} & Pick<ScanDeps, 'probe'>;

/** Deletes the paths under `folder`, except those under `keep`; others are left alone. Returns the ones removed, as given. */
async function removeUnder(layout: DataLayout, folder: string, paths: string[], keep?: string): Promise<string[]> {
  const removed: string[] = [];
  for (const path of paths) {
    const local = toLocal(layout, path);
    if (!inside(folder, local)) continue;
    if (keep !== undefined && (local === keep || inside(keep, local))) continue;
    await rm(local, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

/** The folders `pruneEmpty` never removes: the areas, the library roots and their originals/ twins. */
const pruneStops = (layout: DataLayout): Set<string> =>
  new Set([
    layout.root,
    layout.library,
    layout.series,
    layout.movies,
    layout.originals,
    join(layout.originals, 'series'),
    join(layout.originals, 'movies'),
    layout.staging,
    layout.held,
  ]);

/**
 * Removes the folders a deletion left empty, from each path's parent upwards,
 * under the library, originals/ and staging/held/, stopping at the first one
 * that still holds anything and never removing a root (`pruneStops`).
 * `rmdir` refuses a folder that isn't empty, so nothing else goes with it.
 */
async function pruneEmpty(layout: DataLayout, localPaths: string[]): Promise<void> {
  const stops = pruneStops(layout);
  const areas = [layout.library, layout.originals, layout.held];
  for (const path of localPaths)
    for (let folder = dirname(path); !stops.has(folder) && areas.some((area) => inside(area, folder)); folder = dirname(folder)) {
      const removed = await rmdir(folder).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      if (!removed) break;
    }
}

/** A Work's originals/ folder: strictly below `originals/series` or `originals/movies`, never one of them. */
function originalsWorkFolder(layout: DataLayout, path: string): string | undefined {
  const local = toLocal(layout, path);
  return [join(layout.originals, 'series'), join(layout.originals, 'movies')].some((root) => inside(root, local)) ? local : undefined;
}

/**
 * Deletes a Usenet download's folder only when it resolves, symlinks
 * followed, strictly inside downloads/usenet/ (NZBGet's folder guard).
 * Anything else is refused and left as it is: the library, the torrents'
 * folder and other trees are never touched from here.
 */
async function removeDownloadFolder(layout: DataLayout, contentPath: string): Promise<boolean> {
  const real = await realpath(toLocal(layout, contentPath)).catch(() => undefined);
  const root = await realpath(layout.usenetDownloads).catch(() => undefined);
  if (!real || !root || !inside(root, real)) return false;
  await rm(real, { recursive: true, force: true });
  return true;
}

async function taggedItemRef(client: DownloadClient, correlationTag: string | undefined, signal: AbortSignal): Promise<string | undefined> {
  if (correlationTag === undefined) throw new JobFailure('pipelineError', 'The removal names neither a client item nor a tag.');
  return (await client.findByTag(correlationTag, signal))?.clientRef;
}

type Rename = { from: string; to: string };

/**
 * `renameLibraryFile`: the sidecars first, then the file, each
 * within its folder in the library. A missing `from` with an existing `to`
 * is an earlier run's work. A different file at `to` is never overwritten.
 */
async function renameLibraryFile(layout: DataLayout, file: Rename, sidecars: Rename[]): Promise<void> {
  const local = (rename: Rename) => ({ from: toLocal(layout, rename.from), to: toLocal(layout, rename.to) });
  const all = [...sidecars.map(local), local(file)];
  for (const { from, to } of all)
    if (!inside(layout.library, from) || dirname(from) !== dirname(to))
      throw new JobFailure('pipelineError', 'A library rename must stay within one folder of the library.');
  const info = (path: string) => stat(path).catch(() => undefined);
  // Everything is checked before anything moves.
  const found = await Promise.all(all.map(async (rename) => ({ ...rename, fromInfo: await info(rename.from), toInfo: await info(rename.to) })));
  for (const { to, fromInfo, toInfo } of found)
    if (fromInfo && toInfo && inodeOf(fromInfo) !== inodeOf(toInfo))
      throw new JobFailure('pipelineError', `Another file is already at ${basename(to)}; nothing was renamed over it.`);
  const main = found.at(-1)!;
  if (!main.fromInfo && !main.toInfo) throw new JobFailure('pipelineError', `The library file ${basename(main.from)} is missing.`);
  // A sidecar missing at both names was removed by hand; the file is renamed without it.
  for (const { from, to, fromInfo } of found) if (fromInfo) await rename(from, to);
}

/**
 * `moveLibraryFile`: a scanned file goes to the library
 * path the import would give it, by a rename on the library's
 * one filesystem, so it keeps its inode, and its subtitle sidecars go beside
 * it under the platform's sidecar names. A re-run whose `from` is gone finds the file at
 * that path by its inode, and moves any sidecar still left. The folders the
 * move emptied go, up to the library root.
 */
async function moveLibraryFile(
  layout: DataLayout,
  payload: Extract<MaintenancePayload, { action: 'moveLibraryFile' }>,
): Promise<{ path: string; sidecars: Sidecar[] }> {
  const from = toLocal(layout, payload.from);
  const workFolder = toLocal(layout, payload.workFolderPath);
  const root = [layout.series, layout.movies].find((libraryRoot) => inside(libraryRoot, from));
  if (!root || !inside(root, workFolder)) throw new JobFailure('pipelineError', 'A move to library naming must stay within one library root.');
  const target = await libraryTarget(workFolder, payload.naming, payload.units, payload.probe, extname(from).toLowerCase());
  const source = await stat(from).catch(() => undefined);
  let placed: string | undefined;
  if (source) {
    await mkdir(dirname(target), { recursive: true });
    placed = await placeAt(from, target, false);
  } else placed = await placedAt(target, payload.inode);
  if (!placed) throw new JobFailure('pipelineError', `The library file ${basename(from)} is missing.`);
  const sidecars = await moveSidecars(from, placed);
  for (let folder = dirname(from); inside(root, folder); folder = dirname(folder)) {
    if ((await readdir(folder).catch(() => ['?'])).length > 0) break;
    await rmdir(folder).catch(() => {});
  }
  return { path: placed, sidecars };
}

function requireJellyfin(deps: MaintenanceDeps): NonNullable<MaintenanceDeps['jellyfin']> {
  if (!deps.jellyfin) throw new JobFailure('pipelineError', 'This worker has no JELLYFIN_URL, so it has no Jellyfin to set up.');
  return deps.jellyfin;
}

export function maintenanceHandler(deps: MaintenanceDeps): JobHandler {
  return async (job, { signal, progress }): Promise<JobResult> => {
    const payload = MaintenancePayload.parse(job.payload);
    switch (payload.action) {
      case 'removeDownload': {
        const client = deps.clients[payload.clientKind];
        if (!client) throw new JobFailure('clientUnreachable', `No ${payload.clientKind} client is configured.`);
        const clientRef = payload.clientRef ?? (await taggedItemRef(client, payload.correlationTag, signal));
        if (clientRef === undefined) return { class: 'maintenance', action: 'removeDownload', removed: false };
        const result = await deps.runtime.withClientLock(payload.clientKind, () =>
          client.remove(clientRef, payload.correlationTag, payload.deleteData, signal),
        );
        // NZBGet keeps a finished download's files; qBittorrent deletes a torrent's own.
        if (payload.deleteData && payload.contentPath && payload.clientKind === 'nzbget') await removeDownloadFolder(deps.layout, payload.contentPath);
        return { class: 'maintenance', action: 'removeDownload', ...result };
      }
      case 'testUsenetServer': {
        if (!deps.nzbget) throw new JobFailure('clientUnreachable', 'No NZBGet client is configured.');
        const { host, port, ssl, username, password } = payload;
        return { class: 'maintenance', action: 'testUsenetServer', outcome: await deps.nzbget.testServer({ host, port, ssl, username, password }, signal) };
      }
      case 'cleanStaging':
        // staging/held/ holds upgrade files that wait for their prepare job.
        return {
          class: 'maintenance',
          action: 'cleanStaging',
          removedPaths: await removeUnder(deps.layout, deps.layout.staging, payload.paths, deps.layout.held),
        };
      case 'deleteLibraryFiles': {
        // The library, and an upgrade's leftovers: the old release's kept original and a held file whose preparation ended.
        const removedPaths = [];
        for (const folder of [deps.layout.library, deps.layout.originals, deps.layout.held])
          removedPaths.push(...(await removeUnder(deps.layout, folder, payload.paths)));
        removedPaths.sort((a, b) => payload.paths.indexOf(a) - payload.paths.indexOf(b));
        // A deleted Work's kept originals go with their folder, then every folder the deletion emptied.
        // The folder goes whole on purpose: everything under a Work's originals/ folder is that Work's, and no
        // `files` row lists it all (an upgrade's leftovers, sidecars the import never tracked).
        const originals = payload.originalsFolder === undefined ? undefined : originalsWorkFolder(deps.layout, payload.originalsFolder);
        if (originals) await rm(originals, { recursive: true, force: true });
        await pruneEmpty(deps.layout, [...removedPaths.map((path) => toLocal(deps.layout, path)), ...(originals ? [originals] : [])]);
        // A failed forget doesn't fail the deletion: Jellyfin's scheduled scan drops the item later.
        await deps.target
          ?.forget(payload.libraryId, payload.folders, signal)
          .catch((error: unknown) => deps.log?.(`forget after deleteLibraryFiles failed: ${error instanceof JobFailure ? error.code : 'error'}`));
        return { class: 'maintenance', action: 'deleteLibraryFiles', removedPaths };
      }
      case 'setupJellyfin': {
        const jellyfin = requireJellyfin(deps);
        const steps = SetupStep.options.length;
        return await jellyfin.setup(payload, (step, state) => progress((SetupStep.options.indexOf(step) + 1) / steps, `${step}:${state}`), signal);
      }
      case 'renameLibraryFile':
        await renameLibraryFile(deps.layout, payload, payload.sidecars);
        return { class: 'maintenance', action: 'renameLibraryFile', path: payload.to };
      case 'moveLibraryFile': {
        const { path, sidecars } = await moveLibraryFile(deps.layout, payload);
        return {
          class: 'maintenance',
          action: 'moveLibraryFile',
          path: toData(deps.layout, path),
          sidecars: sidecars.map((sidecar) => ({ ...sidecar, path: toData(deps.layout, sidecar.path) })),
        };
      }
      case 'scanLibrary':
        return { class: 'maintenance', action: 'scanLibrary', ...(await scanLibrary(job, payload, deps, { signal, progress })) };
      case 'checkLibraryFiles':
        return { class: 'maintenance', action: 'checkLibraryFiles', ...(await checkLibraryFiles(job, payload, deps, { signal })) };
      case 'pushJellyfinPassword':
        await requireJellyfin(deps).pushPassword(payload.username, payload.newPassword, signal);
        return { class: 'maintenance', action: 'pushJellyfinPassword', pushed: true };
      case 'buildSupportBundle':
        if (!deps.bundle) throw new JobFailure('pipelineError', 'This worker builds no support bundle.');
        return { class: 'maintenance', action: 'buildSupportBundle', storageId: await buildSupportBundle({ ...deps.bundle, backend: deps.backend }, job) };
      case 'syncDefinitions': {
        if (!deps.definitions) throw new JobFailure('pipelineError', 'This worker syncs no definitions.');
        const outcome = await syncDefinitions({
          ...deps.definitions,
          lease: { jobId: job.jobId, leaseEpoch: job.leaseEpoch },
          log: deps.log ?? (() => {}),
          signal,
        });
        return { class: 'maintenance', action: 'syncDefinitions', ...outcome };
      }
    }
  };
}
