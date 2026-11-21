// The support check: static, run at sync. A definition the
// engine can't run as Prowlarr would is unsupported with one reason and a
// detail that names what and where; it is never run with a wrong result.
import {
  BUILT_IN_DEFINITIONS,
  type DefinitionMeta,
  type DefinitionSupport,
  type DefinitionSupportReason,
  REPLACED_UPSTREAM_DEFINITIONS,
} from '@omnarr/contracts';

import { categoryMappings } from './categories.ts';
import { tokenizeLayout } from './dates.ts';
import { type Definition, loadDefinition, type SelectorBlock, type SelectorField, yamlText } from './definition.ts';
import { canEncode, encodingLabel } from './encoding.ts';
import { argAt, argText, type Filter, FILTERS } from './filters.ts';
import { parsePath } from './jsonPath.ts';
import { translateRegex } from './regex.ts';
import { selectorError } from './selectors.ts';
import { unknownConstructs } from './template.ts';

/** Rows of 900 KB or more don't fit a Convex document beside their metadata. */
export const MAX_DEFINITION_BYTES = 900 * 1024;

/** The setting types the form can show; `info*` are text. */
const SETTING_TYPES = new Set(['text', 'password', 'checkbox', 'select', 'info', 'info_cookie', 'info_useragent', 'info_category_8000', 'info_flaresolverr']);

/** The row filters Prowlarr knows (CardigannParser.ParseRowFilters). */
const ROW_FILTERS = new Set(['andmatch', 'strdump']);

export type Checked = { definitionId?: string; definition?: Definition; meta?: DefinitionMeta; support: DefinitionSupport };

