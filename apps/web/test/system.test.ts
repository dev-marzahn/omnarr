// The worker banner and the System page's wording.
import type { ClientStatusRow, JellyfinStatus, StorageStatus, SystemStatus } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  bannerOf,
  clientStatus,
  formatBytes,
  jellyfinLibrariesLine,
  jellyfinStateLabel,
  jellyfinVersionLine,
  librarySizeView,
  RERUN_PROMPT,
  rerunErrorText,
  setupStepRows,
  storageGroups,
  storageNotes,
  storageRows,
  storageUnavailableText,
  storageWarnings,
  supportBundleLine,
  updateCheckLines,
  videoEncoders,
  workerLine,
} from '../lib/system';

test('supportBundleLine: when the latest bundle was built and until when it is kept', () => {
  const builtAt = Date.UTC(2026, 10, 18, 14, 20);
  const line = supportBundleLine({ builtAt, expiresAt: builtAt + 14 * 86_400_000, url: '/api/storage/x' })!;
  expect(line).toMatch(/^Built .+, kept until 2 Dec$/);
  expect(supportBundleLine(undefined)).toBeUndefined();
});

const worker = (overrides: Partial<NonNullable<SystemStatus['worker']>> = {}): NonNullable<SystemStatus['worker']> => ({
  workerId: 'w1',
  connected: true,
  accepted: true,
  protocolVersion: 1,
  expectedVersion: 1,
  connectedAt: 0,
  lastSeenAt: Date.UTC(2026, 10, 17, 14, 2),
  ffmpegVersion: '7.1',
  encoders: [],
  ...overrides,
});
const notSetUp: JellyfinStatus = { state: 'notSetUp', steps: [], pinned: false, libraries: [] };
const status = (overrides: Partial<SystemStatus>): SystemStatus => ({
  indexers: [],
  clients: [],
  jobCounts: [],
  jellyfin: notSetUp,
  release: { version: '0.1.0', check: { state: 'notYet' } },
  ...overrides,
});

describe("the System page's Jellyfin block", () => {
  const ready: JellyfinStatus = {
    state: 'ready',
    steps: [],
    version: '12.4.0',
    pinned: true,
    libraries: ['Series', 'Movies'],
    lastSetupAt: Date.UTC(2026, 10, 18, 9, 30),
  };

  test.each([
    ['notSetUp', 'Not set up'],
    ['settingUp', 'Setting up'],
    ['ready', 'Ready'],
    ['blocked', 'Needs setup'],
  ] as const)('the state %s reads "%s"', (state, label) => {
    expect(jellyfinStateLabel(state)).toBe(label);
  });

  test('the version, and a warning when it is not the pinned release', () => {
    expect(jellyfinVersionLine(ready)).toBe('Jellyfin 12.4.0');
    expect(jellyfinVersionLine({ ...ready, version: '12.5.0', pinned: false })).toBe('Jellyfin 12.5.0 · not the pinned release');
    expect(jellyfinVersionLine(notSetUp)).toBeUndefined();
  });

  test('the libraries, and the steps in checklist order with their state', () => {
    expect(jellyfinLibrariesLine(ready)).toBe('Libraries: Series, Movies');
    expect(jellyfinLibrariesLine(notSetUp)).toBe('No libraries yet');
    expect(
      setupStepRows([
        { step: 'reachable', state: 'done' },
        { step: 'apiKey', state: 'failed', reason: 'credentialsNeeded' },
      ]),
    ).toEqual([
      { label: 'Jellyfin answers', state: 'done' },
      { label: 'API key', state: 'failed', reason: "Jellyfin refused the password. Remove Jellyfin's config volume and re-run." },
    ]);
  });

  test("the re-run dialog's wording, and its two refusals", () => {
    expect(RERUN_PROMPT).toBe('Enter your platform password to set up Jellyfin again.');
    expect(rerunErrorText('wrongPassword')).toBe('Wrong password');
    expect(rerunErrorText('alreadyRunning')).toBe('Setup is already running');
  });
});

