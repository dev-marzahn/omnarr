// The TMDB v3 adapter for the MetadataProvider port, run in
// Convex actions in the default runtime. Every response is parsed with the
// schemas below, which mark TMDB's nullable fields nullable. Errors are
// ConvexErrors whose message names the endpoint path, never the URL, the
// token or TMDB's text.
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { movieAirDate, utcDate } from './numbering';
import type { KeyCheck, MetadataProvider, ProviderHit, UnitMetadata, WorkMetadata } from './provider';

export type TmdbConfig = { baseUrl: string; token?: string; language: string };

/** TMDB request limits. */
export const TMDB_LIMITS = { inFlight: 4, timeoutMs: 10_000, attempts: 3, retryAfterMs: 2_000 };

/** TMDB's type for the Absolute episode group. */
const ABSOLUTE_GROUP = 2;

const str = z.string().nullable().optional();
const Genre = z.object({ id: z.number() });
const AlternativeTitle = z.object({ title: z.string() });
/** `translations[].data`: `name` for series, `title` for movies. */
const Translations = z.object({
  translations: z.array(z.object({ iso_639_1: z.string(), data: z.object({ name: str, title: str }) })),
});

const TvHit = z.object({
  id: z.number(),
  name: z.string(),
  first_air_date: str,
  poster_path: z.string().nullish(),
  origin_country: z.array(z.string()).optional(),
  genre_ids: z.array(z.number()).optional(),
});
const MovieHit = z.object({
  id: z.number(),
  title: z.string(),
  release_date: str,
  poster_path: z.string().nullish(),
  genre_ids: z.array(z.number()).optional(),
});
const page = <T extends z.ZodType>(hit: T) => z.object({ results: z.array(hit) });
/** `/find/{external_id}`: the person and episode lists aren't read. */
const FindResults = z.object({ tv_results: z.array(TvHit), movie_results: z.array(MovieHit) });

const TvDetails = z.object({
  name: z.string(),
  original_name: z.string(),
  overview: str,
  poster_path: str,
  backdrop_path: str,
  first_air_date: str,
  origin_country: z.array(z.string()),
  original_language: str,
  genres: z.array(Genre),
  status: str,
  seasons: z.array(z.object({ season_number: z.number(), name: str })),
  external_ids: z.object({ imdb_id: str, tvdb_id: z.number().nullable().optional() }),
  alternative_titles: z.object({ results: z.array(AlternativeTitle) }),
  translations: Translations,
  episode_groups: z.object({ results: z.array(z.object({ id: z.string(), type: z.number() })) }),
});
const TvSeason = z.object({
  episodes: z.array(
    z.object({
      id: z.number(),
      season_number: z.number(),
      episode_number: z.number(),
      name: str,
      air_date: str,
      overview: str,
      still_path: str,
      runtime: z.number().nullable().optional(),
    }),
  ),
});
const EpisodeGroup = z.object({
  groups: z.array(z.object({ order: z.number(), episodes: z.array(z.object({ season_number: z.number(), episode_number: z.number(), order: z.number() })) })),
});
const MovieDetails = z.object({
  title: z.string(),
  original_title: z.string(),
  overview: str,
  poster_path: str,
  backdrop_path: str,
  release_date: str,
  original_language: str,
  genres: z.array(Genre),
  status: str,
  runtime: z.number().nullable().optional(),
  external_ids: z.object({ imdb_id: str }),
  alternative_titles: z.object({ titles: z.array(AlternativeTitle) }),
  translations: Translations,
  release_dates: z.object({ results: z.array(z.object({ release_dates: z.array(z.object({ type: z.number(), release_date: z.string() })) })) }),
});

const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
const yearOf = (date?: string | null): number | undefined => (date ? Number(date.slice(0, 4)) : undefined);
const englishTitles = (t: z.infer<typeof Translations>, field: 'name' | 'title') =>
  t.translations.flatMap((tr) => (tr.iso_639_1 === 'en' && tr.data[field] ? [tr.data[field]!] : []));

