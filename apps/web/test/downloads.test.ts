// Settings › Downloads' wording and the passing-test rule.
import type { PortState, ProviderTest, VpnState } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  canSaveProvider,
  codeParts,
  configStateText,
  connectionStatusText,
  GOAL_CHANGE_TEXT,
  peerPortText,
  portStateText,
  providerTestText,
  seedGoalFromValues,
  seedGoalValues,
  needsLoginTest,
  testOfServer,
  TORRENTS_OFF_TEXT,
  usageText,
  torrentsConfigStateText,
  type ProviderValues,
  VPN_KINDS,
  vpnApplyNote,
  vpnFields,
  vpnFormValues,
  type VpnFormValues,
  vpnSaveErrorText,
  vpnSaveInput,
  vpnStateText,
  vpnStoredSecrets,
  seedingMarker,
} from '../lib/downloads';

describe('seedingMarker', () => {
  test('nothing when no torrent seeds', () => {
    expect(seedingMarker(undefined)).toBeUndefined();
    expect(seedingMarker({ count: 0 })).toBeUndefined();
  });

  test('one torrent: "Seeding"', () => {
    expect(seedingMarker({ count: 1 })).toEqual({ label: 'Seeding', title: 'A torrent is seeding to its goal' });
  });

  test('several: "3 seeding"', () => {
    expect(seedingMarker({ count: 3 })).toEqual({ label: '3 seeding', title: '3 torrents are seeding to their goals' });
  });
});

const providerTest = (overrides: Partial<ProviderTest> = {}): ProviderTest => ({
  jobId: 'j1' as ProviderTest['jobId'],
  outcome: 'ok',
  host: 'news.example',
  port: 563,
  ssl: true,
  at: 0,
  ...overrides,
});

describe('providerTestText', () => {
  test('a passing test names the host, the port and SSL', () => {
    expect(providerTestText(providerTest(), true)).toEqual({ color: 'success', title: 'Logged in to news.example:563 over SSL.' });
  });

  test('a rejected login says to check the credentials', () => {
    expect(providerTestText(providerTest({ outcome: 'authRejected' }), true)).toEqual({
      color: 'error',
      title: 'The provider rejected the login.',
      description: 'news.example:563 over SSL answered, but refused this username and password. Check them.',
    });
  });

  test("a failed test says the provider couldn't be reached, and without SSL when it is off", () => {
    expect(providerTestText(providerTest({ outcome: 'failed', port: 119, ssl: false }), true)).toEqual({
      color: 'error',
      title: "Couldn't reach news.example:119 without SSL.",
      description: 'Check the host, the port and the SSL switch.',
    });
  });

  test('a pending test is running while the worker is connected', () => {
    expect(providerTestText(providerTest({ outcome: 'pending' }), true)).toEqual({
      color: 'neutral',
      title: 'Testing the login to news.example:563 over SSL…',
    });
  });

  test('a pending test with no worker connected waits for it ("No worker")', () => {
    expect(providerTestText(providerTest({ outcome: 'pending' }), false)).toEqual({
      color: 'neutral',
      title: 'Waiting for the worker',
      description: 'The test of news.example:563 over SSL starts when the worker connects.',
    });
  });
});

// Save needs a passing test of exactly the values on the form.
describe('canSaveProvider', () => {
  const form: ProviderValues = { host: 'news.example', port: 563, ssl: true, username: 'user123', password: 'secret', connections: 20 };

  test('a passing test of the values on the form allows Save', () => {
    expect(canSaveProvider(form, { ...form }, providerTest())).toBe(true);
  });

  test.each([
    ['username', { username: 'other' }],
    ['password', { password: 'other' }],
    ['connections', { connections: 10 }],
  ] as const)('a test run before the %s changed no longer counts', (_, change) => {
    expect(canSaveProvider({ ...form, ...change }, form, providerTest())).toBe(false);
  });

  test.each([
    ['host', { host: 'eu.news.example' }],
    ['port', { port: 443 }],
    ['ssl', { ssl: false }],
  ] as const)("a passing test whose %s isn't the form's doesn't count", (_, other) => {
    expect(canSaveProvider(form, form, providerTest(other))).toBe(false);
  });

  test.each(['pending', 'authRejected', 'failed'] as const)('a %s test does not allow Save', (outcome) => {
    expect(canSaveProvider(form, form, providerTest({ outcome }))).toBe(false);
  });

  test('a passing test from before the form opened (none pressed here) does not count', () => {
    expect(canSaveProvider(form, undefined, providerTest())).toBe(false);
  });
});