describe('bannerOf: one banner at a time', () => {
  test('no banner while the worker is fine', () => expect(bannerOf(status({ worker: worker() }))).toBeUndefined());

  test('a version mismatch names both versions and what to do', () => {
    expect(bannerOf(status({ banner: 'protocolMismatch', worker: worker({ accepted: false, connected: false, protocolVersion: 0 }) }))).toEqual({
      color: 'error',
      title: 'Worker runs protocol v0; this release needs v1.',
      description: 'Update the worker image to the same release tag. The worker takes no jobs until then and tries again every 60 s.',
    });
  });

  test('offline says since when and what is paused', () => {
    const banner = bannerOf(status({ banner: 'workerOffline', worker: worker({ connected: false }) }));
    expect(banner?.color).toBe('error');
    expect(banner?.title).toMatch(/^Worker offline since /);
    expect(banner?.description).toBe('Download tracking, imports and preparation are paused.');
  });
});

describe('workerLine', () => {
  test.each([
    [worker(), 'Worker online · v1'],
    [worker({ connected: false }), 'Worker offline'],
    [worker({ accepted: false, connected: false, protocolVersion: 0 }), 'Worker v0 · needs v1'],
    [undefined, 'No worker yet'],
  ])('%#', (w, line) => expect(workerLine(w)).toBe(line));
});

// The System page shows these and puts the full list behind "Show all".
test('videoEncoders: the H.264, HEVC and AV1 encoders, software and hardware, in that order', () => {
  const encoders = [
    'a64multi',
    'libx264',
    'h264_vaapi',
    'h264_nvenc',
    'libx265',
    'hevc_qsv',
    'mpeg4',
    'libsvtav1',
    'libaom-av1',
    'av1_vaapi',
    'aac',
    'libopus',
    'vp9_vaapi',
  ];
  expect(videoEncoders(encoders)).toEqual([
    { codec: 'H.264', software: ['libx264'], hardware: ['h264_nvenc', 'h264_vaapi'] },
    { codec: 'HEVC', software: ['libx265'], hardware: ['hevc_qsv'] },
    { codec: 'AV1', software: ['libaom-av1', 'libsvtav1'], hardware: ['av1_vaapi'] },
  ]);
  expect(videoEncoders(['aac', 'mpeg4'])).toEqual([
    { codec: 'H.264', software: [], hardware: [] },
    { codec: 'HEVC', software: [], hardware: [] },
    { codec: 'AV1', software: [], hardware: [] },
  ]);
});

// Enabled, reachable, version, config state and active downloads.
describe('clientStatus', () => {
  const nzbget = (overrides: Partial<ClientStatusRow> = {}): ClientStatusRow => ({
    clientKind: 'nzbget',
    enabled: true,
    reachable: true,
    clientVersion: '24.5',
    config: 'applied',
    activeDownloads: 3,
    ...overrides,
  });

  test('a running client with its config applied', () => {
    expect(clientStatus(nzbget())).toEqual({
      name: 'NZBGet',
      version: 'v24.5',
      badge: { label: 'Running', color: 'success' },
      line: '3 active downloads',
    });
  });

  test("a version the client reports with its own v isn't doubled", () => {
    expect(clientStatus(nzbget({ clientKind: 'qbittorrent', clientVersion: 'v5.3.0' })).version).toBe('v5.3.0');
  });

  test('an unreachable client is an error', () => {
    expect(clientStatus(nzbget({ reachable: false })).badge).toEqual({ label: 'Unreachable', color: 'error' });
  });

  // A failed apply shows "Config not applied".
  test('a failed apply', () => {
    expect(clientStatus(nzbget({ config: 'failed' }))).toMatchObject({
      badge: { label: 'Config not applied', color: 'error' },
      line: '3 active downloads',
    });
  });

  test('a save the worker has not applied yet', () => {
    expect(clientStatus(nzbget({ config: 'pending', activeDownloads: 1 }))).toMatchObject({
      badge: { label: 'Applying config', color: 'warning' },
      line: '1 active download',
    });
  });

  test('a client not in use says so, with no config state, before reachability', () => {
    expect(clientStatus(nzbget({ enabled: false, reachable: false, config: 'pending', activeDownloads: 0 }))).toEqual({
      name: 'NZBGet',
      version: 'v24.5',
      badge: { label: 'Not set up', color: 'neutral' },
      line: '0 active downloads',
    });
    expect(clientStatus(nzbget({ clientKind: 'qbittorrent', enabled: false, clientVersion: undefined, activeDownloads: 2 }))).toEqual({
      name: 'qBittorrent',
      badge: { label: 'Torrents off', color: 'neutral' },
      line: '2 active downloads',
    });
  });
});

