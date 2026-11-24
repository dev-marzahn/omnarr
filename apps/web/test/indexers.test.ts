// Wording for the indexer screens.
import type { IndexerDetail, IndexerRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  BUSY_TEXT,
  capsBlock,
  failureText,
  healthBlock,
  healthPath,
  indexerErrorText,
  kindLabel,
  pacingText,
  rateLimitText,
  removeConfirm,
  siteName,
  SITES,
  siteTestText,
} from '../lib/indexers';

const at = { host: 'indexer.example', path: '/api' };

describe('failureText: one message per IndexerFailureKind, naming host and path, never the URL', () => {
  test.each([
    [{ kind: 'authRejected', errorCode: 100 }, 'indexer.example rejected the API key (/api).'],
    [{ kind: 'unreachable' }, "indexer.example didn't answer. Check the URL."],
    [{ kind: 'timeout' }, 'indexer.example gave no answer in 10 seconds.'],
    [{ kind: 'notAnIndexerApi' }, 'indexer.example/api is not a Newznab or Torznab API.'],
    [{ kind: 'apiDisabled' }, 'indexer.example has turned off API access for this account.'],
    [{ kind: 'rateLimited' }, 'indexer.example says its request limit is reached.'],
    [{ kind: 'httpError', httpStatus: 502 }, 'indexer.example answered HTTP 502 at /api.'],
    [{ kind: 'indexerError', errorCode: 201 }, 'indexer.example answered with error code 201 at /api.'],
  ] as const)('%o', (failure, text) => {
    expect(failureText({ ...failure, ...at })).toBe(text);
  });
});

describe('rateLimitText', () => {
  const row = (overrides: Partial<IndexerRow>) => ({ rateLimitedUntil: Date.UTC(2026, 10, 17, 14, 5), ...overrides }) as IndexerRow;
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  test('the computed time and the rule that set it', () => {
    expect(rateLimitText(row({ rateLimitReason: 'retryAfter' }), Date.UTC(2026, 10, 17, 12), time)).toBe(
      "Rate limited until 14:05 (the indexer's Retry-After)",
    );
    expect(rateLimitText(row({ rateLimitReason: 'fallback' }), Date.UTC(2026, 10, 17, 12), time)).toBe(
      'Rate limited until 14:05 (backing off: no hint from the indexer)',
    );
  });

  test('nothing once the time has passed', () => {
    expect(rateLimitText(row({ rateLimitReason: 'ownCount' }), Date.UTC(2026, 10, 17, 15), time)).toBeUndefined();
  });
});

