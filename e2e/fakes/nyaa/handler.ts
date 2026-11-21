// A fake Nyaa as a fetch handler: the compose server (server.ts)
// serves it over HTTP, and the backend's tests route `fetch` into it. It has
// no package dependencies, so it writes its RSS and HTML by hand, in the
// shape of nyaa's rss.xml and search_results.html templates,
// escaping as Jinja does (`'` as `&#39;`, `"` as `&#34;`).
//
//   GET /?page=rss&q=&c=&f=&m=1        the feed: the newest 75 matches, magnets
//   GET /?q=&c=&f=&s=id&o=desc&p=<n>    the listing's page n, 75 rows a page
//
// A query matches a title when each of its words starts a word of the title,
// ignoring case: a simplification of Nyaa's search that finds `01` in
// `S2 - 01v2` and not in `1071`. `c` and `f` are accepted and ignored. It can
// be switched to answer DDoS-Guard's 503 check page, or a 200 page that isn't
// Nyaa's.
export type NyaaItem = {
  /** Nyaa's torrent ID: `/view/<id>`, and the sort order. */
  id: number;
  title: string;
  /** 40 hex digits. */
  infoHash: string;
  /** As Nyaa prints it, e.g. `1.4 GiB`. */
  size: string;
  /** ISO time. */
  publishedAt: string;
  seeders: number;
  leechers: number;
  /** Extra magnet parameters after `xt`, e.g. a tracker (`tr=…`). */
  magnetParams?: string;
};

export type NyaaFailure = { kind: 'ddosGuard' } | { kind: 'brokenPage' };

export type NyaaFakeOptions = {
  items: NyaaItem[];
  /** The fake's own origin, for the feed's links. Default `https://nyaa.si`. */
  origin?: string;
  failure?: NyaaFailure;
};

export type NyaaRequest = { at: number; path: string; params: URLSearchParams; userAgent: string | null };

export type NyaaHandler = {
  handle: (request: Request) => Promise<Response>;
  /** Every request received, in order, refused ones included. */
  requests: NyaaRequest[];
  setFailure: (failure: NyaaFailure | undefined) => void;
  /** Replaces the catalogue, e.g. to publish a new episode before an RSS fetch. */
  setItems: (items: NyaaItem[]) => void;
};

export const NYAA_PER_PAGE = 75;

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function matches(item: NyaaItem, q: string): boolean {
  const titleWords = words(item.title);
  return words(q).every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)));
}

const magnetOf = (item: NyaaItem) =>
  `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title)}${item.magnetParams ? `&${item.magnetParams}` : ''}`;

/** RFC 822, as nyaa's `rfc822` filter prints it. */
const rfc822 = (iso: string) => new Date(iso).toUTCString().replace('GMT', '-0000');

function feed(items: NyaaItem[], origin: string, magnets: boolean): string {
  const entries = items.map(
    (item) => `		<item>
			<title>${escape(item.title)}</title>
				<link>${escape(magnets ? magnetOf(item) : `${origin}/download/${item.id}.torrent`)}</link>
				<guid isPermaLink="true">${origin}/view/${item.id}</guid>
				<pubDate>${rfc822(item.publishedAt)}</pubDate>

				<nyaa:seeders>${item.seeders}</nyaa:seeders>
				<nyaa:leechers>${item.leechers}</nyaa:leechers>
				<nyaa:downloads>0</nyaa:downloads>
				<nyaa:infoHash>${item.infoHash}</nyaa:infoHash>
			<nyaa:categoryId>1_2</nyaa:categoryId>
			<nyaa:category>Anime - English-translated</nyaa:category>
			<nyaa:size>${item.size}</nyaa:size>
			<nyaa:comments>0</nyaa:comments>
			<nyaa:trusted>No</nyaa:trusted>
			<nyaa:remake>No</nyaa:remake>
			<description><![CDATA[<a href="${origin}/view/${item.id}">#${item.id} | ${item.title}</a>]]></description>
		</item>`,
  );
  return `<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:nyaa="${origin}/xmlns/nyaa" version="2.0">
	<channel>
		<title>Nyaa - Home - ${magnets ? 'Magnet URI' : 'Torrent File'} RSS</title>
		<description>RSS Feed for Home</description>
		<link>${origin}/</link>
		<atom:link href="${origin}/?page=rss" rel="self" type="application/rss+xml" />
${entries.join('\n')}
	</channel>
</rss>`;
}

