// Site definitions in the web app: the picker's reasons
// and filter, a definition's settings as form fields, and the System page's
// definitions card. Kept here, not in .vue files, so `vp check` type-checks it.
import type { DefinitionMeta, DefinitionSupport, DefinitionSyncStatus, DefinitionType, SiteDefinitionRow, SiteSettings } from '@omnarr/contracts';

import type { InfoRow } from './indexers';

/** The regex translation's reasons (the support check's detail starts with one), as words. */
const REGEX: Record<string, string> = {
  atomicGroup: 'atomic group',
  conditional: 'conditional',
  balancingGroup: 'balancing group',
  inlineOption: 'a mid-pattern option',
  unicodeBlock: 'a Unicode block',
  anchor: 'an anchor',
  classEscape: 'a class escape',
  compile: "a pattern that doesn't compile",
};

/** The first word of a detail ("sparkle in search.fields.title" → "sparkle"). */
const head = (detail: string | undefined) => detail?.split(' ')[0] ?? '';

/** Why a definition can't be added, as the picker says it; undefined when it is supported. */
export function supportText(support: DefinitionSupport): string | undefined {
  if (support.ok) return undefined;
  const { detail } = support;
  switch (support.reason) {
    case 'needsFlareSolverr':
      return 'Needs FlareSolverr';
    case 'captcha':
      return 'The login needs a captcha';
    case 'privateInP2':
      return 'Needs a login, which omnarr does not support yet';
    case 'loginMethod':
      return "Uses a login omnarr can't run";
    case 'unknownFilter':
      return `Uses a filter omnarr can't run: ${head(detail)}`;
    case 'unknownKey':
      return `Uses a setting omnarr doesn't know: ${head(detail)}`;
    case 'templateConstruct':
      return `Uses a template omnarr can't run: ${head(detail)}`;
    case 'regex':
      return `Uses a regex omnarr can't run: ${REGEX[head(detail)] ?? 'a pattern it cannot translate'}`;
    case 'dateLayout':
      return "Uses a date format omnarr can't read";
    case 'selector':
      return "Uses a selector omnarr can't parse";
    case 'unsupportedFeature':
      return `Uses something omnarr can't run: ${detail ?? 'unknown'}`;
    case 'tooLarge':
      return 'The file is too large';
    case 'invalidYaml':
      return "The file can't be read";
    case 'builtIn':
      return 'Built in: add Nyaa from the Site list';
    case 'replacedUpstream':
      return 'Prowlarr runs this site with its own code, which omnarr does not have';
  }
}

/** "Upstream update not applied: …". */
export const pendingText = (row: Pick<SiteDefinitionRow, 'pendingUpdate'>): string | undefined =>
  row.pendingUpdate
    ? `Upstream update not applied: ${supportText({ ok: false, reason: row.pendingUpdate.reason, ...(row.pendingUpdate.detail ? { detail: row.pendingUpdate.detail } : {}) })}`
    : undefined;

export const typeLabel = (type: DefinitionType): string => ({ public: 'Public', 'semi-private': 'Semi-private', private: 'Private' })[type];

export type TypeFilter = DefinitionType | 'all';

/** The picker's list: matching the search on the name or id, of the type; supported ones first, then by name. */
export function filterCatalogue(rows: SiteDefinitionRow[], search: string, type: TypeFilter): SiteDefinitionRow[] {
  const needle = search.trim().toLowerCase();
  return rows
    .filter(
      (row) => (type === 'all' || row.type === type) && (!needle || row.name.toLowerCase().includes(needle) || row.definitionId.toLowerCase().includes(needle)),
    )
    .sort((a, b) => Number(b.support.ok) - Number(a.support.ok) || a.name.localeCompare(b.name));
}

export type SettingField =
  | { kind: 'select'; name: string; label: string; items: { value: string; label: string }[] }
  | { kind: 'checkbox' | 'text' | 'password'; name: string; label: string }
  | { kind: 'info'; name: string; label: string; text: string };

/** A definition's settings as form fields: `info` and the other `info_*` types are text to show. */
export function settingFields(meta: Pick<DefinitionMeta, 'settings'>): SettingField[] {
  return meta.settings.flatMap((setting): SettingField[] => {
    const label = setting.label ?? setting.name;
    if (setting.type === 'select') return [{ kind: 'select', name: setting.name, label, items: setting.options ?? [] }];
    if (setting.type === 'checkbox' || setting.type === 'text' || setting.type === 'password') return [{ kind: setting.type, name: setting.name, label }];
    if (setting.type.startsWith('info')) return [{ kind: 'info', name: setting.name, label, text: typeof setting.default === 'string' ? setting.default : '' }];
    return [];
  });
}

/**
 * The form's first values: the stored ones (the DTO's non-secret settings),
 * else each setting's default. Text and password fields start empty: an empty
 * value keeps the stored one.
 */
export function initialSettings(meta: Pick<DefinitionMeta, 'settings'>, stored: SiteSettings = {}): SiteSettings {
  const values: SiteSettings = {};
  for (const setting of meta.settings) {
    if (setting.type === 'select') values[setting.name] = String(stored[setting.name] ?? setting.default ?? setting.options?.[0]?.value ?? '');
    else if (setting.type === 'checkbox') {
      const value = stored[setting.name] ?? setting.default;
      values[setting.name] = value === true || value === 'true';
    } else if (setting.type === 'text' || setting.type === 'password') values[setting.name] = '';
  }
  return values;
}

/** The form's values to send: empty secret fields are left out, so the stored values stay. */
export const settingsToSend = (meta: Pick<DefinitionMeta, 'settings'>, values: SiteSettings): SiteSettings =>
  Object.fromEntries(
    Object.entries(values).filter(([name, value]) => {
      const type = meta.settings.find((setting) => setting.name === name)?.type;
      return !((type === 'text' || type === 'password') && value === '');
    }),
  );

/** The System page's definitions card. */
export function syncCardRows(status: DefinitionSyncStatus | null, formatTime: (ms: number) => string): InfoRow[] {
  if (!status) return [{ label: 'Last sync', value: 'Not synced yet' }];
  return [
    { label: 'Last sync', value: `${formatTime(status.at)} from ${status.source}` },
    { label: 'Supported', value: String(status.supported) },
    { label: 'Unsupported', value: String(status.unsupported) },
    { label: 'Update not applied', value: String(status.pending) },
    ...(status.failure ? [{ label: 'Last failure', value: status.failure.detail }] : []),
  ];
}
