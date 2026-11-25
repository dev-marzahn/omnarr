import { describe, expect, test } from 'vite-plus/test';

import { parseRelease } from '../../src/index.ts';
import { numbers } from '../../src/passes/numbers.ts';
import { release } from './release.ts';

describe('numbers (pass 2)', () => {
  test('reads S01E05 (1071)-style dual numbering into the episode', () => {
    const partial = release({ title: 'Lantern Keeper', episodes: [{ season: 2, episode: 5 }] });
    expect(numbers('[Fansub] Lantern Keeper S02E05 (1071) [1080p]', partial).episodes).toEqual([{ season: 2, episode: 5, absolute: 1071 }]);
  });

  test('reads dual numbering after a dash too', () => {
    const partial = release({ title: 'Lantern Keeper', episodes: [{ season: 2, episode: 5 }] });
    expect(numbers('Lantern Keeper - S02E05 - 1071 [1080p]', partial).episodes).toEqual([{ season: 2, episode: 5, absolute: 1071 }]);
  });

  test('does not read a year in brackets, or a resolution, as an absolute number', () => {
    const partial = release({ episodes: [{ season: 1, episode: 2 }] });
    expect(numbers('The Long Harbor S01E02 (2021) 1080p', partial).episodes).toEqual([{ season: 1, episode: 2 }]);
    expect(numbers('The Long Harbor S01E02 (1080p)', partial).episodes).toEqual([{ season: 1, episode: 2 }]);
  });

  test('leaves multi-episode releases alone', () => {
    const partial = release({
      episodes: [
        { season: 1, episode: 2 },
        { season: 1, episode: 3 },
      ],
    });
    expect(numbers('The Long Harbor S01E02E03 (1071) 1080p', partial).episodes).toEqual(partial.episodes);
  });

  test('reads a year before the first quality token when the library gave none', () => {
    expect(numbers('The.Long.Harbor.2021.S01E01.1080p.WEB.h264-GRPA', release({ title: 'The Long Harbor 2021' })).year).toBe(2021);
  });

  test('takes no year from after a quality token', () => {
    expect(numbers('The.Long.Harbor.S01E01.1080p.WEB.h264-2049', release()).year).toBeUndefined();
  });

  test('takes no year from a title that is a year, or from an air date', () => {
    expect(numbers('1923.S01E01.1080p.WEB.h264-GRPA', release({ title: '1923' })).year).toBeUndefined();
    expect(numbers('Daily.Talk.2024.10.05.720p.HDTV.x264-GRPC', release({ title: 'Daily Talk', airDate: '2024-10-05' })).year).toBeUndefined();
  });

  test('takes no year from a date in an episode title', () => {
    expect(
      numbers('Quiet.Signal.S01E155.Capitulo.de.16.11.2026.1080p.WEB', release({ title: 'Quiet Signal', episodes: [{ season: 1, episode: 155 }] })).year,
    ).toBeUndefined();
    expect(
      numbers('Quiet.Signal.S01E156.2026.11.17.1080p.WEB', release({ title: 'Quiet Signal', episodes: [{ season: 1, episode: 156 }] })).year,
    ).toBeUndefined();
  });

  test('takes a year written after the episode numbers', () => {
    expect(numbers('Quiet.Signal.S01E02.2026.1080p.WEB', release({ title: 'Quiet Signal', episodes: [{ season: 1, episode: 2 }] })).year).toBe(2026);
  });

  test('a year the library read as SxxEyy in a series search is a year, not an episode', () => {
    const fromYear = release({ title: 'Quiet Orchard', episodes: [{ season: 19, episode: 95 }] });
    expect(numbers('Quiet.Orchard.1995.BluRay.1080p.x264-GRPB', fromYear)).toMatchObject({ episodes: [], year: 1995 });
    const realEpisode = release({ title: 'Quiet Orchard', episodes: [{ season: 19, episode: 95 }] });
    expect(numbers('Quiet.Orchard.S19E95.1080p', realEpisode).episodes).toEqual([{ season: 19, episode: 95 }]);
  });

  test('keeps the library year', () => {
    expect(numbers('Quiet.Orchard.2023.1080p', release({ year: 2023 })).year).toBe(2023);
  });

  test('marks season 0 as a special', () => {
    expect(numbers('The.Long.Harbor.S00E05.1080p', release({ episodes: [{ season: 0, episode: 5 }] })).special).toBe(true);
  });
});

