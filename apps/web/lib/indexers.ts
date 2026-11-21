// Wording for the indexer screens. Kept here, not in .vue files, so
// `vp check` type-checks it. Messages name the host and endpoint path only,
// never the URL, which carries the key.
import type { IndexerDetail, IndexerFailureKind, IndexerHealth, IndexerKind, IndexerRow, RateLimitReason, SiteChallenge } from '@omnarr/contracts';

export type FailureInfo = {
  kind: IndexerFailureKind;
  httpStatus?: number;
  errorCode?: number;
  challenge?: SiteChallenge;
  /** A site search sent elsewhere. */
  redirectHost?: string;
  host: string;
  path: string;
};

const CHALLENGE: Record<SiteChallenge, string> = { ddosGuard: 'DDoS-Guard', cloudflare: 'Cloudflare' };

/** The site indexers "Add indexer › Site" lists: Nyaa for now. */
export const SITES = [{ kind: 'nyaa', label: 'Nyaa', description: 'Anime, search by title' }] as const satisfies readonly {
  kind: IndexerKind;
  label: string;
  description: string;
}[];

/** What a passed site test shows: what the site searches and its categories. */
export const siteTestText = (kind: (typeof SITES)[number]['kind']) =>
  ({ nyaa: { title: 'Nyaa: anime, search by title', categories: ['Anime (series)', 'Anime (movies)'] } })[kind];

/** The kind as a row shows it; a definition indexer shows its definition's name. */
export const kindLabel = (kind: IndexerKind, definitionName?: string): string =>
  kind === 'definition' && definitionName ? definitionName : { newznab: 'Newznab', torznab: 'Torznab', nyaa: 'Nyaa', definition: 'Site' }[kind];

/** The path a stored indexer's health message names: an API's endpoint, a site's root. */
export const healthPath = (kind: IndexerKind): string => (kind === 'nyaa' || kind === 'definition' ? '/' : '/api');

/** A site indexer's pacing, as its row says it. */
export const pacingText = (intervalMs: number): string => `One request every ${intervalMs / 1000} s`;

/** The connection test's answer when the site's pacing slot was refused. */
export const BUSY_TEXT = 'Busy: try again in a few minutes.';

export function failureText(failure: FailureInfo): string {
  const { host, path } = failure;
  switch (failure.kind) {
    case 'authRejected':
      return `${host} rejected the API key (${path}).`;
    case 'unreachable':
      return `${host} didn't answer. Check the URL.`;
    case 'timeout':
      return `${host} gave no answer in 10 seconds.`;
    case 'notAnIndexerApi':
      return `${host}${path} is not a Newznab or Torznab API.`;
    case 'apiDisabled':
      return `${host} has turned off API access for this account.`;
    case 'rateLimited':
      return `${host} says its request limit is reached.`;
    case 'httpError':
      if (failure.redirectHost && failure.redirectHost !== host)
        return `${host} redirected to ${failure.redirectHost}. The site may have moved: choose another link.`;
      return `${host} answered HTTP ${failure.httpStatus ?? '?'} at ${path}.`;
    case 'indexerError':
      return `${host} answered with error code ${failure.errorCode ?? '?'} at ${path}.`;
    case 'challenged':
      return `${host} asked for a browser check${failure.challenge ? ` (${CHALLENGE[failure.challenge]})` : ''}.`;
    case 'unexpectedPage':
      return `${host} answered with a page omnarr can't read. The site may have changed.`;
    case 'workerUnavailable':
      return "The worker didn't run the request. Is it connected?";
  }
}

/** Which rule set `rateLimitedUntil`, as the health card says it. */
export const RATE_LIMIT_REASON: Record<RateLimitReason, string> = {
  retryAfter: "the indexer's Retry-After",
  apilimits: "the indexer's API limits",
  ownCount: 'requests counted here in the last 24 hours',
  fallback: 'backing off: no hint from the indexer',
};

/** "Rate limited until 14:05 (…)", while the limit lasts. */
export function rateLimitText(
  row: Pick<IndexerRow, 'rateLimitedUntil' | 'rateLimitReason'>,
  now: number,
  formatTime: (ms: number) => string,
): string | undefined {
  if (row.rateLimitedUntil === undefined || row.rateLimitedUntil <= now) return undefined;
  const reason = row.rateLimitReason ? ` (${RATE_LIMIT_REASON[row.rateLimitReason]})` : '';
  return `Rate limited until ${formatTime(row.rateLimitedUntil)}${reason}`;
}

