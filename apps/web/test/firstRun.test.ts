// First run's routing, the checklist and the copy.
import type { DownloadClientsDetail, FailureCode, JellyfinStatus, ScanStatus, SystemStatus } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { addressLines, advanceTarget, canContinue, checklist, refusalText, routeFor, shouldStartScan, usenetSaved } from '../lib/firstRun';

describe('routeFor', () => {
  test('no admin: the create-admin page only', () => {
    const state = { adminExists: false } as const;
    expect(routeFor(state, false, '/setup')).toBeUndefined();
    for (const path of ['/login', '/library', '/setup/address']) expect(routeFor(state, false, path)).toBe('/setup');
  });

  test('an admin and no session: the sign-in page only', () => {
    const state = { adminExists: true } as const;
    expect(routeFor(state, false, '/login')).toBeUndefined();
    for (const path of ['/setup', '/setup/usenet', '/library']) expect(routeFor(state, false, path)).toBe('/login');
  });

  test("a session mid-way: setup pages up to the step are allowed; later steps, other pages, sign-in and create-admin go to the step's page", () => {
    const state = { adminExists: true, step: 'usenet' } as const;
    for (const path of ['/setup/address', '/setup/indexer', '/setup/usenet']) expect(routeFor(state, true, path)).toBeUndefined();
    for (const path of ['/setup/torrents', '/setup/finish', '/library', '/system', '/login', '/setup'])
      expect(routeFor(state, true, path)).toBe('/setup/usenet');
  });

  test('existing media is a setup step like the others', () => {
    expect(routeFor({ adminExists: true, step: 'existingMedia' }, true, '/setup/existing-media')).toBeUndefined();
    expect(routeFor({ adminExists: true, step: 'existingMedia' }, true, '/library')).toBe('/setup/existing-media');
  });

  test('done: any setup address and the login page open the library; other pages are allowed', () => {
    const state = { adminExists: true, step: 'done' } as const;
    for (const path of ['/setup', '/setup/address', '/setup/finish', '/login']) expect(routeFor(state, true, path)).toBe('/library');
    for (const path of ['/library', '/system', '/settings/indexers']) expect(routeFor(state, true, path)).toBeUndefined();
  });
});

const jellyfin = (overrides: Partial<JellyfinStatus> = {}): JellyfinStatus => ({
  state: 'settingUp',
  steps: (['reachable', 'wizard', 'apiKey', 'libraries', 'testRefresh'] as const).map((step) => ({ step, state: 'pending' as const })),
  pinned: true,
  libraries: [],
  ...overrides,
});
const worker = (overrides: Partial<NonNullable<SystemStatus['worker']>> = {}): NonNullable<SystemStatus['worker']> => ({
  workerId: 'w1',
  connected: true,
  accepted: true,
  protocolVersion: 3,
  expectedVersion: 3,
  connectedAt: 0,
  lastSeenAt: 0,
  ffmpegVersion: '7.1',
  encoders: [],
  ...overrides,
});
const nzbget = { clientKind: 'nzbget' as const, enabled: true, reachable: true, config: 'applied' as const, activeDownloads: 0 };
const status = (overrides: Partial<SystemStatus> = {}): SystemStatus => ({
  worker: worker(),
  indexers: [],
  clients: [nzbget],
  jobCounts: [],
  jellyfin: jellyfin(),
  release: { version: '0.1.0' },
  ...overrides,
});
const clients = (torrents: boolean, torrentConfig: 'applied' | 'pending' = 'applied') =>
  ({ usenet: { config: 'applied' }, torrents: { enabled: torrents, config: torrentConfig } }) as unknown as DownloadClientsDetail;
const states = (lines: { key: string; state: string }[]) => Object.fromEntries(lines.map((line) => [line.key, line.state]));

describe('checklist', () => {
  test("worker connected with its version, NZBGet configured, qBittorrent skipped, Jellyfin's five steps in order", () => {
    const done = jellyfin({ state: 'ready', steps: jellyfin().steps.map((step) => ({ ...step, state: 'done' as const })) });
    const { lines, actions, mismatch } = checklist(status({ jellyfin: done }), clients(false), []);
    expect(lines.map((line) => [line.key, line.label, line.state])).toEqual([
      ['worker', 'Worker connected · protocol v3', 'done'],
      ['nzbget', 'NZBGet configured', 'done'],
      ['qbittorrent', 'qBittorrent skipped', 'skipped'],
      ['reachable', 'Jellyfin answers', 'done'],
      ['wizard', 'Startup wizard', 'done'],
      ['apiKey', 'API key', 'done'],
      ['libraries', 'Libraries', 'done'],
      ['testRefresh', 'First library scan', 'done'],
    ]);
    expect(actions).toEqual([]);
    expect(mismatch).toBeUndefined();
  });

  test('waiting: no worker yet, NZBGet and qBittorrent pending', () => {
    const { lines } = checklist(status({ worker: undefined, clients: [{ ...nzbget, config: 'pending' }] }), clients(true, 'pending'), []);
    expect(states(lines)).toMatchObject({ worker: 'pending', nzbget: 'pending', qbittorrent: 'pending' });
    expect(lines.find((line) => line.key === 'worker')!.label).toBe('Waiting for the worker');
  });

  test('a worker of another version: the protocolMismatch text and no button', () => {
    const { lines, mismatch, actions } = checklist(status({ worker: worker({ accepted: false, connected: false, protocolVersion: 2 }) }), clients(false), []);
    expect(states(lines).worker).toBe('failed');
    expect(mismatch).toBe('Worker runs protocol v2; this release needs v3. Update the worker image to the same release tag.');
    expect(actions).toEqual([]);
  });

  test.each<[FailureCode, string]>([
    ['jellyfinSetupNeeded', 'Set up Jellyfin again'],
    ['jellyfinPasswordNotPushed', 'Set up Jellyfin again'],
  ])('%s: the failed step with its reason, and "Set up Jellyfin again"', (code, label) => {
    const steps = jellyfin().steps.map((step, i) =>
      i < 2 ? { ...step, state: 'done' as const } : i === 2 ? { ...step, state: 'failed' as const, reason: 'credentialsNeeded' as const } : step,
    );
    const { lines, actions } = checklist(status({ jellyfin: jellyfin({ state: 'blocked', steps }) }), clients(false), [code]);
    expect(lines.find((line) => line.key === 'apiKey')).toMatchObject({ state: 'failed', detail: expect.stringContaining('refused the password') });
    expect(actions).toEqual([{ action: 'rerunJellyfinSetup', label }]);
  });

  test('jellyfinUnavailable: "Jellyfin didn\'t respond." with "Retry now" only', () => {
    const { actions, jellyfinNote } = checklist(status(), clients(false), ['jellyfinUnavailable']);
    expect(actions).toEqual([{ action: 'retryNow', label: 'Retry now' }]);
    expect(jellyfinNote).toBe("Jellyfin didn't respond.");
  });
});