describe("usageText: a server's monthly limit on the card", () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const limit = { monthlyLimitGb: 50, resetDay: 15 };

  test('under the limit: what the period used, and its reset date', () => {
    expect(usageText(limit, { usedBytes: 12_345_000_000, limitReached: false }, now)).toBe('Used 12.3 of 50 GB, resets 15 Dec');
  });

  test('at the limit: paused until the next period', () => {
    expect(usageText(limit, { usedBytes: 50e9, limitReached: true }, now)).toBe('Limit reached, paused until 15 Dec');
  });

  test('before the worker has read it: the limit and the reset date', () => {
    expect(usageText({ monthlyLimitGb: 2.5, resetDay: 20 }, undefined, now)).toBe('Limit 2.5 GB a month, resets 20 Nov');
  });

  test('no limit, no line', () => {
    expect(usageText(undefined, undefined, now)).toBeUndefined();
  });
});

describe('needsLoginTest: only a change to the login asks for a new "Test login"', () => {
  const stored = { host: 'news.example', port: 563, ssl: true, username: 'user123', connections: 20 };
  const form: ProviderValues = { ...stored, password: '' };

  test('the stored login, unchanged, with a blank password, needs no test: a new limit or priority saves as it is', () => {
    expect(needsLoginTest(form, stored)).toBe(false);
  });

  test.each([{ host: 'other.example' }, { port: 119 }, { ssl: false }, { username: 'x' }, { password: 'new' }, { connections: 30 }])(
    'a changed login field %o needs one',
    (change) => {
      expect(needsLoginTest({ ...form, ...change }, stored)).toBe(true);
    },
  );

  test('a server not saved yet needs one', () => {
    expect(needsLoginTest(form, undefined)).toBe(true);
  });
});

describe('testOfServer: each form sees only its own server’s "Test login"', () => {
  test("the main server's form sees a test that names no backup, not a backup's", () => {
    expect(testOfServer(providerTest(), undefined)).toEqual(providerTest());
    expect(testOfServer(providerTest({ backupId: 'b1' }), undefined)).toBeUndefined();
  });

  test("a backup server's form sees only the test that names it", () => {
    expect(testOfServer(providerTest({ backupId: 'b1' }), 'b1')).toEqual(providerTest({ backupId: 'b1' }));
    expect(testOfServer(providerTest({ backupId: 'b2' }), 'b1')).toBeUndefined();
    expect(testOfServer(providerTest(), 'b1')).toBeUndefined();
    expect(testOfServer(undefined, 'b1')).toBeUndefined();
  });
});

