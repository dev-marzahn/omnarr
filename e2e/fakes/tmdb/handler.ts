// The fake TMDB v3 API as a fetch handler: the compose server (server.ts)
// serves it over HTTP, and the backend's convex-test suites route the
// metadata adapter's `fetch` into it. It checks the API key the way TMDB
// does: `api_key` in the query, or a Bearer token.
import { MOVIES, SERIES, type EpisodeGroup, type Movie, type Series } from './fixtures.ts';

export type TmdbFakeOptions = { apiKey: string; series?: Series[]; movies?: Movie[] };

const summary = (s: Series) => ({
  id: s.id,
  name: s.name,
  original_name: s.original_name,
  overview: s.overview,
  poster_path: s.poster_path,
  first_air_date: s.first_air_date,
  origin_country: s.origin_country,
  original_language: s.original_language,
  genre_ids: s.genres.map((g) => g.id),
});
const movieSummary = (m: Movie) => ({
  id: m.id,
  title: m.title,
  original_title: m.original_title,
  overview: m.overview,
  poster_path: m.poster_path,
  release_date: m.release_date,
  original_language: m.original_language,
  genre_ids: m.genres.map((g) => g.id),
});
const groupSummary = (g: EpisodeGroup) => ({
  id: g.id,
  name: g.name,
  type: g.type,
  description: '',
  group_count: g.groups.length,
  episode_count: g.groups.reduce((n, group) => n + group.episodes.length, 0),
  network: null,
});

const page = <T>(results: T[]) => ({ page: 1, results, total_pages: 1, total_results: results.length });

