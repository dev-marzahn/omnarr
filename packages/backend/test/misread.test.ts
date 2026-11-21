// "Might be this episode" (after "Possibly misread"): on the episode's
// Candidates tab, when its last search has no picked or acceptable release,
// that search's releases rejected as a wrong title or episode whose name
// contains one of the Work's aliases, so a release the parser misread is
// there to grab instead of a silent "no releases available".
import { MISREAD_ROW_CAP } from '@omnarr/contracts';
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { beforeEach, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { MISREAD_ROWS_READ, mightBeThisEpisode } from '../convex/library/misread';
import { pipelineHarness, release } from './harness';
import { countingReads } from './reads';
import { INDEXER_KEY, seedIndexer, useFetchFakes } from './setup';

const h = pipelineHarness();
let workId: Id<'works'>;
let e2: Doc<'units'>;

/** A part's name after the Work's title, with no IDs (as Nyaa's): the title matches no alias, but contains one. */
const PART = release('part', 'Harbour.Lights.Tide.Road.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPP', { ids: {} });
/** The part's number read as the episode: the title matched, the numbers named no Unit. */
const NUMBERED = release('numbered', 'Harbour.Lights.Part.7.Tide.Road.03.1080p.WEB-DL.AAC2.0.H.264-GRPN');
/** Another show: no alias in it. */
const OTHER = release('other', 'Quiet.Meadow.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPQ');
/** Read correctly, and the right episode. */
const S1E2 = release('s1e2', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB');

/** A fake that answers every request with all its items, as an indexer that ignores the query would. */
function anyQuery(items: FakeItem[], kind: 'newznab' | 'torznab') {
  const fake = createNewznabHandler({ apiKey: INDEXER_KEY, kind, items });
  return (request: Request) => {
    const url = new URL(request.url);
    for (const name of ['q', 'season', 'ep', 'tvdbid', 'tmdbid', 'imdbid']) url.searchParams.delete(name);
    return fake.handle(new Request(url));
  };
}

/** The indexers' fakes now answer with these items. */
const serve = (items: FakeItem[], torrents?: FakeItem[]) =>
  useFetchFakes({
    indexers: { 'indexer.fake': anyQuery(items, 'newznab'), ...(torrents ? { 'tracker.fake': anyQuery(torrents, 'torznab') } : {}) },
  });

/** A Newznab indexer with these items, and a Torznab one when `torrents` are given. */
async function indexer(items: FakeItem[], torrents?: FakeItem[]) {
  serve(items, torrents);
  await seedIndexer(h.t, { host: 'indexer.fake' });
  if (torrents) await seedIndexer(h.t, { host: 'tracker.fake', kind: 'torznab' });
}

beforeEach(async () => {
  useFetchFakes({});
  workId = await h.subscribe();
  e2 = await h.unit(workId, 1, 2);
});

const searchAndPick = async (unitId: Id<'units'> = e2._id) => {
  await h.admin.mutation(api.api.units.searchInteractive, { unitIds: [unitId] });
  await h.settle();
};
const mightBe = (unitId: Id<'units'> = e2._id) => h.admin.query(api.api.units.mightBeThisEpisode, { unitId });

test("the episode's last search lists its releases rejected as a wrong title or episode that contain an alias, with their indexer, what was read and why", async () => {
  await indexer([PART, NUMBERED, OTHER]);
  await searchAndPick();

  const rows = await mightBe();
  const stored = await h.all('candidates');
  expect(rows).toHaveLength(2);
  expect(rows).toContainEqual({
    candidateId: stored.find((row) => row.title === PART.title)!._id,
    title: PART.title,
    indexerName: 'indexer.fake',
    protocol: 'usenet',
    episodes: [{ season: 1, episode: 3 }],
    matchDetail: 'title',
  });
  expect(rows).toContainEqual(expect.objectContaining({ title: NUMBERED.title, episodes: [{ absolute: 7 }], matchDetail: 'episode' }));
});

test("a scene-mapping alias counts: a release that contains one is listed, though it doesn't contain the Work's TMDB title", async () => {
  await h.t.run((ctx) =>
    ctx.db.insert('workAliases', { workId, title: 'Minato no Akari', normalized: 'minato no akari', compact: 'minatonoakari', source: 'sceneMapping' }),
  );
  const SCENE = release('scene', '[Grp] Minato no Akari Part 2 - 03 (1080p) [ABCD1234]', { ids: {} });
  await indexer([SCENE, OTHER]);
  await searchAndPick();

  expect(await mightBe()).toEqual([expect.objectContaining({ title: SCENE.title })]);
});

test('nothing is listed when the last search has an acceptable release, and only the last search counts', async () => {
  await indexer([NUMBERED, PART, S1E2]);
  await searchAndPick();
  expect(await mightBe()).toEqual([]);

  serve([PART]);
  await searchAndPick();
  expect((await mightBe()).map((row) => row.title)).toEqual([PART.title]);
});

test("nothing is listed when the last search picked this episode's release", async () => {
  await indexer([PART, S1E2]);
  await h.admin.mutation(api.api.units.searchNow, { unitIds: [e2._id] });
  await h.settle();
  expect((await h.all('candidates')).find((row) => row.title === S1E2.title)).toMatchObject({ outcome: 'picked' });

  expect(await mightBe()).toEqual([]);
});

const INFO_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
/** A torrent of the part, linked by a .torrent URL with the key in it and by a magnet. */
const PART_TORRENT = release('part-torrent', 'Harbour.Lights.Tide.Road.S01E04.1080p.WEB-DL.AAC2.0.H.264-GRPT', {
  ids: {},
  torrent: { infoHash: INFO_HASH, seeders: 42, peers: 3, file: new Uint8Array([1, 2, 3]) },
});

test("a torrent's row has its seeders, and no row carries a download link, a magnet, an info hash or the indexer's key", async () => {
  await indexer([PART], [PART_TORRENT]);
  await searchAndPick();
  const stored = await h.all('candidates');
  // The stored rows hold the links: the check below would pass by default otherwise.
  expect(stored.find((row) => row.title === PART.title)!.downloadUrl).toContain(INDEXER_KEY);
  expect(stored.find((row) => row.title === PART_TORRENT.title)!.torrent?.magnetUrl).toContain(INFO_HASH);

  const rows = await mightBe();
  expect(rows).toContainEqual(expect.objectContaining({ title: PART_TORRENT.title, protocol: 'torrent', seeders: 42 }));
  expect(rows.find((row) => row.title === PART.title)).not.toHaveProperty('seeders');
  const body = JSON.stringify(rows);
  for (const secret of [INDEXER_KEY, 'apikey', 'magnet:', INFO_HASH, 'https://']) expect(body).not.toContain(secret);
});

test('torrents with the most seeders come first, then the newest releases', async () => {
  const torrent = (guid: string, seeders: number) =>
    release(guid, `Harbour.Lights.Tide.Road.S01E0${seeders % 10}.${guid}.1080p.WEB-DL-GRPT`, {
      ids: {},
      torrent: { infoHash: INFO_HASH.slice(0, -2) + String(seeders).padStart(2, '0'), seeders, peers: 0, file: new Uint8Array([1]) },
    });
  const usenet = (guid: string, publishedAt: string) => release(guid, `Harbour.Lights.Tide.Road.S01E05.${guid}.1080p.WEB-DL-GRPU`, { ids: {}, publishedAt });
  await indexer([usenet('older', '2026-11-01T10:00:00Z'), usenet('newer', '2026-11-12T10:00:00Z')], [torrent('few', 5), torrent('many', 42)]);
  await searchAndPick();

  expect((await mightBe()).map((row) => row.title.split('.')[5])).toEqual(['many', 'few', 'newer', 'older']);
});

/** `rows` more wrong-title rows of the episode's last search, named by `title`. */
async function moreRows(rows: number, title: (r: number) => string) {
  const attemptId = (await h.get(e2._id))!.lastSearchAttemptId;
  const candidate = (await h.all('candidates')).find((row) => row.searchAttemptId === attemptId && row.title === OTHER.title)!;
  const { _id, _creationTime, ...fields } = candidate;
  await h.t.run(async (ctx) => {
    for (let r = 0; r < rows; r++) await ctx.db.insert('candidates', { ...fields, guid: `more-${r}`, title: title(r) });
  });
}

test('the list holds at most MISREAD_ROW_CAP releases', async () => {
  await indexer([OTHER]);
  await searchAndPick();
  await moreRows(MISREAD_ROW_CAP + 10, (r) => `Harbour.Lights.Tide.Road.S01E${r}`);

  expect(await mightBe()).toHaveLength(MISREAD_ROW_CAP);
});

test('the list reads a bounded number of documents, however long the search or the Work’s search history', async () => {
  await indexer([OTHER]);
  await searchAndPick();
  const reads = () =>
    h.t.run(async (ctx) => {
      const { ctx: counted, counter } = countingReads(ctx);
      await mightBeThisEpisode(counted, e2._id);
      return counter.reads;
    });
  await moreRows(MISREAD_ROWS_READ + 1, (r) => `Quiet.Meadow.S01E${r}`);
  const small = await reads();
  await moreRows(2 * MISREAD_ROWS_READ, (r) => `Quiet.Meadow.S02E${r}`);
  // Older searches of the episode and the Work, with rows of their own.
  serve([OTHER, NUMBERED]);
  await searchAndPick((await h.unit(workId, 1, 3))._id);
  await searchAndPick((await h.unit(workId, 1, 4))._id);
  const large = await reads();

  expect(large).toBe(small);
  expect(small).toBeLessThanOrEqual(MISREAD_ROWS_READ + 20);
});

test('a listed release, grabbed for this episode, imports as this episode (a manual grab)', async () => {
  const e3 = await h.unit(workId, 1, 3);
  await indexer([NUMBERED]);
  await searchAndPick(e3._id);
  const [row] = await mightBe(e3._id);
  expect(row).toMatchObject({ title: NUMBERED.title, matchDetail: 'episode' });

  // The row's Grab: the existing manual grab of the search's row, confirming the rejection.
  const w = await h.worker();
  const result = await h.admin.mutation(api.api.units.grabCandidate, { candidateId: row!.candidateId, confirmReason: 'wrongTitleOrEpisode' });
  expect(result).toEqual({ outcome: 'grabbed', grabId: expect.any(String) });
  await h.settle();
  expect(await mightBe(e3._id)).toEqual([]);

  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  const [job] = await w.claim('import');
  expect(job!.payload).toMatchObject({ importAs: [e3._id] });
  await w.runImport(job!, { files: () => [{ relPath: `${NUMBERED.title}.mkv`, sizeBytes: 1_500_000_000 }] });
  await h.settle();

  expect((await h.all('fileVersions')).map((version) => version.unitId)).toEqual([e3._id]);
});

test('an old release whose numbers name another episode of the Work cleanly is not listed; one whose numbers name none is', async () => {
  /** Episode 3 of the whole series: S01E03, not the S01E02 searched for. */
  const OLD = release('old', '[Commie] Harbour Lights - 03 [1080p]', { ids: {} });
  /** Episode 47 of the whole series: no such episode. */
  const UNKNOWN = release('unknown', '[Commie] Harbour Lights - 47 [1080p]', { ids: {} });
  // Numbered across the whole series, as anime is.
  await h.t.run((ctx) => ctx.db.patch(workId, { numberingScheme: 'anime' }));
  await indexer([OLD, UNKNOWN]);
  await searchAndPick();
  const stored = await h.all('candidates');
  // The search read the old one's numbers as another episode's, and not the other's.
  expect(stored.find((row) => row.title === OLD.title)).toMatchObject({ reason: 'wrongTitleOrEpisode', matchDetail: 'otherEpisode' });

  expect((await mightBe()).map((row) => row.title)).toEqual([UNKNOWN.title]);
});
