import type { IndexerItem } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { describe, expect, test } from 'vite-plus/test';

import type { Id } from '../src/ids.ts';
import { filterWorks, matchTitle, matchUnits, type ResolveResult, type WorkForMatch } from '../src/match.ts';
import { release } from './release.ts';

const alias = (id: string) => id as Id<'workAliases'>;
const unit = (id: string) => id as Id<'units'>;

const harbor: WorkForMatch = {
  kind: 'series',
  year: 2021,
  aliases: [
    { aliasId: alias('a1'), normalized: 'the long harbor' },
    { aliasId: alias('a2'), normalized: 'long harbor' },
  ],
  ids: { tmdb: '900001', tvdb: '7700001', imdb: 'tt9900001' },
};
const keeper: WorkForMatch = {
  kind: 'series',
  aliases: [
    { aliasId: alias('k1'), normalized: 'lantern keeper' },
    { aliasId: alias('k2'), normalized: 'lantern keeper s2', anidbId: 4242 },
  ],
  ids: { tmdb: '900002' },
};
const orchard: WorkForMatch = {
  kind: 'movie',
  year: 2023,
  aliases: [{ aliasId: alias('o1'), normalized: 'quiet orchard' }],
  ids: { tmdb: '900101', imdb: 'tt9900101' },
};

const item = (overrides: Partial<IndexerItem> = {}): IndexerItem => ({
  guid: 'g',
  title: 't',
  downloadUrl: 'https://indexer.example/g.nzb',
  sizeBytes: 1,
  protocol: 'usenet',
  publishedAt: 0,
  categories: [5000],
  ids: {},
  ...overrides,
});
const episode = { episodes: [{ season: 1, episode: 2 }] };

