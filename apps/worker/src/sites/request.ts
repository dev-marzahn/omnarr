// A search's requests: the IndexerRequest as `.Query`, the
// definition's settings as `.Config`, the keywords through
// `keywordsfilters`, then one request per search path, with Prowlarr's
// category rule per path and its duplicate-GET rule.
//
// Ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannRequestGenerator.cs
// (GetQueryVariableDefaults, GetRequest) and CardigannBase.cs
// (GetBaseTemplateVariables) at commit 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr; settings are stored by option
// key, not by index into the sorted options.
import type { IndexerRequest, SiteSettings } from '@omnarr/contracts';

import { categoryMappings, siteCategoriesFor } from './categories.ts';
import { type Definition, type SearchPath, yamlText } from './definition.ts';
import { urlEncode, webUrlEncode } from './encoding.ts';
import { applyFilters } from './filters.ts';
import type { SiteRequest } from './http.ts';
import { applyTemplate, type Variables } from './template.ts';

const two = (value: string) => (/^\d$/.test(value) ? `0${value}` : value);

/** GetBaseTemplateVariables: the site link, `.True`, `.False`, `.Today.Year` and the settings as `.Config.*`. */
export function baseVariables(definition: Definition, siteLink: string, settings: SiteSettings, now: number): Variables {
  const variables: Variables = { '.Config.sitelink': siteLink, '.True': 'True', '.False': null, '.Today.Year': String(new Date(now).getUTCFullYear()) };
  for (const setting of definition.settings) {
    const name = `.Config.${setting.name}`;
    const stored = settings[setting.name];
    const fallback = setting.default === undefined || setting.default === null ? undefined : setting.default;
    switch (setting.type) {
      case 'text':
      case 'password':
        variables[name] = stored === undefined ? (fallback === undefined ? null : yamlText(fallback)) : String(stored);
        break;
      case 'checkbox': {
        const value = stored ?? fallback;
        variables[name] = value === true || yamlText(value).toLowerCase() === 'true' ? '.True' : null;
        break;
      }
      case 'select': {
        const keys = Object.keys(setting.options ?? {});
        const value = stored === undefined ? fallback : stored;
        variables[name] = value !== undefined && keys.includes(yamlText(value)) ? yamlText(value) : (keys.sort()[0] ?? null);
        break;
      }
      default:
        break;
    }
  }
  return variables;
}

/** EpisodeSearchString: `S01E02`, or `S01` without an episode. */
const episodeString = (request: IndexerRequest) => (request.season ? `S${two(request.season)}${request.ep ? `E${two(request.ep)}` : ''}` : null);

/** `.Query.*` for an IndexerRequest (GetQueryVariableDefaults and the per-type values). */
export function queryVariables(request: IndexerRequest | undefined): Variables {
  const ids = request?.ids ?? {};
  const type = !request ? 'search' : request.fn === 'tvsearch' ? 'tvsearch' : request.fn === 'movie' ? 'movie' : 'search';
  const variables: Variables = {
    '.Query.Type': type,
    '.Query.Q': request?.q ?? null,
    '.Query.Categories': (request?.categories ?? []).map(String),
    '.Query.Limit': request ? String(request.limit) : null,
    '.Query.Offset': request ? String(request.offset) : null,
    '.Query.Extended': null,
    '.Query.APIKey': null,
    '.Query.Genre': null,
    '.Query.Movie': null,
    '.Query.Year': null,
    '.Query.IMDBID': ids.imdbid ? `tt${ids.imdbid.replace(/^tt/, '').padStart(7, '0')}` : null,
    '.Query.IMDBIDShort': ids.imdbid ? ids.imdbid.replace(/^tt/, '') : null,
    '.Query.TMDBID': ids.tmdbid ?? null,
    '.Query.Series': null,
    '.Query.Ep': request?.fn === 'tvsearch' ? (request.ep ?? null) : null,
    '.Query.Season': request?.fn === 'tvsearch' ? (request.season ?? null) : null,
    '.Query.TVDBID': ids.tvdbid ?? null,
    '.Query.TVRageID': null,
    '.Query.TVMazeID': null,
    '.Query.TraktID': null,
    '.Query.DoubanID': null,
    '.Query.Episode': request?.fn === 'tvsearch' ? episodeString(request) : null,
    '.Query.Album': null,
    '.Query.Artist': null,
    '.Query.Label': null,
    '.Query.Track': null,
    '.Query.Author': null,
    '.Query.Title': null,
    '.Query.Publisher': null,
  };
  return variables;
}

