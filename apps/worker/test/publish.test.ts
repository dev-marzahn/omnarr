// The publish handler: it calls PlaybackTarget.publish with
// the payload's files, Work folder and library, and returns the refs. The
// wait and the refresh scope are the adapter's.
import type { LeasedJob } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { publishHandler } from '../src/jobs/publish.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import type { PlaybackTarget, PublishRequest } from '../src/targets/playbackTarget.ts';

const library = { libraryId: 'lib1' as never, root: '/data/library/series', kind: 'series' as const };
const items = [
  { publicationId: 'p1' as never, path: '/data/library/series/Harbour Lights (2021)/Season 01/E1.mkv' },
  { publicationId: 'p2' as never, path: '/data/library/series/Harbour Lights (2021)/Season 01/E2.mkv' },
];
const job: LeasedJob = {
  jobId: 'job3' as never,
  class: 'publish',
  leaseEpoch: 1,
  payload: { class: 'publish', publicationIds: ['p1' as never, 'p2' as never], workFolderPath: '/data/library/series/Harbour Lights (2021)', items, library },
};
const ctx = { signal: new AbortController().signal, progress: () => {} };

function target(publish: PlaybackTarget['publish']) {
  const requests: PublishRequest[] = [];
  const fake: PlaybackTarget = {
    publish: async (request, signal) => {
      requests.push(request);
      return publish(request, signal);
    },
    forget: async () => {},
    observe: async () => [],
    readWatchState: async () => [],
  };
  return { fake, requests };
}

describe('publish', () => {
  test("hands the target the files, the Work folder and the library, and returns the target's refs, readings and series items", async () => {
    const readings = { p1: { kind: 'episode' as const, season: 1, episode: 1 }, p2: { kind: 'episode' as const, season: 0, episode: 26 } };
    const seriesRefs = { p1: 'series1', p2: 'series1' };
    const { fake, requests } = target(async () => ({ refs: { p1: 'item1', p2: 'item2' }, readings, seriesRefs }));
    expect(await publishHandler({ target: fake })(job, ctx)).toEqual({
      class: 'publish',
      targetItemRefs: { p1: 'item1', p2: 'item2' },
      readings,
      seriesItemRefs: seriesRefs,
    });
    expect(requests).toEqual([{ items, workFolderPath: '/data/library/series/Harbour Lights (2021)', library }]);
  });

  test("the target's failure fails the job, with its reason", async () => {
    const { fake } = target(async () => {
      throw new JobFailure('jellyfinSetupNeeded', "Jellyfin isn't set up yet.");
    });
    await expect(publishHandler({ target: fake })(job, ctx)).rejects.toMatchObject({ code: 'jellyfinSetupNeeded' });
  });
});
