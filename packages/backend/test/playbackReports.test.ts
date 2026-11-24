// Plays: the session poller's report, the item page's last plays, and their
// 90-day retention. Named playbackReports, after the table: playback.test.ts
// is for playback profiles.
import { type ActivePlay, type Capabilities, DEFAULT_LIMITS, STORAGE_AREAS } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { asAdmin, type Backend, setup, shippedProfile, worker } from './setup';

/** Every area free and writable: the session only has to be accepted. */
const capabilities: Capabilities = {
  ffmpegVersion: '7.1',
  encoders: ['libx264', 'aac'],
  storage: Object.fromEntries(STORAGE_AREAS.map((area) => [area, { freeBytes: 1e12, device: '1', writable: true }])) as Capabilities['storage'],
};

const OWNER = 'platform-admin-user';
/**
 * convex-test never lets a function's clock go behind the last commit, so
 * each test moves time forward only: the setup runs at START, the plays from NOW.
 */
const START = Date.UTC(2026, 10, 18, 20, 0);
const NOW = Date.UTC(2026, 10, 18, 21, 4);
const DAY = 86_400_000;

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let unitId: Id<'units'>;
let otherUnitId: Id<'units'>;

/** One episode published as Jellyfin item `item-e1`, and another Unit to compete for an item ref. */
async function seed() {
  return t.run(async (ctx) => {
    const playbackProfileId = await ctx.db.insert('playbackProfiles', { name: 'Default' });
    const releaseProfileId = await ctx.db.insert('releaseProfiles', shippedProfile());
    const libraryId = await ctx.db.insert('libraries', {
      kind: 'series',
      name: 'Series',
      rootPath: '/data/library/series',
      playbackProfileId,
      defaultReleaseProfileId: releaseProfileId,
    });
    const workId = await ctx.db.insert('works', {
      libraryId,
      kind: 'series',
      title: 'Harbour Lights',
      numberingScheme: 'standard',
      releaseProfileId,
      monitorNewUnits: true,
    });
    const unit = (episode: number) =>
      ctx.db.insert('units', { workId, kind: 'episode', tmdbSeason: 1, tmdbEpisode: episode, monitored: true, derivedState: 'ready' });
    const publish = async (unit: Id<'units'>, state: Doc<'publications'>['state'], targetItemRef: string) => {
      const fileId = await ctx.db.insert('files', { path: `/data/library/series/${unit}.mkv`, sizeBytes: 1, inode: unit, origin: 'download', role: 'source' });
      const fileVersionId = await ctx.db.insert('fileVersions', { unitId: unit, fileId, kind: 'primary', playbackProfileId, fits: true });
      await ctx.db.insert('publications', { unitId: unit, fileVersionId, generation: 0, target: 'jellyfin', state, targetItemRef });
    };
    const e1 = await unit(1);
    const e2 = await unit(2);
    await publish(e1, 'visible', 'item-e1');
    // A stale row for the same item (a re-publish elsewhere that failed): the visible one wins.
    await publish(e2, 'failed', 'item-e1');
    await ctx.db.insert('jellyfinServer', {
      state: 'ready',
      steps: [],
      locale: { uiCulture: 'en-US', metadataCountry: 'US', metadataLanguage: 'en' },
      adminUserId: 'jf-admin',
      apiKey: 'key',
      libraries: [],
      ownerUserId: OWNER,
    });
    return { e1, e2 };
  });
}

async function connect(workerId = 'w1'): Promise<Id<'workerSessions'>> {
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId, capabilities });
  if (!response.accepted) throw new Error('not accepted');
  vi.setSystemTime(NOW);
  return response.sessionId;
}

const report = (sessionId: Id<'workerSessions'>, plays: ActivePlay[]) => t.mutation(api.jellyfin.playback.report, { ...worker, sessionId, plays });
const rows = () => t.run((ctx) => ctx.db.query('playbackReports').collect());

