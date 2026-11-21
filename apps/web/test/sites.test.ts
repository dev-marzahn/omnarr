// Wording and helpers for site definitions: the picker's
// reasons, its search and type filter, the settings form's fields, and the
// System page's definitions card.
import type { DefinitionMeta, DefinitionSupportReason, DefinitionSyncStatus, SiteDefinitionRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { filterCatalogue, initialSettings, settingFields, supportText, syncCardRows, typeLabel } from '../lib/sites';

const row = (definitionId: string, name: string, extra: Partial<SiteDefinitionRow> = {}): SiteDefinitionRow => ({
  definitionId,
  source: 'upstream',
  name,
  type: 'public',
  language: 'en-US',
  support: { ok: true },
  ...extra,
});

describe('supportText: every reason the picker shows', () => {
  test.each([
    [{ ok: true }, undefined],
    [{ ok: false, reason: 'needsFlareSolverr' }, 'Needs FlareSolverr'],
    [{ ok: false, reason: 'captcha' }, 'The login needs a captcha'],
    [{ ok: false, reason: 'privateInP2' }, 'Needs a login, which omnarr does not support yet'],
    [{ ok: false, reason: 'loginMethod' }, "Uses a login omnarr can't run"],
    [{ ok: false, reason: 'unknownFilter', detail: 'sparkle in search.fields.title' }, "Uses a filter omnarr can't run: sparkle"],
    [{ ok: false, reason: 'unknownKey', detail: 'search.shiny' }, "Uses a setting omnarr doesn't know: search.shiny"],
    [{ ok: false, reason: 'templateConstruct', detail: 'printf in search.inputs' }, "Uses a template omnarr can't run: printf"],
    [{ ok: false, reason: 'regex', detail: 'atomicGroup ((?> at 3) in search.fields.title' }, "Uses a regex omnarr can't run: atomic group"],
    [{ ok: false, reason: 'regex', detail: 'inlineOption ((?i) at 9) in search.keywordsfilters' }, "Uses a regex omnarr can't run: a mid-pattern option"],
    [{ ok: false, reason: 'dateLayout', detail: 'the specifier "gg" in "yyyy gg" in search.fields.date' }, "Uses a date format omnarr can't read"],
    [{ ok: false, reason: 'selector' }, "Uses a selector omnarr can't parse"],
    [{ ok: false, reason: 'unsupportedFeature', detail: 'certificates' }, "Uses something omnarr can't run: certificates"],
    [{ ok: false, reason: 'tooLarge' }, 'The file is too large'],
    [{ ok: false, reason: 'invalidYaml' }, "The file can't be read"],
    [{ ok: false, reason: 'builtIn' }, 'Built in: add Nyaa from the Site list'],
    [{ ok: false, reason: 'replacedUpstream' }, 'Prowlarr runs this site with its own code, which omnarr does not have'],
  ] as const)('%o', (support, text) => {
    expect(supportText(support as { ok: true } | { ok: false; reason: DefinitionSupportReason; detail?: string })).toBe(text);
  });
});

describe('filterCatalogue', () => {
  const rows = [row('tokyotosho', 'Tokyo Toshokan'), row('privy', 'Privy', { type: 'private' }), row('acgrip', 'ACG.RIP', { language: 'zh-CN' })];

  test('matches the name or id, ignoring case, and the type', () => {
    expect(filterCatalogue(rows, 'TOKYO', 'all').map((r) => r.definitionId)).toEqual(['tokyotosho']);
    expect(filterCatalogue(rows, 'acg', 'all').map((r) => r.definitionId)).toEqual(['acgrip']);
    expect(filterCatalogue(rows, '', 'private').map((r) => r.definitionId)).toEqual(['privy']);
  });

  test('supported definitions first, then by name', () => {
    const mixed = [row('b', 'Beta', { support: { ok: false, reason: 'captcha' } }), row('a', 'Alpha'), row('c', 'Charlie')];
    expect(filterCatalogue(mixed, '', 'all').map((r) => r.definitionId)).toEqual(['a', 'c', 'b']);
  });

  test('types read as words', () => {
    expect([typeLabel('public'), typeLabel('semi-private'), typeLabel('private')]).toEqual(['Public', 'Semi-private', 'Private']);
  });
});

const META: DefinitionMeta = {
  name: 'Lantern Site',
  type: 'public',
  links: ['https://lantern.test/', 'https://mirror.lantern.test/'],
  settings: [
    {
      name: 'sort',
      type: 'select',
      label: 'Sort',
      default: 'added',
      options: [
        { value: 'added', label: 'Date added' },
        { value: 'seeders', label: 'Seeders' },
      ],
    },
    { name: 'freeleech', type: 'checkbox', label: 'Free only', default: false },
    { name: 'passkey', type: 'password', label: 'Passkey' },
    { name: 'note', type: 'info', label: 'About', default: 'Paced.' },
    { name: 'info_category_8000', type: 'info_category_8000', label: 'Other', default: 'Unmapped categories go to Other.' },
  ],
  modes: { search: ['q'] },
  categories: [5070],
};

describe('the settings form', () => {
  test('fields from the settings: controls for select, checkbox, text and password; text for the info types', () => {
    expect(settingFields(META)).toEqual([
      {
        kind: 'select',
        name: 'sort',
        label: 'Sort',
        items: [
          { value: 'added', label: 'Date added' },
          { value: 'seeders', label: 'Seeders' },
        ],
      },
      { kind: 'checkbox', name: 'freeleech', label: 'Free only' },
      { kind: 'password', name: 'passkey', label: 'Passkey' },
      { kind: 'info', name: 'note', label: 'About', text: 'Paced.' },
      { kind: 'info', name: 'info_category_8000', label: 'Other', text: 'Unmapped categories go to Other.' },
    ]);
  });

  test('the first values: the stored ones, else the defaults; a secret field starts empty', () => {
    expect(initialSettings(META)).toEqual({ sort: 'added', freeleech: false, passkey: '' });
    expect(initialSettings(META, { sort: 'seeders', freeleech: true })).toEqual({ sort: 'seeders', freeleech: true, passkey: '' });
  });
});

describe('the System page card', () => {
  test('the last sync, its source, the counts and the failure', () => {
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const ok: DefinitionSyncStatus = {
      at: Date.UTC(2026, 10, 20, 2, 30),
      ok: true,
      source: 'indexers.prowlarr.com',
      supported: 52,
      unsupported: 533,
      pending: 1,
    };
    expect(syncCardRows(ok, time)).toEqual([
      { label: 'Last sync', value: '02:30 from indexers.prowlarr.com' },
      { label: 'Supported', value: '52' },
      { label: 'Unsupported', value: '533' },
      { label: 'Update not applied', value: '1' },
    ]);
    expect(
      syncCardRows({ ...ok, ok: false, failure: { code: 'definitionSyncFailed', detail: 'indexers.prowlarr.com answered HTTP 503.' } }, time),
    ).toContainEqual({
      label: 'Last failure',
      value: 'indexers.prowlarr.com answered HTTP 503.',
    });
    expect(syncCardRows(null, time)).toEqual([{ label: 'Last sync', value: 'Not synced yet' }]);
  });
});