const scan = (run: Partial<NonNullable<ScanStatus['run']>> | null): ScanStatus => ({
  run: run && {
    scanRunId: 'r' as never,
    trigger: 'firstRun',
    state: 'reading',
    counts: { read: 0, tracked: 0, matched: 0, unmatched: 0, ignored: 0, imported: 0 } as never,
    startedAt: 0,
    hasDecisions: false,
    ...run,
  },
  untracked: 0,
  schedule: {} as never,
});

describe('the first-run scan', () => {
  test('starts once: not when a first-run scan already exists', () => {
    expect(shouldStartScan(scan(null))).toBe(true);
    expect(shouldStartScan(scan({ trigger: 'manual', state: 'ready' }))).toBe(true);
    expect(shouldStartScan(scan({ state: 'reading' }))).toBe(false);
  });

  test('Continue needs the worker connected and the first-run scan ended', () => {
    expect(canContinue(status(), scan({ state: 'reading' }))).toBe(false);
    expect(canContinue(status({ worker: undefined }), scan({ state: 'ready' }))).toBe(false);
    for (const state of ['ready', 'failed', 'cancelled'] as const) expect(canContinue(status(), scan({ state }))).toBe(true);
  });

  test('advance: existingMedia when the scan found untracked files, else done', () => {
    expect(advanceTarget(scan({ state: 'ready', counts: { read: 3, tracked: 0 } as never }))).toBe('existingMedia');
    expect(advanceTarget(scan({ state: 'ready', counts: { read: 2, tracked: 2 } as never }))).toBe('done');
    expect(advanceTarget(scan(null))).toBe('done');
  });
});

describe('addressLines', () => {
  const ports = { web: '3000', convex: '3210', convexSite: '3211', jellyfin: '8096' };
  test("no web URL: each line is this browser's address on its port, and the note says how to use a domain", () => {
    const { lines, note } = addressLines({ webUrl: '', convexUrl: '', convexSiteUrl: '', jellyfinUrl: '', ports });
    expect(lines[0]).toEqual({ label: 'Web app', value: "This browser's address on port 3000" });
    expect(lines[3]).toEqual({ label: 'Jellyfin', value: "This browser's address on port 8096" });
    expect(note).toMatch(/^omnarr accepts sign-in from any address on port 3000\. To use a domain, set OMNARR_WEB_URL/);
  });

  test('URLs set: the URLs, and sign-in works only at the web URL', () => {
    const { lines, note } = addressLines({
      webUrl: 'https://o.example.net',
      convexUrl: 'https://api.example.net',
      convexSiteUrl: 'https://auth.example.net',
      jellyfinUrl: '',
      ports,
    });
    expect(lines.map((line) => line.value)).toEqual([
      'https://o.example.net',
      'https://api.example.net',
      'https://auth.example.net',
      "This browser's address on port 8096",
    ]);
    expect(note).toBe('Sign-in works only at https://o.example.net.');
  });
});

describe('usenetSaved', () => {
  const usenet = (overrides: Partial<DownloadClientsDetail['usenet']>) =>
    ({ enabled: false, hasPassword: false, configVersion: 0, config: 'pending', backupServers: [], ...overrides }) as DownloadClientsDetail['usenet'];
  const server = { host: 'news.provider.example', port: 563, ssl: true, username: 'u', connections: 20, level: 0 };

  test('a main server saved, on the step or in Settings, shows the step its backup servers and Continue', () => {
    expect(usenetSaved(usenet({ enabled: true, server, hasPassword: true, configVersion: 1, config: 'applied' }))).toBe(true);
  });

  test('no provider, or only a Test login (a row without a saved server), shows neither backup servers nor Continue', () => {
    expect(usenetSaved(usenet({}))).toBe(false);
    expect(usenetSaved(usenet({ enabled: false, server }))).toBe(false);
  });
});

describe('refusalText', () => {
  test.each([
    [{ error: 'wrongSetupPassword' }, "That isn't the setup password. No account was created."],
    [{ error: 'invalidUsername' }, 'Use 3–30 letters, digits, _ or .'],
    [{ error: 'weakPassword' }, 'Use at least 8 characters.'],
    [{ error: 'adminExists' }, 'An admin account already exists. Sign in instead.'],
  ] as const)('%o', (result, text) => {
    expect(refusalText(result)).toBe(text);
  });

  test('locked names the time', () => {
    expect(refusalText({ error: 'locked', until: 0 }, () => '14:05')).toBe('Too many wrong setup passwords. Try again at 14:05.');
  });
});
