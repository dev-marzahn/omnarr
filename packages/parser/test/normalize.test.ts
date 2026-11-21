import { describe, expect, test } from 'vite-plus/test';

import { normalizeReleaseTitle, normalizeTitle, titleSides } from '../src/index.ts';

describe('titleSides (a dual title, test-install backlog)', () => {
  test.each([
    ['星之灯笼 / Star Lantern', ['星之灯笼', 'Star Lantern']],
    ['Star Lantern / 星之灯笼', ['Star Lantern', '星之灯笼']],
    ['星之灯笼/Star Lantern', ['星之灯笼', 'Star Lantern']],
    ["JOJO的奇妙冒险 飙马野郎/JoJo's Bizarre Adventure Steel Ball Run", ['JOJO的奇妙冒险 飙马野郎', "JoJo's Bizarre Adventure Steel Ball Run"]],
    ['星之灯笼 / 星の灯籠 / Star Lantern', ['星之灯笼', '星の灯籠', 'Star Lantern']],
    ['Long Harbor / Quiet Orchard', ['Long Harbor', 'Quiet Orchard']],
    ['Fate/Zero', []],
    ['AC/DC', []],
    ['Star Lantern', []],
  ])('%s', (title, sides) => {
    expect(titleSides(title)).toEqual(sides);
  });
});

describe('normalizeTitle (the rule workAliases.normalized stores)', () => {
  test.each([
    ['The Long Harbor', 'the long harbor'],
    ['Lumière Café', 'lumiere cafe'],
    ['Hoshi no Kagami: Ōkami-hen', 'hoshi no kagami okamihen'],
    ['Salt & Pepper', 'salt and pepper'],
    ['Salt&Pepper', 'salt and pepper'],
    ["Keeper's Lantern!", 'keepers lantern'],
    ['Paper Lantern Road (2019)', 'paper lantern road 2019'],
    ['  Quiet    Orchard  ', 'quiet orchard'],
    ['A.R.C. Station', 'arc station'],
    ['Señor Ñandú', 'senor nandu'],
  ])('%s → %s', (title, normalized) => {
    expect(normalizeTitle(title)).toBe(normalized);
  });

  test.each([
    ['1923', '1923'],
    ['Blade Runner 2049', 'blade runner 2049'],
  ])('keeps a title that is or holds a year: %s', (title, normalized) => {
    expect(normalizeTitle(title)).toBe(normalized);
  });

  test('keeps articles', () => {
    expect(normalizeTitle('The Orchard')).not.toBe(normalizeTitle('Orchard'));
  });
});

describe('normalizeReleaseTitle (the blocklist key)', () => {
  test.each([
    ['The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA', 'the long harbor s01e02 1080p web dl ddp5 1 h 264 grpa'],
    ['The Long Harbor S01E02 1080p WEB-DL DDP5.1 H.264-GRPA', 'the long harbor s01e02 1080p web dl ddp5 1 h 264 grpa'],
    ['The_Long_Harbor_S01E02_1080p_WEB-DL_DDP5.1_H.264-GRPA.mkv', 'the long harbor s01e02 1080p web dl ddp5 1 h 264 grpa'],
  ])('reads separators and the extension alike: %s', (title, key) => {
    expect(normalizeReleaseTitle(title)).toBe(key);
  });

  test.each([
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA-Obfuscated',
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA-postbot',
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA[eztv]',
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA[rartv]',
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA-Scrambled',
    'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA-xpost',
  ])('a re-post keeps the same key: %s', (title) => {
    expect(normalizeReleaseTitle(title)).toBe(normalizeReleaseTitle('The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA'));
  });

  // The indexer lists one anime post under two spellings.
  test('brackets and parentheses read as separators, and a trailing CRC32 tag is dropped', () => {
    const key = 'subgroup lantern keeper 1076 1080p';
    expect(normalizeReleaseTitle('[SubGroup].Lantern.Keeper-1076.1080p')).toBe(key);
    expect(normalizeReleaseTitle('[SubGroup] Lantern Keeper - 1076 (1080p) [5A6B7C8D]')).toBe(key);
    expect(normalizeReleaseTitle('[SubGroup] Lantern Keeper - 1076 (1080p) [5A6B7C8D].mkv')).toBe(key);
  });

  test.each([
    ['another resolution', '[SubGroup] Lantern Keeper - 1076 (720p) [5A6B7C8D]'],
    ['another episode', '[SubGroup] Lantern Keeper - 1077 (1080p) [5A6B7C8D]'],
    ['a v2', '[SubGroup] Lantern Keeper - 1076v2 (1080p) [5A6B7C8D]'],
    ['another group', '[KazeSubs] Lantern Keeper - 1076 (1080p) [5A6B7C8D]'],
    ['a tag that is not a CRC32', '[SubGroup] Lantern Keeper - 1076 (1080p) [HEVC]'],
  ])('a near miss keeps its own key: %s', (_, title) => {
    expect(normalizeReleaseTitle(title)).not.toBe(normalizeReleaseTitle('[SubGroup].Lantern.Keeper-1076.1080p'));
  });

  test('a different encode of the same episode gets a different key', () => {
    expect(normalizeReleaseTitle('The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA')).not.toBe(
      normalizeReleaseTitle('The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.265-GRPA'),
    );
    expect(normalizeReleaseTitle('The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA')).not.toBe(
      normalizeReleaseTitle('The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPB'),
    );
  });
});
