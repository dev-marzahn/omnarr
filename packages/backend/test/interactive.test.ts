// Interactive search and manual grab: "Search and pick" offers the results
// instead of picking, `grabCandidate` grabs any row, rejected and unclear
// ones too, and a release whose numbering didn't decide it imports as the
// Unit the user chose.
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { addToBlocklist } from '../convex/pipeline/blocklist';
import type { FakeWorker } from './fakeWorker';
import { pipelineHarness, release } from './harness';
import { INDEXER_KEY, seedIndexer, useFetchFakes } from './setup';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;
let e2: Doc<'units'>;
let e3: Doc<'units'>;

const S1E2 = release('s1e2', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB');
const GERMAN = release('s1e2-de', 'Harbour.Lights.S01E02.German.1080p.WEB-DL.AAC2.0.H.264-GRPG');
/** Named by its air date, which S01E02 and S01E03 share here: the resolver can't tell which (rule 1). */
const BY_DATE = release('by-date', 'Harbour.Lights.2021.03.11.1080p.WEB-DL.AAC2.0.H.264-GRPH');

/** An indexer that answers every request with all its items, as one that ignores the numbers would. */
async function indexer(items: FakeItem[]) {
  const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items });
  const anyQuery = (request: Request) => {
    const url = new URL(request.url);
    for (const name of ['q', 'season', 'ep']) url.searchParams.delete(name);
    return fake.handle(new Request(url));
  };
  useFetchFakes({ indexers: { 'indexer.fake': anyQuery } });
  return seedIndexer(h.t, { host: 'indexer.fake' });
}

beforeEach(async () => {
  // Subscribed with no indexer: the subscribe search fails and every Unit is wanted.
  useFetchFakes({});
  workId = await h.subscribe();
  e2 = await h.unit(workId, 1, 2);
  e3 = await h.unit(workId, 1, 3);
  await h.t.run((ctx) => ctx.db.patch(e3._id, { airDateUtc: e2.airDateUtc }));
  await indexer([S1E2, GERMAN, BY_DATE]);
  w = await h.worker();
});

const searchAndPick = async (unitId: Id<'units'> = e2._id) => {
  const { searchAttemptId } = await h.admin.mutation(api.api.units.searchInteractive, { unitIds: [unitId] });
  await h.settle();
  return searchAttemptId;
};
const timeline = async (unitId: Id<'units'> = e2._id) => (await h.admin.query(api.api.units.timeline, { unitId }))!;
const row = async (guid: string) => (await timeline()).lastSearch!.candidates.find((candidate) => candidate.title.includes(guid))!;
const candidateOf = async (title: string) => (await h.all('candidates')).find((candidate) => candidate.title === title)!;
/** Grabs a row, and lets the run reach its first job. */
const grab = async (candidateId: Id<'candidates'>, confirmReason?: Doc<'candidates'>['reason']) => {
  const result = await h.admin.mutation(api.api.units.grabCandidate, { candidateId, ...(confirmReason ? { confirmReason } : {}) });
  await h.settle();
  return result;
};

describe('Search and pick offers the results instead of grabbing', () => {
  test('the attempt ends offered: every row is ranked or rejected, nothing is grabbed, and the Unit stays wanted', async () => {
    const attemptId = await searchAndPick();

    expect(await h.get(attemptId)).toMatchObject({ trigger: 'interactive', state: 'offered', unitIds: [e2._id] });
    expect(await h.all('grabs')).toEqual([]);
    expect((await h.get(e2._id))!.derivedState).toBe('wanted');
    const search = (await timeline()).lastSearch!;
    expect(search).toMatchObject({ trigger: 'interactive', state: 'offered', offeredUntil: search.at + 3_600_000 });
    expect(await row(S1E2.title)).toMatchObject({ outcome: 'pending', rank: 1, coversUnit: true, covers: [{ unitId: e2._id, tmdbSeason: 1, tmdbEpisode: 2 }] });
    expect(await row(GERMAN.title)).toMatchObject({ outcome: 'rejected', reason: 'language' });
  });

  test('a release of unclear numbering keeps the Units it could be, counts for this one, and would be grabbed for it', async () => {
    await searchAndPick();
    expect(await row(BY_DATE.title)).toMatchObject({
      outcome: 'rejected',
      reason: 'wrongTitleOrEpisode',
      matchDetail: 'episode',
      matchProblem: 'ambiguous',
      coversUnit: true,
      possibleUnits: [
        { unitId: e2._id, tmdbSeason: 1, tmdbEpisode: 2 },
        { unitId: e3._id, tmdbSeason: 1, tmdbEpisode: 3 },
      ],
      covers: [{ unitId: e2._id, tmdbSeason: 1, tmdbEpisode: 2 }],
    });
    const { units } = (await h.admin.query(api.api.library.detail, { workId }))!;
    expect(units.find((unit) => unit.unitId === e2._id)!.lastSearch).toMatchObject({ outcome: 'offered', unclearCount: 1 });
    expect(units.find((unit) => unit.unitId === e3._id)!.lastSearch?.unclearCount ?? 0).toBe(0);
  });

  test("an automatic search's unclear release counts too, so the Work row offers Search and pick", async () => {
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [e3._id] });
    await h.settle();
    const { units } = (await h.admin.query(api.api.library.detail, { workId }))!;
    expect(units.find((unit) => unit.unitId === e3._id)!.lastSearch).toMatchObject({ unclearCount: 1 });
  });
});