/** The search's keyword tokens (Q, Series, Movie, Year, then Episode), joined, and `.Keywords` after `keywordsfilters`. */
function keywords(definition: Definition, variables: Variables, encoding: string | undefined, now: number): void {
  const tokens = ['.Query.Q', '.Query.Series', '.Query.Movie', '.Query.Year', '.Query.Episode']
    .map((name) => variables[name])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  variables['.Query.Keywords'] = tokens.join(' ');
  variables['.Keywords'] = applyFilters(tokens.join(' '), definition.search.keywordsfilters, { variables, encoding, now });
}

/** `key=value` pairs, the value URL-encoded in the site's encoding (StringUtil.GetQueryString). */
const queryString = (pairs: [string, string][], encoding: string | undefined, separator = '&') =>
  pairs.map(([key, value]) => `${key}=${urlEncode(value, encoding)}`).join(separator);

/** ResolvePath: `path` against the site link. */
export const resolve = (path: string, base: string) => new URL(path, base).href;

export type PlannedRequest = { request: SiteRequest; path: SearchPath; variables: Variables };

/** Header values (a list takes its first), templated. */
export const headersOf = (headers: Record<string, string | string[]> | undefined, variables: Variables): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name, applyTemplate(Array.isArray(value) ? String(value[0] ?? '') : String(value), variables)]),
  );

/** GetRequest: every search path's request for an IndexerRequest, or for RSS (no request: no keywords). */
export function searchRequests(
  definition: Definition,
  options: { siteLink: string; settings: SiteSettings; request?: IndexerRequest; now: number },
): PlannedRequest[] {
  const { siteLink, now } = options;
  const encoding = definition.encoding;
  const variables: Variables = { ...baseVariables(definition, siteLink, options.settings, now), ...queryVariables(options.request) };
  let mapped = siteCategoriesFor(definition, options.request?.categories ?? []);
  if (!mapped.length)
    mapped = categoryMappings(definition)
      .filter((mapping) => mapping.default)
      .map((mapping) => mapping.siteId);
  keywords(definition, variables, encoding, now);
  const { search } = definition;
  const seen = new Set<string>();
  const planned: PlannedRequest[] = [];
  for (const path of search.paths) {
    const pathVariables: Variables = { ...variables, '.Categories': mapped };
    if (path.categories && mapped.length) {
      const pathCats = path.categories.map(String);
      let intersects = mapped.some((id) => pathCats.includes(id));
      if (pathCats[0] === '!') intersects = !intersects;
      if (!intersects) continue;
      pathVariables['.Categories'] = mapped.filter((id) => pathCats.includes(id));
    }
    let url = resolve(applyTemplate(path.path, pathVariables, webUrlEncode).replace(/\+/g, '%20'), siteLink);
    const method = String(path.method ?? '').toLowerCase() === 'post' ? 'POST' : 'GET';
    const pairs: [string, string][] = [];
    const inputSets = [...(path.inheritinputs === false ? [] : [search.inputs]), path.inputs];
    for (const inputs of inputSets) {
      for (const [key, raw] of Object.entries(inputs ?? {})) {
        if (key === '$raw') {
          for (const part of applyTemplate(String(raw), pathVariables, webUrlEncode).split('&')) {
            const eq = part.indexOf('=');
            const name = eq < 0 ? part : part.slice(0, eq);
            if (name) pairs.push([name, eq < 0 ? '' : part.slice(eq + 1)]);
          }
          continue;
        }
        const value = applyTemplate(raw === null || raw === undefined ? '' : String(raw), pathVariables);
        if (value.trim() || search.allowEmptyInputs) pairs.push([key, value]);
      }
    }
    if (method === 'GET' && pairs.length) url += `?${queryString(pairs, encoding)}`;
    if (method === 'GET' && seen.has(url)) continue;
    seen.add(url);
    planned.push({
      request: {
        url,
        method,
        ...(method === 'POST' ? { form: pairs } : {}),
        headers: headersOf(search.headers, pathVariables),
        // The top-level `followredirect` is the login's; a search follows only its path's (CardigannRequestGenerator).
        followRedirect: path.followredirect === true,
      },
      path,
      variables: pathVariables,
    });
  }
  return planned;
}
