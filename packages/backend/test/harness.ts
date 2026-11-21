// The scaffolding of the pipeline tests (pipeline, cancel, pause, failures,
// derivedState, timeline): Harbour Lights subscribed against the Newznab
// fake, a fake worker, and reads of the rows the run writes.
import { createNewznabHandler, type FakeItem, type NewznabHandler } from '@omnarr/e2e/fakes/newznab';
import { afterEach, beforeEach, vi } from 'vite-plus/test';

import { api, components } from '../convex/_generated/api';
import type { Doc, Id, TableNames } from '../convex/_generated/dataModel';
import { fakeWorker, type FakeWorker } from './fakeWorker';
import { asAdmin, INDEXER_KEY, seedIndexer, seedLibraries, settleSearches, setup, useFetchFakes, type Backend, type Libraries } from './setup';

export const release = (guid: string, title: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  guid,
  title,
  categories: [5000, 5040],
  sizeBytes: 1_500_000_000,
  publishedAt: '2026-11-10T18:30:00Z',
  ids: { tvdbid: '7700001' },
  ...extra,
});

/** Fits the default target (H.264, AAC 2.0) apart from its container. */
export const E1 = release('s1e1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB');

/** E1 in four releases, best first: each one the next-best search falls back to. */
export const E1_RELEASES = [
  E1,
  release('s1e1-bluray', 'Harbour.Lights.S01E01.1080p.BluRay.AAC2.0.H.264-GRPC'),
  release('s1e1-webrip', 'Harbour.Lights.S01E01.1080p.WEBRip.AAC2.0.H.264-GRPD'),
  release('s1e1-720p', 'Harbour.Lights.S01E01.720p.WEB-DL.AAC2.0.H.264-GRPE'),
];

export type Harness = ReturnType<typeof pipelineHarness>;

/** Registers beforeEach/afterEach; the fields are set for each test. */
export function pipelineHarness() {
  const h = {
    t: undefined as unknown as Backend,
    admin: undefined as unknown as Awaited<ReturnType<typeof asAdmin>>,
    libraries: undefined as unknown as Libraries,
    fake: undefined as unknown as NewznabHandler,

    /** The Newznab fake with these items, behind `fetch` with TMDB. */
    indexer(items: FakeItem[], host = 'indexer.fake') {
      h.fake = createNewznabHandler({ apiKey: INDEXER_KEY, items });
      useFetchFakes({ indexers: { [host]: h.fake.handle } });
      return seedIndexer(h.t, { host });
    },

    /** The fake in Torznab mode: each item needs its `torrent`. */
    tracker(items: FakeItem[], host = 'tracker.fake') {
      h.fake = createNewznabHandler({ apiKey: INDEXER_KEY, kind: 'torznab', items });
      useFetchFakes({ indexers: { [host]: h.fake.handle } });
      return seedIndexer(h.t, { host, kind: 'torznab' });
    },

    /** Subscribes to Harbour Lights and lets its searches end. */
    async subscribe(seasons = [1]): Promise<Id<'works'>> {
      const { workId } = await h.admin.action(api.api.library.subscribe, {
        tmdbId: '900001',
        kind: 'series',
        libraryId: h.libraries.series,
        releaseProfileId: h.libraries.releaseProfileId,
        seasons,
      });
      await settleSearches(h.t);
      return workId;
    },

    worker: (workerId?: string): Promise<FakeWorker> => fakeWorker(h.t, workerId),

    /** Runs the scheduled work (the workflow's steps and the searches) to its end. */
    settle: () => settleSearches(h.t),

    all: <T extends TableNames>(table: T) => h.t.run((ctx) => ctx.db.query(table as 'grabs').collect()) as unknown as Promise<Doc<T>[]>,

    get: <T extends TableNames>(id: Id<T>) => h.t.run((ctx) => ctx.db.get(id as Id<'grabs'>)) as unknown as Promise<Doc<T> | null>,

    async unit(workId: Id<'works'>, season: number, episode: number): Promise<Doc<'units'>> {
      return (await h.t.run((ctx) =>
        ctx.db
          .query('units')
          .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
          .first(),
      ))!;
    },

    activeDownload: async () => (await h.all('downloads')).find((d) => d.state === 'active')!._id,

    /**
     * Makes the run's next replay pause, for real: its record now lists a
     * migration the code doesn't have (reason `migrations`).
     */
    breakReplay: (workflowId: string) =>
      h.t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.save, { workflowId, applied: ['a-migration-this-code-lacks'], overlay: [] })),

    /** Deploys the fix: the record lists only migrations the code has, so the next replay goes through. */
    fixReplay: (workflowId: string) => h.t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.save, { workflowId, applied: [], overlay: [] })),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    h.t = setup();
    // Settling moves the fake clock on; a month outlasts any test's runs.
    h.admin = await asAdmin(h.t, 30 * 86_400_000);
    h.libraries = await seedLibraries(h.t);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return h;
}
