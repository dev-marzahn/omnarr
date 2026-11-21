// A Cardigann definition: its types, and `loadDefinition`, which reads
// the YAML with `yaml` and refuses keys outside the format (`unknownKey`), so
// the support check sees what the engine would skip. The key names are the
// format's, as the upstream v11/v12 schema and Prowlarr's model name them;
// the lists below are written for omnarr.
import { parse } from 'yaml';

import type { Filter } from './filters.ts';

export type SelectorBlock = {
  selector?: string;
  optional?: boolean;
  default?: string;
  text?: string;
  attribute?: string;
  remove?: string;
  filters?: Filter[];
  case?: Record<string, string>;
};

export type SettingsField = { name: string; type: string; label?: string; default?: unknown; defaults?: unknown[]; options?: Record<string, string> };

export type CategoryMapping = { id: string; cat?: string; desc?: string; default?: boolean };

export type SearchPath = {
  path: string;
  method?: string;
  inputs?: Record<string, string>;
  queryseparator?: string;
  categories?: string[];
  inheritinputs?: boolean;
  followredirect?: boolean;
  response?: { type?: string; noResultsMessage?: string };
};

export type SelectorField = { selector?: string; attribute?: string; usebeforeresponse?: boolean; filters?: Filter[] };

export type Definition = {
  id: string;
  replaces?: string[];
  name: string;
  description?: string;
  language?: string;
  type?: string;
  encoding?: string;
  requestDelay?: number;
  links: string[];
  legacylinks?: string[];
  followredirect?: boolean;
  testlinktorrent?: boolean;
  certificates?: string[];
  caps: {
    categories?: Record<string, string>;
    categorymappings?: CategoryMapping[];
    modes?: Record<string, string[]>;
    allowrawsearch?: boolean;
  };
  settings: SettingsField[];
  login?: Record<string, unknown> & { method?: string; captcha?: unknown };
  ratio?: unknown;
  search: {
    paths: SearchPath[];
    headers?: Record<string, string | string[]>;
    keywordsfilters?: Filter[];
    allowEmptyInputs?: boolean;
    inputs?: Record<string, string>;
    error?: unknown[];
    preprocessingfilters?: Filter[];
    rows: SelectorBlock & { after?: number; dateheaders?: SelectorBlock; count?: SelectorBlock; multiple?: boolean; missingAttributeEqualsNoResults?: boolean };
    fields: [string, SelectorBlock][];
  };
  download?: {
    selectors?: SelectorField[];
    method?: string;
    before?: { path?: string; method?: string; inputs?: Record<string, string>; queryseparator?: string; pathselector?: SelectorField };
    infohash?: { hash?: SelectorField; title?: SelectorField; usebeforeresponse?: boolean };
    headers?: Record<string, string | string[]>;
  };
};

type Shape = { keys: readonly string[]; children?: Record<string, Shape | 'map' | 'list'> };

const SELECTOR_KEYS = ['selector', 'optional', 'default', 'text', 'attribute', 'remove', 'filters', 'case'] as const;
const FILTER: Shape = { keys: ['name', 'args'] };
const FILTERS: Record<string, Shape> = { filters: FILTER };
const SELECTOR: Shape = { keys: SELECTOR_KEYS, children: FILTERS };
const SELECTOR_FIELD: Shape = { keys: ['selector', 'attribute', 'usebeforeresponse', 'filters'], children: FILTERS };
const ERROR: Shape = { keys: ['path', 'selector', 'message'], children: { message: SELECTOR } };
const REQUEST_KEYS = ['path', 'method', 'inputs', 'queryseparator'] as const;