const NOT_FOUND = { status_code: 34, status_message: 'The resource you requested could not be found.', success: false };
const UNAUTHORIZED = { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.', success: false };
const NOT_ALLOWED = { status_code: 0, status_message: 'Method not allowed', success: false };

const CONFIGURATION = {
  images: {
    base_url: 'http://image.tmdb.org/t/p/',
    secure_base_url: 'https://image.tmdb.org/t/p/',
    poster_sizes: ['w342', 'original'],
    still_sizes: ['w300', 'original'],
  },
  change_keys: ['air_date', 'episode', 'season'],
};

/** Pixel sizes of TMDB's image widths: posters 2:3, backdrops and stills 16:9. */
const SHAPES: Record<string, [number, number]> = { w92: [92, 138], w342: [342, 513], w780: [780, 439], w300: [300, 169], original: [500, 750] };

/**
 * A made-up image for a path, as SVG: a gradient whose hue comes from the
 * file name, with the name written on it, so each poster looks different and
 * a still differs from its poster. Unknown files are 404s, as on the CDN.
 */
function imageResponse(size: string, file: string): Response {
  if (!/\.(jpg|png)$/.test(file)) return new Response('Not found', { status: 404 });
  const shape = SHAPES[size];
  if (!shape) return new Response('Not found', { status: 404 });
  const [w, h] = file.startsWith('still-') || size === 'w780' || size === 'w300' ? [shape[0], Math.round((shape[0] * 9) / 16)] : shape;
  let hash = 0;
  for (const char of file) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  const label = file
    .replace(/\.(jpg|png)$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/[&<>"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hash} 70% 45%)"/><stop offset="1" stop-color="hsl(${(hash + 40) % 360} 60% 12%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="${Math.round(w * 0.07)}" y="${Math.round(h * 0.12)}" font-family="sans-serif" font-weight="700" font-size="${Math.max(10, Math.round(w / 12))}" fill="white">${label}</text></svg>`;
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
}

export function createTmdbHandler(options: TmdbFakeOptions): (request: Request) => Response {
  const series = options.series ?? SERIES;
  const movies = options.movies ?? MOVIES;

  /** What `/tv/{id}/<name>` serves, which `append_to_response=<name>` also adds. */
  const seriesPart = (s: Series, name: string): unknown => {
    if (name === 'external_ids') return { id: s.id, ...s.external_ids };
    if (name === 'episode_groups') return { id: s.id, results: s.episode_groups.map(groupSummary) };
    if (name === 'alternative_titles') return { id: s.id, results: s.alternative_titles };
    if (name === 'translations') return { id: s.id, translations: s.translations };
    return undefined;
  };
  const moviePart = (m: Movie, name: string): unknown => {
    if (name === 'external_ids') return { id: m.id, ...m.external_ids };
    if (name === 'alternative_titles') return { id: m.id, titles: m.alternative_titles };
    if (name === 'translations') return { id: m.id, translations: m.translations };
    if (name === 'release_dates') return { id: m.id, results: m.release_dates };
    return undefined;
  };
  const appended = (query: URLSearchParams, part: (name: string) => unknown) =>
    Object.fromEntries(
      (query.get('append_to_response') ?? '')
        .split(',')
        .filter(Boolean)
        .flatMap((name) => {
          const value = part(name);
          return value === undefined ? [] : [[name, value]];
        }),
    );

  const route = (path: string, query: URLSearchParams): unknown => {
    const matches = (title: string) => title.toLowerCase().includes((query.get('query') ?? '').toLowerCase());
    let m: RegExpMatchArray | null;
    if (path === '/3/configuration') return CONFIGURATION;
    if (path === '/3/search/tv') return page(series.filter((s) => matches(s.name) || matches(s.original_name)).map(summary));
    if (path === '/3/search/movie') return page(movies.filter((mv) => matches(mv.title)).map(movieSummary));
    if ((m = path.match(/^\/3\/find\/([^/]+)$/))) {
      // TMDB's /find answers 200 with empty lists for an ID it doesn't know.
      const id = decodeURIComponent(m[1]!);
      const source = query.get('external_source');
      const tv = series.filter((s) => (source === 'tvdb_id' ? String(s.external_ids.tvdb_id) === id : source === 'imdb_id' && s.external_ids.imdb_id === id));
      const film = movies.filter((mv) => source === 'imdb_id' && mv.external_ids.imdb_id === id);
      return { movie_results: film.map(movieSummary), person_results: [], tv_results: tv.map(summary), tv_episode_results: [], tv_season_results: [] };
    }
    if ((m = path.match(/^\/3\/tv\/episode_group\/([^/]+)$/))) {
      const group = series.flatMap((s) => s.episode_groups).find((g) => g.id === m![1]);
      return group ? { ...groupSummary(group), groups: group.groups } : undefined;
    }
    if ((m = path.match(/^\/3\/tv\/(\d+)(?:\/(.*))?$/))) {
      const s = series.find((x) => x.id === Number(m![1]));
      if (!s) return undefined;
      const rest = m[2];
      if (!rest) {
        const { seasons, external_ids: _ids, episode_groups: _groups, alternative_titles: _titles, translations: _translations, ...details } = s;
        return {
          ...details,
          seasons: seasons.map(({ episodes, ...season }) => ({ ...season, episode_count: episodes.length })),
          ...appended(query, (name) => seriesPart(s, name)),
        };
      }
      const seasonMatch = rest.match(/^season\/(\d+)$/);
      if (seasonMatch) return s.seasons.find((x) => x.season_number === Number(seasonMatch[1]));
      return seriesPart(s, rest);
    }
    if ((m = path.match(/^\/3\/movie\/(\d+)(?:\/([a-z_]+))?$/))) {
      const mv = movies.find((x) => x.id === Number(m![1]));
      if (!mv) return undefined;
      if (m[2]) return moviePart(mv, m[2]);
      const { external_ids: _ids, alternative_titles: _titles, translations: _translations, release_dates: _dates, ...details } = mv;
      return { ...details, ...appended(query, (name) => moviePart(mv, name)) };
    }
    return undefined;
  };

  return (request) => {
    const url = new URL(request.url);
    // TMDB's image CDN: no key; `/t/p/{size}/{file}`.
    const image = url.pathname.match(/^\/t\/p\/(w\d+|original)\/([\w.-]+)$/);
    if (image) return imageResponse(image[1]!, image[2]!);
    const send = (status: number, body: unknown) => Response.json(body, { status, headers: { 'content-type': 'application/json;charset=utf-8' } });
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (url.searchParams.get('api_key') !== options.apiKey && bearer !== options.apiKey) return send(401, UNAUTHORIZED);
    if (request.method !== 'GET') return send(405, NOT_ALLOWED);
    const body = route(url.pathname, url.searchParams);
    return body === undefined ? send(404, NOT_FOUND) : send(200, body);
  };
}