export const HEALTH_LABEL: Record<IndexerRow['health']['status'], { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  ok: { label: 'Healthy', color: 'success' },
  timeout: { label: 'No answer', color: 'warning' },
  rateLimited: { label: 'Rate limited', color: 'warning' },
  error: { label: 'Failing', color: 'error' },
  unknown: { label: 'Not used yet', color: 'neutral' },
};

/** What `indexers.create` and `indexers.update` refuse with, by their error data. */
export function indexerErrorText(error: unknown): string {
  const data = (error as { data?: Record<string, unknown> } | null)?.data;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  // A paced refusal carries `skipped: 'paced'` and no failure kind; the update path's site test drops `skipped`, so no kind is busy too.
  if (code === 'testFailed' && data) return data.skipped === 'paced' || typeof data.kind !== 'string' ? BUSY_TEXT : failureText(data as unknown as FailureInfo);
  if (code === 'nameTaken') return 'Another indexer has this name.';
  if (code === 'kindRequired') return "The indexer's answer doesn't say whether it is Usenet or torrent. Choose one.";
  if (code === 'alreadyExists') return 'Nyaa is already added.';
  if (code === 'notEditable') return "A site indexer's address and key can't be changed.";
  if (code === 'definitionUnsupported') return "omnarr can't run this site's definition.";
  if (code === 'definitionRequired') return 'Choose a site.';
  if (code === 'invalidBaseUrl') return "Choose one of the site's links.";
  if (code === 'invalidSettings') return `The setting ${typeof data?.setting === 'string' ? data.setting : ''} has a value the site does not offer.`;
  return 'Something went wrong. Try again.';
}

/** The confirm before Remove; `indexers.remove` keeps the candidates. A site indexer has no key. */
export const removeConfirm = (name: string, hasKey = true) => ({
  title: `Remove ${name}?`,
  description: `${name}${hasKey ? ' and its stored API key are' : ' is'} deleted. Releases it already found stay, shown as from a removed indexer.`,
});

export type InfoRow = { label: string; value: string };

/** The form's Caps block: what the indexer's caps and the settings give. */
export function capsBlock(detail: Pick<IndexerDetail, 'caps' | 'categories' | 'apiLimit' | 'rssIntervalMinutes' | 'effectiveRssIntervalMinutes'>): InfoRow[] {
  const byId = new Map(detail.caps.categories.map((c) => [c.id, c]));
  const topLevel = [...detail.categories.series, ...detail.categories.movies].flatMap((id) => {
    const category = byId.get(id);
    if (!category) return [];
    const parent = category.parentId === undefined ? category : byId.get(category.parentId);
    return parent ? [parent.name] : [];
  });
  const raised = detail.effectiveRssIntervalMinutes > detail.rssIntervalMinutes ? ' (raised to fit the API limit)' : '';
  return [
    {
      label: 'Search types',
      value:
        detail.caps.searchModes
          .filter((m) => m.available)
          .map((m) => m.mode)
          .join(', ') || 'None',
    },
    { label: 'Categories', value: [...new Set(topLevel)].join(', ') || 'None chosen' },
    {
      label: 'API limit',
      value: detail.apiLimit ? `${detail.apiLimit.max} requests a day${detail.apiLimit.source === 'user' ? ' (set here)' : ''}` : 'None reported',
    },
    { label: 'RSS', value: `Every ${detail.effectiveRssIntervalMinutes} min${raised}` },
  ];
}

const CALL_STATUS: Record<NonNullable<IndexerHealth['lastSearch']>['status'], string> = {
  ok: 'ok',
  timeout: 'no answer',
  rateLimited: 'rate limited',
  error: 'failed',
};

/** The form's Health block: the last search, the last RSS fetch and the day's errors. */
export function healthBlock(detail: Pick<IndexerDetail, 'health' | 'errors24h'>, formatTime: (ms: number) => string): InfoRow[] {
  const { lastSearch, lastRss } = detail.health;
  return [
    {
      label: 'Last search',
      value: lastSearch ? `${formatTime(lastSearch.at)} · ${CALL_STATUS[lastSearch.status]} · ${lastSearch.count} results` : 'None yet',
    },
    { label: 'Last RSS', value: lastRss ? `${formatTime(lastRss.at)} · ${lastRss.newItems} new items, ${lastRss.matched} matched` : 'None yet' },
    { label: 'Errors (24 h)', value: String(detail.errors24h) },
  ];
}

/** A comma-separated category list as numbers, ignoring anything that isn't one. */
export const parseCategories = (text: string): number[] =>
  text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
