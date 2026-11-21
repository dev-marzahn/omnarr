// A fake Newznab API as a fetch handler: the compose server
// (server.ts) serves it over HTTP, and tests route `fetch` into it. Like the
// TMDB fake it has no package dependencies, so it writes its XML by hand.
//
// It serves caps, `t=search`, `t=tvsearch` and `t=movie`, refuses a wrong key
// with error 100, and can be switched to fail: rate limits (error 500, HTTP
// 429 with or without Retry-After, apilimits at their maximum), a timeout that
// honours the abort signal, and a body that is no API.
//
// `GET /getnzb/<guid>.nzb` serves the NZB of an item linked to a release
// (../usenet/release.ts), naming the articles the NNTP fake serves. It needs
// the key, and a rate-limit failure refuses it as it refuses searches.
import { nzbXml } from '../usenet/release.ts';
import { ITEMS, type FakeItem, type FakeTorrent } from './fixtures.ts';

export type { FakeItem, FakeTorrent } from './fixtures.ts';

export type NewznabFailure =
  | { kind: 'limit500' }
  | { kind: 'http429'; retryAfter?: string }
  | { kind: 'apilimitsAtMax' }
  | { kind: 'timeout' }
  | { kind: 'notAnApi' }
  | { kind: 'wrongKey' }
  /** The day's download limit is used up: `/getnzb` answers error 501, searches go on. */
  | { kind: 'grabLimit501' };

export type NewznabFakeOptions = {
  apiKey: string;
  /**
   * `torznab`: answers as a Torznab indexer: the torznab
   * namespace, torrent enclosures, each item's `torrent` as `torznab:attr`,
   * and `/dl/<guid>.torrent` serving its file. Default `newznab`.
   */
  kind?: 'newznab' | 'torznab';
  items?: FakeItem[];
  /** `<limits max default>`: the most items one page holds. Default 100. */
  pageMax?: number;
  /** Leave `supportedParams` out of caps, so the Torznab 1.1 defaults apply. */
  defaultParams?: boolean;
  /** `<tv-search available="no">`. */
  noTvSearch?: boolean;
  /** An `apilimits` element on every answer, with this many requests of `max` used. */
  apiLimits?: { current: number; max: number };
  failure?: NewznabFailure;
};

export type NewznabHandler = {
  handle: (request: Request, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** The query of every request received, in order, refused ones included. */
  requests: URLSearchParams[];
  /** Switches the failure every later request meets; `undefined` serves normally again. */
  setFailure: (failure: NewznabFailure | undefined) => void;
};

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });

const error = (code: number, description: string) => xml(`<error code="${code}" description="${escape(description)}"/>`);

const CATEGORIES = [
  {
    id: 2000,
    name: 'Movies',
    subcats: [
      { id: 2040, name: 'HD' },
      { id: 2045, name: 'UHD' },
    ],
  },
  {
    id: 5000,
    name: 'TV',
    subcats: [
      { id: 5030, name: 'SD' },
      { id: 5040, name: 'HD' },
      { id: 5070, name: 'Anime' },
      { id: 105040, name: 'HD x265' },
    ],
  },
  { id: 7000, name: 'Other', subcats: [] },
];

/** An item is in a requested category, or in a child of one (5040 is under 5000). */
const inCategories = (item: FakeItem, wanted: number[]) =>
  wanted.length === 0 || item.categories.some((id) => wanted.includes(id) || wanted.includes(Math.floor(id / 1000) * 1000));

/** Every word of `q` appears in the title, with dots and underscores read as spaces. */
const matchesQuery = (item: FakeItem, q: string) => {
  const title = item.title.toLowerCase().replace(/[._]/g, ' ');
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => title.includes(word));
};

const stripTt = (value: string) => value.replace(/^tt/i, '');

/** The IDs a request names match the item's: any one of them (IDs combine with OR). */
function matchesIds(item: FakeItem, query: URLSearchParams): boolean {
  const asked = (['tvdbid', 'tmdbid', 'imdbid'] as const).filter((name) => query.has(name));
  if (asked.length === 0) return true;
  return asked.some((name) => item.ids?.[name] !== undefined && stripTt(item.ids[name]!) === stripTt(query.get(name)!));
}