/** Every key of the format, per block. A key elsewhere is `unknownKey`. */
const SHAPE: Shape = {
  keys: [
    'id',
    'replaces',
    'name',
    'description',
    'language',
    'type',
    'encoding',
    'requestDelay',
    'links',
    'legacylinks',
    'followredirect',
    'testlinktorrent',
    'certificates',
    'caps',
    'settings',
    'login',
    'ratio',
    'search',
    'download',
  ],
  children: {
    settings: { keys: ['name', 'type', 'label', 'default', 'defaults', 'options'] },
    caps: { keys: ['categories', 'categorymappings', 'modes', 'allowrawsearch'], children: { categorymappings: { keys: ['id', 'cat', 'desc', 'default'] } } },
    login: {
      keys: [
        'path',
        'submitpath',
        'cookies',
        'method',
        'form',
        'selectors',
        'inputs',
        'selectorinputs',
        'getselectorinputs',
        'error',
        'test',
        'captcha',
        'headers',
      ],
      children: { error: ERROR, test: { keys: ['path', 'selector'] }, captcha: { keys: ['type', 'selector', 'image', 'input'] } },
    },
    ratio: { keys: [...SELECTOR_KEYS, 'path'], children: FILTERS },
    search: {
      keys: ['path', 'paths', 'headers', 'keywordsfilters', 'allowEmptyInputs', 'inputs', 'error', 'preprocessingfilters', 'rows', 'fields'],
      children: {
        paths: {
          keys: [...REQUEST_KEYS, 'categories', 'inheritinputs', 'followredirect', 'response'],
          children: { response: { keys: ['type', 'noResultsMessage'] } },
        },
        keywordsfilters: FILTER,
        preprocessingfilters: FILTER,
        error: ERROR,
        rows: {
          keys: [...SELECTOR_KEYS, 'after', 'dateheaders', 'count', 'multiple', 'missingAttributeEqualsNoResults'],
          children: { ...FILTERS, dateheaders: SELECTOR, count: SELECTOR },
        },
      },
    },
    download: {
      keys: ['selectors', 'method', 'before', 'infohash', 'headers'],
      children: {
        selectors: SELECTOR_FIELD,
        before: { keys: [...REQUEST_KEYS, 'pathselector'], children: { pathselector: SELECTOR_FIELD } },
        infohash: { keys: ['hash', 'title', 'usebeforeresponse'], children: { hash: SELECTOR_FIELD, title: SELECTOR_FIELD } },
      },
    },
  },
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A YAML scalar as text, as .NET's `(string)` cast reads it. */
export const yamlText = (value: unknown): string => String(value as string | number | boolean);

/** The first key outside the format, as a dotted path. */
function unknownKey(value: unknown, shape: Shape, at: string): string | undefined {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (!isObject(item)) continue;
    for (const [key, child] of Object.entries(item)) {
      if (!shape.keys.includes(key)) return `${at}${key}`;
      const nested = shape.children?.[key];
      if (nested && typeof nested === 'object') {
        const found = unknownKey(child, nested, `${at}${key}.`);
        if (found) return found;
      }
    }
  }
  // `fields` is a map of selector blocks under any name.
  if (shape === SHAPE.children!.search && isObject(value) && isObject(value.fields)) {
    for (const [name, field] of Object.entries(value.fields)) {
      const found = unknownKey(field, SELECTOR, `${at}fields.${name}.`);
      if (found) return found;
    }
  }
  return undefined;
}

export type Loaded = { ok: true; definition: Definition } | { ok: false; reason: 'invalidYaml' | 'unknownKey'; detail: string };

/** A list of names, or a single name, as a list. */
const listOf = (value: unknown): string[] | undefined =>
  value === undefined || value === null ? undefined : Array.isArray(value) ? value.map(String) : [yamlText(value)];

/** Reads a definition: the YAML, the key check, and Prowlarr's clean-up (default settings, encoding, `search.path`). */
export function loadDefinition(text: string): Loaded {
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 100, uniqueKeys: false });
  } catch (error) {
    return { ok: false, reason: 'invalidYaml', detail: (error as Error).message.split('\n')[0]! };
  }
  if (!isObject(raw) || typeof raw.id !== 'string' || !isObject(raw.search)) return { ok: false, reason: 'invalidYaml', detail: 'no id or search block' };
  const key = unknownKey(raw, SHAPE, '');
  if (key) return { ok: false, reason: 'unknownKey', detail: key };
  const search = raw.search as Record<string, unknown>;
  const paths = Array.isArray(search.paths) ? search.paths : search.path !== undefined ? [{ path: search.path }] : [];
  const fields = isObject(search.fields) ? (Object.entries(search.fields) as [string, SelectorBlock][]) : [];
  const links = listOf(raw.links) ?? [];
  if (!links.length) return { ok: false, reason: 'invalidYaml', detail: 'no links' };
  const definition = {
    ...(raw as unknown as Definition),
    name: yamlText(raw.name ?? raw.id),
    links,
    ...(raw.legacylinks !== undefined ? { legacylinks: listOf(raw.legacylinks) } : {}),
    caps: isObject(raw.caps) ? (raw.caps as Definition['caps']) : {},
    // Prowlarr adds a username and password when a file has no settings (IndexerDefinitionUpdateService).
    settings: Array.isArray(raw.settings)
      ? (raw.settings as SettingsField[])
      : [
          { name: 'username', label: 'Username', type: 'text' },
          { name: 'password', label: 'Password', type: 'password' },
        ],
    encoding: typeof raw.encoding === 'string' ? raw.encoding : 'UTF-8',
    search: {
      ...(search as unknown as Definition['search']),
      paths: paths as SearchPath[],
      fields,
      rows: (isObject(search.rows) ? search.rows : {}) as Definition['search']['rows'],
    },
  } satisfies Definition;
  return { ok: true, definition };
}

/** The site link a stored base URL resolves to: a legacy link becomes the first link (ResolveSiteLink). */
export function siteLinkOf(definition: Definition, baseUrl: string | undefined): string {
  if (!baseUrl) return definition.links[0]!;
  if (definition.legacylinks?.includes(baseUrl)) return definition.links[0]!;
  return baseUrl;
}
