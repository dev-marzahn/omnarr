// A grab through a definition: the `download` block's `before`
// request, its `infohash` selectors (a magnet) or its `selectors` on the
// details page (the first link that is a magnet or a .torrent), and then the
// file. No request carries a session yet. The `siteUrl` itself must be on
// one of the definition's hosts.
//
// Ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannRequestGenerator.cs
// (DownloadRequest, HandleRequest, MatchSelector) at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr; a tested .torrent link's body is
// used as the file instead of fetching it a second time.
import { REFUSED_HOSTS } from '../release/fetch.ts';
import type { Definition, SelectorField } from './definition.ts';
import { urlEncode } from './encoding.ts';
import { applyFilters } from './filters.ts';
import { PacedSkip, siteFailure, siteRequest, type SiteHttpOptions, type SiteResponse } from './http.ts';
import { headersOf, resolve } from './request.ts';
import { parseDom, querySelector } from './selectors.ts';
import { applyTemplate, type Variables } from './template.ts';

export type Downloaded = { kind: 'torrent'; bytes: Uint8Array } | { kind: 'magnet'; uri: string };

export type DownloadOutcome = { ok: true; value: Downloaded } | { ok: false; failure: ReturnType<typeof siteFailure> };

/** The hosts a `siteUrl` may name: the definition's links and legacy links. */
export function definitionHosts(definition: Definition): Set<string> {
  const hosts = new Set<string>();
  for (const link of [...definition.links, ...(definition.legacylinks ?? [])]) {
    try {
      hosts.add(new URL(link).host);
    } catch {
      // a link that isn't a URL names no host
    }
  }
  return hosts;
}

/** AddTemplateVariablesFromUri with the `.DownloadUri` prefix. */
function uriVariables(variables: Variables, link: URL): void {
  const prefix = '.DownloadUri';
  variables[`${prefix}.AbsoluteUri`] = link.href;
  variables[`${prefix}.AbsolutePath`] = link.pathname;
  variables[`${prefix}.Scheme`] = link.protocol.replace(/:$/, '');
  variables[`${prefix}.Host`] = link.hostname;
  variables[`${prefix}.Port`] = link.port || (link.protocol === 'https:' ? '443' : '80');
  variables[`${prefix}.PathAndQuery`] = link.pathname + link.search;
  variables[`${prefix}.Query`] = link.search;
  for (const [key, value] of link.searchParams) if (!(`${prefix}.Query.${key}` in variables)) variables[`${prefix}.Query.${key}`] = value;
}

/** MatchSelector: the first element's attribute or text, filtered; undefined when nothing matches. */
function matchSelector(body: string, field: SelectorField, variables: Variables, definition: Definition, now: number): string | undefined {
  const dom = parseDom(body, false);
  const element = querySelector(dom, dom.$.root(), applyTemplate(field.selector ?? '', variables));
  if (!element) return undefined;
  const value = field.attribute !== undefined ? element.attr(field.attribute) : element.text();
  if (value === undefined) throw new Error(`attribute ${field.attribute} is not set`);
  return applyFilters(value, field.filters, { variables, encoding: definition.encoding, now });
}

const isTorrent = (bytes: Uint8Array) => bytes.length > 0 && bytes[0] === 0x64; // 'd', a bencoded dictionary