// The library reads a fansub `S2-01` as a season pack (or `S2-05` as seasons 2 to 5); it is one episode.
describe('a fansub season-numbered episode, `[Group] Title S2-01` or `Title S2-01` (parseRelease)', () => {
  const episodeOf = (title: string) => {
    const { episodes, pack, revision, special } = parseRelease(title, 'series');
    return { episodes, pack, revision, special };
  };

  test('S2-01v2 is season 2, episode 1, version 2, and not a pack', () => {
    expect(episodeOf('[SubsPlease] Otonari no Tenshi-sama ni Itsunomanika Dame Ningen ni Sareteita Ken S2-01v2 [1080p] [6504C9CC]')).toEqual({
      episodes: [{ season: 2, episode: 1 }],
      pack: undefined,
      revision: { version: 2, real: 0, repack: false },
      special: false,
    });
  });

  test('S2-01 is S2E1', () => {
    expect(episodeOf('[SubsPlease] Otonari no Tenshi-sama ni Itsunomanika Dame Ningen ni Sareteita Ken S2-01 [480p] [95FC520B]')).toMatchObject({
      episodes: [{ season: 2, episode: 1 }],
      pack: undefined,
      revision: { version: 1 },
    });
  });

  test('without a group in front, S2-01 is S2E1 and the season mark leaves the title', () => {
    expect(parseRelease('Lantern Keeper S2-01', 'series')).toMatchObject({
      title: 'Lantern Keeper',
      normalizedTitle: 'lantern keeper',
      episodes: [{ season: 2, episode: 1 }],
    });
    expect(episodeOf('Lantern Keeper S2-01 [1080p]')).toMatchObject({ episodes: [{ season: 2, episode: 1 }], pack: undefined });
    expect(episodeOf('Lantern.Keeper.S2-01.1080p.WEB.h264-GRP')).toMatchObject({ episodes: [{ season: 2, episode: 1 }], pack: undefined });
  });

  test('without a group in front, the version after S2-01 is the revision, not the group', () => {
    const release = parseRelease('Lantern Keeper S2-01v2', 'series');
    expect(release).toMatchObject({ episodes: [{ season: 2, episode: 1 }], revision: { version: 2 } });
    expect(release.group).toBeUndefined();
  });

  test('without a group in front, the season mark leaves the title wherever the library left it', () => {
    expect(parseRelease('Lantern.Keeper.S2-01.2019.1080p.WEB-GRP', 'series')).toMatchObject({
      title: 'Lantern Keeper',
      episodes: [{ season: 2, episode: 1 }],
      year: 2019,
    });
  });

  test('without a group in front, an episode above the season is a season range, as S1-10 packs are written', () => {
    expect(episodeOf('Lantern Keeper S1-10 Complete 1080p').pack).toEqual({ seasons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], full: true });
    expect(episodeOf('Lantern.Keeper.S2-05.1080p.WEB.h264-GRP').pack).toEqual({ seasons: [2, 3, 4, 5], full: true });
    expect(episodeOf('Lantern Keeper S10-12').pack).toEqual({ seasons: [10, 11, 12], full: true });
  });

  test('a resolution after the dash is no episode', () => {
    expect(episodeOf('Lantern Keeper S2-1080p')).toMatchObject({ episodes: [{ season: 2 }], pack: { seasons: [2], full: true } });
    expect(episodeOf('Lantern.Keeper.S2-480p.WEB')).toMatchObject({ episodes: [{ season: 2 }], pack: { seasons: [2], full: true } });
  });

  test('a group with nothing after the episode keeps its name, and a season mark in the title stays', () => {
    expect(parseRelease('[Grp] Lantern Keeper S2-01v2', 'series')).toMatchObject({
      group: 'Grp',
      episodes: [{ season: 2, episode: 1 }],
      revision: { version: 2 },
    });
    expect(parseRelease('S2 Lantern Keeper S2-01', 'series')).toMatchObject({ title: 'S2 Lantern Keeper', episodes: [{ season: 2, episode: 1 }] });
  });

  test('an SxxEyy the library read stays', () => {
    expect(episodeOf('Lantern Keeper S01E05 S2-10').episodes).toEqual([{ season: 1, episode: 5 }]);
    expect(episodeOf('Lantern.Keeper.S03E04.S2-01').episodes).toEqual([{ season: 3, episode: 4 }]);
  });

  test('S2-00 is episode 0 of season 2, never a pack and not a special', () => {
    expect(episodeOf('[SubsPlease] Tsue to Tsurugi no Wistoria S2-00 [1080p] [A1F31848]')).toMatchObject({
      episodes: [{ season: 2, episode: 0 }],
      pack: undefined,
      special: false,
    });
  });

  test('a two-digit season, and an episode above the season, which the library reads as a season range', () => {
    expect(episodeOf('[SubsPlease] Lantern Keeper S12-03 (1080p) [A1F31848]')).toMatchObject({ episodes: [{ season: 12, episode: 3 }], pack: undefined });
    expect(episodeOf('[SubsPlease] Lantern Keeper S2-05 (1080p) [A1F31848]')).toMatchObject({ episodes: [{ season: 2, episode: 5 }], pack: undefined });
  });

  test('the spaced form keeps its reading: title with the season mark, and an absolute number read within that season', () => {
    const spaced = parseRelease('[SubsPlease] Tsue to Tsurugi no Wistoria S2 - 01 (1080p) [A1F31848]', 'series');
    expect(spaced).toMatchObject({ title: 'Tsue to Tsurugi no Wistoria S2', episodes: [{ absolute: 1 }] });
    expect(spaced.pack).toBeUndefined();
    expect(episodeOf('[SubsPlease] Lantern Keeper S2 - 01-12 (1080p) [Batch]').episodes).toEqual(Array.from({ length: 12 }, (_, i) => ({ absolute: i + 1 })));
  });

  test('season packs and season ranges stay packs', () => {
    expect(episodeOf('Lantern.Keeper.S02.1080p.WEB.h264-OldT')).toMatchObject({ episodes: [{ season: 2 }], pack: { seasons: [2], full: true } });
    expect(episodeOf('Lantern Keeper S02 1080p WEB h264-OldT')).toMatchObject({ episodes: [{ season: 2 }], pack: { seasons: [2], full: true } });
    expect(episodeOf('[SubsPlease] Lantern Keeper S2 Batch (1080p)')).toMatchObject({ episodes: [{ season: 2 }], pack: { seasons: [2], full: true } });
    expect(episodeOf('[Grp] Lantern Keeper S01-03 (1080p)').pack).toEqual({ seasons: [1, 2, 3], full: true });
    expect(episodeOf('[Grp] Lantern Keeper S1-3 (1080p)').pack).toEqual({ seasons: [1, 2, 3], full: true });
    expect(episodeOf('Lantern.Keeper.S01-03.1080p.BluRay.x264-GRP').pack).toEqual({ seasons: [1, 2, 3], full: true });
    expect(episodeOf('Lantern Keeper S01-03').pack).toEqual({ seasons: [1, 2, 3], full: true });
    expect(episodeOf('Lantern Keeper S1-3').pack).toEqual({ seasons: [1, 2, 3], full: true });
  });

  test('absolute numbers, SxxEyy and titles with numbers and dashes are unchanged', () => {
    expect(parseRelease('[SubsPlease] Lantern Keeper - 01v2 (1080p) [A1F31848]', 'series')).toMatchObject({
      episodes: [{ absolute: 1 }],
      revision: { version: 2 },
    });
    expect(episodeOf('Lantern.Keeper.S01E01.1080p.WEB.h264-GRP').episodes).toEqual([{ season: 1, episode: 1 }]);
    expect(parseRelease('[SubsPlease] Mob Psycho 100 S3 - 01 (1080p) [A1F31848]', 'series')).toMatchObject({
      title: 'Mob Psycho 100 S3',
      episodes: [{ absolute: 1 }],
    });
    expect(parseRelease('[SubsPlease] 86 - Eighty Six - 01 (1080p) [A1F31848]', 'series')).toMatchObject({
      title: '86 - Eighty Six',
      episodes: [{ absolute: 1 }],
    });
    expect(episodeOf('[SubsPlease] 2.5-jigen no Ririsa - 01 (1080p) [A1F31848]').episodes).toEqual([{ absolute: 1 }]);
  });
});
