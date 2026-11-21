import { describe, expect, test } from 'vite-plus/test';

import {
  cleanTitle,
  folderTitle,
  isPlaceholderTitle,
  JELLYFIN_EXTRAS_SUFFIXES,
  libraryFileName,
  type NamedUnit,
  type NamingContext,
  seasonFolderFor,
  sidecarName,
  sidecarOf,
  trashQualityLabel,
  workFolderName,
} from '../src/naming.ts';
import { type AudioStream, ProbeSummary, type ProbeStream, type VideoStream } from '../src/playback.ts';
import { QualityId } from '../src/release.ts';

describe('cleanTitle', () => {
  test('removes the characters filesystems refuse, writes a colon as " -", collapses spaces and drops trailing dots', () => {
    expect(cleanTitle('Who/What\\When*Why?"<Here>|')).toBe('WhoWhatWhenWhyHere');
    expect(cleanTitle('Star Trek: Discovery')).toBe('Star Trek - Discovery');
    expect(cleanTitle('  Too   many    spaces ')).toBe('Too many spaces');
    expect(cleanTitle('To Be Continued...')).toBe('To Be Continued');
    expect(cleanTitle('Mr. Robot')).toBe('Mr. Robot');
  });
});

// Fixtures: a parsed release, and probes built from streams.
const release = (overrides: Partial<NamingContext['release']> = {}): NamingContext['release'] => ({
  title: 'Show',
  normalizedTitle: 'show',
  episodes: [],
  special: false,
  extras: false,
  hdr: [],
  atmos: false,
  languages: [],
  subtitleLanguages: [],
  hardcodedSubs: false,
  edition: {},
  revision: { version: 1, real: 0, repack: false },
  notes: [],
  quality: 'webdl-1080p',
  ...overrides,
});

const video = (overrides: Partial<VideoStream> = {}): VideoStream => ({
  index: 0,
  kind: 'video',
  codec: 'h264',
  default: true,
  forced: false,
  hearingImpaired: false,
  width: 1920,
  height: 1080,
  bitDepth: 8,
  pixFmt: 'yuv420p',
  interlaced: false,
  hdr: 'sdr',
  ...overrides,
});

const audio = (overrides: Partial<AudioStream> = {}): AudioStream => ({
  index: 1,
  kind: 'audio',
  codec: 'eac3',
  channels: 6,
  default: true,
  forced: false,
  hearingImpaired: false,
  ...overrides,
});

const probe = (...streams: ProbeStream[]): ProbeSummary => ProbeSummary.parse({ container: 'matroska', streams });

/** An episode's source: H.264 SDR with E-AC-3 5.1. */
const EPISODE_PROBE = probe(video(), audio());

const seriesNaming = (overrides: Partial<NamingContext> = {}): NamingContext => ({
  kind: 'series',
  title: 'Show',
  year: 2019,
  tmdbId: 1,
  anime: false,
  release: release({ streamingService: 'AMZN', group: 'GRP' }),
  ...overrides,
});

const PILOT: NamedUnit = { season: 1, episode: 2, title: 'Pilot' };