const TABLET: ActivePlay = {
  deviceId: 'dev-tablet',
  deviceName: 'Spike Tablet',
  client: 'Jellyfin Android',
  itemRef: 'item-e1',
  method: 'directPlay',
  reasons: [],
  rawReasons: [],
};
const CHROME: ActivePlay = {
  deviceId: 'dev-chrome',
  deviceName: 'Chrome',
  client: 'Jellyfin Web',
  itemRef: 'item-e1',
  method: 'transcode',
  reasons: ['audioCodec'],
  rawReasons: ['AudioCodecNotSupported'],
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  t = setup();
  admin = await asAdmin(t, 365 * 86_400_000);
  ({ e1: unitId, e2: otherUnitId } = await seed());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('jellyfin.playback.report', () => {
  test('a new play inserts an open row with its Unit, the owner and the time it was first seen', async () => {
    const sessionId = await connect();
    await report(sessionId, [TABLET]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        owner: OWNER,
        deviceId: 'dev-tablet',
        deviceName: 'Spike Tablet',
        client: 'Jellyfin Android',
        itemRef: 'item-e1',
        unitId,
        method: 'directPlay',
        reasons: [],
        rawReasons: [],
        open: true,
        startedAt: NOW,
      }),
    ]);
    expect((await rows())[0]!.endedAt).toBeUndefined();
  });

  test('the Unit comes from the visible Publication when several have the item', async () => {
    await report(await connect(), [TABLET]);
    expect((await rows())[0]!.unitId).toBe(unitId);
    expect((await rows())[0]!.unitId).not.toBe(otherUnitId);
  });

  test('an unchanged set writes nothing', async () => {
    const sessionId = await connect();
    await report(sessionId, [TABLET, CHROME]);
    const before = await rows();
    vi.setSystemTime(NOW + 30_000);
    await report(sessionId, [CHROME, TABLET]);
    expect(await rows()).toEqual(before);
  });

  test('a changed method updates the row, keeping when it started', async () => {
    const sessionId = await connect();
    await report(sessionId, [CHROME]);
    const [before] = await rows();
    vi.setSystemTime(NOW + 30_000);
    await report(sessionId, [{ ...CHROME, method: 'remux', reasons: ['container'], rawReasons: ['ContainerNotSupported'] }]);
    expect(await rows()).toEqual([{ ...before, method: 'remux', reasons: ['container'], rawReasons: ['ContainerNotSupported'] }]);
  });

  test('a play missing from the set gets endedAt and open = false; the others stay open', async () => {
    const sessionId = await connect();
    await report(sessionId, [TABLET, CHROME]);
    vi.setSystemTime(NOW + 60_000);
    await report(sessionId, [CHROME]);
    const byDevice = Object.fromEntries((await rows()).map((row) => [row.deviceId, row]));
    expect(byDevice['dev-tablet']).toMatchObject({ open: false, endedAt: NOW + 60_000, startedAt: NOW });
    expect(byDevice['dev-chrome']).toMatchObject({ open: true });
    expect(byDevice['dev-chrome']!.endedAt).toBeUndefined();
  });

  test('the same device playing the item again after it ended is a new play', async () => {
    const sessionId = await connect();
    await report(sessionId, [TABLET]);
    await report(sessionId, []);
    vi.setSystemTime(NOW + 60_000);
    await report(sessionId, [TABLET]);
    expect((await rows()).map((row) => [row.open, row.startedAt])).toEqual([
      [false, NOW],
      [true, NOW + 60_000],
    ]);
  });

  test('a play of an item the platform did not publish has no unitId', async () => {
    await report(await connect(), [{ ...TABLET, itemRef: 'someone-elses-item' }]);
    const [row] = await rows();
    expect(row).toMatchObject({ itemRef: 'someone-elses-item', open: true });
    expect(row!.unitId).toBeUndefined();
  });

  test('two reports of the same play from two workers make one row', async () => {
    const first = await connect('w1');
    const second = await connect('w2');
    await report(first, [TABLET]);
    await report(second, [TABLET]);
    expect(await rows()).toHaveLength(1);
  });

  test('before Jellyfin is set up there is no owner, and a report writes nothing', async () => {
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('jellyfinServer').collect()) await ctx.db.delete(row._id);
    });
    await report(await connect(), [TABLET]);
    expect(await rows()).toEqual([]);
  });

  test('refuses an admin caller and a session the handshake did not accept', async () => {
    const sessionId = await connect();
    await expect(admin.mutation(api.jellyfin.playback.report, { sessionId, plays: [TABLET] } as never)).rejects.toThrow();
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'old', capabilities });
    const old = (await t.run((ctx) => ctx.db.query('workerSessions').collect())).find((s) => !s.accepted)!;
    await expect(report(old._id, [TABLET])).rejects.toThrow(/sessionNotAccepted/);
    expect(await rows()).toEqual([]);
  });
});

