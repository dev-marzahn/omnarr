// The fake TMDB's catalogue: made-up titles in TMDB v3's response shapes,
// trimmed to the fields the metadata sync reads. A series with specials, an
// anime series with an Absolute episode group, a series whose TMDB and TVDB
// seasons differ, one movie, and two generated variants: Harbour Lights
// after a season restructure and a 1,100-episode series.

export type Episode = {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  air_date: string | null;
  // Optional, so tests can write an episode with only the basic fields.
  overview?: string;
  still_path?: string | null;
  runtime?: number | null;
};
export type Season = { id: number; season_number: number; name: string; air_date: string | null; episodes: Episode[] };
/** An episode group with its episodes; the series lists only a summary of it. */
export type EpisodeGroup = {
  id: string;
  name: string;
  type: number;
  groups: { id: string; name: string; order: number; episodes: { id: number; season_number: number; episode_number: number; order: number }[] }[];
};
export type AlternativeTitle = { iso_3166_1: string; title: string; type: string };
export type Translation = {
  iso_3166_1: string;
  iso_639_1: string;
  name: string;
  english_name: string;
  data: { name?: string; title?: string; overview: string };
};
export type Series = {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  origin_country: string[];
  original_language: string;
  genres: { id: number; name: string }[];
  number_of_seasons: number;
  status: string;
  seasons: Season[];
  external_ids: { imdb_id: string | null; tvdb_id: number | null };
  episode_groups: EpisodeGroup[];
  alternative_titles: AlternativeTitle[];
  translations: Translation[];
};
export type ReleaseDate = { certification: string; iso_639_1: string; note: string; release_date: string; type: number };
export type Movie = {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  original_language: string;
  runtime: number;
  status: string;
  genres: { id: number; name: string }[];
  external_ids: { imdb_id: string | null };
  alternative_titles: AlternativeTitle[];
  translations: Translation[];
  release_dates: { iso_3166_1: string; release_dates: ReleaseDate[] }[];
};

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const episodes = (season: number, count: number, firstAirDate: string, idBase: number): Episode[] =>
  Array.from({ length: count }, (_, i) => ({
    id: idBase + i,
    episode_number: i + 1,
    season_number: season,
    name: `Episode ${i + 1}`,
    air_date: addDays(firstAirDate, 7 * i),
    overview: `Season ${season}, episode ${i + 1}.`,
    still_path: `/still-${idBase + i}.jpg`,
    runtime: 45,
  }));

const season = (n: number, name: string, count: number, firstAirDate: string | null, idBase: number): Season => ({
  id: idBase,
  season_number: n,
  name,
  air_date: firstAirDate,
  episodes: firstAirDate ? episodes(n, count, firstAirDate, idBase * 100) : [],
});

/** One group holding every regular episode in TMDB order: the Absolute group (type 2). */
const absoluteGroup = (id: string, seasons: Season[]): EpisodeGroup => ({
  id,
  name: 'Absolute order',
  type: 2,
  groups: [
    {
      id: `${id}-1`,
      name: 'Episodes',
      order: 0,
      episodes: seasons
        .filter((s) => s.season_number > 0)
        .flatMap((s) => s.episodes)
        .map((e, order) => ({ id: e.id, season_number: e.season_number, episode_number: e.episode_number, order })),
    },
  ],
});

const english = (name: string, overview: string): Translation => ({
  iso_3166_1: 'US',
  iso_639_1: 'en',
  name: 'English',
  english_name: 'English',
  data: { name, overview },
});

const harbourSeasons = [
  season(0, 'Specials', 1, '2021-12-24', 9100),
  season(1, 'Season 1', 6, '2021-03-04', 9101),
  season(2, 'Season 2', 6, '2023-03-02', 9102),
];
const starSeasons = [season(1, 'Season 1', 12, '2022-04-07', 9201), season(2, 'Season 2', 12, '2023-01-05', 9202)];
const northboundSeasons = [season(1, 'Season 1', 12, '2019-01-10', 9301), season(2, 'Season 2', 12, '2019-04-04', 9302)];