// qBittorrent's seeding count, seeding problems, connection status and peer port.
describe("clientStatus: qBittorrent's torrent parts", () => {
  const qbittorrent = (overrides: Partial<ClientStatusRow> = {}): ClientStatusRow => ({
    clientKind: 'qbittorrent',
    enabled: true,
    reachable: true,
    clientVersion: '5.1.2',
    config: 'applied',
    activeDownloads: 2,
    seedingCount: 12,
    seedingProblemCount: 0,
    connectionStatus: 'connected',
    peerPort: 51413,
    ...overrides,
  });

  test('seeding count, connection status and peer port follow the downloads; no problems, no warning', () => {
    expect(clientStatus(qbittorrent())).toEqual({
      name: 'qBittorrent',
      version: 'v5.1.2',
      badge: { label: 'Running', color: 'success' },
      line: '2 active downloads · 12 seeding · connected · peer port 51413',
    });
  });

  test('seeding problems are a warning, counted', () => {
    expect(clientStatus(qbittorrent({ seedingProblemCount: 2 })).warnings).toEqual(['2 seeding problems']);
    expect(clientStatus(qbittorrent({ seedingProblemCount: 1 })).warnings).toEqual(['1 seeding problem']);
  });

  test('a firewalled connection shows the forwarding hint with the peer port', () => {
    expect(clientStatus(qbittorrent({ connectionStatus: 'firewalled' }))).toEqual({
      name: 'qBittorrent',
      version: 'v5.1.2',
      badge: { label: 'Running', color: 'success' },
      line: '2 active downloads · 12 seeding · firewalled · peer port 51413',
      warnings: ["Peers can't connect to you. Forward port 51413 on your router."],
    });
  });

  test('firewalled before the peer port is reported, and with seeding problems', () => {
    expect(clientStatus(qbittorrent({ connectionStatus: 'firewalled', peerPort: undefined, seedingProblemCount: 3 }))).toMatchObject({
      line: '2 active downloads · 12 seeding · firewalled',
      warnings: ['3 seeding problems', "Peers can't connect to you. Forward the peer port on your router."],
    });
  });

  test('a disconnected qBittorrent', () => {
    expect(clientStatus(qbittorrent({ connectionStatus: 'disconnected' })).line).toBe('2 active downloads · 12 seeding · disconnected · peer port 51413');
  });

  test('torrents off: seeding ones keep seeding, so the count still shows', () => {
    expect(clientStatus(qbittorrent({ enabled: false, seedingCount: 4, connectionStatus: undefined, peerPort: undefined }))).toEqual({
      name: 'qBittorrent',
      version: 'v5.1.2',
      badge: { label: 'Torrents off', color: 'neutral' },
      line: '2 active downloads · 4 seeding',
    });
  });

  // Finding 17: through the VPN, the port shown is the one peers use; OMNARR_PEER_PORT isn't.
  // The rows carry what the worker reports: in the VPN layout, the forwarded or static port as the
  // peer port while up and none otherwise; without a VPN, OMNARR_PEER_PORT.
  const vpn = (state: NonNullable<ClientStatusRow['vpn']>['state'], port: NonNullable<ClientStatusRow['vpn']>['port']): Partial<ClientStatusRow> => ({
    vpn: { state, layoutWithoutChoice: false, port },
    peerPort: state === 'off' ? 51413 : state === 'up' && (port.kind === 'forwarded' || port.kind === 'static') ? port.port : undefined,
  });

  test('VPN up with a forwarded port: peers connect on it, forwarded by the provider; no router hint', () => {
    const row = qbittorrent({ connectionStatus: 'firewalled', ...vpn('up', { kind: 'forwarded', port: 38852 }) });
    expect(clientStatus(row, 'pia')).toMatchObject({ line: '2 active downloads · 12 seeding · firewalled · peers connect on 38852, forwarded by PIA' });
    expect(clientStatus(row, 'pia').warnings).toBeUndefined();
    expect(clientStatus(qbittorrent(vpn('up', { kind: 'forwarded', port: 41234 })), 'protonvpn').line).toMatch(/41234, forwarded by ProtonVPN$/);
  });

  test('VPN up with a static port from a config file: forwarded by your VPN', () => {
    expect(clientStatus(qbittorrent(vpn('up', { kind: 'static', port: 55001 })), 'wireguardFile').line).toMatch(
      /peers connect on 55001, forwarded by your VPN$/,
    );
  });

  test('VPN up without a forwarded port: says so, and shows no port', () => {
    expect(clientStatus(qbittorrent(vpn('up', { kind: 'none' })), 'protonvpn').line).toBe('2 active downloads · 12 seeding · connected · no forwarded port');
    expect(clientStatus(qbittorrent(vpn('up', { kind: 'waiting' })), 'pia').line).toBe('2 active downloads · 12 seeding · connected · no forwarded port');
  });

  test('VPN chosen but not up: no port at all, since torrents wait', () => {
    expect(clientStatus(qbittorrent(vpn('down', { kind: 'none' })), 'pia').line).toBe('2 active downloads · 12 seeding · connected');
  });

  test('no VPN: the peer port and, when firewalled, the router hint, as before', () => {
    expect(clientStatus(qbittorrent({ connectionStatus: 'firewalled', ...vpn('off', { kind: 'none' }) }))).toMatchObject({
      line: '2 active downloads · 12 seeding · firewalled · peer port 51413',
      warnings: ["Peers can't connect to you. Forward port 51413 on your router."],
    });
  });
});