describe('units.plays', () => {
  const plays = () => admin.query(api.api.units.plays, { unitId });

  test("returns the Unit's last 10 plays, newest first, as PlayRows", async () => {
    const sessionId = await connect();
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(NOW + i * 60_000);
      await report(sessionId, [{ ...TABLET, deviceId: `dev-${i}`, deviceName: `Device ${i}` }]);
    }
    // Another item's play is not the Unit's.
    await report(sessionId, [
      { ...TABLET, deviceId: 'dev-11', deviceName: 'Device 11' },
      { ...CHROME, itemRef: 'someone-elses-item' },
    ]);
    const result = await plays();
    expect(result).toHaveLength(10);
    expect(result.map((row) => row.deviceName)).toEqual([
      'Device 11',
      'Device 10',
      'Device 9',
      'Device 8',
      'Device 7',
      'Device 6',
      'Device 5',
      'Device 4',
      'Device 3',
      'Device 2',
    ]);
    expect(result[0]).toEqual({ deviceName: 'Device 11', client: 'Jellyfin Android', method: 'directPlay', reasons: [], startedAt: NOW + 11 * 60_000 });
    expect(result[1]).toEqual({
      deviceName: 'Device 10',
      client: 'Jellyfin Android',
      method: 'directPlay',
      reasons: [],
      startedAt: NOW + 10 * 60_000,
      endedAt: NOW + 11 * 60_000,
    });
  });

  test('carries the reasons of a transcode', async () => {
    await report(await connect(), [CHROME]);
    expect(await plays()).toEqual([{ deviceName: 'Chrome', client: 'Jellyfin Web', method: 'transcode', reasons: ['audioCodec'], startedAt: NOW }]);
  });

  test('returns a legacy row as it was stored: the client-reported directStream, and other', async () => {
    await t.run((ctx) =>
      ctx.db.insert('playbackReports', {
        owner: OWNER,
        deviceId: 'dev-old',
        deviceName: 'Old Phone',
        client: 'Jellyfin Android',
        itemRef: 'item-e1',
        unitId,
        method: 'directStream',
        reasons: ['other'],
        rawReasons: ['DirectPlayError'],
        open: false,
        startedAt: START,
        endedAt: START + 60_000,
      }),
    );
    expect(await plays()).toEqual([
      { deviceName: 'Old Phone', client: 'Jellyfin Android', method: 'directStream', reasons: ['other'], startedAt: START, endedAt: START + 60_000 },
    ]);
  });

  test('refuses a worker caller: with its token, and with no admin session', async () => {
    await expect(t.query(api.api.units.plays, { ...worker, unitId } as never)).rejects.toThrow();
    await expect(t.query(api.api.units.plays, { unitId })).rejects.toThrow(/unauthorized/);
  });
});

test("the play report's functions are built from their wrappers", async () => {
  const playback = await import('../convex/jellyfin/playback');
  const units = await import('../convex/api/units');
  expect((playback.report as unknown as { __wrapped: string }).__wrapped).toBe('workerMutation');
  expect((units.plays as unknown as { __wrapped: string }).__wrapped).toBe('adminQuery');
});

describe('playbackReports retention', () => {
  const LATER = NOW + DEFAULT_LIMITS.playbackReportTtlMs + DAY;

  test('the daily run deletes rows that started more than 90 days ago and keeps the rest', async () => {
    const sessionId = await connect();
    await report(sessionId, [TABLET]);
    await report(sessionId, []);
    vi.setSystemTime(NOW + 2 * DAY);
    await report(sessionId, [CHROME]);

    vi.setSystemTime(LATER);
    await t.mutation(internal.pipeline.retention.cleanUpRuns, {});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect((await rows()).map((row) => row.deviceId)).toEqual(['dev-chrome']);
  });

  test('deletes in pages of 200, rescheduling while a page is full', async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++)
        await ctx.db.insert('playbackReports', {
          owner: OWNER,
          deviceId: `dev-${i}`,
          deviceName: 'Old',
          client: 'Jellyfin Web',
          itemRef: 'item-e1',
          unitId,
          method: 'directPlay',
          reasons: [],
          rawReasons: [],
          open: false,
          startedAt: NOW - i,
          endedAt: NOW,
        });
    });
    vi.setSystemTime(LATER);
    await t.mutation(internal.pipeline.retention.expirePlaybackReports, {});
    expect(await rows()).toHaveLength(250);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await rows()).toEqual([]);
  });
});