describe('grabCandidate', () => {
  test('grabbing the row ranked first starts a Grab picked by the user, and the attempt is picked', async () => {
    const attemptId = await searchAndPick();
    const candidate = await candidateOf(S1E2.title);
    const result = await grab(candidate._id);
    expect(result).toEqual({ outcome: 'grabbed', grabId: expect.any(String) });

    expect(await h.get(candidate._id)).toMatchObject({ outcome: 'picked', pickedBy: 'user' });
    expect((await h.get(attemptId))!.state).toBe('picked');
    const run = (await timeline()).runs[0]!;
    expect(run).toMatchObject({ grabId: (result as { grabId: Id<'grabs'> }).grabId, pickedBy: 'user', search: { trigger: 'interactive' } });
    // The other rows keep their outcome.
    expect((await candidateOf(GERMAN.title)).outcome).toBe('rejected');
  });

  test('a rejected row is grabbed with its reason, which the pick step records; it imports normally', async () => {
    await searchAndPick();
    const german = await candidateOf(GERMAN.title);
    await grab(german._id, 'language');
    const run = (await timeline()).runs[0]!;
    expect(run.stages).toContainEqual(expect.objectContaining({ kind: 'decision', confirmReason: 'language' }));

    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');
    expect(job!.payload).not.toHaveProperty('importAs');
    await w.runImport(job!);
    await h.settle();
    expect((await h.all('fileVersions')).map((version) => version.unitId)).toEqual([e2._id]);
  });

  test('a release of unclear numbering is imported as the Unit the user chose, whatever its name says', async () => {
    await searchAndPick();
    const byDate = await candidateOf(BY_DATE.title);
    const { grabId } = (await grab(byDate._id, 'wrongTitleOrEpisode')) as { grabId: Id<'grabs'> };
    expect(await h.get(grabId)).toMatchObject({ importAs: [e2._id] });
    expect((await h.all('grabUnits')).map((row) => row.unitId)).toEqual([e2._id]);

    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');
    expect(job!.payload).toMatchObject({ importAs: [e2._id], expectedUnits: [expect.objectContaining({ unitId: e2._id })] });
    await w.runImport(job!, { files: () => [{ relPath: 'Harbour.Lights.2021.03.11.1080p.WEB-DL.AAC2.0.H.264-GRPH.mkv', sizeBytes: 1_500_000_000 }] });
    await h.settle();

    expect((await h.all('fileVersions')).map((version) => version.unitId)).toEqual([e2._id]);
    const run = (await timeline()).runs[0]!;
    expect(run.stages.map((stage) => stage.message)).toContain('Imported as S01E02, as you chose.');
  });

  test('a blocklisted row is taken off the blocklist first', async () => {
    await h.t.run((ctx) =>
      addToBlocklist(ctx, {
        workId,
        item: { guid: `https://indexer.fake/details/${S1E2.guid}`, title: S1E2.title, protocol: 'usenet' },
        reason: 'missingArticles',
      }),
    );
    await searchAndPick();
    const candidate = await candidateOf(S1E2.title);
    expect(candidate.reason).toBe('blocklisted');
    expect((await row(S1E2.title)).blocklisted).toMatchObject({ reason: 'missingArticles', at: expect.any(Number) });

    await grab(candidate._id, 'blocklisted');
    expect(await h.all('blocklist')).toEqual([]);
    expect((await h.all('grabs'))[0]!.state).toBe('submitting');
  });

  test('results older than an hour are refused, so the user searches again', async () => {
    await searchAndPick();
    vi.advanceTimersByTime(61 * 60_000);
    expect(await grab((await candidateOf(S1E2.title))._id)).toEqual({ outcome: 'expired' });
    expect(await h.all('grabs')).toEqual([]);
  });

  test('a Unit that already has a running Grab is refused, naming that Grab', async () => {
    await searchAndPick();
    const { grabId } = (await grab((await candidateOf(S1E2.title))._id)) as { grabId: Id<'grabs'> };
    await searchAndPick();
    const [, german] = (await h.all('candidates')).filter((candidate) => candidate.title === GERMAN.title);
    expect(await grab(german!._id, 'language')).toEqual({ outcome: 'busy', grabId });
  });

  test("an automatic search's rows can't be grabbed", async () => {
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [e2._id] });
    await h.settle();
    const [auto] = (await h.all('candidates')).filter((candidate) => candidate.title === GERMAN.title);
    await expect(grab(auto!._id, 'language')).rejects.toThrow(/not open for picking/);
  });

  test('a season pack of unclear numbering is refused: a pack needs a clear season', async () => {
    await searchAndPick();
    const byDate = await candidateOf(BY_DATE.title);
    await h.t.run((ctx) => ctx.db.patch(byDate._id, { parsed: { ...byDate.parsed, pack: { seasons: [1], full: true } } }));
    expect(await grab(byDate._id, 'wrongTitleOrEpisode')).toEqual({ outcome: 'packNeedsSeason' });
  });
});