// qBittorrent's VPN line, once the worker has reported its VPN state.
describe("clientStatus: qBittorrent's VPN line", () => {
  const qbittorrent = (vpn: ClientStatusRow['vpn']): ClientStatusRow => ({
    clientKind: 'qbittorrent',
    enabled: true,
    reachable: true,
    config: 'applied',
    activeDownloads: 0,
    vpn,
  });

  test('up: the exit IP and the port state', () => {
    expect(
      clientStatus(qbittorrent({ state: 'up', layoutWithoutChoice: false, publicIp: '203.0.113.7', port: { kind: 'forwarded', port: 41234 } })).vpn,
    ).toEqual({
      badge: { label: 'Up', color: 'success' },
      line: 'Exit IP 203.0.113.7 · Peers can connect on port 41234 through the VPN.',
    });
  });

  test('up before gluetun knows its exit IP, with no forwarded port', () => {
    expect(clientStatus(qbittorrent({ state: 'up', layoutWithoutChoice: false, port: { kind: 'none' } })).vpn?.line).toBe(
      "Your VPN doesn't forward a port. Torrents work, with fewer peers.",
    );
  });

  test('down: what that means, and no exit IP or port, which are read only while up', () => {
    expect(clientStatus(qbittorrent({ state: 'down', layoutWithoutChoice: false, publicIp: '203.0.113.7', port: { kind: 'waiting' } })).vpn).toEqual({
      badge: { label: 'Down', color: 'error' },
      line: 'The tunnel is down. Torrents wait, and no torrent traffic leaves without it.',
    });
  });

  test('chosen but not active: the step to switch to the VPN layout', () => {
    expect(clientStatus(qbittorrent({ state: 'notActive', layoutWithoutChoice: false, port: { kind: 'none' } })).vpn).toEqual({
      badge: { label: 'Not active', color: 'warning' },
      line: "A VPN is chosen, but the VPN layout isn't in use yet. Torrents wait, and move no traffic, until it is.",
      step: 'Add `COMPOSE_FILE=compose.yml:compose.vpn.yml` to `.env`, then run `docker compose up -d`.',
    });
  });

  test('the VPN layout without a choice: the step to switch back', () => {
    expect(clientStatus(qbittorrent({ state: 'up', layoutWithoutChoice: true, port: { kind: 'none' } })).vpn).toEqual({
      badge: { label: 'Up', color: 'success' },
      line: "Your VPN doesn't forward a port. Torrents work, with fewer peers.",
      step: 'No VPN is chosen, but the VPN layout still runs, so torrents go through it. Remove `COMPOSE_FILE=compose.yml:compose.vpn.yml` from `.env`, then run `docker compose up -d`.',
    });
  });

  test('no VPN', () => {
    expect(clientStatus(qbittorrent({ state: 'off', layoutWithoutChoice: false, port: { kind: 'none' } })).vpn).toEqual({
      badge: { label: 'No VPN', color: 'neutral' },
      line: 'Torrents connect directly, without a VPN.',
    });
  });

  test("the line never names gluetun's or qBittorrent's address", () => {
    const line = JSON.stringify(clientStatus(qbittorrent({ state: 'up', layoutWithoutChoice: true, port: { kind: 'static', port: 55001 } })).vpn);
    expect(line).not.toMatch(/gluetun:|qbittorrent:|8000|8080|https?:\/\//i);
  });
});

// The /data areas from the worker's heartbeat.
describe('the free-space card', () => {
  const area = (freeBytes: number, device = 'sda1', writable = true) => ({ freeBytes, device, writable });
  const storage = (overrides: Partial<StorageStatus> = {}): StorageStatus => ({
    areas: { downloads: area(3.2e12), staging: area(3.2e12), originals: area(3.2e12), series: area(3.2e12), movies: area(3.2e12) },
    librarySameDevice: true,
    downloadsSameDevice: true,
    reportedAt: 0,
    ...overrides,
  });

  test('one row per area, originals included, in the tree order', () => {
    expect(storageRows(storage())).toEqual([
      { area: 'downloads', label: 'downloads', free: '3.2 TB free', writable: true },
      { area: 'staging', label: 'staging', free: '3.2 TB free', writable: true },
      { area: 'originals', label: 'originals', free: '3.2 TB free', writable: true },
      { area: 'series', label: 'library/series', free: '3.2 TB free', writable: true },
      { area: 'movies', label: 'library/movies', free: '3.2 TB free', writable: true },
    ]);
  });

  // System's free-space rows: one row when the areas share a filesystem, a row per filesystem otherwise.
  test('grouped by filesystem: one row for one filesystem, with the libraries as "library"', () => {
    expect(storageGroups(storage())).toEqual([{ label: 'downloads, staging, originals, library', free: '3.2 TB free', writable: true }]);
  });

  test('downloads on another filesystem: two rows, in the tree order', () => {
    const { areas } = storage();
    expect(storageGroups(storage({ areas: { ...areas, downloads: area(8e11, 'sdb1') }, downloadsSameDevice: false }))).toEqual([
      { label: 'downloads', free: '800.0 GB free', writable: true },
      { label: 'staging, originals, library', free: '3.2 TB free', writable: true },
    ]);
  });

  test('one library elsewhere keeps its own name, and an area that is not writable gets its own row', () => {
    const { areas } = storage();
    expect(storageGroups(storage({ areas: { ...areas, movies: area(1e12, 'sdc1'), originals: area(3.2e12, 'sda1', false) } }))).toEqual([
      { label: 'downloads, staging, library/series', free: '3.2 TB free', writable: true },
      { label: 'originals', free: '3.2 TB free', writable: false },
      { label: 'library/movies', free: '1.0 TB free', writable: true },
    ]);
  });

  // A torrent's download stays while it seeds, so free space comes back only at the goal.
  test('one filesystem: the areas share free space, and seeding holds a prepared file twice', () => {
    expect(storageNotes(storage())).toEqual([
      'These areas share one filesystem and its free space.',
      'Preparing a file while its torrent is still seeding takes double space until the seeding goal is met.',
    ]);
  });

  test('no notes when downloads or the library are elsewhere: their warnings say it', () => {
    const { areas } = storage();
    expect(storageNotes(storage({ downloadsSameDevice: false }))).toEqual([]);
    expect(storageNotes(storage({ librarySameDevice: false, areas: { ...areas, movies: area(1e12, 'sdb1') } }))).toEqual([]);
  });

  describe('the Library rows', () => {
    const size = (totalBytes: number, seriesBytes: number, moviesBytes: number) => ({ totalBytes, seriesBytes, moviesBytes, measuredAt: 0 });

    test('the total, then Series and Movies under it, and when it was measured', () => {
      const view = librarySizeView(size(4.2e12, 3e12, 1.2e12));
      expect(view.rows).toEqual([
        { label: 'Library', size: '4.2 TB used', part: false },
        { label: 'Series', size: '3.0 TB', part: true },
        { label: 'Movies', size: '1.2 TB', part: true },
      ]);
      expect(view.note).toMatch(/^Measured .+\. Counts only the files omnarr tracks\.$/);
    });

    test('an empty library shows 0 B, not a blank', () => {
      expect(librarySizeView(size(0, 0, 0)).rows.map((row) => row.size)).toEqual(['0 B used', '0 B', '0 B']);
    });

    test('while it is measured: one Library line', () => {
      expect(librarySizeView(undefined)).toEqual({ rows: [{ label: 'Library', size: 'measuring…', part: false }], note: '' });
    });

    test('a failed read: no rows, one line', () => {
      expect(librarySizeView(undefined, true)).toEqual({ rows: [], note: "Couldn't measure the library's size. Open System again to retry." });
    });
  });

  test('no warning when every area is writable and on one filesystem', () => {
    expect(storageWarnings(storage())).toEqual([]);
  });

  // Not an Issue, only a line on the System page.
  test('downloads on another filesystem: imports copy files', () => {
    expect(storageWarnings(storage({ downloadsSameDevice: false }))).toEqual([
      {
        color: 'warning',
        title: 'Downloads and library are on different filesystems: imports copy files',
        description: 'A seeding torrent takes double space until its download is removed.',
      },
    ]);
  });

  // The storageUnavailable Issue names the areas and says what to do.
  test('areas that are not writable', () => {
    const { areas } = storage();
    expect(storageWarnings(storage({ areas: { ...areas, staging: area(1e12, 'sda1', false), originals: area(1e12, 'sda1', false) } }))).toEqual([
      {
        color: 'error',
        title: 'Storage unavailable',
        description:
          "Staging and originals aren't writable. Put the library, staging and originals on the /data volume, and check the owner set in the compose file.",
      },
    ]);
  });

  test('library areas on another filesystem than staging', () => {
    const { areas } = storage();
    expect(storageWarnings(storage({ librarySameDevice: false, areas: { ...areas, movies: area(1e12, 'sdb1') } }))).toEqual([
      {
        color: 'error',
        title: 'Storage unavailable',
        description:
          'Library/movies is on another filesystem than staging. Put the library, staging and originals on the /data volume, and check the owner set in the compose file.',
      },
    ]);
  });

  test('storageUnavailableText names one area, and both problems together', () => {
    const { areas } = storage();
    expect(storageUnavailableText(storage({ areas: { ...areas, downloads: area(1e12, 'sda1', false) } }))).toBe(
      "Downloads isn't writable. Put the library, staging and originals on the /data volume, and check the owner set in the compose file.",
    );
    expect(
      storageUnavailableText(
        storage({
          librarySameDevice: false,
          areas: { ...areas, series: area(1e12, 'sdb1', false), originals: area(1e12, 'sdc1'), movies: area(1e12, 'sdb1') },
        }),
      ),
    ).toBe(
      "Library/series isn't writable. Originals, library/series and library/movies are on another filesystem than staging. Put the library, staging and originals on the /data volume, and check the owner set in the compose file.",
    );
    expect(storageUnavailableText(storage())).toBeUndefined();
  });
});

describe("the System page's update check", () => {
  const releaseUrl = 'https://github.com/dev-marzahn/omnarr/releases/tag/v1.3.0';
  const newer = { latest: '1.3.0', releaseUrl };
  const at = Date.UTC(2026, 10, 24, 6, 30);
  const texts = (release: SystemStatus['release']) => updateCheckLines(release).map((line) => line.text);

  test('a newer release: "omnarr <latest> is available", linked to its page', () => {
    expect(updateCheckLines({ version: '1.2.0', check: { state: 'available', newer, checkedAt: at } })).toEqual([
      { text: 'omnarr 1.3.0 is available', icon: 'i-lucide-arrow-up-circle', tone: 'primary', url: releaseUrl },
    ]);
  });

  test('up to date, with the time of the last check', () => {
    const [line] = updateCheckLines({ version: '1.3.0', check: { state: 'upToDate', checkedAt: at } });
    expect(line).toMatchObject({ tone: 'muted', text: expect.stringMatching(/^Up to date · checked .*(24 Nov|Nov 24)/) });
    expect(line!.url).toBeUndefined();
  });

  test('a development build is never offered a release, so it says only when the check ran', () => {
    expect(texts({ version: '0.0.0-dev', check: { state: 'upToDate', checkedAt: at } })).toEqual([expect.stringMatching(/^Checked for releases /)]);
  });

  test('turned off', () => {
    expect(texts({ version: '1.3.0', check: { state: 'off' } })).toEqual(['Update check is off']);
  });

  test('not run yet', () => {
    expect(texts({ version: '1.3.0', check: { state: 'notYet' } })).toEqual(["Update check hasn't run yet"]);
  });

  test('failed: a warning with its time, and when the check last answered if it ever did', () => {
    expect(updateCheckLines({ version: '1.3.0', check: { state: 'failed', failedAt: at } })).toEqual([
      { text: expect.stringMatching(/^Update check failed [^·]+$/), icon: 'i-lucide-triangle-alert', tone: 'warning' },
    ]);
    expect(texts({ version: '1.3.0', check: { state: 'failed', failedAt: at, lastCheckedAt: at - 86_400_000 } })).toEqual([
      expect.stringMatching(/^Update check failed .+ · last answered .*(23 Nov|Nov 23)/),
    ]);
  });

  test('failed after finding a newer release: the release stays linked above the warning', () => {
    const lines = updateCheckLines({ version: '1.2.0', check: { state: 'failed', failedAt: at, lastCheckedAt: at, knownNewer: newer } });
    expect(lines.map((line) => [line.tone, line.url])).toEqual([
      ['primary', releaseUrl],
      ['warning', undefined],
    ]);
  });
});

test('formatBytes', () => {
  expect(formatBytes(3.2e12)).toBe('3.2 TB');
  expect(formatBytes(2_014e6)).toBe('2.0 GB');
  expect(formatBytes(512)).toBe('512 B');
});
