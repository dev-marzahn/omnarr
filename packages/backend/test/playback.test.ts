// Playback profiles: first run's defaults,
// one row per library, a saved draft and its cap override, a new device
// table, the read playback.get gives, the save dialog's previewChange, and the
// recomputeFits a changed target runs.
import { DEVICE_TABLE_VERSION, type DeviceId, type PlaybackDraft, type ProbeSummary, type TargetFormat } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { applyDraft, recomputeForTable } from '../convex/playback/profiles';
import { HEVC_PROBE, MKV_PROBE, SEASON_1, type SeedFile, seedFile, seedShow, seedUnit, WEBDL_PROBE } from './fakePrepare';
import { asAdmin, seedLibraries, setup, shippedProfile, worker, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
});

/** The brief's default: Chrome and the Jellyfin Android app. */
const DEFAULT_TARGET: TargetFormat = {
  containers: ['mp4'],
  video: { codecs: ['h264'], maxHeight: 1080, maxBitrateKbps: null, hdr: 'sdrOnly', maxBitDepth: { h264: 8, hevc: 8, av1: 8 } },
  audio: { codecs: ['aac', 'mp3', 'opus', 'flac'], maxChannels: 2 },
  subtitles: { mode: 'text', textFormats: ['srt', 'ass'] },
};

/** Jellyfin on Fire TV alone. */
const FIRE_TV_TARGET: TargetFormat = {
  containers: ['mp4', 'mkv'],
  video: { codecs: ['h264', 'hevc'], maxHeight: 2160, maxBitrateKbps: null, hdr: 'hdr10', maxBitDepth: { h264: 8, hevc: 10, av1: 8 } },
  audio: { codecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'], maxChannels: 6 },
  subtitles: { mode: 'text', textFormats: ['srt'] },
};

const DEVICES: DeviceId[] = ['chrome', 'jellyfinAndroid'];

const profiles = () => t.run((ctx) => ctx.db.query('playbackProfiles').collect());
const library = (id: Id<'libraries'>) => t.run(async (ctx) => (await ctx.db.get(id))!);
const profileOf = async (id: Id<'libraries'>) => t.run(async (ctx) => (await ctx.db.get((await ctx.db.get(id))!.playbackProfileId))!);

/** Before playback profiles: both libraries on one profile row that only has its name. */
async function sharedLibraries() {
  return await t.run(async (ctx) => {
    const releaseProfileId = await ctx.db.insert('releaseProfiles', shippedProfile());
    const shared = await ctx.db.insert('playbackProfiles', { name: 'Series' });
    const insert = (kind: 'series' | 'movies', name: string) =>
      ctx.db.insert('libraries', { kind, name, rootPath: `/data/library/${kind}`, playbackProfileId: shared, defaultReleaseProfileId: releaseProfileId });
    const series = await insert('series', 'Series');
    const movies = await insert('movies', 'Movies');
    // A movie and an episode imported before playback profiles, both on the shared row.
    const version = async (libraryId: Id<'libraries'>, kind: 'series' | 'movie', path: string) => {
      const workId = await ctx.db.insert('works', {
        libraryId,
        kind,
        title: path,
        numberingScheme: 'standard',
        releaseProfileId,
        monitorNewUnits: true,
      });
      const unitId = await ctx.db.insert('units', { workId, kind: kind === 'movie' ? 'movie' : 'episode', monitored: true, derivedState: 'ready' });
      const fileId = await ctx.db.insert('files', { path, sizeBytes: 1, inode: path, origin: 'download', role: 'source' });
      return await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId: shared, fits: true });
    };
    return {
      series,
      movies,
      shared,
      episodeVersion: await version(series, 'series', '/data/library/series/e.mkv'),
      movieVersion: await version(movies, 'movie', '/data/library/movies/m.mkv'),
    };
  });
}

describe('playback.setupDefaults', () => {
  test('splits a row both libraries share: one profile per library, with the target of the devices, and each file version on its own', async () => {
    const { series, movies, shared, episodeVersion, movieVersion } = await sharedLibraries();
    await admin.mutation(api.api.playback.setupDefaults, { devices: DEVICES });

    expect((await library(series)).playbackProfileId).toBe(shared);
    const moviesProfileId = (await library(movies)).playbackProfileId;
    expect(moviesProfileId).not.toBe(shared);
    const filled = { mode: 'devices', devices: DEVICES, target: DEFAULT_TARGET, deviceTableVersion: 1 };
    expect(await profileOf(series)).toMatchObject({ name: 'Series', ...filled });
    expect(await profileOf(movies)).toMatchObject({ name: 'Movies', ...filled });
    expect(await profiles()).toHaveLength(2);

    const versions = await t.run(async (ctx) => [await ctx.db.get(episodeVersion), await ctx.db.get(movieVersion)]);
    expect(versions.map((version) => version!.playbackProfileId)).toEqual([shared, moviesProfileId]);
  });

  test('a second run fills each library’s own row with the new devices', async () => {
    const libraries = await seedLibraries(t);
    const before = await Promise.all([profileOf(libraries.series), profileOf(libraries.movies)]);
    await admin.mutation(api.api.playback.setupDefaults, { devices: ['jellyfinFireTv'] });
    const after = await Promise.all([profileOf(libraries.series), profileOf(libraries.movies)]);
    expect(after.map((profile) => profile._id)).toEqual(before.map((profile) => profile._id));
    for (const profile of after) expect(profile).toMatchObject({ devices: ['jellyfinFireTv'], target: FIRE_TV_TARGET });
    expect(await profiles()).toHaveLength(2);
  });
});

