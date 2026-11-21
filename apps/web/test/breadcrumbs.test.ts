// The detail pages' breadcrumbs: parents only, and a back link on a phone.
import { describe, expect, test } from 'vite-plus/test';

import { backLink, itemCrumbs, workCrumbs } from '../lib/breadcrumbs';

describe('workCrumbs', () => {
  test("a series' Work page: Series", () => {
    expect(workCrumbs('series')).toEqual([{ label: 'Series', to: '/library', icon: 'i-lucide-tv' }]);
  });

  test('a movie: Movies, and never its own title', () => {
    expect(workCrumbs('movie')).toEqual([{ label: 'Movies', to: '/library?kind=movies', icon: 'i-lucide-film' }]);
  });
});

describe('itemCrumbs', () => {
  test('an episode: Series › its series', () => {
    expect(itemCrumbs({ workKind: 'series', workId: 'w1', workTitle: 'The Long Harbor' })).toEqual([
      { label: 'Series', to: '/library', icon: 'i-lucide-tv' },
      { label: 'The Long Harbor', to: '/library/w1' },
    ]);
  });

  test("a movie's item: Movies only, so the title isn't repeated", () => {
    expect(itemCrumbs({ workKind: 'movie', workId: 'w2', workTitle: 'Northern Line' })).toEqual([
      { label: 'Movies', to: '/library?kind=movies', icon: 'i-lucide-film' },
    ]);
  });

  test('before the item has loaded: the library alone', () => {
    expect(itemCrumbs(undefined)).toEqual([{ label: 'Series', to: '/library', icon: 'i-lucide-tv' }]);
  });
});

describe('backLink', () => {
  test('the nearest parent', () => {
    expect(backLink(itemCrumbs({ workKind: 'series', workId: 'w1', workTitle: 'The Long Harbor' }))).toEqual({ label: 'The Long Harbor', to: '/library/w1' });
    expect(backLink(workCrumbs('movie'))).toEqual({ label: 'Movies', to: '/library?kind=movies', icon: 'i-lucide-film' });
  });

  test('none without parents', () => {
    expect(backLink([])).toBeUndefined();
  });
});