describe('matchTitle', () => {
  test('matches an alias by normalized title and returns it', () => {
    expect(matchTitle(release({ normalizedTitle: 'long harbor', ...episode }), item(), harbor)).toEqual({ ok: true, aliasId: 'a2' });
  });

  test('returns the AniDB ID of the alias that matched', () => {
    const parsed = release({ normalizedTitle: 'lantern keeper s2', episodes: [{ absolute: 5 }] });
    expect(matchTitle(parsed, item(), keeper)).toEqual({ ok: true, aliasId: 'k2', anidbId: 4242 });
  });

  test('rejects another title', () => {
    expect(matchTitle(release({ normalizedTitle: 'the long harbour tales', ...episode }), item(), harbor)).toEqual({ ok: false, detail: 'title' });
  });

  describe('hyphens (normalizeTitle deletes them)', () => {
    const mori: WorkForMatch = {
      kind: 'series',
      // "Mori-sama Keeps Watch" and "Mori-sama: Ember Arc", normalized.
      aliases: [
        { aliasId: alias('m1'), normalized: 'morisama keeps watch' },
        { aliasId: alias('m2'), normalized: 'mori sama ember arc', anidbId: 5151 },
      ],
      ids: { tmdb: '900009' },
    };
    const anime = { episodes: [{ absolute: 3 }] };

    test('a release without the hyphen matches the hyphenated alias', () => {
      expect(matchTitle(release({ normalizedTitle: 'mori sama keeps watch', ...anime }), item(), mori)).toEqual({ ok: true, aliasId: 'm1' });
    });

    test('a hyphenated release matches the alias without it, with its AniDB entry', () => {
      expect(matchTitle(release({ normalizedTitle: 'morisamaember arc', ...anime }), item(), mori)).toEqual({ ok: true, aliasId: 'm2', anidbId: 5151 });
    });
  });

  describe('a season named after an alias', () => {
    const anime = { episodes: [{ absolute: 2 }] };

    test.each(['long harbor s2', 'long harbor s02', 'long harbor season 2', 'long harbor 2nd season'])(
      '%s matches long harbor with season 2, without an ID',
      (title) => {
        expect(matchTitle(release({ normalizedTitle: title, ...anime }), item(), harbor)).toEqual({ ok: true, aliasId: 'a2', season: 2 });
      },
    );

    test("an AniDB-linked alias's season comes from its entry, not the title", () => {
      expect(matchTitle(release({ normalizedTitle: 'lantern keeper s2', ...anime }), item(), keeper)).toEqual({ ok: true, aliasId: 'k2', anidbId: 4242 });
    });

    test('a Work whose own name ends in a season, with no alias before it, names no season', () => {
      const sequel: WorkForMatch = { kind: 'series', aliases: [{ aliasId: alias('q1'), normalized: 'quiet signal 2nd season' }], ids: { tmdb: '900010' } };
      expect(matchTitle(release({ normalizedTitle: 'quiet signal 2nd season', ...anime }), item(), sequel)).toEqual({ ok: true, aliasId: 'q1' });
    });
  });

  describe('a dual title, `中文名 / English Title` (test-install backlog)', () => {
    const lantern: WorkForMatch = {
      kind: 'series',
      aliases: [
        { aliasId: alias('s1'), normalized: 'star lantern' },
        { aliasId: alias('s2'), normalized: '星之灯笼' },
      ],
      ids: { tmdb: '900020' },
    };
    const english: WorkForMatch = { ...lantern, aliases: [lantern.aliases[0]!] };
    const chinese: WorkForMatch = { ...lantern, aliases: [lantern.aliases[1]!] };
    const parse = (title: string) => parseRelease(title, 'series');

    test.each([
      ['[Group] 星之灯笼 / Star Lantern - 04 [1080p]', english, 's1'],
      ['[Group] 星之灯笼 / Star Lantern - 04 [1080p]', chinese, 's2'],
      ['[Group] Star Lantern / 星之灯笼 - 04 [1080p]', english, 's1'],
      ['[Group] 星之灯笼/Star Lantern - 04 [1080p]', english, 's1'],
      ['[Group] 星之灯笼 / 星の灯籠 / Star Lantern - 04 [1080p]', english, 's1'],
    ])('%s matches through either side (%#)', (title, work, aliasId) => {
      expect(matchTitle(parse(title), item(), work)).toEqual({ ok: true, aliasId });
    });

    test('a side with a season mark names the season', () => {
      expect(matchTitle(parse('[Group] 星之灯笼 / Star Lantern S2 - 04 [1080p]'), item(), english)).toEqual({ ok: true, aliasId: 's1', season: 2 });
    });

    test('a slash inside a Latin name is no separator, and neither side may be another title', () => {
      const fate: WorkForMatch = { kind: 'series', aliases: [{ aliasId: alias('f1'), normalized: 'zero' }], ids: { tmdb: '900021' } };
      expect(matchTitle(parse('[Group] Fate/Zero - 04 [1080p]'), item(), fate)).toEqual({ ok: false, detail: 'title' });
      expect(matchTitle(parse('[Group] 别的 / Other Lantern - 04 [1080p]'), item(), lantern)).toEqual({ ok: false, detail: 'title' });
    });
  });

  describe('by ID', () => {
    test.each([
      ['tvdbid', { tvdbid: '7700001' }],
      ['imdbid without tt', { imdbid: '9900001' }],
      ['tmdbid', { tmdbid: '900001' }],
    ])('a renamed title matches through %s when it shares half its words', (_name, ids) => {
      expect(matchTitle(release({ normalizedTitle: 'long harbor stories', ...episode }), item({ ids }), harbor)).toEqual({ ok: true, aliasId: 'a2' });
    });

    test('an ID with too few shared words is an indexer mistake', () => {
      expect(matchTitle(release({ normalizedTitle: 'quiet signal', ...episode }), item({ ids: { tvdbid: '7700001' } }), harbor)).toEqual({
        ok: false,
        detail: 'title',
      });
    });

    test('another Work’s ID does not help', () => {
      expect(matchTitle(release({ normalizedTitle: 'long harbor stories', ...episode }), item({ ids: { tvdbid: '1' } }), harbor)).toEqual({
        ok: false,
        detail: 'title',
      });
    });
  });

  describe('movies', () => {
    test.each([
      [2022, true],
      [2023, true],
      [2024, true],
      [2021, false],
      [2025, false],
    ])('a year of %i matches the Work’s 2023: %s', (year, ok) => {
      expect(matchTitle(release({ normalizedTitle: 'quiet orchard', year }), item(), orchard).ok).toBe(ok);
    });

    test('an unknown year on either side matches', () => {
      expect(matchTitle(release({ normalizedTitle: 'quiet orchard' }), item(), orchard).ok).toBe(true);
      expect(matchTitle(release({ normalizedTitle: 'quiet orchard', year: 1990 }), item(), { ...orchard, year: undefined }).ok).toBe(true);
    });
  });

  describe('kind conflicts', () => {
    test('a series result with no episodes, pack or air date', () => {
      expect(matchTitle(release({ normalizedTitle: 'the long harbor' }), item(), harbor)).toEqual({ ok: false, detail: 'kind' });
      expect(matchTitle(release({ normalizedTitle: 'the long harbor', airDate: '2024-10-05' }), item(), harbor).ok).toBe(true);
      expect(matchTitle(release({ normalizedTitle: 'the long harbor', pack: { seasons: [1], full: true } }), item(), harbor).ok).toBe(true);
    });

    test('a movie result with episodes or a pack', () => {
      expect(matchTitle(release({ normalizedTitle: 'quiet orchard', ...episode }), item(), orchard)).toEqual({ ok: false, detail: 'kind' });
      expect(matchTitle(release({ normalizedTitle: 'quiet orchard', pack: { seasons: [1], full: true } }), item(), orchard)).toEqual({
        ok: false,
        detail: 'kind',
      });
    });
  });

  test('extras are rejected', () => {
    expect(matchTitle(release({ normalizedTitle: 'the long harbor', extras: true, ...episode }), item(), harbor)).toEqual({ ok: false, detail: 'extras' });
  });
});