describe('playback.update', () => {
  let libraries: Libraries;
  beforeEach(async () => {
    libraries = await seedLibraries(t);
  });
  const update = (draft: PlaybackDraft, libraryId = libraries.series) => admin.mutation(api.api.playback.update, { libraryId, draft });
  const devices = (extra: Partial<Extract<PlaybackDraft, { mode: 'devices' }>> = {}): PlaybackDraft => ({
    mode: 'devices',
    devices: DEVICES,
    keepOriginal: false,
    ...extra,
  });

  test('a cap override replaces the derived cap; null removes it; absent returns to the derived one', async () => {
    await update(devices({ maxHeightOverride: 720 }));
    expect(await profileOf(libraries.series)).toMatchObject({
      maxHeightOverride: 720,
      target: { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxHeight: 720 } },
    });

    await update(devices({ maxHeightOverride: null }));
    expect(await profileOf(libraries.series)).toMatchObject({
      maxHeightOverride: null,
      target: { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxHeight: null } },
    });

    await update(devices());
    const profile = await profileOf(libraries.series);
    expect(profile.maxHeightOverride).toBeUndefined();
    expect(profile.target).toEqual(DEFAULT_TARGET);
  });

  test('changes only the library’s own profile, and saves "Keep the original"', async () => {
    await update(devices({ devices: ['jellyfinFireTv'], keepOriginal: true }));
    expect(await profileOf(libraries.series)).toMatchObject({ devices: ['jellyfinFireTv'], target: FIRE_TV_TARGET, keepOriginal: true });
    expect(await profileOf(libraries.movies)).toMatchObject({ devices: DEVICES, target: DEFAULT_TARGET });
  });

  test('custom mode takes the draft’s target as it is', async () => {
    const target: TargetFormat = { ...FIRE_TV_TARGET, containers: ['mkv', 'mp4'], subtitles: { mode: 'keep', textFormats: ['srt'] } };
    await update({ mode: 'custom', target, keepOriginal: false });
    expect(await profileOf(libraries.series)).toMatchObject({ mode: 'custom', devices: DEVICES, target });
  });

  test('refuses "keep" subtitles unless mkv is the first container', async () => {
    const target: TargetFormat = { ...FIRE_TV_TARGET, subtitles: { mode: 'keep', textFormats: ['srt'] } };
    await expect(update({ mode: 'custom', target, keepOriginal: false })).rejects.toThrow(/mkv/);
    expect((await profileOf(libraries.series)).target).toEqual(DEFAULT_TARGET);
  });

  test('refuses devices mode without a device', async () => {
    await expect(update(devices({ devices: [] }))).rejects.toThrow();
    const profileId = (await library(libraries.series)).playbackProfileId;
    await expect(t.run((ctx) => applyDraft(ctx, profileId, { mode: 'devices', devices: [], keepOriginal: false }))).rejects.toThrow(/device/);
  });

  test('applyDraft says whether the target changed', async () => {
    const profileId = (await library(libraries.series)).playbackProfileId;
    const apply = (draft: PlaybackDraft) => t.run((ctx) => applyDraft(ctx, profileId, draft));
    expect(await apply(devices())).toEqual({ targetChanged: false });
    expect(await apply(devices({ keepOriginal: true }))).toEqual({ targetChanged: false });
    expect(await apply(devices({ maxHeightOverride: 720 }))).toEqual({ targetChanged: true });
    expect(await apply({ mode: 'custom', target: DEFAULT_TARGET, keepOriginal: true })).toEqual({ targetChanged: true });
  });
});

/** A target that takes Matroska and 10-bit HEVC as they are. */
const LOOSE_TARGET: TargetFormat = {
  ...DEFAULT_TARGET,
  containers: ['mp4', 'mkv'],
  video: { ...DEFAULT_TARGET.video, codecs: ['h264', 'hevc'], maxBitDepth: { h264: 8, hevc: 10, av1: 8 } },
};
const DEFAULT_DRAFT: PlaybackDraft = { mode: 'devices', devices: DEVICES, keepOriginal: false };
const LOOSE_DRAFT: PlaybackDraft = { mode: 'custom', target: LOOSE_TARGET, keepOriginal: false };

