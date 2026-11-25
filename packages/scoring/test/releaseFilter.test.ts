import { describe, expect, test } from 'vite-plus/test';

import { isReadableReleaseFilter, MAX_RELEASE_FILTER_LENGTH, releaseFilterMatches } from '../src/releaseFilter.ts';

describe('releaseFilterMatches', () => {
  test("Sonarr's inline case-insensitive flag applies to the whole pattern", () => {
    expect(releaseFilterMatches('(?i)-(?:playWEB)(?:-|$)', 'American.Dad.S07E01.1080p.WEB.h264-PLAYWEB')).toBe(true);
    expect(releaseFilterMatches('(?i)-(?:playWEB)(?:-|$)', 'American.Dad.S07E01.1080p.WEB.h264-NTb')).toBe(false);
  });

  test('a pattern matches anywhere in the title unless it is anchored', () => {
    expect(releaseFilterMatches('(?i)[. ]GERMAN[. ]', 'Babylon.S01E01.GERMAN.720p.WEB.x264-RiVER')).toBe(true);
    expect(releaseFilterMatches('(?i)^Kingdom\\.S01E01', 'The.Kingdom.S01E01.1080p')).toBe(false);
  });

  test('a catastrophic-backtracking pattern answers at once on a long title', () => {
    const started = performance.now();
    expect(releaseFilterMatches('(a+)+$', `${'a'.repeat(20_000)}!`)).toBe(false);
    expect(releaseFilterMatches('^(a|a)*$', `${'a'.repeat(20_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a pattern RE2 can't read matches nothing", () => {
    expect(releaseFilterMatches('(?<=x)y', 'xy')).toBe(false);
    expect(releaseFilterMatches('(a)\\1', 'aa')).toBe(false);
  });
});

describe('isReadableReleaseFilter', () => {
  test("a lookaround, a backreference, .NET's empty flag group and an unclosed group are not readable", () => {
    for (const pattern of ['(?<=x)y', '(?!x)y', '(a)\\1', '(?-)[-_. ]Danish[-_. ]', '(unclosed']) expect(isReadableReleaseFilter(pattern)).toBe(false);
  });

  test('a pattern past the length limit is not readable; the longest live one was 87 characters on 2026-11-25', () => {
    expect(isReadableReleaseFilter('a'.repeat(MAX_RELEASE_FILTER_LENGTH))).toBe(true);
    expect(isReadableReleaseFilter('a'.repeat(MAX_RELEASE_FILTER_LENGTH + 1))).toBe(false);
  });
});