/** The season and episode a title writes as `S01E02` or `S01`, as an indexer stores them. */
function numbersOf(item: FakeItem): { season?: number; episode?: number } {
  const match = /\bS(\d{1,2})(?:E(\d{1,3}))?\b/i.exec(item.title);
  return match ? { season: Number(match[1]), episode: match[2] === undefined ? undefined : Number(match[2]) } : {};
}

function matchesNumbers(item: FakeItem, query: URLSearchParams): boolean {
  const { season, episode } = numbersOf(item);
  if (query.has('season') && season !== Number(query.get('season'))) return false;
  if (query.has('ep') && episode !== Number(query.get('ep'))) return false;
  return true;
}

const magnetOf = (item: FakeItem, torrent: FakeTorrent) =>
  `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(item.title)}${torrent.magnetParams ? `&${torrent.magnetParams}` : ''}`;

/** A Torznab item: a .torrent enclosure when the item has a file, else only its magnet. */
function torznabItemXml(item: FakeItem, origin: string, apiKey: string): string {
  const torrent = item.torrent;
  if (!torrent) throw new Error(`Torznab mode needs a torrent on item ${item.guid}`);
  const magnet = magnetOf(item, torrent);
  const download = torrent.file ? `${origin}/dl/${item.guid}.torrent?apikey=${apiKey}` : magnet;
  const attrs = [
    ...item.categories.map((id) => ['category', String(id)]),
    ...Object.entries(item.ids ?? {}).map(([name, value]) => [name, value]),
    ['seeders', String(torrent.seeders)],
    ...(torrent.peers === undefined ? [] : [['peers', String(torrent.peers)]]),
    ['infohash', torrent.infoHash],
    ...(torrent.file ? [['magneturl', magnet]] : []),
    ...(torrent.minimumRatio === undefined ? [] : [['minimumratio', String(torrent.minimumRatio)]]),
    ...(torrent.minimumSeedTimeSec === undefined ? [] : [['minimumseedtime', String(torrent.minimumSeedTimeSec)]]),
  ];
  return [
    '    <item>',
    `      <title>${escape(item.title)}</title>`,
    `      <guid isPermaLink="true">${escape(`${origin}/details/${item.guid}`)}</guid>`,
    `      <link>${escape(download)}</link>`,
    `      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>`,
    `      <enclosure url="${escape(download)}" length="${item.sizeBytes}" type="application/x-bittorrent"/>`,
    ...attrs.map(([name, value]) => `      <torznab:attr name="${name}" value="${escape(value!)}"/>`),
    '    </item>',
  ].join('\n');
}

function itemXml(item: FakeItem, origin: string, apiKey: string): string {
  const download = `${origin}/getnzb/${item.guid}.nzb?apikey=${apiKey}`;
  const attrs = [
    ...item.categories.map((id) => ['category', String(id)]),
    ['size', String(item.sizeBytes)],
    ...Object.entries(item.ids ?? {}).map(([name, value]) => [name, value]),
  ];
  return [
    '    <item>',
    `      <title>${escape(item.title)}</title>`,
    `      <guid isPermaLink="true">${escape(`${origin}/details/${item.guid}`)}</guid>`,
    `      <link>${escape(download)}</link>`,
    `      <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>`,
    `      <enclosure url="${escape(download)}" length="${item.sizeBytes}" type="application/x-nzb"/>`,
    ...attrs.map(([name, value]) => `      <newznab:attr name="${name}" value="${escape(value!)}"/>`),
    '    </item>',
  ].join('\n');
}

/** Never answers; rejects when the caller aborts, as a real timeout does. */
const hang = (signal?: AbortSignal) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
  });