const HARBOUR_LIGHTS: Series = {
  id: 900001,
  name: 'Harbour Lights',
  original_name: 'Harbour Lights',
  overview: 'A lighthouse keeper and the town below.',
  poster_path: '/harbour-lights.jpg',
  backdrop_path: '/harbour-lights-backdrop.jpg',
  first_air_date: '2021-03-04',
  origin_country: ['GB'],
  original_language: 'en',
  genres: [{ id: 18, name: 'Drama' }],
  number_of_seasons: 2,
  status: 'Returning Series',
  seasons: harbourSeasons,
  external_ids: { imdb_id: 'tt9900001', tvdb_id: 7700001 },
  episode_groups: [],
  alternative_titles: [],
  translations: [english('Harbour Lights', 'A lighthouse keeper and the town below.')],
};

/**
 * The scan's Sonarr library: season 1 has 26 episodes, of which the scan
 * fixture holds 24, so two are missing; the first two have real titles.
 */
const oldShowSeason = season(1, 'Season 1', 26, '2015-01-08', 9401);
oldShowSeason.episodes[0]!.name = 'Pilot';
oldShowSeason.episodes[1]!.name = 'Second';
const OLD_SHOW: Series = {
  id: 900008,
  name: 'Old Show',
  original_name: 'Old Show',
  overview: 'A long-running show someone already had on disk.',
  poster_path: null,
  backdrop_path: null,
  first_air_date: '2015-01-08',
  origin_country: ['US'],
  original_language: 'en',
  genres: [{ id: 35, name: 'Comedy' }],
  number_of_seasons: 1,
  status: 'Ended',
  seasons: [oldShowSeason],
  external_ids: { imdb_id: 'tt9900008', tvdb_id: 7700008 },
  episode_groups: [],
  alternative_titles: [],
  translations: [english('Old Show', 'A long-running show someone already had on disk.')],
};

export const SERIES: Series[] = [
  HARBOUR_LIGHTS,
  {
    id: 900002,
    name: 'Star Lantern',
    original_name: 'Hoshi no Chōchin',
    overview: 'A girl follows a lantern across the night sky.',
    poster_path: '/star-lantern.jpg',
    backdrop_path: '/star-lantern-backdrop.jpg',
    first_air_date: '2022-04-07',
    origin_country: ['JP'],
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    number_of_seasons: 2,
    status: 'Ended',
    seasons: starSeasons,
    external_ids: { imdb_id: null, tvdb_id: 7700002 },
    episode_groups: [absoluteGroup('5f0000000000000000000001', starSeasons)],
    // The two Anime-Lists entry names.
    alternative_titles: [
      { iso_3166_1: 'US', title: 'Star Lantern', type: '' },
      { iso_3166_1: 'US', title: 'Star Lantern 2nd Season', type: '' },
    ],
    translations: [
      english('Star Lantern', 'A girl follows a lantern across the night sky.'),
      { iso_3166_1: 'JP', iso_639_1: 'ja', name: '日本語', english_name: 'Japanese', data: { name: '星の提灯', overview: '' } },
    ],
  },
  {
    // TMDB has two seasons of 12; TVDB, by XEM, one season of 24.
    id: 900003,
    name: 'Northbound Signal',
    original_name: 'Northbound Signal',
    overview: 'A radio operator hears a voice from the future.',
    poster_path: '/northbound-signal.jpg',
    backdrop_path: null,
    first_air_date: '2019-01-10',
    origin_country: ['US'],
    original_language: 'en',
    genres: [{ id: 9648, name: 'Mystery' }],
    number_of_seasons: 2,
    status: 'Ended',
    seasons: northboundSeasons,
    external_ids: { imdb_id: 'tt9900003', tvdb_id: 7700003 },
    episode_groups: [],
    alternative_titles: [],
    translations: [english('Northbound Signal', 'A radio operator hears a voice from the future.')],
  },
  OLD_SHOW,
];