describe('a save that changes the target', () => {
  let libraries: Libraries;
  let unitId: Id<'units'>;
  beforeEach(async () => {
    vi.useFakeTimers();
    libraries = await seedLibraries(t);
    const workId = await seedShow(t, libraries);
    unitId = await seedUnit(t, workId, 2, 'Pilot');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const settle = () => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000));

  test('runs recomputeFits: the files that no longer fit are rewritten and prepared', async () => {
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: LOOSE_DRAFT });
    await settle();
    await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/E2.mkv`, fits: true });
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: DEFAULT_DRAFT });
    await settle();
    expect((await t.run((ctx) => ctx.db.query('fileVersions').collect())).map((version) => version.fits)).toEqual([false]);
    expect((await t.run((ctx) => ctx.db.query('renditions').collect())).map((rendition) => [rendition.reason, rendition.state])).toEqual([
      ['profileEdit', 'pending'],
    ]);
  });

  test('a save that leaves the target as it is recomputes nothing', async () => {
    await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/E2.mkv`, fits: true });
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: { ...DEFAULT_DRAFT, keepOriginal: true } });
    await settle();
    expect((await t.run((ctx) => ctx.db.query('fileVersions').collect())).map((version) => version.fits)).toEqual([true]);
    expect(await t.run((ctx) => ctx.db.query('renditions').collect())).toEqual([]);
  });
});

describe('playback.previewChange (the save dialog)', () => {
  let libraries: Libraries;
  let workId: Id<'works'>;
  beforeEach(async () => {
    libraries = await seedLibraries(t);
    workId = await seedShow(t, libraries);
  });
  let episode = 0;
  const file = async (probe: ProbeSummary, fits: boolean, extra: Partial<SeedFile> = {}) =>
    seedFile(t, { unitIds: [await seedUnit(t, workId, ++episode)], probe, path: `${SEASON_1}/${episode}`, fits, ...extra });
  const preview = (draft: PlaybackDraft) => admin.query(api.api.playback.previewChange, { libraryId: libraries.series, draft });

  test('counts the files that would stop fitting by their most expensive step, those it would prepare, the scanned ones left alone, and those that would fit', async () => {
    await file(MKV_PROBE, true);
    await file(MKV_PROBE, true, { origin: 'scan', keepsName: true, release: null });
    await file(HEVC_PROBE, true);
    await file(WEBDL_PROBE, false);
    // A multi-episode file counts once.
    const third = await seedUnit(t, workId, 99);
    await seedFile(t, { unitIds: [await seedUnit(t, workId, 98), third], probe: MKV_PROBE, path: `${SEASON_1}/double`, fits: true });

    expect(await preview(DEFAULT_DRAFT)).toEqual({
      noLongerFit: { remux: 3, audio: 0, subtitle: 0, video: 1 },
      willPrepare: 3,
      scannedOnDemand: 1,
      nowFit: 0,
      truncated: false,
    });
    // Nothing is written.
    expect((await t.run((ctx) => ctx.db.query('fileVersions').collect())).filter((version) => !version.fits)).toHaveLength(1);
  });

  test('counts the files that would start fitting', async () => {
    await file(MKV_PROBE, false);
    await file(HEVC_PROBE, false);
    await file(WEBDL_PROBE, false);
    expect(await preview(LOOSE_DRAFT)).toMatchObject({ noLongerFit: { remux: 0, audio: 0, subtitle: 0, video: 0 }, nowFit: 2, truncated: false });
  });

  test('reads at most 4,000 versions and says so ("4,000+")', async () => {
    await t.run(async (ctx) => {
      const unitId = await ctx.db.insert('units', { workId, kind: 'episode', monitored: true, derivedState: 'ready' });
      const playbackProfileId = (await ctx.db.get(libraries.series))!.playbackProfileId;
      for (let n = 0; n < 4_001; n++) {
        const fileId = await ctx.db.insert('files', {
          path: `/x/${n}.mkv`,
          sizeBytes: 1,
          inode: `1:${n}`,
          probe: MKV_PROBE,
          origin: 'download',
          role: 'source',
        });
        await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId, fits: true });
      }
    });
    const result = await preview(DEFAULT_DRAFT);
    expect(result.truncated).toBe(true);
    expect(result.noLongerFit.remux).toBe(4_000);
  });

  test('refuses a caller without an admin session, and a worker', async () => {
    await expect(t.query(api.api.playback.previewChange, { libraryId: libraries.series, draft: DEFAULT_DRAFT })).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.api.playback.previewChange, { ...worker, libraryId: libraries.series, draft: DEFAULT_DRAFT } as never)).rejects.toThrow();
  });
});