function listing(items: NyaaItem[]): string {
  const body =
    items.length === 0
      ? '<h3>No results found</h3>'
      : `<div class="table-responsive">
	<table class="table table-bordered table-hover table-striped torrent-list">
		<thead><tr><th class="hdr-category">Category</th><th class="hdr-name">Name</th><th class="hdr-comments"></th><th class="hdr-link">Link</th><th class="hdr-size">Size</th><th class="hdr-date">Date</th><th class="hdr-seeders"></th><th class="hdr-leechers"></th><th class="hdr-downloads"></th></tr></thead>
		<tbody>
${items
  .map(
    (item) => `			<tr class="default">
				<td><a href="/?c=1_2" title="Anime - English-translated"><img src="/static/img/icons/nyaa/1_2.png" alt="Anime - English-translated" class="category-icon"></a></td>
				<td colspan="2">
					<a href="/view/${item.id}" title="${escape(item.title)}">${escape(item.title)}</a>
				</td>
				<td class="text-center">
					<a href="/download/${item.id}.torrent"><i class="fa fa-fw fa-download"></i></a>
					<a href="${escape(magnetOf(item))}"><i class="fa fa-fw fa-magnet"></i></a>
				</td>
				<td class="text-center">${item.size}</td>
				<td class="text-center" data-timestamp="${Math.floor(Date.parse(item.publishedAt) / 1000)}">${item.publishedAt.slice(0, 16).replace('T', ' ')}</td>
				<td class="text-center">${item.seeders}</td>
				<td class="text-center">${item.leechers}</td>
				<td class="text-center">0</td>
			</tr>`,
  )
  .join('\n')}
		</tbody>
	</table>
</div>`;
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Browse :: Nyaa</title></head><body><div class="container">\n${body}\n</div></body></html>`;
}

const DDOS_GUARD = `<!DOCTYPE html><html><head><title>DDOS-GUARD</title></head><body><h1>Checking your browser before accessing the website.</h1></body></html>`;

export function createNyaaHandler(options: NyaaFakeOptions): NyaaHandler {
  const origin = options.origin ?? 'https://nyaa.si';
  let items = options.items;
  let failure = options.failure;
  const requests: NyaaRequest[] = [];
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    requests.push({ at: Date.now(), path: url.pathname, params: url.searchParams, userAgent: request.headers.get('user-agent') });
    if (failure?.kind === 'ddosGuard') return new Response(DDOS_GUARD, { status: 503, headers: { server: 'ddos-guard', 'content-type': 'text/html' } });
    if (failure?.kind === 'brokenPage')
      return new Response('<html><body><p>Under maintenance.</p></body></html>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    const q = url.searchParams.get('q') ?? '';
    const found = items.filter((item) => matches(item, q)).sort((a, b) => b.id - a.id);
    if (url.searchParams.get('page') === 'rss') {
      return new Response(feed(found.slice(0, NYAA_PER_PAGE), origin, url.searchParams.get('m') === '1'), {
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    }
    const page = Math.max(1, Number(url.searchParams.get('p') ?? '1') || 1);
    return new Response(listing(found.slice((page - 1) * NYAA_PER_PAGE, page * NYAA_PER_PAGE)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  return {
    handle,
    requests,
    setFailure: (next) => {
      failure = next;
    },
    setItems: (next) => {
      items = next;
    },
  };
}
