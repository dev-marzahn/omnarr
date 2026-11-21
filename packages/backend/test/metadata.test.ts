import { longSeries, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import { asAdmin, seedAnimeLists, seedLibraries, setup, useMetadataFakes, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
  useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('metadata.search', () => {
  test('finds series and movies by title, with the numbering TMDB suggests', async () => {
    const hits = await admin.action(api.api.metadata.search, { query: 'star' });
    const poster = expect.stringMatching(/^data:image\/svg\+xml;base64,/);
    expect(hits).toEqual([
      { tmdbId: '900002', kind: 'series', title: 'Star Lantern', year: 2022, numberingScheme: 'anime', numberingReason: 'genreOrigin', posterDataUri: poster },
    ]);
    const orchard = await admin.action(api.api.metadata.search, { query: 'orchard' });
    expect(orchard).toEqual([
      { tmdbId: '900101', kind: 'movie', title: 'The Quiet Orchard', year: 2020, numberingScheme: 'standard', numberingReason: 'none', posterDataUri: poster },
    ]);
  });

  test('suggests anime from Anime-Lists first', async () => {
    await seedAnimeLists(t);
    const hits = await admin.action(api.api.metadata.search, { query: 'star' });
    expect(hits).toEqual([expect.objectContaining({ numberingScheme: 'anime', numberingReason: 'animeLists' })]);
    expect(await admin.action(api.api.metadata.preview, { tmdbId: '900002', kind: 'series' })).toMatchObject({
      numberingScheme: 'anime',
      numberingReason: 'animeLists',
    });
  });

  test('searches one kind when asked', async () => {
    expect(await admin.action(api.api.metadata.search, { query: 'orchard', kind: 'series' })).toEqual([]);
  });

  test('marks a title already in the library with its Work', async () => {
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
    expect(await admin.action(api.api.metadata.search, { query: 'harbour' })).toEqual([expect.objectContaining({ tmdbId: '900001', workId })]);
  });

  test('says so when TMDB cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(admin.action(api.api.metadata.search, { query: 'harbour' })).rejects.toThrow(/metadataUnavailable/);
  });

  test('waits out a 429 and retries, at most 3 attempts in all', async () => {
    const tmdb = globalThis.fetch;
    const limited = (times: number) => {
      let calls = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        // The API's limit; the image CDN is another host.
        if (new Request(input, init).url.includes('image.tmdb.fake')) return tmdb(input, init);
        calls++;
        return calls <= times ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : tmdb(input, init);
      });
      return () => calls;
    };
    let calls = limited(2);
    expect(await admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' })).toHaveLength(1);
    expect(calls()).toBe(3);
    calls = limited(3);
    await expect(admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' })).rejects.toThrow(/metadataUnavailable/);
    expect(calls()).toBe(3);
  });

  test('a response that fails its schema is metadataBadResponse', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ results: [{ id: 'not a number' }] }));
    await expect(admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' })).rejects.toThrow(/metadataBadResponse/);
  });

  test('only an admin can search', async () => {
    await expect(t.action(api.api.metadata.search, { query: 'harbour' })).rejects.toThrow(/unauthorized/);
  });
});

describe('metadata.preview', () => {
  test('lists the seasons with their episodes, how many aired, and when the next one airs', async () => {
    const day = 24 * 60 * 60 * 1000;
    const date = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
    const episode = (n: number, air_date: string | null) => ({ id: 990000 + n, season_number: 3, episode_number: n, name: `Episode ${n}`, air_date });
    useMetadataFakes({
      series: [
        {
          ...SERIES[0]!,
          seasons: [
            ...SERIES[0]!.seasons,
            { id: 99003, season_number: 3, name: 'Season 3', air_date: date(-7), episodes: [episode(1, date(-7)), episode(2, date(7)), episode(3, null)] },
          ],
        },
      ],
    });
    const preview = await admin.action(api.api.metadata.preview, { tmdbId: '900001', kind: 'series' });
    expect(preview).toEqual({
      tmdbId: '900001',
      kind: 'series',
      title: 'Harbour Lights',
      year: 2021,
      numberingScheme: 'standard',
      numberingReason: 'none',
      seasons: [
        { season: 0, episodes: 1, aired: 1 },
        { season: 1, episodes: 6, aired: 6 },
        { season: 2, episodes: 6, aired: 6 },
        { season: 3, episodes: 3, aired: 1, nextAirDateUtc: Date.parse(`${date(7)}T00:00:00Z`) },
      ],
    });
  });

  test('fetches at most 4 TMDB requests at a time', async () => {
    useMetadataFakes({ series: [longSeries()] });
    const tmdb = globalThis.fetch;
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      // The API's concurrency; the image CDN is another host.
      if (new Request(input, init).url.includes('image.tmdb.fake')) return tmdb(input, init);
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await tmdb(input, init);
      } finally {
        inFlight--;
      }
    });
    const preview = await admin.action(api.api.metadata.preview, { tmdbId: '900004', kind: 'series' });
    expect(preview.seasons).toHaveLength(22);
    expect(most).toBe(4);
  });

  test('a movie has no seasons', async () => {
    const preview = await admin.action(api.api.metadata.preview, { tmdbId: '900101', kind: 'movie' });
    expect(preview).toMatchObject({ kind: 'movie', title: 'The Quiet Orchard', seasons: [] });
  });

  test('an ID TMDB does not know is refused', async () => {
    await expect(admin.action(api.api.metadata.preview, { tmdbId: '1', kind: 'series' })).rejects.toThrow(/notFound/);
  });
});
