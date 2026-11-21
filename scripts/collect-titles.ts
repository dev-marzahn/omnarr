// Collects release titles from one of your own Newznab or Torznab indexers, as
// raw material for the parser's golden corpus. It writes titles and
// categories only, one JSON object a line, to a file outside the repository.
// Pick titles from it, write their expected fields by hand, and add them to
// packages/parser/test/golden/ with `source: "indexer"`.
//
//   COLLECT_INDEXER_KEY=<key> node scripts/collect-titles.ts \
//     --url https://indexer.example --categories 5000,2000 --pages 5 --out ~/titles.jsonl
//
// The key is read from the environment so it stays out of shell history. No
// GUID, URL or key is written or printed.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { IndexerFailureKind } from '@omnarr/contracts';

import { parseFeed } from '../packages/backend/convex/indexers/feed.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

export type CollectedTitle = { title: string; categories: number[] };

/** Thrown for a usage error or a failed request; `main` prints the message. */
class CollectError extends Error {}

/** The real path, resolving symlinks in the part of the path that exists (macOS's /tmp is /private/tmp). */
function realResolve(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realResolve(parent), basename(absolute));
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(realResolve(dir), realResolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A pasted URL whose path doesn't end in `/api` gets `/api` appended. */
function apiUrlOf(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CollectError('--url is not a URL.');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.replace(/\/+$/, '').endsWith('/api')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/api`;
  return url;
}

function httpFailure(status: number): IndexerFailureKind {
  if (status === 401 || status === 403) return 'authRejected';
  if (status === 429) return 'rateLimited';
  return 'httpError';
}

async function fetchPage(apiUrl: URL, apiKey: string, categories: number[], offset: number) {
  const url = new URL(apiUrl);
  url.search = new URLSearchParams({ t: 'search', cat: categories.join(','), limit: String(PAGE_LIMIT), offset: String(offset), apikey: apiKey }).toString();
  const where = `${apiUrl.hostname} ${apiUrl.pathname}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const kind: IndexerFailureKind = error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    throw new CollectError(`${kind} at ${where}`);
  }
  if (!response.ok) throw new CollectError(`${httpFailure(response.status)} (HTTP ${response.status}) at ${where}`);
  const result = parseFeed(await response.text(), { host: apiUrl.hostname, path: apiUrl.pathname, protocol: 'usenet' });
  if (!result.ok) {
    const code = result.failure.errorCode === undefined ? '' : ` (code ${result.failure.errorCode})`;
    throw new CollectError(`${result.failure.kind}${code} at ${where}`);
  }
  return result.value;
}

export type CollectOptions = { url: string; apiKey: string; categories: number[]; pages: number; out: string };

/** Reads up to `pages` pages of `t=search` and writes each new title once, newest first. */
export async function collectTitles(options: CollectOptions): Promise<{ titles: number; pages: number }> {
  if (isInside(options.out, ROOT)) throw new CollectError(`--out must be outside the repository (${ROOT}); golden cases are written by hand.`);
  const apiUrl = apiUrlOf(options.url);
  const seen = new Set<string>();
  const collected: CollectedTitle[] = [];
  let offset = 0;
  let pages = 0;
  let failure: CollectError | undefined;
  while (pages < options.pages) {
    let page;
    try {
      page = await fetchPage(apiUrl, options.apiKey, options.categories, offset);
    } catch (error) {
      if (!(error instanceof CollectError)) throw error;
      failure = error;
      break;
    }
    pages += 1;
    for (const item of page.items) {
      if (seen.has(item.title)) continue;
      seen.add(item.title);
      collected.push({ title: item.title, categories: item.categories });
    }
    offset += page.items.length;
    if (page.items.length === 0 || (page.total !== undefined && offset >= page.total)) break;
  }
  if (collected.length > 0) writeFileSync(options.out, collected.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  if (failure) throw new CollectError(`${failure.message}; stopped after ${pages} page(s), ${collected.length} title(s) written.`);
  return { titles: collected.length, pages };
}

function optionsFrom(argv: string[], env: NodeJS.ProcessEnv): CollectOptions {
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: 'string' }, categories: { type: 'string' }, pages: { type: 'string', default: '5' }, out: { type: 'string' } },
  });
  const usage = 'Usage: COLLECT_INDEXER_KEY=<key> node scripts/collect-titles.ts --url <indexer> --categories 5000,2000 [--pages 5] --out <file>';
  if (!values.url || !values.categories || !values.out) throw new CollectError(usage);
  const apiKey = env.COLLECT_INDEXER_KEY;
  if (!apiKey) throw new CollectError(`Set COLLECT_INDEXER_KEY to the indexer's API key.\n${usage}`);
  const categories = values.categories.split(',').map((value) => Number(value.trim()));
  if (categories.some((id) => !Number.isInteger(id) || id <= 0)) throw new CollectError('--categories takes comma-separated category IDs, such as 5000,2000.');
  const pages = Number(values.pages);
  if (!Number.isInteger(pages) || pages < 1) throw new CollectError('--pages takes a whole number of at least 1.');
  return { url: values.url, apiKey, categories, pages, out: values.out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = optionsFrom(process.argv.slice(2), process.env);
    const { titles, pages } = await collectTitles(options);
    console.log(`Wrote ${titles} title(s) from ${pages} page(s) to ${options.out}`);
  } catch (error) {
    if (!(error instanceof CollectError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