export function createNewznabHandler(options: NewznabFakeOptions): NewznabHandler {
  const catalogue = [...(options.items ?? ITEMS)].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const pageMax = options.pageMax ?? 100;
  const requests: URLSearchParams[] = [];
  let failure = options.failure;
  const torznab = options.kind === 'torznab';

  const apiLimits = (limits = options.apiLimits) =>
    limits ? [`    <${torznab ? 'torznab' : 'newznab'}:apilimits apicurrent="${limits.current}" apimax="${limits.max}" grabcurrent="0" grabmax="100"/>`] : [];

  const caps = () => {
    const params = (list: string) => (options.defaultParams ? '' : ` supportedParams="${list}"`);
    return xml(
      [
        '<caps>',
        '  <server title="Newznab fake"/>',
        `  <limits max="${pageMax}" default="${pageMax}"/>`,
        '  <searching>',
        `    <search available="yes"${params('q')}/>`,
        `    <tv-search available="${options.noTvSearch ? 'no' : 'yes'}"${params('q,tvdbid,imdbid,season,ep')}/>`,
        `    <movie-search available="yes"${params('q,imdbid,tmdbid')}/>`,
        '  </searching>',
        '  <categories>',
        ...CATEGORIES.map((category) =>
          [
            `    <category id="${category.id}" name="${category.name}">`,
            ...category.subcats.map((sub) => `      <subcat id="${sub.id}" name="${escape(sub.name)}"/>`),
            '    </category>',
          ].join('\n'),
        ),
        '  </categories>',
        '</caps>',
      ].join('\n'),
    );
  };

  const results = (query: URLSearchParams, origin: string, limits?: { current: number; max: number }) => {
    const fn = query.get('t');
    const categories = (query.get('cat') ?? '').split(',').filter(Boolean).map(Number);
    const matching = catalogue.filter(
      (item) =>
        inCategories(item, categories) &&
        (item.everyQuery === true ||
          (matchesQuery(item, query.get('q') ?? '') && (fn === 'search' || matchesIds(item, query)) && (fn !== 'tvsearch' || matchesNumbers(item, query)))),
    );
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(pageMax, Math.max(1, Number(query.get('limit') ?? pageMax) || pageMax));
    const page = matching.slice(offset, offset + limit);
    const ns = torznab ? 'torznab' : 'newznab';
    return xml(
      [
        torznab
          ? '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">'
          : '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">',
        '  <channel>',
        '    <title>Newznab fake</title>',
        `    <${ns}:response offset="${offset}" total="${matching.length}"/>`,
        ...apiLimits(limits),
        ...page.map((item) => (torznab ? torznabItemXml : itemXml)(item, origin, options.apiKey)),
        '  </channel>',
        '</rss>',
      ].join('\n'),
    );
  };

  const handle = async (request: Request, init?: { signal?: AbortSignal }) => {
    const url = new URL(request.url);
    requests.push(url.searchParams);
    if (failure?.kind === 'timeout') return hang(init?.signal ?? request.signal);
    if (failure?.kind === 'notAnApi') return new Response('<html><body>Welcome to my blog</body></html>', { headers: { 'content-type': 'text/html' } });
    const getnzb = /\/getnzb\/([^/]+)\.nzb$/.exec(url.pathname);
    const dl = torznab ? /\/dl\/([^/]+)\.torrent$/.exec(url.pathname) : null;
    if (!url.pathname.endsWith('/api') && !getnzb && !dl) return new Response('Not found', { status: 404 });
    if (failure?.kind === 'wrongKey' || url.searchParams.get('apikey') !== options.apiKey) return error(100, 'Incorrect user credentials');
    if (failure?.kind === 'limit500') return error(500, 'Request limit reached');
    if (failure?.kind === 'http429')
      return new Response('Too many requests', { status: 429, headers: failure.retryAfter ? { 'retry-after': failure.retryAfter } : {} });
    if (getnzb) {
      if (failure?.kind === 'grabLimit501') return error(501, 'Download limit reached');
      const release = catalogue.find((item) => item.guid === getnzb[1])?.release;
      return release ? new Response(nzbXml(release), { headers: { 'content-type': 'application/x-nzb' } }) : new Response('Not found', { status: 404 });
    }
    if (dl) {
      if (failure?.kind === 'grabLimit501') return error(501, 'Download limit reached');
      const file = catalogue.find((item) => item.guid === dl[1])?.torrent?.file;
      return file ? new Response(file, { headers: { 'content-type': 'application/x-bittorrent' } }) : new Response('Not found', { status: 404 });
    }
    const fn = url.searchParams.get('t');
    if (fn === 'caps') return caps();
    if (fn === 'search' || fn === 'tvsearch' || fn === 'movie') {
      if (fn === 'tvsearch' && options.noTvSearch) return error(203, 'Function not available');
      return results(url.searchParams, url.origin, failure?.kind === 'apilimitsAtMax' ? { current: 100, max: 100 } : undefined);
    }
    return error(202, 'No such function');
  };

  return {
    handle,
    requests,
    setFailure: (next) => {
      failure = next;
    },
  };
}