export async function runDownload(
  definition: Definition,
  url: string,
  options: { http: SiteHttpOptions; variables: Variables; now: number },
): Promise<DownloadOutcome> {
  let link: URL;
  try {
    link = new URL(url);
  } catch {
    return { ok: false, failure: siteFailure('httpError', url) };
  }
  if (link.protocol === 'magnet:') return { ok: true, value: { kind: 'magnet', uri: url } };
  if (!definitionHosts(definition).has(link.host)) return { ok: false, failure: siteFailure('notAnIndexerApi', url) };
  const { http, now } = options;
  const variables: Variables = { ...options.variables };
  uriVariables(variables, link);
  const download = definition.download;
  const headers = headersOf(download?.headers ?? definition.search.headers, variables);
  const get = (target: string, binary = false, followRedirect = true) => siteRequest({ url: target, method: 'GET', headers, followRedirect, binary }, http);
  let method: 'GET' | 'POST' = 'GET';
  let response: SiteResponse | undefined;
  let finalBytes: Uint8Array | undefined;

  if (download) {
    const before = download.before;
    if (before) {
      let path = before.path;
      if (before.pathselector) {
        response = await get(link.href);
        if (!response.ok) return response;
        path = matchSelector(response.body, before.pathselector, variables, definition, now);
      }
      const beforeMethod = String(before.method ?? '').toLowerCase() === 'post' ? 'POST' : 'GET';
      let target = resolve(applyTemplate(path ?? '', variables), definition.links[0]!);
      const pairs = Object.entries(before.inputs ?? {}).map(([key, value]) => [key, applyTemplate(String(value ?? ''), variables)] as [string, string]);
      if (beforeMethod === 'GET' && pairs.length)
        target += `${target.includes('?') ? '' : '?'}${pairs.map(([key, value]) => `${key}=${urlEncode(value, definition.encoding)}`).join(before.queryseparator ?? '&')}`;
      response = await siteRequest(
        {
          url: target,
          method: beforeMethod,
          ...(beforeMethod === 'POST' ? { form: pairs } : {}),
          headers: { ...headers, referer: link.href },
          followRedirect: false,
        },
        http,
      );
    }
    if (String(download.method ?? '').toLowerCase() === 'post') method = 'POST';

    if (download.infohash) {
      if (!download.infohash.usebeforeresponse || !before || !response) response = await get(link.href);
      if (!response.ok) return response;
      const hash = download.infohash.hash ? matchSelector(response.body, download.infohash.hash, variables, definition, now) : undefined;
      const title = download.infohash.title ? matchSelector(response.body, download.infohash.title, variables, definition, now) : undefined;
      if (!hash || title === undefined) return { ok: false, failure: siteFailure('unexpectedPage', link.href) };
      return { ok: true, value: { kind: 'magnet', uri: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` } };
    }

    if (download.selectors?.length) {
      let found = false;
      for (const selector of download.selectors) {
        try {
          if (!selector.usebeforeresponse || !before || !response) response = await get(link.href);
          if (!response.ok) return response;
          const href = matchSelector(response.body, selector, variables, definition, now);
          if (!href) continue;
          const torrentLink = new URL(href, link);
          if (torrentLink.protocol === 'magnet:') return { ok: true, value: { kind: 'magnet', uri: torrentLink.href } };
          // A page's link never reaches the stack's own services (`REFUSED_HOSTS`), nor anything but http(s).
          if (!/^https?:$/.test(torrentLink.protocol) || REFUSED_HOSTS.has(torrentLink.hostname))
            return { ok: false, failure: siteFailure('unexpectedPage', link.href) };
          if (definition.testlinktorrent !== false) {
            const tested = await get(torrentLink.href, true);
            if (!tested.ok || !isTorrent(tested.bytes)) continue;
            if (method === 'GET') finalBytes = tested.bytes;
          }
          link = torrentLink;
          found = true;
          break;
        } catch (error) {
          // Prowlarr goes on with the next selector; a refused pacing slot ends the grab.
          if (error instanceof PacedSkip) throw error;
        }
      }
      if (!found) return { ok: false, failure: siteFailure('unexpectedPage', url) };
    }
  }

  if (finalBytes) return { ok: true, value: { kind: 'torrent', bytes: finalBytes } };
  const final = await siteRequest({ url: link.href, method, headers, followRedirect: true, binary: true }, http);
  if (!final.ok) return final;
  if (!isTorrent(final.bytes)) return { ok: false, failure: siteFailure('unexpectedPage', link.href) };
  return { ok: true, value: { kind: 'torrent', bytes: final.bytes } };
}
