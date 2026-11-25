import { describe, expect, test } from 'vite-plus/test';

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

  test.each([
    ['Lantern Keeper S02E01.v10', 10],
    ['Lantern Keeper S02E01-12.v3 [1080p]', 3],
    ['Lantern Keeper S02E01v2', 2],
    ['Lantern Keeper S02E01.v1000', 1000],
  ])('reads the version written after the episode mark in %s, which the library drops', (cleanTitle, version) => {
    expect(numbers(cleanTitle, release({ episodes: [{ season: 2, episode: 1 }] })).revision.version).toBe(version);
  });

  test('a word starting with v after the episode mark is no version, so the library revision stays', () => {
    expect(numbers('Lantern Keeper S02E01v2rip', release({ episodes: [{ season: 2, episode: 1 }] })).revision.version).toBe(1);
    expect(numbers('Lantern Keeper S02E01.v2rip', release({ episodes: [{ season: 2, episode: 1 }] })).revision.version).toBe(1);
  });
});