describe('recomputeForTable (a device-table seed)', () => {
  test('recomputes devices-mode profiles computed with an older table, and leaves custom and current ones', async () => {
    const libraries = await seedLibraries(t);
    const stale: TargetFormat = { ...DEFAULT_TARGET, audio: { codecs: ['aac'], maxChannels: 2 } };
    const ids = await t.run(async (ctx) => {
      const series = (await ctx.db.get(libraries.series))!.playbackProfileId;
      const movies = (await ctx.db.get(libraries.movies))!.playbackProfileId;
      await ctx.db.patch(series, { target: stale, deviceTableVersion: 0, maxHeightOverride: 720 });
      await ctx.db.patch(movies, { mode: 'custom', target: stale, deviceTableVersion: 0 });
      const current = await ctx.db.insert('playbackProfiles', {
        name: 'Current',
        mode: 'devices',
        devices: DEVICES,
        target: stale,
        deviceTableVersion: DEVICE_TABLE_VERSION,
      });
      return { series, movies, current };
    });
    await t.run((ctx) => recomputeForTable(ctx));
    const [series, movies, current] = await t.run((ctx) => Promise.all([ctx.db.get(ids.series), ctx.db.get(ids.movies), ctx.db.get(ids.current)]));
    expect(series).toMatchObject({ deviceTableVersion: 1, target: { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxHeight: 720 } } });
    expect(movies).toMatchObject({ deviceTableVersion: 0, target: stale });
    expect(current).toMatchObject({ target: stale });
  });
});

describe('playback.get', () => {
  test("a library's profile with the derived cap and the device table's cards", async () => {
    const libraries = await seedLibraries(t);
    const profileId = (await library(libraries.series)).playbackProfileId;
    await admin.mutation(api.api.playback.update, {
      libraryId: libraries.series,
      draft: { mode: 'devices', devices: DEVICES, maxHeightOverride: 720, keepOriginal: true },
    });
    const detail = await admin.query(api.api.playback.get, { libraryId: libraries.series });
    expect(detail).toEqual({
      libraryId: libraries.series,
      libraryKind: 'series',
      profileId,
      name: 'Series',
      mode: 'devices',
      devices: DEVICES,
      target: { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxHeight: 720 } },
      maxHeightOverride: 720,
      derivedMaxHeight: 1080,
      keepOriginal: true,
      deviceTableVersion: 1,
      devicesAvailable: [
        {
          deviceId: 'chrome',
          name: 'Chrome',
          subtitle: 'Jellyfin web',
          containers: ['mp4'],
          videoCodecs: ['h264 8-bit', 'av1 10-bit'],
          maxHeight: null,
          audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
          maxChannels: 2,
        },
        {
          deviceId: 'jellyfinAndroid',
          name: 'Jellyfin Android app',
          subtitle: 'Phones and tablets',
          containers: ['mp4'],
          videoCodecs: ['h264 8-bit'],
          maxHeight: 1080,
          audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
          maxChannels: 2,
        },
        {
          deviceId: 'jellyfinFireTv',
          name: 'Jellyfin on Fire TV',
          subtitle: 'Fire TV Stick 4K',
          containers: ['mp4', 'mkv'],
          videoCodecs: ['h264 8-bit', 'hevc 10-bit'],
          maxHeight: 2160,
          audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'],
          maxChannels: 6,
        },
      ],
    });
  });

  test('an unknown library is notFound', async () => {
    const libraries = await seedLibraries(t);
    await t.run((ctx) => ctx.db.delete(libraries.movies));
    await expect(admin.query(api.api.playback.get, { libraryId: libraries.movies })).rejects.toThrow(/notFound/);
  });
});

describe('the public functions', () => {
  test('each is built from an admin wrapper', async () => {
    const playback = await import('../convex/api/playback');
    expect((playback.get as unknown as { __wrapped: string }).__wrapped).toBe('adminQuery');
    expect((playback.previewChange as unknown as { __wrapped: string }).__wrapped).toBe('adminQuery');
    expect((playback.update as unknown as { __wrapped: string }).__wrapped).toBe('adminMutation');
    expect((playback.setupDefaults as unknown as { __wrapped: string }).__wrapped).toBe('adminMutation');
  });

  test('each refuses a caller without an admin session, and a worker', async () => {
    const { series } = await seedLibraries(t);
    const draft: PlaybackDraft = { mode: 'devices', devices: DEVICES, keepOriginal: false };
    await expect(t.query(api.api.playback.get, { libraryId: series })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.playback.update, { libraryId: series, draft })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.playback.setupDefaults, { devices: DEVICES })).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.api.playback.get, { ...worker, libraryId: series } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.playback.update, { ...worker, libraryId: series, draft } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.playback.setupDefaults, { ...worker, devices: DEVICES } as never)).rejects.toThrow();
  });
});