/**
 * Harbour Lights after TMDB restructured it: season 1's episodes
 * 4–6 became a new season 2 with their episode IDs, the old season 2 became
 * season 3, and its last episode (a placeholder) was deleted.
 */
export function harbourLightsRestructured(): Series {
  const [specials, s1, s2] = harbourSeasons as [Season, Season, Season];
  const renumber = (list: Episode[], seasonNumber: number) => list.map((e, i) => ({ ...e, season_number: seasonNumber, episode_number: i + 1 }));
  return {
    ...HARBOUR_LIGHTS,
    number_of_seasons: 3,
    seasons: [
      specials,
      { ...s1, episodes: s1.episodes.slice(0, 3) },
      { id: 9103, season_number: 2, name: 'Season 2', air_date: s1.episodes[3]!.air_date, episodes: renumber(s1.episodes.slice(3), 2) },
      { ...s2, id: 9104, season_number: 3, name: 'Season 3', episodes: renumber(s2.episodes.slice(0, 5), 3) },
    ],
  };
}

/** A long-running series of `count` episodes, 50 to a season, all aired (for the per-mutation limits test). */
export function longSeries(count = 1100): Series {
  const seasons: Season[] = [];
  for (let n = 1; (n - 1) * 50 < count; n++)
    seasons.push(season(n, `Season ${n}`, Math.min(50, count - (n - 1) * 50), addDays('1990-01-04', 7 * 50 * (n - 1)), 94000 + n));
  return {
    id: 900004,
    name: 'Endless Tide',
    original_name: 'Endless Tide',
    overview: 'The longest-running show on the coast.',
    poster_path: null,
    backdrop_path: null,
    first_air_date: '1990-01-04',
    origin_country: ['JP'],
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    number_of_seasons: seasons.length,
    status: 'Returning Series',
    seasons,
    external_ids: { imdb_id: null, tvdb_id: 7700004 },
    episode_groups: [],
    alternative_titles: [],
    translations: [english('Endless Tide', 'The longest-running show on the coast.')],
  };
}

/**
 * An anime whose seasons TMDB merged into one season of 10 (as with JUJUTSU
 * KAISEN): TVDB, by XEM, has seasons of 4, 3 and 3, and Anime-Lists still points the second-season entry at a TMDB
 * season 2 (`test/fixtures/animeLists/missingSeason.xml`).
 */
export function emberRite(): Series {
  return {
    id: 900007,
    name: 'Ember Rite',
    original_name: 'Hi no Gishiki',
    overview: 'Apprentices keep a fire that must not go out.',
    poster_path: null,
    backdrop_path: null,
    first_air_date: '2020-10-03',
    origin_country: ['JP'],
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    number_of_seasons: 1,
    status: 'Returning Series',
    seasons: [season(1, 'Season 1', 10, '2020-10-03', 9701)],
    external_ids: { imdb_id: null, tvdb_id: 7700007 },
    episode_groups: [],
    alternative_titles: [{ iso_3166_1: 'US', title: 'Ember Rite 2nd Season', type: '' }],
    translations: [english('Ember Rite', 'Apprentices keep a fire that must not go out.')],
  };
}

/**
 * JoJo's Bizarre Adventure (2012) in the shape TMDB gives it,
 * with made-up IDs and a few episodes a part: six seasons, one per part, which TVDB numbers the same way. XEM's
 * scene numbering restarts at absolute 1 in each part (test fixture
 * `xem/jojoPartsShape.json`). Not in `SERIES`.
 */
