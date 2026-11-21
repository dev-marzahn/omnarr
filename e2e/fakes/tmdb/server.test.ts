import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createTmdbFake } from './server.ts';

const server = createTmdbFake({ apiKey: 'k' });
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/3`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('the TMDB fake', () => {
  test('refuses a request without the API key, as TMDB does', async () => {
    expect(await get('/tv/900001')).toMatchObject({ status: 401, body: { status_code: 7, success: false } });
  });

  // The image CDN needs no key; each file gets its own picture.
  test('serves images at /t/p/{size}/{file} without the key, and 404 for an unknown size', async () => {
    const root = base.replace(/\/3$/, '');
    const poster = await fetch(`${root}/t/p/w342/harbour-lights.jpg`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('image/svg+xml');
    expect(await poster.text()).toContain('width="342" height="513"');
    expect((await fetch(`${root}/t/p/w300/still-1001.jpg`).then((r) => r.text())).includes('height="169"')).toBe(true);
    expect((await fetch(`${root}/t/p/w9999/harbour-lights.jpg`)).status).toBe(404);
  });

  test('accepts the key as api_key or as a Bearer token', async () => {
    expect((await get('/tv/900001?api_key=k')).status).toBe(200);
    expect((await get('/tv/900001', { headers: { authorization: 'Bearer k' } })).status).toBe(200);
  });

  test('searches series and movies by title', async () => {
    expect((await get('/search/tv?api_key=k&query=harbour')).body).toMatchObject({ total_results: 1, results: [{ id: 900001, name: 'Harbour Lights' }] });
    expect((await get('/search/movie?api_key=k&query=orchard')).body).toMatchObject({ results: [{ id: 900101 }] });
  });

  test('serves a series with its seasons, a season with its episodes, and external IDs', async () => {
    const details = (await get('/tv/900001?api_key=k')).body;
    expect(details.seasons).toEqual([
      expect.objectContaining({ season_number: 0, episode_count: 1 }),
      expect.objectContaining({ season_number: 1, episode_count: 6 }),
      expect.objectContaining({ season_number: 2, episode_count: 6 }),
    ]);
    const season = (await get('/tv/900001/season/1?api_key=k')).body;
    expect(season.episodes).toHaveLength(6);
    expect((season.episodes as { air_date: string }[])[1]!.air_date).toBe('2021-03-11');
    expect((await get('/tv/900001/external_ids?api_key=k')).body).toEqual({ id: 900001, imdb_id: 'tt9900001', tvdb_id: 7700001 });
  });

  test('lists episode groups, and 404s like TMDB for unknown IDs', async () => {
    expect((await get('/tv/900002/episode_groups?api_key=k')).body).toMatchObject({ results: [{ name: 'Absolute order', type: 2 }] });
    expect(await get('/tv/1/season/1?api_key=k')).toMatchObject({ status: 404, body: { status_code: 34 } });
  });

  test('appends external IDs, alternative titles, translations and episode groups to a series', async () => {
    const details = (await get('/tv/900002?api_key=k&append_to_response=external_ids,alternative_titles,translations,episode_groups')).body;
    expect(details).toMatchObject({
      overview: expect.any(String),
      poster_path: expect.stringMatching(/^\//),
      backdrop_path: expect.stringMatching(/^\//),
      external_ids: { tvdb_id: 7700002, imdb_id: null },
      alternative_titles: { results: [{ title: 'Star Lantern' }, { title: 'Star Lantern 2nd Season' }] },
      translations: {
        translations: expect.arrayContaining([expect.objectContaining({ iso_639_1: 'en', data: expect.objectContaining({ name: 'Star Lantern' }) })]),
      },
      episode_groups: { results: [{ id: '5f0000000000000000000001', type: 2 }] },
    });
    expect((await get('/tv/900002?api_key=k')).body).not.toHaveProperty('external_ids');
  });

  test('serves an episode group with its episodes in order', async () => {
    const group = (await get('/tv/episode_group/5f0000000000000000000001?api_key=k')).body;
    expect(group).toMatchObject({ type: 2, episode_count: 24, groups: [{ order: 0 }] });
    const episodes = (group.groups as { episodes: { season_number: number; episode_number: number; order: number }[] }[])[0]!.episodes;
    expect(episodes).toHaveLength(24);
    expect(episodes[12]).toMatchObject({ season_number: 2, episode_number: 1, order: 12 });
    expect((await get('/tv/episode_group/unknown?api_key=k')).status).toBe(404);
  });

  test('gives episodes an overview, a still and a runtime', async () => {
    const season = (await get('/tv/900001/season/1?api_key=k')).body;
    expect((season.episodes as object[])[0]).toMatchObject({
      overview: expect.any(String),
      still_path: expect.stringMatching(/^\//),
      runtime: expect.any(Number),
    });
  });

  test('appends release dates, external IDs and titles to a movie', async () => {
    const movie = (await get('/movie/900101?api_key=k&append_to_response=external_ids,alternative_titles,translations,release_dates')).body;
    expect(movie).toMatchObject({
      overview: expect.any(String),
      external_ids: { imdb_id: 'tt9900101' },
      alternative_titles: { titles: expect.any(Array) },
      translations: { translations: expect.any(Array) },
      release_dates: {
        results: expect.arrayContaining([
          expect.objectContaining({ iso_3166_1: 'GB', release_dates: expect.arrayContaining([expect.objectContaining({ type: 3 })]) }),
        ]),
      },
    });
  });

  test('answers /configuration, which checks a token', async () => {
    expect((await get('/configuration?api_key=k')).body).toHaveProperty('images');
    expect((await get('/configuration?api_key=wrong')).status).toBe(401);
  });

  test('finds titles by a TVDB or IMDb ID through /find, with every result list', async () => {
    expect((await get('/find/7700001?api_key=k&external_source=tvdb_id')).body).toEqual({
      movie_results: [],
      person_results: [],
      tv_results: [expect.objectContaining({ id: 900001, name: 'Harbour Lights', first_air_date: '2021-03-04' })],
      tv_episode_results: [],
      tv_season_results: [],
    });
    expect((await get('/find/tt9900101?api_key=k&external_source=imdb_id')).body).toMatchObject({
      movie_results: [{ id: 900101, title: 'The Quiet Orchard' }],
      tv_results: [],
    });
    expect((await get('/find/tt0000000?api_key=k&external_source=imdb_id')).body).toMatchObject({ movie_results: [], tv_results: [] });
  });
});
