// Playback on the real stack with Jellyfin 12.4: the
// product sets Jellyfin up, the pipeline publishes Harbour Lights S01E01, and
// a simulated client plays it. The session poller reports the play within
// one poll and the report (production polls every 30 s; E2E_LIMITS'
// playbackPollMs every 2 s, so 15 s here), with method directPlay and the
// Unit, and the play ends as soon after the client stops. Only the method is
// checked: a simulated client can't make Jellyfin produce transcode reasons
// (those are checked by hand).
import { randomBytes } from 'node:crypto';

import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import { ADMIN, down, NEWZNAB_KEY, rows, setUpJellyfinThroughProduct, up, waitFor, type Deployment } from './stack.ts';

// The backend's generated API isn't a dependency of this package, so calls go by name.
// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
let d: Deployment;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);

/** One play poll (E2E_LIMITS' playbackPollMs) and the report, with room for a busy CI runner. */
const PLAY_REPORTED_MS = 15_000;

type PlaybackReport = { _id: string; unitId?: string; itemRef: string; deviceName: string; method: string; reasons: string[]; open: boolean; endedAt?: number };
const reports = () => rows<PlaybackReport>(d.env, 'playbackReports');

/** A user's device, as Jellyfin's apps sign in: its own client, device and device ID. */
const DEVICE = 'MediaBrowser Client="omnarr-e2e-player", Device="E2E Tablet", DeviceId="omnarr-e2e-player", Version="1.0.0"';

async function jellyfin(path: string, authorization: string, body: object): Promise<Response> {
  return fetch(`${d.jellyfinUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  d = await up();
}, 600_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

test('a direct play of the published episode is recorded with its Unit, and ends when the client stops', async () => {
  await setUpJellyfinThroughProduct(d);

  // One episode through the pipeline, as in pipeline.e2e.ts.
  await action('api/indexers:create', { name: 'Newznab Main', url: 'http://newznab:4120/api', apiKey: NEWZNAB_KEY, priority: 10 });
  const { library } = await query('api/library:list', { kind: 'series' });
  const { workId } = await action('api/library:subscribe', {
    tmdbId: '900001',
    kind: 'series',
    libraryId: library.libraryId,
    releaseProfileId: library.defaultReleaseProfileId,
    seasons: [1],
  });
  // Ready: prepared and the MP4 published, so the item played is the one that stays.
  const e1: { unitId: string } = await waitFor(
    'S01E01 to be ready',
    async () =>
      (await query('api/library:detail', { workId })).units.find(
        (u: { tmdbSeason?: number; tmdbEpisode?: number; state: string }) => u.tmdbSeason === 1 && u.tmdbEpisode === 1 && u.state === 'ready',
      ),
    600_000,
    1_000,
  );
  const published = await waitFor(
    'S01E01 to be visible in Jellyfin',
    async () =>
      rows<{ unitId: string; state: string; targetItemRef?: string }>(d.env, 'publications').find((p) => p.unitId === e1.unitId && p.state === 'visible'),
    600_000,
    1_000,
  );
  const itemId = published.targetItemRef!;

  // The client signs in as the admin and reports a direct play of the episode's item.
  const signIn = await jellyfin('/Users/AuthenticateByName', DEVICE, { Username: ADMIN.username, Pw: ADMIN.password });
  expect(signIn.status).toBe(200);
  const { AccessToken } = (await signIn.json()) as { AccessToken: string };
  const device = `${DEVICE}, Token="${AccessToken}"`;
  const playSession = randomBytes(8).toString('hex');
  const playing = await jellyfin('/Sessions/Playing', device, {
    ItemId: itemId,
    MediaSourceId: itemId,
    PlayMethod: 'DirectPlay',
    PositionTicks: 0,
    CanSeek: true,
    IsPaused: false,
    PlaySessionId: playSession,
  });
  expect(playing.status).toBe(204);

  const open = await waitFor(
    'the play to be reported',
    async () => {
      const rowsOpen = reports().filter((row) => row.open);
      return rowsOpen.length === 1 ? rowsOpen[0] : undefined;
    },
    PLAY_REPORTED_MS,
    500,
  );
  expect(open).toMatchObject({ method: 'directPlay', reasons: [], unitId: e1.unitId, itemRef: itemId, deviceName: 'E2E Tablet' });
  expect(await query('api/units:plays', { unitId: e1.unitId })).toEqual([expect.objectContaining({ deviceName: 'E2E Tablet', method: 'directPlay' })]);

  // The client stops: the next poll no longer sees the play, and its row ends.
  const stopped = await jellyfin('/Sessions/Playing/Stopped', device, { ItemId: itemId, MediaSourceId: itemId, PositionTicks: 0, PlaySessionId: playSession });
  expect(stopped.status).toBe(204);
  const ended = await waitFor('the play to end', async () => reports().find((row) => row._id === open._id && row.endedAt !== undefined), PLAY_REPORTED_MS, 500);
  expect(ended.open).toBe(false);
  expect(reports()).toHaveLength(1);
}, 1_200_000);