export function jojoParts(): Series {
  const parts = [
    season(1, 'Phantom Blood & Battle Tendency', 6, '2012-10-06', 9801),
    season(2, 'Stardust Crusaders', 3, '2014-04-05', 9802),
    season(3, 'Diamond Is Unbreakable', 5, '2016-04-02', 9803),
    season(4, 'Golden Wind', 3, '2018-10-06', 9804),
    season(5, 'Stone Ocean', 6, '2021-12-01', 9805),
    season(6, 'Steel Ball Run', 3, '2026-03-07', 9806),
  ];
  return {
    id: 900009,
    name: "JoJo's Bizarre Adventure",
    original_name: 'ジョジョの奇妙な冒険',
    overview: 'Generations of the Joestar family.',
    poster_path: null,
    backdrop_path: null,
    first_air_date: '2012-10-06',
    origin_country: ['JP'],
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    number_of_seasons: parts.length,
    status: 'Returning Series',
    seasons: parts,
    external_ids: { imdb_id: null, tvdb_id: 7700009 },
    episode_groups: [],
    // TMDB's real alternative title for the airing part (the part-title fix): the show's name with a season's name.
    alternative_titles: [{ iso_3166_1: 'JP', title: "STEEL BALL RUN JoJo's Bizarre Adventure", type: '' }],
    translations: [english("JoJo's Bizarre Adventure", 'Generations of the Joestar family.')],
  };
}

/**
 * Attack on Titan with made-up IDs (TMDB 900010, TVDB 7700010), for the
 * part-title fix: four seasons named as TMDB names them, the last one "The
 * Final Season" with two cours of 16 and 12 episodes; the first three seasons
 * are shortened. The alternative title with "Part 2" is modelled, not TMDB's.
 * XEM's numbering is built in the test. Not in `SERIES`.
 */
export function attackOnTitan(): Series {
  const seasons = [
    season(1, 'Season 1', 3, '2013-04-07', 9811),
    season(2, 'Season 2', 2, '2017-04-01', 9812),
    season(3, 'Season 3', 4, '2018-07-23', 9813),
    season(4, 'The Final Season', 28, '2020-12-07', 9814),
  ];
  return {
    id: 900010,
    name: 'Attack on Titan',
    original_name: '進撃の巨人',
    overview: 'Humanity behind the walls.',
    poster_path: null,
    backdrop_path: null,
    first_air_date: '2013-04-07',
    origin_country: ['JP'],
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    number_of_seasons: seasons.length,
    status: 'Ended',
    seasons,
    external_ids: { imdb_id: null, tvdb_id: 7700010 },
    episode_groups: [],
    alternative_titles: [
      { iso_3166_1: 'JP', title: 'Shingeki no Kyojin', type: 'romaji' },
      { iso_3166_1: 'US', title: 'Attack on Titan: The Final Season Part 2', type: '' },
    ],
    translations: [english('Attack on Titan', 'Humanity behind the walls.')],
  };
}

export const MOVIES: Movie[] = [
  {
    id: 900101,
    title: 'The Quiet Orchard',
    original_title: 'The Quiet Orchard',
    overview: 'Two sisters and the orchard they inherit.',
    poster_path: '/quiet-orchard.jpg',
    backdrop_path: '/quiet-orchard-backdrop.jpg',
    release_date: '2020-09-18',
    original_language: 'en',
    runtime: 104,
    status: 'Released',
    genres: [{ id: 18, name: 'Drama' }],
    external_ids: { imdb_id: 'tt9900101' },
    alternative_titles: [{ iso_3166_1: 'US', title: 'Quiet Orchard', type: '' }],
    translations: [{ iso_3166_1: 'US', iso_639_1: 'en', name: 'English', english_name: 'English', data: { title: 'The Quiet Orchard', overview: '' } }],
    // A festival premiere before the theatrical date, and a later digital one (for the movie date rule).
    release_dates: [
      { iso_3166_1: 'US', release_dates: [{ certification: '', iso_639_1: '', note: 'Festival', release_date: '2020-09-10T00:00:00.000Z', type: 1 }] },
      {
        iso_3166_1: 'GB',
        release_dates: [
          { certification: '12A', iso_639_1: '', note: '', release_date: '2020-09-18T00:00:00.000Z', type: 3 },
          { certification: '12A', iso_639_1: '', note: '', release_date: '2020-12-01T00:00:00.000Z', type: 4 },
        ],
      },
    ],
  },
];