describe('indexerErrorText: what create and update refuse with', () => {
  test.each([
    [{ code: 'testFailed', kind: 'authRejected', ...at }, 'indexer.example rejected the API key (/api).'],
    [{ code: 'nameTaken' }, 'Another indexer has this name.'],
    [{ code: 'kindRequired' }, "The indexer's answer doesn't say whether it is Usenet or torrent. Choose one."],
  ])('%o', (data, text) => {
    expect(indexerErrorText({ data })).toBe(text);
  });

  test('anything else', () => {
    expect(indexerErrorText(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});

describe("the form's Caps and Health blocks", () => {
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const detail = (overrides: Partial<IndexerDetail> = {}) =>
    ({
      caps: {
        searchModes: [
          { mode: 'search', available: true, supportedParams: ['q'] },
          { mode: 'tv-search', available: true, supportedParams: ['q', 'season'] },
          { mode: 'movie-search', available: false, supportedParams: [] },
        ],
        categories: [
          { id: 2000, name: 'Movies' },
          { id: 2040, name: 'Movies/HD', parentId: 2000 },
          { id: 5000, name: 'TV' },
          { id: 5040, name: 'TV/HD', parentId: 5000 },
          { id: 7000, name: 'Other' },
        ],
        pageLimit: { max: 100 },
      },
      categories: { series: [5000, 5040], movies: [2040] },
      rssIntervalMinutes: 15,
      effectiveRssIntervalMinutes: 15,
      errors24h: 0,
      health: { status: 'ok' },
      ...overrides,
    }) as IndexerDetail;

  test('Caps: the available search types, the chosen categories by top-level name, the API limit and the RSS interval', () => {
    expect(capsBlock(detail({ apiLimit: { max: 100, source: 'apilimits' } }))).toEqual([
      { label: 'Search types', value: 'search, tv-search' },
      { label: 'Categories', value: 'TV, Movies' },
      { label: 'API limit', value: '100 requests a day' },
      { label: 'RSS', value: 'Every 15 min' },
    ]);
  });

  test('Caps: a limit entered here, none reported, and an RSS interval raised by the share', () => {
    expect(capsBlock(detail({ apiLimit: { max: 50, source: 'user' }, effectiveRssIntervalMinutes: 116 }))).toContainEqual({
      label: 'API limit',
      value: '50 requests a day (set here)',
    });
    expect(capsBlock(detail())).toContainEqual({ label: 'API limit', value: 'None reported' });
    expect(capsBlock(detail({ effectiveRssIntervalMinutes: 116 }))).toContainEqual({ label: 'RSS', value: 'Every 116 min (raised to fit the API limit)' });
  });

  test('Health: last search, last RSS and errors in the last 24 hours', () => {
    const at = Date.UTC(2026, 10, 17, 16, 58);
    const health = {
      status: 'ok' as const,
      lastSearch: { at, status: 'ok' as const, count: 23 },
      lastRss: { at: Date.UTC(2026, 10, 17, 16, 45), newItems: 4, matched: 1 },
    };
    expect(healthBlock(detail({ health, errors24h: 2 }), time)).toEqual([
      { label: 'Last search', value: '16:58 · ok · 23 results' },
      { label: 'Last RSS', value: '16:45 · 4 new items, 1 matched' },
      { label: 'Errors (24 h)', value: '2' },
    ]);
    expect(healthBlock(detail({ health: { status: 'error', lastSearch: { at, status: 'timeout', count: 0 } } }), time)).toEqual([
      { label: 'Last search', value: '16:58 · no answer · 0 results' },
      { label: 'Last RSS', value: 'None yet' },
      { label: 'Errors (24 h)', value: '0' },
    ]);
  });

  test('Health: a count of one is singular', () => {
    const at = Date.UTC(2026, 10, 17, 16, 58);
    const health = {
      status: 'ok' as const,
      lastSearch: { at, status: 'ok' as const, count: 1 },
      lastRss: { at: Date.UTC(2026, 10, 17, 16, 45), newItems: 1, matched: 1 },
    };
    expect(healthBlock(detail({ health }), time).slice(0, 2)).toEqual([
      { label: 'Last search', value: '16:58 · ok · 1 result' },
      { label: 'Last RSS', value: '16:45 · 1 new item, 1 matched' },
    ]);
  });
});

describe('removeConfirm: the confirm before an indexer is removed names it', () => {
  test('title and what removing does', () => {
    expect(removeConfirm('Fake indexer')).toEqual({
      title: 'Remove Fake indexer?',
      description: 'Fake indexer and its stored API key are deleted. Releases it already found stay, shown as from a removed indexer.',
    });
  });

  test('a site indexer has no key to delete', () => {
    expect(removeConfirm('Nyaa', false).description).toBe('Nyaa is deleted. Releases it already found stay, shown as from a removed indexer.');
  });
});

describe('site indexers', () => {
  const nyaa = { host: 'nyaa.si', path: '/' };

  test.each([
    [{ kind: 'challenged', httpStatus: 503, challenge: 'ddosGuard' }, 'nyaa.si asked for a browser check (DDoS-Guard).'],
    [{ kind: 'challenged', httpStatus: 403, challenge: 'cloudflare' }, 'nyaa.si asked for a browser check (Cloudflare).'],
    [{ kind: 'challenged', httpStatus: 403 }, 'nyaa.si asked for a browser check.'],
    [{ kind: 'unexpectedPage' }, "nyaa.si answered with a page omnarr can't read. The site may have changed."],
  ] as const)('failureText %o', (failure, text) => {
    expect(failureText({ ...failure, ...nyaa })).toBe(text);
  });

  test("the kind's label, and the path a health message names", () => {
    expect([kindLabel('newznab'), kindLabel('torznab'), kindLabel('nyaa')]).toEqual(['Newznab', 'Torznab', 'Nyaa']);
    expect([healthPath('newznab'), healthPath('torznab'), healthPath('nyaa')]).toEqual(['/api', '/api', '/']);
  });

  test("the pacing line, and the test's answer when the site's queue is full", () => {
    expect(pacingText(5_000)).toBe('One request every 5 s');
    expect(pacingText(2_500)).toBe('One request every 2.5 s');
    expect(BUSY_TEXT).toBe('Busy: try again in a few minutes.');
  });

  test('what createSite and update refuse with', () => {
    expect(indexerErrorText({ data: { code: 'alreadyExists' } })).toBe('Nyaa is already added.');
    expect(indexerErrorText({ data: { code: 'notEditable' } })).toBe("A site indexer's address and key can't be changed.");
    expect(indexerErrorText({ data: { code: 'testFailed', kind: 'challenged', challenge: 'ddosGuard', ...nyaa } })).toBe(
      'nyaa.si asked for a browser check (DDoS-Guard).',
    );
  });

  test('the Site list offers Nyaa, which searches anime by title', () => {
    expect(SITES).toEqual([{ kind: 'nyaa', label: 'Nyaa', description: 'Anime, search by title' }]);
  });

  test('a passed site test says what the site searches, and its categories', () => {
    expect(siteTestText('nyaa')).toEqual({ title: 'Nyaa: anime, search by title', categories: ['Anime (series)', 'Anime (movies)'] });
  });

  test.each([
    ['an empty Name takes the site', '', '', 'Nyaa', 'Nyaa'],
    ['switching to "Other site" clears the Name the form filled', 'Nyaa', 'Nyaa', '', ''],
    ['picking Nyaa again replaces a filled definition name', 'Lantern', 'Lantern', 'Nyaa', 'Nyaa'],
    ['a typed Name stays on "Other site"', 'My anime', 'Nyaa', '', 'My anime'],
    ['a typed Name stays on another site', 'My anime', '', 'Nyaa', 'My anime'],
  ])('Name when the site changes: %s', (_, name, filled, next, expected) => {
    expect(siteName(name, filled, next)).toBe(expected);
  });
});

describe('definition indexers', () => {
  const site = { host: 'lantern.test', path: '/latest' };

  test.each([
    [{ kind: 'workerUnavailable' }, "The worker didn't run the request. Is it connected?"],
    [
      { kind: 'httpError', httpStatus: 301, redirectHost: 'lantern.example' },
      'lantern.test redirected to lantern.example. The site may have moved: choose another link.',
    ],
  ] as const)('failureText %o', (failure, text) => {
    expect(failureText({ ...failure, ...site })).toBe(text);
  });

  test("a definition indexer's kind is its definition's name; its health names the site's root", () => {
    expect(kindLabel('definition')).toBe('Site');
    expect(kindLabel('definition', 'Lantern Site')).toBe('Lantern Site');
    expect(healthPath('definition')).toBe('/');
  });

  test.each([
    [{ code: 'definitionUnsupported' }, "omnarr can't run this site's definition."],
    [{ code: 'definitionRequired' }, 'Choose a site.'],
    [{ code: 'invalidBaseUrl' }, "Choose one of the site's links."],
    [{ code: 'invalidSettings', setting: 'sort' }, 'The setting sort has a value the site does not offer.'],
    [{ code: 'testFailed', skipped: 'paced' }, BUSY_TEXT],
    [{ code: 'testFailed' }, BUSY_TEXT],
  ])('indexerErrorText %o', (data, text) => {
    expect(indexerErrorText({ data })).toBe(text);
  });
});