describe('a release the user picked that fails', () => {
  test('is blocklisted with no next-best search and no Issue, and does not count toward the limit of 3', async () => {
    await searchAndPick();
    await grab((await candidateOf(S1E2.title))._id);
    await w.submitAll();
    await h.settle();
    await w.failed(await h.activeDownload(), 'missingArticles');
    await h.settle();

    expect(await h.all('blocklist')).toEqual([expect.objectContaining({ reason: 'missingArticles', title: S1E2.title })]);
    expect((await h.all('searchAttempts')).filter((attempt) => attempt.trigger === 'nextBest')).toEqual([]);
    expect(await h.all('issues')).toEqual([]);
    expect((await h.get(e2._id))!.derivedState).toBe('wanted');
    expect((await timeline()).runs[0]).toMatchObject({ state: 'failed', pickedBy: 'user', failureCode: 'missingArticles' });
  });
});

describe('a release of a title omnarr did not recognise, grabbed for the episode the user chose ("Possibly misread")', () => {
  /** The JoJo fixture with a third Steel Ball Run episode, S06E03. */
  const jojo = () => {
    const series = jojoParts();
    const part = series.seasons.find((season) => season.season_number === 6)!;
    const last = part.episodes.at(-1)!;
    part.episodes.push({ ...last, id: last.id + 1, episode_number: 3, name: 'Episode 3', air_date: '2026-03-21' });
    return series;
  };
  /** The part's number between the series' name and the part's: no alias matches, so it is a wrong title. */
  const SBR03 = release('sbr03', '[SubsPlease] JoJo no Kimyou na Bouken Part 7 - Steel Ball Run - 03 (1080p) [ABCD1234]', { ids: {} });
  let s6e3: Doc<'units'>;
  /** The Search and pick's row: the subscribe search found the release too. */
  const offered = async () => (await h.all('candidates')).filter((candidate) => candidate.title === SBR03.title).at(-1)!;

  // No XEM: its scene numbering restarts at 1 in each part, which would make `- 03` ambiguous rather than another Unit's.
  beforeEach(async () => {
    const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: [SBR03] });
    useFetchFakes({
      series: [...SERIES, jojo()],
      indexers: {
        'indexer.fake': (request: Request) => {
          const url = new URL(request.url);
          for (const name of ['q', 'season', 'ep', 'tvdbid', 'tmdbid', 'imdbid']) url.searchParams.delete(name);
          return fake.handle(new Request(url));
        },
      },
    });
    const { workId: jojoId } = await h.admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: h.libraries.series,
      releaseProfileId: h.libraries.releaseProfileId,
      seasons: [6],
      numberingScheme: 'anime',
    });
    await h.settle();
    s6e3 = await h.unit(jojoId, 6, 3);
  });

  test("it imports as S06E03, though its file's name reads as another Unit's absolute number", async () => {
    await searchAndPick(s6e3._id);
    const row = await offered();
    expect(row).toMatchObject({ reason: 'wrongTitleOrEpisode', matchDetail: 'title' });
    const { grabId } = (await grab(row._id, 'wrongTitleOrEpisode')) as { grabId: Id<'grabs'> };
    expect(await h.get(grabId)).toMatchObject({ importAs: [s6e3._id] });

    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');
    const files = [{ relPath: `${SBR03.title}.mkv`, sizeBytes: 1_500_000_000 }];
    // Read without an alias, the name's `- 03` is the whole series' third episode: S01E03, not the chosen one.
    const [s1e3] = (await h.all('units')).filter((unit) => unit.workId === s6e3.workId && unit.tmdbSeason === 1 && unit.tmdbEpisode === 3);
    expect(await w.resolveFiles(job!, files)).toEqual([{ relPath: files[0]!.relPath, unitIds: [s1e3!._id] }]);
    expect(job!.payload).toMatchObject({ importAs: [s6e3._id] });
    await w.runImport(job!, { files: () => files });
    await h.settle();

    expect((await h.all('fileVersions')).map((version) => version.unitId)).toEqual([s6e3._id]);
    expect((await timeline(s6e3._id)).runs[0]!.stages.map((stage) => stage.message)).toContain('Imported as S06E03, as you chose.');
  });

  test('a pack of a title omnarr did not recognise is refused: a pack needs a clear season', async () => {
    await searchAndPick(s6e3._id);
    const row = await offered();
    await h.t.run((ctx) => ctx.db.patch(row._id, { parsed: { ...row.parsed, episodes: [], pack: { seasons: [], full: true } } }));
    expect(await grab(row._id, 'wrongTitleOrEpisode')).toEqual({ outcome: 'packNeedsSeason' });
    expect(await h.all('grabs')).toEqual([]);
  });
});