describe('matchUnits', () => {
  const resolved = (unitIds: string[], extra: Partial<ResolveResult> = {}): ResolveResult => ({
    unitIds: unitIds.map(unit),
    via: { ordering: 'scene', source: 'xem' },
    confidence: 'mapped',
    ...extra,
  });
  const group = { unitIds: ['u1', 'u2', 'u3'].map(unit), wantedUnitIds: ['u1', 'u2'].map(unit) };

  test('covers the wanted Units of the group, and records how they were resolved', () => {
    expect(matchUnits(resolved(['u1']), group, release())).toEqual({
      ok: true,
      coveredUnitIds: ['u1'],
      alsoContainsUnitIds: [],
      matchDetail: 'scene/xem, mapped',
    });
  });

  test('a pack also contains Units outside the group or not wanted', () => {
    expect(matchUnits(resolved(['u1', 'u2', 'u3', 'u9'], { confidence: 'assumed' }), group, release())).toEqual({
      ok: true,
      coveredUnitIds: ['u1', 'u2'],
      alsoContainsUnitIds: ['u3', 'u9'],
      matchDetail: 'scene/xem, assumed',
    });
  });

  test.each(['ambiguous', 'notFound', 'schemeMismatch'] as const)('a %s problem is a wrong episode, and keeps the problem', (problem) => {
    expect(matchUnits(resolved(['u1'], { problem }), group, release())).toEqual({ ok: false, detail: 'episode', problem });
  });

  test('an ambiguous release keeps the Units it could be, so a manual grab can pick one', () => {
    expect(matchUnits(resolved([], { problem: 'ambiguous', possibleUnitIds: ['u1', 'u8'].map(unit) }), group, release())).toEqual({
      ok: false,
      detail: 'episode',
      problem: 'ambiguous',
      possibleUnitIds: ['u1', 'u8'],
    });
  });

  test('no Unit at all is a wrong episode', () => {
    expect(matchUnits(resolved([]), group, release())).toEqual({ ok: false, detail: 'episode' });
  });

  test('Units of the Work outside the group are another episode', () => {
    expect(matchUnits(resolved(['u8', 'u9']), group, release())).toEqual({ ok: false, detail: 'otherEpisode' });
  });

  test('a release that covers no wanted Unit is another episode too', () => {
    expect(matchUnits(resolved(['u3']), group, release())).toEqual({ ok: false, detail: 'otherEpisode' });
  });
});

describe('filterWorks (several Works)', () => {
  const remake: WorkForMatch = { ...orchard, year: 1979, ids: { tmdb: '800101', imdb: 'tt8800101' } };

  test('one Work is kept as it is', () => {
    expect(filterWorks([orchard], item(), release({ year: 1990 }))).toEqual([orchard]);
  });

  test('keeps the Work whose year matches', () => {
    expect(filterWorks([orchard, remake], item(), release({ year: 1979 }))).toEqual([remake]);
  });

  test('keeps the Work whose ID the item carries', () => {
    expect(filterWorks([orchard, remake], item({ ids: { imdbid: '9900101' } }), release())).toEqual([orchard]);
  });

  test('keeps none when the release decides nothing, so the item is stored for none', () => {
    expect(filterWorks([orchard, remake], item(), release())).toEqual([]);
  });

  test('keeps none when more than one Work is left', () => {
    expect(filterWorks([orchard, { ...remake, year: 2023 }], item(), release({ year: 2023 }))).toEqual([]);
  });
});