/** Lets at most `max` calls run at once; the rest wait in order. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unavailable = (path: string, why: string) => new ConvexError({ code: 'metadataUnavailable', message: `TMDB ${path} ${why}.` });

export function tmdbProvider(config: TmdbConfig): MetadataProvider {
  const limit = limiter(TMDB_LIMITS.inFlight);

  /** One GET with the timeout, retrying a 429 after `Retry-After` (or 2 s), at most 3 attempts in all. */
  async function send(path: string, query: Record<string, string>, token: string): Promise<Response> {
    const url = `${config.baseUrl}/3${path}?${new URLSearchParams({ ...query, language: config.language })}`;
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TMDB_LIMITS.timeoutMs);
      let response: Response;
      try {
        response = await limit(() => fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: controller.signal }));
      } catch {
        throw unavailable(path, 'could not be reached');
      } finally {
        clearTimeout(timer);
      }
      if (response.status !== 429 || attempt >= TMDB_LIMITS.attempts) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && response.headers.has('retry-after') ? retryAfter * 1000 : TMDB_LIMITS.retryAfterMs);
    }
  }

  /** GETs and parses a v3 endpoint; null when TMDB doesn't know the resource. */
  async function get<T extends z.ZodType>(schema: T, path: string, query: Record<string, string> = {}): Promise<z.infer<T> | null> {
    if (!config.token) throw new ConvexError({ code: 'metadataUnavailable', message: 'No TMDB API token is configured.' });
    const response = await send(path, query, config.token);
    if (response.status === 404) return null;
    if (response.status === 401) throw new ConvexError({ code: 'metadataKeyRejected', message: `TMDB rejected the token (${path}).` });
    if (!response.ok) throw unavailable(path, `answered ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // The schema paths only: the data may be large and is TMDB's.
      console.error(`TMDB ${path}: unexpected response at ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`);
      throw new ConvexError({ code: 'metadataBadResponse', message: `TMDB ${path} sent an unexpected response.` });
    }
    return parsed.data;
  }

  async function lookupSeries(tmdbId: string): Promise<WorkMetadata | null> {
    const details = await get(TvDetails, `/tv/${tmdbId}`, { append_to_response: 'external_ids,alternative_titles,translations,episode_groups' });
    if (!details) return null;
    const absolute = details.episode_groups.results.filter((group) => group.type === ABSOLUTE_GROUP);
    const [group, ...seasons] = await Promise.all([
      // Only a single Absolute group can be used, so only then is it fetched.
      absolute.length === 1 ? get(EpisodeGroup, `/tv/episode_group/${absolute[0]!.id}`) : Promise.resolve(null),
      ...details.seasons.map((season) => get(TvSeason, `/tv/${tmdbId}/season/${season.season_number}`)),
    ]);
    const units: UnitMetadata[] = seasons.flatMap((season) =>
      (season?.episodes ?? []).map((episode) => ({
        kind: episode.season_number === 0 ? ('special' as const) : ('episode' as const),
        tmdbId: String(episode.id),
        tmdbSeason: episode.season_number,
        tmdbEpisode: episode.episode_number,
        title: opt(episode.name),
        airDateUtc: utcDate(episode.air_date),
        overview: opt(episode.overview) || undefined,
        stillPath: opt(episode.still_path),
        runtimeMin: opt(episode.runtime),
      })),
    );
    const groupEpisodes = group?.groups
      .toSorted((a, b) => a.order - b.order)
      .flatMap((g) => g.episodes.toSorted((a, b) => a.order - b.order))
      .map((e) => ({ tmdbSeason: e.season_number, tmdbEpisode: e.episode_number }));
    return {
      kind: 'series',
      tmdbId,
      title: details.name,
      year: yearOf(details.first_air_date),
      overview: opt(details.overview) || undefined,
      posterPath: opt(details.poster_path),
      backdropPath: opt(details.backdrop_path),
      genreIds: details.genres.map((genre) => genre.id),
      originCountry: details.origin_country,
      originalLanguage: opt(details.original_language),
      tmdbStatus: opt(details.status),
      tvdbId: opt(details.external_ids.tvdb_id),
      imdbId: opt(details.external_ids.imdb_id) || undefined,
      aliases: [...englishTitles(details.translations, 'name'), details.original_name, ...details.alternative_titles.results.map((a) => a.title)],
      absoluteGroups: absolute.length ? { count: absolute.length, episodes: groupEpisodes } : undefined,
      seasons: details.seasons.map((season) => ({ season: season.season_number, name: opt(season.name) })),
      units,
    };
  }

  async function lookupMovie(tmdbId: string): Promise<WorkMetadata | null> {
    const details = await get(MovieDetails, `/movie/${tmdbId}`, { append_to_response: 'external_ids,alternative_titles,translations,release_dates' });
    if (!details) return null;
    const releaseDates = details.release_dates.results.flatMap((country) => country.release_dates.map((r) => ({ type: r.type, releaseDate: r.release_date })));
    return {
      kind: 'movie',
      tmdbId,
      title: details.title,
      year: yearOf(details.release_date),
      overview: opt(details.overview) || undefined,
      posterPath: opt(details.poster_path),
      backdropPath: opt(details.backdrop_path),
      genreIds: details.genres.map((genre) => genre.id),
      originCountry: [],
      originalLanguage: opt(details.original_language),
      tmdbStatus: opt(details.status),
      imdbId: opt(details.external_ids.imdb_id) || undefined,
      aliases: [...englishTitles(details.translations, 'title'), details.original_title, ...details.alternative_titles.titles.map((a) => a.title)],
      units: [
        {
          kind: 'movie',
          title: details.title,
          airDateUtc: movieAirDate(releaseDates, details.release_date),
          overview: opt(details.overview) || undefined,
          runtimeMin: opt(details.runtime),
        },
      ],
    };
  }

  const tvHit = (hit: z.infer<typeof TvHit>): ProviderHit => ({
    tmdbId: String(hit.id),
    kind: 'series',
    title: hit.name,
    year: yearOf(hit.first_air_date),
    ...(hit.poster_path ? { posterPath: hit.poster_path } : {}),
    genreIds: hit.genre_ids ?? [],
    originCountry: hit.origin_country ?? [],
  });
  const movieHit = (hit: z.infer<typeof MovieHit>): ProviderHit => ({
    tmdbId: String(hit.id),
    kind: 'movie',
    title: hit.title,
    year: yearOf(hit.release_date),
    ...(hit.poster_path ? { posterPath: hit.poster_path } : {}),
    genreIds: hit.genre_ids ?? [],
    originCountry: [],
  });

  return {
    async search(query, kind): Promise<ProviderHit[]> {
      if (kind === 'series') return ((await get(page(TvHit), '/search/tv', { query }))?.results ?? []).map(tvHit);
      return ((await get(page(MovieHit), '/search/movie', { query }))?.results ?? []).map(movieHit);
    },

    async findByExternalId(provider, value): Promise<ProviderHit[]> {
      const found = await get(FindResults, `/find/${encodeURIComponent(value)}`, { external_source: provider === 'tvdb' ? 'tvdb_id' : 'imdb_id' });
      return [...(found?.tv_results ?? []).map(tvHit), ...(found?.movie_results ?? []).map(movieHit)];
    },

    lookupWork: (tmdbId, kind) => (kind === 'series' ? lookupSeries(tmdbId) : lookupMovie(tmdbId)),

    async checkKey(token): Promise<KeyCheck> {
      try {
        const response = await send('/configuration', {}, token);
        if (response.ok) return 'valid';
        return response.status === 401 ? 'rejected' : 'unreachable';
      } catch {
        return 'unreachable';
      }
    },
  };
}
