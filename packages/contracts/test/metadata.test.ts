import { describe, expect, test } from 'vite-plus/test';

import { MetadataHit } from '../src/dto/metadata.ts';
import { Ordering } from '../src/library.ts';

describe('Ordering', () => {
  test.each(['scene', 'tvdb', 'absolute', 'anidb:123'])('accepts %s', (ordering) => {
    expect(Ordering.safeParse(ordering).success).toBe(true);
  });

  test.each(['anidb:', 'anidb:x', 'anidb:12a', 'anidb'])('rejects %s', (ordering) => {
    expect(Ordering.safeParse(ordering).success).toBe(false);
  });
});

describe('MetadataHit', () => {
  const hit = { tmdbId: '900002', kind: 'series', title: 'Star Lantern', numberingScheme: 'anime' };

  test('requires the reason for its numbering suggestion', () => {
    expect(MetadataHit.safeParse(hit).success).toBe(false);
    expect(MetadataHit.safeParse({ ...hit, numberingReason: 'animeLists' }).success).toBe(true);
  });
});