describe('libraryFileName: series', () => {
  test('an episode with every part, before and after preparation', () => {
    expect(libraryFileName({ naming: seriesNaming(), units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
    const prepared = probe(video(), audio({ codec: 'aac', channels: 2 }));
    expect(libraryFileName({ naming: seriesNaming(), units: [PILOT], probe: prepared, ext: '.mp4' })).toBe(
      'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4',
    );
  });

  test('the dynamic range and a PROPER revision appear when present', () => {
    const naming = seriesNaming({
      release: release({ quality: 'webdl-2160p', streamingService: 'NF', group: 'GRP', revision: { version: 2, real: 0, repack: false } }),
    });
    const hdr = probe(video({ codec: 'hevc', bitDepth: 10, hdr: 'hdr10' }), audio({ codec: 'eac3', channels: 6 }));
    expect(libraryFileName({ naming, units: [PILOT], probe: hdr, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [NF][WEBDL-2160p Proper][EAC3 5.1][HDR10][h265]-GRP.mkv',
    );
  });

  test('each unknown part is left out with its brackets and separator', () => {
    const bare = seriesNaming({ year: undefined, release: release({ quality: 'unknown' }) });
    expect(libraryFileName({ naming: bare, units: [{ season: 1, episode: 2 }], probe: probe(video()), ext: '.mkv' })).toBe('Show - S01E02 [h264].mkv');
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 2 }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
    const noService = seriesNaming({ release: release({ group: 'GRP' }) });
    expect(libraryFileName({ naming: noService, units: [PILOT], probe: probe(audio()), ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [WEBDL-1080p][EAC3 5.1]-GRP.mkv',
    );
    const noGroup = seriesNaming({ release: release({ streamingService: 'AMZN' }) });
    expect(libraryFileName({ naming: noGroup, units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264].mkv',
    );
  });

  test("the probe's codec names become TRaSH's", () => {
    const name = (streams: ProbeStream[]): string =>
      libraryFileName({ naming: seriesNaming({ release: release() }), units: [{ season: 1, episode: 2 }], probe: probe(...streams), ext: '.mkv' });
    expect(name([video({ codec: 'av1' }), audio({ codec: 'opus', channels: 2 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][Opus 2.0][AV1].mkv');
    expect(name([video({ codec: 'vp9' }), audio({ codec: 'flac', channels: 1 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][FLAC 1.0][VP9].mkv');
    expect(name([video({ codec: 'mpeg2video' }), audio({ codec: 'ac3', channels: 6 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][AC3 5.1][MPEG2].mkv');
    expect(name([video({ codec: 'vc1' }), audio({ codec: 'truehd', channels: 8 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][TrueHD 7.1][VC1].mkv');
    expect(name([video({ codec: 'mpeg4' }), audio({ codec: 'mp3', channels: 2 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][MP3 2.0][XviD].mkv');
    expect(name([video({ codec: 'hevc' }), audio({ codec: 'dts', channels: 6 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][DTS 5.1][h265].mkv');
    expect(name([video(), audio({ codec: 'dts', profile: 'DTS-HD MA', channels: 8 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][DTS-HD MA 7.1][h264].mkv');
    expect(name([video(), audio({ codec: 'dts', profile: 'DTS-HD MA + DTS:X', channels: 8 })])).toBe(
      'Show (2019) - S01E02 [WEBDL-1080p][DTS-HD MA 7.1][h264].mkv',
    );
  });

  test('the first audio stream names the audio; an unnamed codec or channel count leaves its piece out', () => {
    const name = (streams: ProbeStream[]): string =>
      libraryFileName({ naming: seriesNaming({ release: release() }), units: [{ season: 1, episode: 2 }], probe: probe(...streams), ext: '.mkv' });
    expect(name([video(), audio({ codec: 'aac', channels: 2 }), audio({ index: 2, codec: 'eac3', channels: 6 })])).toBe(
      'Show (2019) - S01E02 [WEBDL-1080p][AAC 2.0][h264].mkv',
    );
    expect(name([video(), audio({ codec: 'pcm_s16le', channels: 2 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][h264].mkv');
    expect(name([video(), audio({ codec: 'aac', channels: 4 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][AAC][h264].mkv');
    expect(name([video({ codec: 'prores' }), audio({ codec: 'aac', channels: 2 })])).toBe('Show (2019) - S01E02 [WEBDL-1080p][AAC 2.0].mkv');
  });

  test('every dynamic range; SDR has none', () => {
    const name = (v: VideoStream): string =>
      libraryFileName({ naming: seriesNaming({ release: release() }), units: [{ season: 1, episode: 2 }], probe: probe(v), ext: '.mkv' });
    expect(name(video({ codec: 'hevc', hdr: 'dv', dv: { profile: 8, compatibility: 1 } }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][DV HDR10][h265].mkv');
    expect(name(video({ codec: 'hevc', hdr: 'dv', dv: { profile: 5, compatibility: 0 } }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][DV][h265].mkv');
    expect(name(video({ codec: 'hevc', hdr: 'hdr10plus' }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][HDR10Plus][h265].mkv');
    expect(name(video({ codec: 'hevc', hdr: 'hdr10' }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][HDR10][h265].mkv');
    expect(name(video({ codec: 'hevc', hdr: 'hlg' }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][HLG][h265].mkv');
    expect(name(video({ codec: 'hevc', hdr: 'sdr' }))).toBe('Show (2019) - S01E02 [WEBDL-1080p][h265].mkv');
  });

  test("a placeholder title is left out with its separator, until TMDB's real one arrives", () => {
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 5, title: 'Episode 5' }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E05 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 5, title: '' }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E05 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });

  test('the episode title is cleaned', () => {
    expect(
      libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 2, title: 'Who? Me: A "Story"...' }], probe: EPISODE_PROBE, ext: '.mkv' }),
    ).toBe('Show (2019) - S01E02 - Who Me - A Story [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv');
  });

  test('the episode title is cut at 90 characters', () => {
    const long = `${'A'.repeat(85)} Words Beyond`;
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 2, title: long }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      `Show (2019) - S01E02 - ${'A'.repeat(85)} Word [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`,
    );
    const cutAtSpace = `${'A'.repeat(89)} B`;
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 1, episode: 2, title: cutAtSpace }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      `Show (2019) - S01E02 - ${'A'.repeat(89)} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`,
    );
  });

  test('a multi-episode file names its first and last episode and joins the titles with " + "', () => {
    const two = [
      { season: 1, episode: 1, title: 'Pilot' },
      { season: 1, episode: 2, title: 'The Return' },
    ];
    expect(libraryFileName({ naming: seriesNaming(), units: two, probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E01-E02 - Pilot + The Return [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
    const three = [
      { season: 1, episode: 5, title: 'Part Three' },
      { season: 1, episode: 3, title: 'Part One' },
      { season: 1, episode: 4, title: 'Part Two' },
    ];
    expect(libraryFileName({ naming: seriesNaming(), units: three, probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E03-E05 - Part One + Part Two + Part Three [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });

  test("a multi-episode file's titles are left out while any is a placeholder", () => {
    const units = [
      { season: 1, episode: 1, title: 'Pilot' },
      { season: 1, episode: 2, title: 'Episode 2' },
    ];
    expect(libraryFileName({ naming: seriesNaming(), units, probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E01-E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });

  test('the joined titles are cut at 90 characters together', () => {
    const units = [
      { season: 1, episode: 1, title: 'A'.repeat(50) },
      { season: 1, episode: 2, title: 'B'.repeat(50) },
    ];
    expect(libraryFileName({ naming: seriesNaming(), units, probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      `Show (2019) - S01E01-E02 - ${'A'.repeat(50)} + ${'B'.repeat(37)} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`,
    );
  });

  test('specials are season 0, and episodes past 99 keep their digits', () => {
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 0, episode: 1, title: 'Behind the Show' }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S00E01 - Behind the Show [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
    expect(libraryFileName({ naming: seriesNaming(), units: [{ season: 3, episode: 104 }], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S03E104 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });
});

describe('libraryFileName: the title comes from the stored folder', () => {
  test("a TMDB title change after the folder was chosen doesn't change the names", () => {
    // `works.folder` is `Show (2019) [tmdbid-1]`; TMDB and the release now say `Show: Reborn`.
    const naming = seriesNaming({ ...folderTitle('Show (2019) [tmdbid-1]'), release: release({ title: 'Show Reborn', year: 2021, group: 'GRP' }) });
    expect(libraryFileName({ naming, units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });

  test("the folder's title is cleaned like any other", () => {
    const naming = seriesNaming({ title: 'Star Trek: Discovery', year: 2017 });
    expect(libraryFileName({ naming, units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Star Trek - Discovery (2017) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });
});

const animeNaming = (overrides: Partial<NamingContext> = {}): NamingContext =>
  seriesNaming({
    title: 'Anime',
    year: 2020,
    anime: true,
    release: release({ quality: 'bluray-1080p', group: 'SubGrp', revision: { version: 2, real: 0, repack: false } }),
    ...overrides,
  });

/** A dual-audio anime Blu-ray: HEVC 10-bit, Japanese FLAC and English AAC. */
const ANIME_PROBE = probe(
  video({ codec: 'hevc', bitDepth: 10 }),
  audio({ codec: 'flac', channels: 2, language: 'ja' }),
  audio({ index: 2, codec: 'aac', channels: 2, language: 'en' }),
);

describe('libraryFileName: anime', () => {
  test('every part: the absolute number, the audio languages and the bit depth, and the revision as `v2`', () => {
    const naming = animeNaming({
      release: release({ quality: 'webdl-1080p', streamingService: 'CR', group: 'SubGrp', revision: { version: 2, real: 0, repack: false } }),
    });
    const hdr = probe(
      video({ codec: 'hevc', bitDepth: 10, hdr: 'hdr10' }),
      audio({ codec: 'aac', channels: 2, language: 'ja' }),
      audio({ index: 2, codec: 'aac', channels: 2, language: 'en' }),
    );
    expect(libraryFileName({ naming, units: [{ season: 1, episode: 2, absolute: 2, title: 'The Journey' }], probe: hdr, ext: '.mkv' })).toBe(
      'Anime (2020) - S01E02 - 002 - The Journey [CR][WEBDL-1080p v2][AAC 2.0][JA+EN][HDR10][h265 10bit]-SubGrp.mkv',
    );
  });

  test('the absolute number has at least three digits', () => {
    expect(libraryFileName({ naming: animeNaming(), units: [{ season: 21, episode: 5, absolute: 1050, title: 'Arc' }], probe: ANIME_PROBE, ext: '.mkv' })).toBe(
      'Anime (2020) - S21E05 - 1050 - Arc [Bluray-1080p v2][FLAC 2.0][JA+EN][h265 10bit]-SubGrp.mkv',
    );
  });

  test('each unknown part is left out with its separator; the bit depth stays without a named codec', () => {
    const bare = animeNaming({ year: undefined, release: release({ quality: 'unknown' }) });
    expect(
      libraryFileName({
        naming: bare,
        units: [{ season: 1, episode: 2 }],
        probe: probe(video({ codec: 'prores', bitDepth: 10 }), audio({ codec: 'aac', channels: 2 })),
        ext: '.mkv',
      }),
    ).toBe('Anime - S01E02 [AAC 2.0][10bit].mkv');
    expect(
      libraryFileName({
        naming: bare,
        units: [{ season: 1, episode: 2, absolute: 2 }],
        probe: probe(audio({ codec: 'aac', channels: 2, language: 'und' })),
        ext: '.mkv',
      }),
    ).toBe('Anime - S01E02 - 002 [AAC 2.0].mkv');
  });

  test('audio languages are deduplicated in stream order, and untagged streams are skipped', () => {
    const streams = probe(
      video({ codec: 'h264' }),
      audio({ codec: 'aac', channels: 2, language: 'ja' }),
      audio({ index: 2, codec: 'aac', channels: 2 }),
      audio({ index: 3, codec: 'aac', channels: 6, language: 'ja' }),
      audio({ index: 4, codec: 'aac', channels: 2, language: 'de' }),
    );
    expect(libraryFileName({ naming: animeNaming(), units: [{ season: 1, episode: 2, absolute: 2, title: 'Arc' }], probe: streams, ext: '.mkv' })).toBe(
      'Anime (2020) - S01E02 - 002 - Arc [Bluray-1080p v2][AAC 2.0][JA+DE][h264 8bit]-SubGrp.mkv',
    );
  });

  test('a multi-episode file names its absolute range', () => {
    const units = [
      { season: 1, episode: 2, absolute: 2, title: 'Two' },
      { season: 1, episode: 1, absolute: 1, title: 'One' },
    ];
    expect(libraryFileName({ naming: animeNaming(), units, probe: ANIME_PROBE, ext: '.mkv' })).toBe(
      'Anime (2020) - S01E01-E02 - 001-002 - One + Two [Bluray-1080p v2][FLAC 2.0][JA+EN][h265 10bit]-SubGrp.mkv',
    );
  });

  test('a series that is not anime has neither the absolute number nor the languages', () => {
    const naming = animeNaming({ anime: false });
    expect(libraryFileName({ naming, units: [{ season: 1, episode: 2, absolute: 2, title: 'Arc' }], probe: ANIME_PROBE, ext: '.mkv' })).toBe(
      'Anime (2020) - S01E02 - Arc [Bluray-1080p Proper][FLAC 2.0][h265]-SubGrp.mkv',
    );
  });
});

const movieNaming = (overrides: Partial<NamingContext> = {}): NamingContext => ({
  kind: 'movie',
  title: 'Film',
  year: 2020,
  tmdbId: 9,
  anime: false,
  release: release({ title: 'Film', quality: 'bluray-1080p', group: 'GRP' }),
  ...overrides,
});

/** A movie's source: H.264 SDR with DTS 5.1. */
const MOVIE_PROBE = probe(video(), audio({ codec: 'dts', channels: 6 }));

describe('libraryFileName: movie', () => {
  test('a movie with every part', () => {
    expect(libraryFileName({ naming: movieNaming(), units: [], probe: MOVIE_PROBE, ext: '.mkv' })).toBe(
      'Film (2020) [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264]-GRP.mkv',
    );
  });

  test('every part', () => {
    const naming = movieNaming({
      release: release({
        quality: 'webdl-2160p',
        streamingService: 'AMZN',
        group: 'GRP',
        edition: { extended: true },
        revision: { version: 2, real: 0, repack: true },
      }),
    });
    const uhd = probe(video({ codec: 'hevc', bitDepth: 10, hdr: 'dv', dv: { profile: 8, compatibility: 1 } }), audio({ codec: 'eac3', channels: 6 }));
    expect(libraryFileName({ naming, units: [{}], probe: uhd, ext: '.mkv' })).toBe(
      'Film (2020) [tmdbid-9] - {Extended} [AMZN][WEBDL-2160p Repack][EAC3 5.1][DV HDR10][h265]-GRP.mkv',
    );
  });

  test('each edition tag', () => {
    const name = (edition: NamingContext['release']['edition']): string =>
      libraryFileName({ naming: movieNaming({ release: release({ quality: 'bluray-1080p', edition }) }), units: [], probe: probe(video()), ext: '.mkv' });
    expect(name({ extended: true })).toBe('Film (2020) [tmdbid-9] - {Extended} [Bluray-1080p][h264].mkv');
    expect(name({ directors: true })).toBe("Film (2020) [tmdbid-9] - {Director's Cut} [Bluray-1080p][h264].mkv");
    expect(name({ unrated: true })).toBe('Film (2020) [tmdbid-9] - {Unrated} [Bluray-1080p][h264].mkv');
    expect(name({ theatrical: true })).toBe('Film (2020) [tmdbid-9] - {Theatrical} [Bluray-1080p][h264].mkv');
    expect(name({ imax: true })).toBe('Film (2020) [tmdbid-9] - {IMAX} [Bluray-1080p][h264].mkv');
    expect(name({ remastered: true })).toBe('Film (2020) [tmdbid-9] - {Remastered} [Bluray-1080p][h264].mkv');
    expect(name({ criterion: true })).toBe('Film (2020) [tmdbid-9] - {Criterion} [Bluray-1080p][h264].mkv');
  });

  test("several editions share one pair of braces, as Radarr's `{Edition Tags}` does; 3D and false flags name none", () => {
    const name = (edition: NamingContext['release']['edition']): string =>
      libraryFileName({ naming: movieNaming({ release: release({ quality: 'bluray-1080p', edition }) }), units: [], probe: probe(video()), ext: '.mkv' });
    expect(name({ imax: true, extended: true })).toBe('Film (2020) [tmdbid-9] - {Extended IMAX} [Bluray-1080p][h264].mkv');
    expect(name({ threeD: true, extended: false })).toBe('Film (2020) [tmdbid-9] - [Bluray-1080p][h264].mkv');
  });

  test('each unknown part is left out with its separator', () => {
    const bare = movieNaming({ year: undefined, release: release({ quality: 'unknown' }) });
    expect(libraryFileName({ naming: bare, units: [], probe: probe(), ext: '.mkv' })).toBe('Film [tmdbid-9].mkv');
    expect(libraryFileName({ naming: movieNaming({ year: undefined }), units: [], probe: MOVIE_PROBE, ext: '.mkv' })).toBe(
      'Film [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264]-GRP.mkv',
    );
    const editionOnly = movieNaming({ release: release({ quality: 'unknown', edition: { extended: true } }) });
    expect(libraryFileName({ naming: editionOnly, units: [], probe: probe(), ext: '.mkv' })).toBe('Film (2020) [tmdbid-9] - {Extended}.mkv');
  });

  test('a series ignores edition flags', () => {
    const naming = seriesNaming({ release: release({ edition: { extended: true }, group: 'GRP' }) });
    expect(libraryFileName({ naming, units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot [WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
    );
  });
});

describe('libraryFileName: at most 240 bytes before the extension', () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  const withoutExt = (s: string): string => s.replace(/\.mkv$/, '');

  test('the episode title is shortened first', () => {
    const name = libraryFileName({
      naming: seriesNaming({ title: 'W'.repeat(100) }),
      units: [{ season: 1, episode: 2, title: 'E'.repeat(90) }],
      probe: EPISODE_PROBE,
      ext: '.mkv',
    });
    expect(name).toBe(`${'W'.repeat(100)} (2019) - S01E02 - ${'E'.repeat(81)} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`);
    expect(bytes(withoutExt(name))).toBe(240);
  });

  test('the cut counts bytes, not characters', () => {
    const name = libraryFileName({
      naming: seriesNaming({ title: 'W'.repeat(100) }),
      units: [{ season: 1, episode: 2, title: 'あ'.repeat(40) }],
      probe: EPISODE_PROBE,
      ext: '.mkv',
    });
    expect(name).toBe(`${'W'.repeat(100)} (2019) - S01E02 - ${'あ'.repeat(27)} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`);
  });

  test('the shortened title loses the spaces and dots its cut leaves at the end', () => {
    const name = libraryFileName({
      naming: seriesNaming({ title: 'W'.repeat(100) }),
      units: [{ season: 1, episode: 2, title: `${'E'.repeat(78)}.. More` }],
      probe: EPISODE_PROBE,
      ext: '.mkv',
    });
    expect(name).toBe(`${'W'.repeat(100)} (2019) - S01E02 - ${'E'.repeat(78)} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`);
  });

  test('when the title is gone and the name is still too long, CustomFormats is dropped', () => {
    const name = libraryFileName({ naming: seriesNaming({ title: 'W'.repeat(190) }), units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' });
    expect(name).toBe(`${'W'.repeat(190)} (2019) - S01E02 [WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`);
    expect(bytes(withoutExt(name))).toBe(240);
  });

  test('then the anime AudioLanguages', () => {
    const naming = animeNaming({ title: 'W'.repeat(176), release: release({ quality: 'webdl-1080p', streamingService: 'CR', group: 'SubGrp' }) });
    const dual = probe(
      video({ codec: 'hevc', bitDepth: 10 }),
      audio({ codec: 'aac', channels: 2, language: 'ja' }),
      audio({ index: 2, codec: 'aac', channels: 2, language: 'en' }),
    );
    const name = libraryFileName({ naming, units: [{ season: 1, episode: 2, absolute: 2, title: 'Arc' }], probe: dual, ext: '.mkv' });
    expect(name).toBe(`${'W'.repeat(176)} (2020) - S01E02 - 002 [WEBDL-1080p][AAC 2.0][h265 10bit]-SubGrp.mkv`);
    expect(bytes(withoutExt(name))).toBe(240);
  });

  test('as a last resort the Work title is cut', () => {
    const name = libraryFileName({ naming: movieNaming({ title: 'W'.repeat(300) }), units: [], probe: MOVIE_PROBE, ext: '.mkv' });
    expect(name).toBe(`${'W'.repeat(186)} (2020) [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264]-GRP.mkv`);
    expect(bytes(withoutExt(name))).toBe(240);
  });

  test('the extension does not count', () => {
    const name = libraryFileName({ naming: seriesNaming({ title: 'W'.repeat(190) }), units: [PILOT], probe: EPISODE_PROBE, ext: '.extension' });
    expect(name).toBe(`${'W'.repeat(190)} (2019) - S01E02 [WEBDL-1080p][EAC3 5.1][h264]-GRP.extension`);
  });
});

// Jellyfin 12.4 files a name as an extra when, without its extension and
// trailing digits and ignoring case, it ends in a suffix. A TRaSH name
// otherwise ends in `]` (a bracket part), `}` (a movie's editions) or `)`, so
// only `-{Group}` can end it in one. Every listed suffix can come from a
// group: the parser's groups hold dots (`YTS.MX`) and underscores
// (`Koten_Gars`), and an anime subgroup from a leading `[...]` may hold spaces
// (`[Fan - Trailer]`), so each suffix gets a case.
describe('libraryFileName: the extras-suffix rewrite', () => {
  const name = (group: string): string =>
    libraryFileName({ naming: seriesNaming({ release: release({ streamingService: 'AMZN', group }) }), units: [PILOT], probe: EPISODE_PROBE, ext: '.mkv' });

  const BASE = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]';
  const CASES: Record<string, [group: string, expected: string]> = {
    '-trailer': ['Trailer', `${BASE}[Trailer].mkv`],
    '.trailer': ['Fan.Trailer', `${BASE}[Fan.Trailer].mkv`],
    _trailer: ['Fan_Trailer', `${BASE}[Fan_Trailer].mkv`],
    '- trailer': ['Fan - Trailer', `${BASE}[Fan - Trailer].mkv`],
    '-sample': ['SAMPLE', `${BASE}[SAMPLE].mkv`],
    '.sample': ['Fan.Sample', `${BASE}[Fan.Sample].mkv`],
    _sample: ['Fan_Sample', `${BASE}[Fan_Sample].mkv`],
    '- sample': ['Fan - Sample', `${BASE}[Fan - Sample].mkv`],
    '-scene': ['SCENE', `${BASE}[SCENE].mkv`],
    '-clip': ['Clip', `${BASE}[Clip].mkv`],
    '-interview': ['Interview', `${BASE}[Interview].mkv`],
    '-behindthescenes': ['BehindTheScenes', `${BASE}[BehindTheScenes].mkv`],
    '-deleted': ['Deleted', `${BASE}[Deleted].mkv`],
    '-deletedscene': ['DeletedScene', `${BASE}[DeletedScene].mkv`],
    '-featurette': ['Featurette', `${BASE}[Featurette].mkv`],
    '-short': ['Short', `${BASE}[Short].mkv`],
    '-extra': ['EXTRA', `${BASE}[EXTRA].mkv`],
    '-other': ['OTHER', `${BASE}[OTHER].mkv`],
  };

  test('each suffix has a case', () => {
    expect(Object.keys(CASES).sort()).toEqual([...JELLYFIN_EXTRAS_SUFFIXES].sort());
  });

  for (const [suffix, [group, expected]] of Object.entries(CASES)) {
    test(`a group that ends the name in \`${suffix}\` is written in brackets`, () => {
      expect(name(group)).toBe(expected);
    });
  }

  test('trailing digits and mixed case still match', () => {
    expect(name('Other2')).toBe(`${BASE}[Other2].mkv`);
    expect(name('oThEr')).toBe(`${BASE}[oThEr].mkv`);
    expect(name('Scene123')).toBe(`${BASE}[Scene123].mkv`);
  });

  test("a group that contains a suffix without ending in one keeps TRaSH's `-{Group}`", () => {
    expect(name('OTHERS')).toBe(`${BASE}-OTHERS.mkv`);
    expect(name('Shorty')).toBe(`${BASE}-Shorty.mkv`);
    expect(name('SampleGrp')).toBe(`${BASE}-SampleGrp.mkv`);
    expect(name('GRP')).toBe(`${BASE}-GRP.mkv`);
  });

  test("a movie's group is rewritten the same way", () => {
    expect(
      libraryFileName({ naming: movieNaming({ release: release({ quality: 'bluray-1080p', group: 'OTHER' }) }), units: [], probe: MOVIE_PROBE, ext: '.mkv' }),
    ).toBe('Film (2020) [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264][OTHER].mkv');
  });

  test('a name with no bracket part and no group, which the episode title would end in a suffix, leaves the title out', () => {
    const bare = seriesNaming({ release: release({ quality: 'unknown' }) });
    const unnamed = probe(video({ codec: 'prores' }));
    expect(libraryFileName({ naming: bare, units: [{ season: 1, episode: 2, title: 'Trailer' }], probe: unnamed, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02.mkv',
    );
    expect(libraryFileName({ naming: bare, units: [{ season: 1, episode: 2, title: 'The Re-Short2' }], probe: unnamed, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02.mkv',
    );
    expect(libraryFileName({ naming: bare, units: [{ season: 1, episode: 2, title: 'Pilot' }], probe: unnamed, ext: '.mkv' })).toBe(
      'Show (2019) - S01E02 - Pilot.mkv',
    );
  });

  test('the group is cleaned like a title', () => {
    expect(name('A/B<C>')).toBe(`${BASE}-ABC.mkv`);
  });
});

describe('workFolderName', () => {
  test('a series and a movie folder carry the title, the year and the TMDB ID tag', () => {
    expect(workFolderName({ kind: 'series', title: 'Show', year: 2019, tmdbId: 1 })).toBe('Show (2019) [tmdbid-1]');
    expect(workFolderName({ kind: 'movie', title: 'Film', year: 2020, tmdbId: 9 })).toBe('Film (2020) [tmdbid-9]');
  });

  test('without a year the folder is `{Title} [tmdbid-{tmdbId}]`', () => {
    expect(workFolderName({ kind: 'series', title: 'Show', tmdbId: 1 })).toBe('Show [tmdbid-1]');
  });

  test('the title is cleaned', () => {
    expect(workFolderName({ kind: 'movie', title: 'Mission: Impossible?', year: 1996, tmdbId: 954 })).toBe('Mission - Impossible (1996) [tmdbid-954]');
  });
});

describe('folderTitle', () => {
  test('reads the title and year of a folder the platform named', () => {
    expect(folderTitle('Show (2019) [tmdbid-1]')).toEqual({ title: 'Show', year: 2019 });
    expect(folderTitle('Show [tmdbid-1]')).toEqual({ title: 'Show' });
  });

  test("reads scanned folders: Sonarr's and Radarr's ID tags, no tag, no year", () => {
    expect(folderTitle('Film (2020) {tmdb-9}')).toEqual({ title: 'Film', year: 2020 });
    expect(folderTitle('Show (2019) {tvdb-81189}')).toEqual({ title: 'Show', year: 2019 });
    expect(folderTitle('Film (2020) [imdbid-tt0111161]')).toEqual({ title: 'Film', year: 2020 });
    expect(folderTitle('Show (2019)')).toEqual({ title: 'Show', year: 2019 });
    expect(folderTitle('Show')).toEqual({ title: 'Show' });
  });

  test('a year inside the title is part of the title', () => {
    expect(folderTitle('Blade Runner 2049 (2017) [tmdbid-335984]')).toEqual({ title: 'Blade Runner 2049', year: 2017 });
    expect(folderTitle('1917 [tmdbid-530915]')).toEqual({ title: '1917' });
  });

  test('takes the base of a stored path', () => {
    expect(folderTitle('series/Show (2019) [tmdbid-1]')).toEqual({ title: 'Show', year: 2019 });
  });
});

describe('seasonFolderFor', () => {
  test('without a folder for the season, it is `Season {00}`, specials `Season 00`', () => {
    expect(seasonFolderFor([], 1)).toBe('Season 01');
    expect(seasonFolderFor(['Season 02'], 1)).toBe('Season 01');
    expect(seasonFolderFor([], 12)).toBe('Season 12');
    expect(seasonFolderFor([], 0)).toBe('Season 00');
  });

  test('an existing folder for that season under another spelling is reused, matched by number', () => {
    expect(seasonFolderFor(['Season 1', 'Season 2'], 1)).toBe('Season 1');
    expect(seasonFolderFor(['Season 01'], 1)).toBe('Season 01');
    expect(seasonFolderFor(['S01', 'S02'], 2)).toBe('S02');
    expect(seasonFolderFor(['season 3'], 3)).toBe('season 3');
    expect(seasonFolderFor(['Season 10'], 1)).toBe('Season 01');
  });

  test("Sonarr's `Specials` folder holds season 0", () => {
    expect(seasonFolderFor(['Specials', 'Season 1'], 0)).toBe('Specials');
    expect(seasonFolderFor(['Season 0'], 0)).toBe('Season 0');
  });

  test('other folders are not seasons', () => {
    expect(seasonFolderFor(['extras', 'Season One', 'S01E01'], 1)).toBe('Season 01');
  });

  test("when two spellings exist, the platform's own one wins", () => {
    expect(seasonFolderFor(['Season 1', 'Season 01'], 1)).toBe('Season 01');
  });
});

describe('sidecarOf: a subtitle file beside a video, by the sidecar naming rule', () => {
  test('the base name, then a language, SDH and forced flags and a number in any order, then srt or ass', () => {
    expect(sidecarOf('clip_0001', 'clip_0001.srt')).toEqual({ forced: false, sdh: false, format: 'srt' });
    expect(sidecarOf('clip_0001', 'clip_0001.en.srt')).toEqual({ language: 'en', forced: false, sdh: false, format: 'srt' });
    expect(sidecarOf('clip_0001', 'clip_0001.de.forced.ass')).toEqual({ language: 'de', forced: true, sdh: false, format: 'ass' });
    expect(sidecarOf('clip_0001', 'clip_0001.EN.SDH.2.srt')).toEqual({ language: 'en', forced: false, sdh: true, format: 'srt' });
    // Jellyfin's other spellings: ISO 639-2 and `hi` or `cc` for hearing impaired.
    expect(sidecarOf('clip_0001', 'clip_0001.ger.hi.srt')).toEqual({ language: 'de', forced: false, sdh: true, format: 'srt' });
  });

  test('another base, another extension, or an unknown word is no sidecar of this video, or no language', () => {
    expect(sidecarOf('clip_0001', 'clip_0002.en.srt')).toBeUndefined();
    expect(sidecarOf('clip_0001', 'clip_0001.mp4')).toBeUndefined();
    expect(sidecarOf('clip_0001', 'clip_0001.en.vtt')).toBeUndefined();
    expect(sidecarOf('clip_0001', 'clip_0001.English.srt')).toEqual({ forced: false, sdh: false, format: 'srt' });
  });

  test("sidecarName's names read back as their sidecars", () => {
    const sidecar = { language: 'ja', sdh: true, forced: true, format: 'ass' } as const;
    expect(sidecarOf('Show - S01E02', sidecarName('Show - S01E02', sidecar, new Set()))).toEqual(sidecar);
  });
});

describe('sidecarName', () => {
  const BASE = 'Show (2019) - S01E02 - Pilot [WEBDL-1080p][AAC 2.0][h264]-GRP';

  test("`<base>.<lang>[.sdh][.forced].<srt|ass>`, Jellyfin's flags", () => {
    expect(sidecarName(BASE, { language: 'en', sdh: false, forced: false, format: 'srt' }, new Set())).toBe(`${BASE}.en.srt`);
    expect(sidecarName(BASE, { language: 'en', sdh: true, forced: false, format: 'srt' }, new Set())).toBe(`${BASE}.en.sdh.srt`);
    expect(sidecarName(BASE, { language: 'de', sdh: false, forced: true, format: 'ass' }, new Set())).toBe(`${BASE}.de.forced.ass`);
    expect(sidecarName(BASE, { language: 'ja', sdh: true, forced: true, format: 'ass' }, new Set())).toBe(`${BASE}.ja.sdh.forced.ass`);
  });

  test('the language is left out when absent or `und`', () => {
    expect(sidecarName(BASE, { sdh: false, forced: false, format: 'srt' }, new Set())).toBe(`${BASE}.srt`);
    expect(sidecarName(BASE, { language: 'und', sdh: false, forced: true, format: 'srt' }, new Set())).toBe(`${BASE}.forced.srt`);
  });

  test('a second and third track with the same language and flags get `.<n>` before the extension, and each name is taken', () => {
    const taken = new Set<string>();
    const english = { language: 'en', sdh: false, forced: false, format: 'srt' } as const;
    expect(sidecarName(BASE, english, taken)).toBe(`${BASE}.en.srt`);
    expect(sidecarName(BASE, english, taken)).toBe(`${BASE}.en.2.srt`);
    expect(sidecarName(BASE, english, taken)).toBe(`${BASE}.en.3.srt`);
    expect(sidecarName(BASE, { ...english, forced: true }, taken)).toBe(`${BASE}.en.forced.srt`);
    expect(taken).toEqual(new Set([`${BASE}.en.srt`, `${BASE}.en.2.srt`, `${BASE}.en.3.srt`, `${BASE}.en.forced.srt`]));
  });

  test('names the caller already holds are skipped', () => {
    const taken = new Set([`${BASE}.en.srt`, `${BASE}.en.2.srt`]);
    expect(sidecarName(BASE, { language: 'en', sdh: false, forced: false, format: 'srt' }, taken)).toBe(`${BASE}.en.3.srt`);
  });
});

describe('trashQualityLabel', () => {
  test("every quality has TRaSH's label, and `unknown` has none", () => {
    const labels: Record<QualityId, string | undefined> = {
      'remux-2160p': 'Remux-2160p',
      'bluray-2160p': 'Bluray-2160p',
      'webdl-2160p': 'WEBDL-2160p',
      'webrip-2160p': 'WEBRip-2160p',
      'hdtv-2160p': 'HDTV-2160p',
      'remux-1080p': 'Remux-1080p',
      'bluray-1080p': 'Bluray-1080p',
      'webdl-1080p': 'WEBDL-1080p',
      'webrip-1080p': 'WEBRip-1080p',
      'hdtv-1080p': 'HDTV-1080p',
      'bluray-720p': 'Bluray-720p',
      'webdl-720p': 'WEBDL-720p',
      'webrip-720p': 'WEBRip-720p',
      'hdtv-720p': 'HDTV-720p',
      'bluray-576p': 'Bluray-576p',
      'bluray-480p': 'Bluray-480p',
      'webdl-480p': 'WEBDL-480p',
      'webrip-480p': 'WEBRip-480p',
      dvd: 'DVD',
      sdtv: 'SDTV',
      brdisk: 'BR-DISK',
      rawhd: 'Raw-HD',
      workprint: 'WORKPRINT',
      telecine: 'TELECINE',
      telesync: 'TELESYNC',
      screener: 'DVDSCR',
      cam: 'CAM',
      unknown: undefined,
    };
    for (const quality of QualityId.options) expect(trashQualityLabel(quality), quality).toBe(labels[quality]);
  });

  test('a first release has no revision tag; a PROPER and a REPACK get theirs', () => {
    expect(trashQualityLabel('webdl-1080p', { version: 1, real: 0, repack: false })).toBe('WEBDL-1080p');
    expect(trashQualityLabel('webdl-1080p', { version: 2, real: 0, repack: false })).toBe('WEBDL-1080p Proper');
    expect(trashQualityLabel('bluray-1080p', { version: 2, real: 1, repack: false })).toBe('Bluray-1080p Proper');
    expect(trashQualityLabel('webdl-1080p', { version: 2, real: 0, repack: true })).toBe('WEBDL-1080p Repack');
  });

  test('an anime release writes its version instead, as Sonarr does for the anime series type', () => {
    expect(trashQualityLabel('webdl-1080p', { version: 2, real: 0, repack: false }, { anime: true })).toBe('WEBDL-1080p v2');
    expect(trashQualityLabel('bluray-1080p', { version: 3, real: 0, repack: false }, { anime: true })).toBe('Bluray-1080p v3');
    expect(trashQualityLabel('webdl-1080p', { version: 1, real: 0, repack: false }, { anime: true })).toBe('WEBDL-1080p');
  });

  test('`unknown` has no label even with a revision', () => {
    expect(trashQualityLabel('unknown', { version: 2, real: 0, repack: true })).toBeUndefined();
  });
});

describe('isPlaceholderTitle', () => {
  test("an empty or absent title and TMDB's `Episode <n>` are placeholders", () => {
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('  ')).toBe(true);
    expect(isPlaceholderTitle('Episode 5')).toBe(true);
    expect(isPlaceholderTitle('Episode 12')).toBe(true);
  });

  test('a real title is not, even one that starts with "Episode"', () => {
    expect(isPlaceholderTitle('Pilot')).toBe(false);
    expect(isPlaceholderTitle('Episode 5: The Return')).toBe(false);
    expect(isPlaceholderTitle('The Episode 5')).toBe(false);
  });
});