// No page shows a client's address or port.
test("no text names a download client's address or port", () => {
  const texts = [
    ...(['ok', 'authRejected', 'failed', 'pending'] as const).flatMap((outcome) =>
      [true, false].map((worker) => Object.values(providerTestText(providerTest({ outcome }), worker)).join(' ')),
    ),
    ...(['applied', 'pending', 'failed'] as const).map((config) =>
      configStateText({ enabled: true, config, appliedAt: 0, applyFailure: 'clientUnreachable' }, 0),
    ),
    configStateText({ enabled: false, config: 'pending' }, 0),
    ...(['applied', 'pending', 'failed'] as const).map((config) =>
      torrentsConfigStateText({ configVersion: 1, config, appliedAt: 0, applyFailure: 'clientUnreachable' }, 0),
    ),
    torrentsConfigStateText({ configVersion: 0, config: 'pending' }, 0),
    ...[51413, undefined].map((port) => Object.values(peerPortText(port)).join(' ')),
    ...(['connected', 'firewalled', 'disconnected', undefined] as const).map((status) => Object.values(connectionStatusText(status)).join(' ')),
    TORRENTS_OFF_TEXT,
    GOAL_CHANGE_TEXT,
    ...[
      { ratio: null, days: null },
      { ratio: 0, days: 14 },
      { ratio: 2, days: -1 },
    ].map((values) => Object.values(seedGoalFromValues(values)).join(' ')),
  ];
  for (const text of texts) expect(text).not.toMatch(/nzbget:|qbittorrent:|6789|8080|localhost|127\.0\.0\.1|https?:\/\//i);
});

const NOW = Date.UTC(2026, 10, 18, 12, 0);
const MIN = 60_000;

describe('configStateText', () => {
  test('an applied config says how long ago', () => {
    expect(configStateText({ enabled: true, config: 'applied', appliedAt: NOW - 2 * MIN }, NOW)).toBe('Applied 2 min ago');
  });

  test.each([
    [20_000, 'Applied just now'],
    [59 * MIN, 'Applied 59 min ago'],
    [3 * 60 * MIN, 'Applied 3 h ago'],
    [3 * 24 * 60 * MIN, 'Applied 3 days ago'],
  ])('an apply %i ms ago reads "%s"', (age, text) => {
    expect(configStateText({ enabled: true, config: 'applied', appliedAt: NOW - age }, NOW)).toBe(text);
  });

  test('with no provider saved, NZBGet is not set up', () => {
    expect(configStateText({ enabled: false, config: 'pending' }, NOW)).toBe('Not set up: no provider saved yet');
  });

  test('a Test login before the first save leaves it not set up, never a provider that is off', () => {
    expect(configStateText({ enabled: false, config: 'failed', applyFailure: 'clientUnreachable' }, NOW)).toBe('Not set up: no provider saved yet');
  });

  test('a saved provider the worker has not applied yet', () => {
    expect(configStateText({ enabled: true, config: 'pending' }, NOW)).toBe('Not applied yet');
  });

  test('a failed apply names why, from applyFailure', () => {
    expect(configStateText({ enabled: true, config: 'failed', applyFailure: 'clientUnreachable' }, NOW)).toBe('Not applied: NZBGet unreachable');
  });

  test("another failure code uses the timeline's label for it", () => {
    expect(configStateText({ enabled: true, config: 'failed', applyFailure: 'unknownClientFailure' }, NOW)).toBe('Not applied: unknown download client answer');
  });
});

// ---- The Torrents card ----

// The goal: a ratio and a number of days, at least one; an empty field is no limit on it.
describe('seedGoalFromValues', () => {
  test('a ratio and days give both limits, days in milliseconds', () => {
    expect(seedGoalFromValues({ ratio: 2, days: 14 })).toEqual({ goal: { ratio: 2, seedTimeMs: 1_209_600_000 } });
  });

  test('an empty days field is no limit on seed time', () => {
    expect(seedGoalFromValues({ ratio: 1.5, days: null })).toEqual({ goal: { ratio: 1.5 } });
  });

  test('an empty ratio field is no limit on ratio', () => {
    expect(seedGoalFromValues({ ratio: null, days: 7 })).toEqual({ goal: { seedTimeMs: 604_800_000 } });
  });

  test('half a day is 12 hours', () => {
    expect(seedGoalFromValues({ ratio: null, days: 0.5 })).toEqual({ goal: { seedTimeMs: 43_200_000 } });
  });

  test('both empty is refused: at least one is required', () => {
    expect(seedGoalFromValues({ ratio: null, days: null })).toEqual({ error: 'Set a ratio, a number of days, or both.' });
  });

  test.each([0, -1])('a ratio of %i is refused', (ratio) => {
    expect(seedGoalFromValues({ ratio, days: 14 })).toEqual({ error: 'The ratio must be above 0.' });
  });

  test.each([0, -3])('%i days is refused', (days) => {
    expect(seedGoalFromValues({ ratio: 2, days })).toEqual({ error: 'The number of days must be above 0.' });
  });
});

describe('seedGoalValues', () => {
  test('the default goal reads ratio 2 and 14 days', () => {
    expect(seedGoalValues({ ratio: 2, seedTimeMs: 1_209_600_000 })).toEqual({ ratio: 2, days: 14 });
  });

  test('a missing dimension is an empty field', () => {
    expect(seedGoalValues({ seedTimeMs: 604_800_000 })).toEqual({ ratio: null, days: 7 });
    expect(seedGoalValues({ ratio: 3 })).toEqual({ ratio: 3, days: null });
  });
});

describe('torrentsConfigStateText', () => {
  test('an applied config says how long ago', () => {
    expect(torrentsConfigStateText({ configVersion: 2, config: 'applied', appliedAt: NOW - 2 * MIN }, NOW)).toBe('Applied 2 min ago');
  });

  test('nothing saved yet: qBittorrent runs with the default goal', () => {
    expect(torrentsConfigStateText({ configVersion: 0, config: 'pending' }, NOW)).toBe('Not saved yet: the default goal applies');
  });

  test('a save the worker has not applied yet', () => {
    expect(torrentsConfigStateText({ configVersion: 1, config: 'pending' }, NOW)).toBe('Not applied yet');
  });

  test('an unreachable qBittorrent', () => {
    expect(torrentsConfigStateText({ configVersion: 1, config: 'failed', applyFailure: 'clientUnreachable' }, NOW)).toBe(
      'Not applied: qBittorrent unreachable',
    );
    expect(torrentsConfigStateText({ configVersion: 1, config: 'failed' }, NOW)).toBe('Not applied: qBittorrent unreachable');
  });

  test("another failure code uses the timeline's label for it", () => {
    expect(torrentsConfigStateText({ configVersion: 1, config: 'failed', applyFailure: 'unknownClientFailure' }, NOW)).toBe(
      'Not applied: unknown download client answer',
    );
  });
});

// Read-only, with "Forward this port on your router".
describe('peerPortText', () => {
  test('a reported port, with the forwarding hint', () => {
    expect(peerPortText(51413)).toEqual({ value: '51413', hint: 'Forward this port on your router.' });
  });

  test('before the worker reports it', () => {
    expect(peerPortText(undefined)).toEqual({ value: 'Not reported yet' });
  });

  // Finding 17: through the VPN, the port peers use is the forwarded one; OMNARR_PEER_PORT isn't shown.
  // The worker reports that port as the peer port while the VPN is up, and none otherwise.
  test('VPN up with a forwarded port: that port, forwarded by the provider, and no router hint', () => {
    expect(peerPortText(38852, { state: 'up', port: { kind: 'forwarded', port: 38852 } }, 'pia')).toEqual({
      value: '38852',
      hint: 'Forwarded by PIA. Peers connect on this port through the VPN.',
    });
    expect(peerPortText(55001, { state: 'up', port: { kind: 'static', port: 55001 } }, 'openvpnFile')).toEqual({
      value: '55001',
      hint: 'Forwarded by your VPN. Peers connect on this port through the VPN.',
    });
  });

  test('VPN up without one: no forwarded port', () => {
    expect(peerPortText(undefined, { state: 'up', port: { kind: 'none' } }, 'protonvpn')).toEqual({
      value: 'No forwarded port',
      hint: "Your VPN doesn't forward a port. Torrents work, with fewer peers.",
    });
    expect(peerPortText(undefined, { state: 'up', port: { kind: 'waiting' } }, 'pia')).toEqual({
      value: 'No forwarded port',
      hint: 'Waiting for the VPN to forward a port.',
    });
  });

  test("a VPN that isn't up: the port comes from the VPN once it is", () => {
    expect(peerPortText(undefined, { state: 'connecting', port: { kind: 'waiting' } }, 'pia')).toEqual({
      value: 'Through the VPN',
      hint: 'Shown once the VPN is up.',
    });
  });

  test('no VPN: the published peer port and the router hint', () => {
    expect(peerPortText(51413, { state: 'off', port: { kind: 'none' } })).toEqual({ value: '51413', hint: 'Forward this port on your router.' });
  });
});

// qBittorrent's connection status; firewalled shows the forwarding hint.
describe('connectionStatusText', () => {
  test.each([
    ['connected', { color: 'success', label: 'Connected', description: 'Peers can connect to you.' }],
    [
      'firewalled',
      {
        color: 'warning',
        label: 'Firewalled',
        description: "Peers can't connect to you, so torrents find fewer peers. Forward the peer port on your router.",
      },
    ],
    ['disconnected', { color: 'error', label: 'Disconnected', description: 'qBittorrent has no network connection.' }],
    [undefined, { color: 'neutral', label: 'Not reported yet' }],
  ] as const)('%s', (status, text) => {
    expect(connectionStatusText(status)).toEqual(text);
  });
});

// What turning torrents off and changing the goal do.
test("the card's notes on the switch and the goal", () => {
  expect(TORRENTS_OFF_TEXT).toBe('Turning torrents off stops new torrent grabs. Torrents already seeding keep seeding until their goals are met.');
  expect(GOAL_CHANGE_TEXT).toBe('A changed goal applies to new torrents only.');
});

// ---- The VPN card ----

// Each VPN state, as the card and the System page show it.
describe('vpnStateText', () => {
  test.each([
    ['off', { color: 'neutral', label: 'No VPN', description: 'Torrents connect directly, without a VPN.' }],
    [
      'notActive',
      {
        color: 'warning',
        label: 'Not active',
        description: "A VPN is chosen, but the VPN layout isn't in use yet. Torrents wait, and move no traffic, until it is.",
      },
    ],
    ['connecting', { color: 'neutral', label: 'Connecting', description: 'Torrents wait until the VPN is up.' }],
    ['up', { color: 'success', label: 'Up', description: 'Torrent traffic goes only through the VPN.' }],
    ['down', { color: 'error', label: 'Down', description: 'The tunnel is down. Torrents wait, and no torrent traffic leaves without it.' }],
  ] as const)('%s', (state, text) => {
    expect(vpnStateText(state)).toEqual(text);
  });
});

// Each peer port state; no port state is an error.
describe('portStateText', () => {
  test.each([
    [{ kind: 'forwarded', port: 41234 }, 'Peers can connect on port 41234 through the VPN.'],
    [{ kind: 'static', port: 55001 }, 'Peers can connect on port 55001 through the VPN.'],
    [{ kind: 'waiting' }, 'Waiting for the VPN to forward a port.'],
    [{ kind: 'none' }, "Your VPN doesn't forward a port. Torrents work, with fewer peers."],
  ] as const)('%o', (port, text) => {
    expect(portStateText(port)).toBe(text);
  });
});

// The four choices, in the card's order.
test('the VPN kinds and their labels', () => {
  expect(VPN_KINDS).toEqual([
    { value: 'wireguardFile', label: 'WireGuard config file' },
    { value: 'openvpnFile', label: 'OpenVPN config file' },
    { value: 'protonvpn', label: 'ProtonVPN' },
    { value: 'pia', label: 'PIA' },
  ]);
});

// gluetun reads its files only when it starts; the layout switch is one .env line.
describe('vpnApplyNote', () => {
  const apply = { title: 'Apply with `docker compose up -d`', description: 'The VPN container reads its settings only when it starts.' };
  const switchOn = {
    title: 'Switch to the VPN layout',
    description: 'Add `COMPOSE_FILE=compose.yml:compose.vpn.yml` to `.env`, then run `docker compose up -d`. Until then, torrents wait.',
  };
  const switchBack = {
    title: 'Switch back to the direct layout',
    description:
      'Remove `COMPOSE_FILE=compose.yml:compose.vpn.yml` from `.env`, then run `docker compose up -d`. Until then, torrents still go through the VPN.',
  };
  const runtime = (state: VpnState, layoutWithoutChoice = false) => ({ state, layoutWithoutChoice });

  test('a VPN chosen while it is not active: the .env step', () => {
    expect(vpnApplyNote(true, runtime('notActive'))).toEqual(switchOn);
  });

  test('a first VPN chosen in the direct layout, or before the worker reported: the .env step', () => {
    expect(vpnApplyNote(true, runtime('off'))).toEqual(switchOn);
    expect(vpnApplyNote(true, undefined)).toEqual(switchOn);
  });

  test.each(['connecting', 'up', 'down'] as const)('a VPN changed while the VPN layout runs (%s): apply with the command', (state) => {
    expect(vpnApplyNote(true, runtime(state))).toEqual(apply);
  });

  test('a VPN chosen again in the VPN layout, after No VPN: apply with the command', () => {
    expect(vpnApplyNote(true, runtime('up', true))).toEqual(apply);
  });

  test('No VPN while the VPN layout still runs: the step to switch back', () => {
    expect(vpnApplyNote(false, runtime('up', true))).toEqual(switchBack);
    expect(vpnApplyNote(false, runtime('down'))).toEqual(switchBack);
  });

  test('No VPN in the direct layout: the worker applies it, nothing to run', () => {
    expect(vpnApplyNote(false, runtime('notActive'))).toBeUndefined();
    expect(vpnApplyNote(false, runtime('off'))).toBeUndefined();
  });
});

test('codeParts splits backticked commands out of a text', () => {
  expect(codeParts('Add `X=1` to `.env`, then run it.')).toEqual([
    { text: 'Add ' },
    { code: 'X=1' },
    { text: ' to ' },
    { code: '.env' },
    { text: ', then run it.' },
  ]);
});

// saveVpn's input. A blank secret field keeps the stored one, so it is left out.
describe('vpnSaveInput', () => {
  const blank: VpnFormValues = {
    useVpn: true,
    kind: 'wireguardFile',
    config: '',
    username: '',
    password: '',
    privateKey: '',
    countries: '',
    staticPort: null,
  };

  test('No VPN is null, whatever the fields hold', () => {
    expect(vpnSaveInput({ ...blank, useVpn: false, config: '[Interface]' })).toEqual({ input: null });
  });

  test('a WireGuard file sends the pasted text as it is', () => {
    expect(vpnSaveInput({ ...blank, config: '[Interface]\nPrivateKey = k\n' })).toEqual({
      input: { kind: 'wireguardFile', wireguardConf: '[Interface]\nPrivateKey = k\n' },
    });
  });

  test('blank secret fields are left out, so the stored ones are kept', () => {
    expect(vpnSaveInput({ ...blank, config: '  \n' })).toEqual({ input: { kind: 'wireguardFile' } });
    expect(vpnSaveInput({ ...blank, kind: 'pia' })).toEqual({ input: { kind: 'pia' } });
  });

  test('an OpenVPN file sends its file and login', () => {
    expect(vpnSaveInput({ ...blank, kind: 'openvpnFile', config: 'client\n', username: ' me ', password: ' p w ' })).toEqual({
      input: { kind: 'openvpnFile', openvpnConf: 'client\n', username: 'me', password: ' p w ' },
    });
  });

  test("ProtonVPN sends the private key, trimmed, and the countries split at commas; the other kinds' fields stay out", () => {
    expect(vpnSaveInput({ ...blank, kind: 'protonvpn', privateKey: ' abc= ', countries: 'Netherlands, ,Switzerland ', config: 'x', username: 'u' })).toEqual({
      input: { kind: 'protonvpn', wireguardPrivateKey: 'abc=', serverCountries: ['Netherlands', 'Switzerland'] },
    });
  });

  test("PIA sends its login and regions; empty regions mean any, so they're left out", () => {
    expect(vpnSaveInput({ ...blank, kind: 'pia', username: 'p123', password: 'pw', countries: 'DE Berlin' })).toEqual({
      input: { kind: 'pia', username: 'p123', password: 'pw', serverCountries: ['DE Berlin'] },
    });
  });

  test('the static forwarded port is sent when set', () => {
    expect(vpnSaveInput({ ...blank, kind: 'openvpnFile', staticPort: 55001 })).toEqual({ input: { kind: 'openvpnFile', staticForwardedPort: 55001 } });
  });

  test.each([0, 65_536, 1.5])('a static port of %d is refused', (staticPort) => {
    expect(vpnSaveInput({ ...blank, staticPort })).toEqual({ error: 'The static forwarded port must be a whole number from 1 to 65535.' });
  });
});

describe('vpnFormValues', () => {
  test('No VPN saved: the form starts on No VPN, with the first kind ready', () => {
    expect(vpnFormValues({})).toEqual({
      useVpn: false,
      kind: 'wireguardFile',
      config: '',
      username: '',
      password: '',
      privateKey: '',
      countries: '',
      staticPort: null,
    });
  });

  test('a saved choice: its kind, countries and port; the secret fields stay blank', () => {
    expect(vpnFormValues({ kind: 'protonvpn', serverCountries: ['Netherlands', 'Switzerland'], staticForwardedPort: 55001 })).toMatchObject({
      useVpn: true,
      kind: 'protonvpn',
      privateKey: '',
      countries: 'Netherlands, Switzerland',
      staticPort: 55001,
    });
  });
});

// "Stored" shows only for the kind it was stored for: another kind keeps nothing.
describe('vpnStoredSecrets', () => {
  const vpn = { kind: 'openvpnFile', hasVpnConfig: true, hasVpnCredentials: true } as const;

  test('the saved kind shows its stored config and login', () => {
    expect(vpnStoredSecrets(vpn, 'openvpnFile')).toEqual({ config: true, credentials: true });
  });

  test('another kind starts with nothing stored', () => {
    expect(vpnStoredSecrets(vpn, 'pia')).toEqual({ config: false, credentials: false });
  });

  test('no VPN saved: nothing stored', () => {
    expect(vpnStoredSecrets({ hasVpnConfig: false, hasVpnCredentials: false }, 'wireguardFile')).toEqual({ config: false, credentials: false });
  });
});

describe('vpnSaveErrorText', () => {
  test("a refused save shows the server's reason", () => {
    const error = { data: { code: 'invalidVpn', message: 'The config has no [Peer] Endpoint.' } };
    expect(vpnSaveErrorText(error)).toBe('The config has no [Peer] Endpoint.');
  });

  test('any other failure says to try again', () => {
    expect(vpnSaveErrorText(new Error('network'))).toBe("The VPN settings couldn't be saved. Try again.");
    expect(vpnSaveErrorText({ data: { code: 'forbidden' } })).toBe("The VPN settings couldn't be saved. Try again.");
  });
});

// No VPN text names gluetun's or qBittorrent's address or port.
test("no VPN text names a client's address or port", () => {
  const states = ['off', 'notActive', 'connecting', 'up', 'down'] as const;
  const texts = [
    ...states.map((state) => Object.values(vpnStateText(state)).join(' ')),
    ...[{ kind: 'forwarded', port: 41234 }, { kind: 'static', port: 55001 }, { kind: 'waiting' }, { kind: 'none' }].map((port) =>
      portStateText(port as PortState),
    ),
    ...VPN_KINDS.map(({ value, label }) => `${label} ${JSON.stringify(vpnFields(value))}`),
    ...[true, false].flatMap((chosen) =>
      [undefined, ...states.map((state) => ({ state, layoutWithoutChoice: false })), { state: 'up' as const, layoutWithoutChoice: true }].map((runtime) =>
        JSON.stringify(vpnApplyNote(chosen, runtime) ?? ''),
      ),
    ),
    vpnSaveErrorText(new Error('x')),
    JSON.stringify(vpnSaveInput({ useVpn: true, kind: 'pia', config: '', username: '', password: '', privateKey: '', countries: '', staticPort: 0 })),
  ];
  for (const text of texts) expect(text).not.toMatch(/gluetun:|qbittorrent:|nzbget:|8000|8080|6789|localhost|127\.0\.0\.1|https?:\/\//i);
});

// What each kind asks for.
describe('vpnFields', () => {
  const staticPort = { label: 'Static forwarded port', hint: 'Optional. Only for a provider that gives you a fixed forwarded port.' };

  test('a WireGuard file: the file, whose Endpoint must be an IP address', () => {
    expect(vpnFields('wireguardFile')).toEqual({
      config: {
        label: 'WireGuard config file',
        hint: "Your provider's WireGuard file (such as wg0.conf). Its Endpoint must be an IP address, not a hostname.",
        accept: '.conf,text/plain',
      },
      staticPort,
    });
  });

  test('an OpenVPN file: the file and its login', () => {
    expect(vpnFields('openvpnFile')).toEqual({
      config: { label: 'OpenVPN config file', hint: "Your provider's OpenVPN file (.ovpn).", accept: '.ovpn,.conf,text/plain' },
      credentials: { hint: 'The OpenVPN username and password your provider gives you.' },
      staticPort,
    });
  });

  test('ProtonVPN: the private key of a config generated with port forwarding on, and countries', () => {
    expect(vpnFields('protonvpn')).toEqual({
      privateKey: {
        label: 'WireGuard private key',
        hint: 'In your Proton account, create a WireGuard configuration with "NAT-PMP (Port Forwarding)" turned on, and paste its PrivateKey.',
      },
      countries: { label: 'Countries', hint: 'Comma separated, such as "Netherlands, Switzerland". Leave empty for any country.' },
      staticPort,
    });
  });

  test('PIA: OpenVPN username and password, and regions instead of countries', () => {
    expect(vpnFields('pia')).toEqual({
      credentials: { hint: 'Your PIA username and password. PIA connects over OpenVPN.' },
      countries: { label: 'Regions', hint: 'PIA regions, comma separated, such as "DE Berlin, Netherlands". Leave empty for any region.' },
      staticPort,
    });
  });
});