class Unsupported extends Error {
  public constructor(
    public readonly reason: DefinitionSupportReason,
    public readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

const no = (reason: DefinitionSupportReason, detail: string): never => {
  throw new Unsupported(reason, detail);
};

function checkTemplate(template: unknown, at: string): void {
  if (typeof template !== 'string') return;
  const unknown = unknownConstructs(template);
  if (unknown.length) no('templateConstruct', `${unknown[0]} in ${at}`);
  for (const match of template.matchAll(/{{\s*re_replace\s+\..+?\s+"(.*?)"\s+".*?"\s*}}/g)) checkRegex(match[1]!, at);
  // Prowlarr's `if` takes only a variable once the logic functions ran: a literal or a call there throws at run time.
  for (const match of template.matchAll(/{{\s*if\s+([^}]+?)\s*}}/g)) {
    const condition = match[1]!;
    if (!/^(?:\(|\.|(?:and|or|eq|ne)\s)/.test(condition)) no('templateConstruct', `if ${condition} in ${at}`);
  }
}

function checkRegex(pattern: string, at: string): void {
  const translated = translateRegex(pattern);
  if (!translated.ok) no('regex', `${translated.reason} (${translated.detail}) in ${at}`);
}

function checkFilters(filters: Filter[] | undefined, at: string, rowFilters = false): void {
  for (const filter of filters ?? []) {
    if (!filter || typeof filter.name !== 'string') no('unknownFilter', `a filter without a name in ${at}`);
    if (rowFilters) {
      if (!ROW_FILTERS.has(filter.name)) no('unknownFilter', `${filter.name} in ${at}`);
      continue;
    }
    if (!FILTERS.has(filter.name)) no('unknownFilter', `${filter.name} in ${at}`);
    switch (filter.name) {
      case 'regexp':
        checkRegex(argText(filter.args) ?? '', at);
        break;
      case 're_replace':
        checkRegex(argAt(filter.args, 0), at);
        checkTemplate(argAt(filter.args, 1), at);
        break;
      case 'replace':
        checkTemplate(argAt(filter.args, 1), at);
        break;
      case 'append':
      case 'prepend':
        checkTemplate(argText(filter.args), at);
        break;
      case 'dateparse':
      case 'timeparse': {
        const layout = tokenizeLayout(argText(filter.args) ?? '');
        if (!layout.ok) no('dateLayout', `${layout.detail} in ${at}`);
        break;
      }
      case 'diacritics':
        if (argText(filter.args) !== 'replace') no('unsupportedFeature', `diacritics ${argText(filter.args)} in ${at}`);
        break;
      case 'jsonjoinarray':
        if (!parsePath(argAt(filter.args, 0))) no('selector', `the JSON path ${argAt(filter.args, 0)} in ${at}`);
        break;
    }
  }
}

function checkCss(selector: string | undefined, at: string): void {
  if (typeof selector !== 'string') return;
  checkTemplate(selector, at);
  const error = selectorError(selector);
  if (error) no('selector', `${selector} in ${at}: ${error}`);
}

function checkJsonSelector(selector: string | undefined, at: string): void {
  if (typeof selector !== 'string') return;
  checkTemplate(selector, at);
  if (selector.includes('{{')) return;
  const path = selector.replace(/^\.+/, '').split(':')[0]!;
  if (path && !parsePath(path)) no('selector', `the JSON path ${selector} in ${at}`);
  for (const match of selector.matchAll(/:(.+?)\((.+?)\)(?=:|$)/g)) {
    if (!['has', 'not', 'contains'].includes(match[1]!)) no('selector', `:${match[1]} in ${at}`);
  }
}

function checkBlock(block: SelectorBlock | undefined, at: string, json: boolean): void {
  if (!block || typeof block !== 'object') return;
  (json ? checkJsonSelector : checkCss)(block.selector, at);
  checkTemplate(block.text, at);
  checkTemplate(block.default, at);
  if (block.remove !== undefined) checkCss(block.remove, at);
  for (const [key, value] of Object.entries(block.case ?? {})) {
    if (!json && key !== '*') checkCss(key, `${at}.case`);
    checkTemplate(value, `${at}.case`);
  }
  checkFilters(block.filters, at);
}

function checkField(field: SelectorField | undefined, at: string): void {
  if (!field) return;
  checkCss(field.selector, at);
  checkFilters(field.filters, at);
}

function checkStructure(definition: Definition): void {
  const id = definition.id;
  if ((BUILT_IN_DEFINITIONS as readonly string[]).includes(id)) no('builtIn', 'Built in: add Nyaa from the Site list');
  if ((REPLACED_UPSTREAM_DEFINITIONS as readonly string[]).includes(id)) no('replacedUpstream', 'Prowlarr runs this site with its own code');
  for (const setting of definition.settings) {
    if (setting.type === 'info_flaresolverr') no('needsFlareSolverr', 'The site needs FlareSolverr');
    if (!SETTING_TYPES.has(setting.type)) no('unsupportedFeature', `the setting type ${setting.type}`);
  }
  if (definition.login?.captcha) no('captcha', 'The login has a captcha');
  if (definition.type !== 'public') no('privateInP2', `a ${definition.type ?? 'untyped'} site`);
  if (definition.login) no('privateInP2', 'the site has a login');
  if (definition.certificates?.length) no('unsupportedFeature', 'certificates');
  if (!encodingLabel(definition.encoding) || !canEncode(definition.encoding)) no('unsupportedFeature', `the encoding ${definition.encoding}`);
  if (!definition.search.paths.length) no('invalidYaml', 'no search path');

  const json = definition.search.paths[0]?.response?.type === 'json';
  definition.search.paths.forEach((path, index) => {
    const at = `search.paths[${index}]`;
    const type = path.response?.type;
    if (type !== undefined && type !== 'json' && type !== 'xml') no('unsupportedFeature', `the response type ${type} in ${at}`);
    if ((type === 'json') !== json) no('unsupportedFeature', `paths with JSON and HTML responses in ${at}`);
    checkTemplate(path.path, at);
    for (const value of Object.values(path.inputs ?? {})) checkTemplate(value, `${at}.inputs`);
  });
  for (const value of Object.values(definition.search.inputs ?? {})) checkTemplate(value, 'search.inputs');
  for (const value of Object.values(definition.search.headers ?? {})) checkTemplate(Array.isArray(value) ? value[0] : value, 'search.headers');
  checkFilters(definition.search.keywordsfilters, 'search.keywordsfilters');
  checkFilters(definition.search.preprocessingfilters, 'search.preprocessingfilters');
  const { rows } = definition.search;
  if (!rows.selector) no('invalidYaml', 'no rows selector');
  (json ? checkJsonSelector : checkCss)(rows.selector, 'search.rows');
  checkFilters(rows.filters, 'search.rows', true);
  checkBlock(rows.dateheaders, 'search.rows.dateheaders', json);
  checkBlock(rows.count, 'search.rows.count', json);
  if (json && rows.attribute !== undefined) checkJsonSelector(rows.attribute, 'search.rows.attribute');
  for (const [name, block] of definition.search.fields) checkBlock(block, `search.fields.${name}`, json);

  const download = definition.download;
  if (download) {
    download.selectors?.forEach((field, index) => checkField(field, `download.selectors[${index}]`));
    if (download.before) {
      checkTemplate(download.before.path, 'download.before');
      for (const value of Object.values(download.before.inputs ?? {})) checkTemplate(value, 'download.before.inputs');
      checkField(download.before.pathselector, 'download.before.pathselector');
    }
    checkField(download.infohash?.hash, 'download.infohash.hash');
    checkField(download.infohash?.title, 'download.infohash.title');
    for (const value of Object.values(download.headers ?? {})) checkTemplate(Array.isArray(value) ? value[0] : value, 'download.headers');
  }
}

const settingDefault = (value: unknown): string | boolean | undefined =>
  value === undefined || value === null ? undefined : typeof value === 'boolean' ? value : yamlText(value);

/** The catalogue's view of a definition (`meta`). */
export function metaOf(definition: Definition): DefinitionMeta {
  const categories = [...new Set(categoryMappings(definition).flatMap((mapping) => (mapping.newznab === undefined ? [] : [mapping.newznab])))].sort(
    (a, b) => a - b,
  );
  const type = definition.type === 'semi-private' || definition.type === 'private' ? definition.type : 'public';
  return {
    name: definition.name,
    ...(definition.description ? { description: String(definition.description) } : {}),
    type,
    ...(definition.language ? { language: definition.language } : {}),
    links: definition.links,
    ...(definition.legacylinks?.length ? { legacylinks: definition.legacylinks } : {}),
    settings: definition.settings.map((setting) => {
      const fallback = settingDefault(setting.default);
      return {
        name: String(setting.name),
        type: String(setting.type),
        ...(setting.label !== undefined ? { label: String(setting.label) } : {}),
        ...(fallback !== undefined ? { default: fallback } : {}),
        ...(setting.options ? { options: Object.entries(setting.options).map(([value, label]) => ({ value: String(value), label: String(label) })) } : {}),
      };
    }),
    modes: Object.fromEntries(Object.entries(definition.caps.modes ?? {}).map(([mode, params]) => [mode, (params ?? []).map(String)])),
    categories,
    ...(typeof definition.requestDelay === 'number' ? { requestDelay: definition.requestDelay } : {}),
  };
}

/** The support check of one file's text: its id and metadata when it could be read, and the verdict. */
export function checkDefinition(yaml: string): Checked {
  if (new TextEncoder().encode(yaml).length > MAX_DEFINITION_BYTES) {
    const id = /^id:\s*(\S+)/m.exec(yaml)?.[1];
    return { ...(id ? { definitionId: id } : {}), support: { ok: false, reason: 'tooLarge', detail: 'over 900 KB' } };
  }
  const loaded = loadDefinition(yaml);
  if (!loaded.ok) {
    const id = /^id:\s*([\w.-]+)\s*$/m.exec(yaml)?.[1];
    return { ...(id ? { definitionId: id } : {}), support: { ok: false, reason: loaded.reason, detail: loaded.detail } };
  }
  const { definition } = loaded;
  let meta: DefinitionMeta | undefined;
  try {
    meta = metaOf(definition);
    checkStructure(definition);
    return { definitionId: definition.id, definition, meta, support: { ok: true } };
  } catch (error) {
    const support: DefinitionSupport =
      error instanceof Unsupported
        ? { ok: false, reason: error.reason, detail: error.detail }
        : { ok: false, reason: 'invalidYaml', detail: (error as Error).message };
    return { definitionId: definition.id, definition, ...(meta ? { meta } : {}), support };
  }
}
