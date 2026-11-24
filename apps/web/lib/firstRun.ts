// First run: which page a path may show, the finish step's checklist, when
// the first-run scan starts and Continue unlocks, and the copy of sign-in,
// the first steps and the password page.
import type { CreateAdminResult, DownloadClientsDetail, FailureCode, FirstRunStep, ScanStatus, SetupState, SystemStatus } from '@omnarr/contracts';

import { type JellyfinAction, jellyfinActions } from './jellyfin';
import { setupStepRows } from './system';

/** Each step's frame. */
export const FRAME_PATH: Record<Exclude<FirstRunStep, 'done'>, string> = {
  account: '/setup',
  address: '/setup/address',
  indexer: '/setup/indexer',
  usenet: '/setup/usenet',
  torrents: '/setup/torrents',
  devices: '/setup/devices',
  metadata: '/setup/metadata',
  finish: '/setup/finish',
  existingMedia: '/setup/existing-media',
};
const ORDER = Object.keys(FRAME_PATH) as Exclude<FirstRunStep, 'done'>[];
const LIBRARY = '/library';
const isSetupPath = (path: string) => path === '/setup' || path.startsWith('/setup/');

/**
 * Where to send the browser instead of `path`, or undefined to show it. No
 * admin: the account step. An admin and no session: sign-in. A session
 * mid-way: the steps from the address up to its own (Back revisits them);
 * anything else goes to the step's page. Done: the setup pages and sign-in
 * open the library.
 */
export function routeFor(state: SetupState, signedIn: boolean, path: string): string | undefined {
  if (!state.adminExists) return path === FRAME_PATH.account ? undefined : FRAME_PATH.account;
  if (!signedIn) return path === '/login' ? undefined : '/login';
  const step = state.step ?? 'done';
  if (step === 'done') return isSetupPath(path) || path === '/login' ? LIBRARY : undefined;
  const asked = ORDER.findIndex((candidate) => FRAME_PATH[candidate] === path);
  return asked > 0 && asked <= ORDER.indexOf(step) ? undefined : FRAME_PATH[step];
}

export type ChecklistLine = { key: string; label: string; state: 'done' | 'pending' | 'failed' | 'skipped'; detail?: string };
export type Checklist = {
  lines: ChecklistLine[];
  /** A worker of another version: its text, with no button. */
  mismatch?: string;
  /** The fixes for the open Jellyfin Issues. */
  actions: JellyfinAction[];
  /** "Jellyfin didn't respond." while jellyfinUnavailable is open. */
  jellyfinNote?: string;
};

const clientState = (config: 'applied' | 'pending' | 'failed' | undefined): ChecklistLine['state'] =>
  config === 'applied' ? 'done' : config === 'failed' ? 'failed' : 'pending';

/** The finish step's lines, read live from system.status and downloadClients.get, and the open Jellyfin Issues' codes. */
export function checklist(status: SystemStatus, clients: DownloadClientsDetail, jellyfinIssues: FailureCode[]): Checklist {
  const { worker } = status;
  const mismatch =
    worker && !worker.accepted
      ? `Worker runs protocol v${worker.protocolVersion}; this release needs v${worker.expectedVersion}. Update the worker image to the same release tag.`
      : undefined;
  const nzbget = status.clients.find((row) => row.clientKind === 'nzbget');
  const qbittorrent = status.clients.find((row) => row.clientKind === 'qbittorrent');
  const lines: ChecklistLine[] = [
    worker?.connected
      ? { key: 'worker', label: `Worker connected · protocol v${worker.protocolVersion}`, state: 'done' }
      : mismatch
        ? { key: 'worker', label: `Worker v${worker!.protocolVersion} · needs v${worker!.expectedVersion}`, state: 'failed' }
        : { key: 'worker', label: 'Waiting for the worker', state: 'pending' },
    { key: 'nzbget', label: 'NZBGet configured', state: clientState(nzbget?.config) },
    clients.torrents.enabled
      ? { key: 'qbittorrent', label: 'qBittorrent configured', state: clientState(qbittorrent?.config ?? clients.torrents.config) }
      : { key: 'qbittorrent', label: 'qBittorrent skipped', state: 'skipped' },
    ...setupStepRows(status.jellyfin.steps).map((row, i) => ({
      key: status.jellyfin.steps[i]!.step,
      label: row.label,
      state: row.state,
      ...(row.reason ? { detail: row.reason } : {}),
    })),
  ];
  const actions = [...new Map(jellyfinIssues.flatMap(jellyfinActions).map((action) => [action.action, action])).values()];
  return {
    lines,
    ...(mismatch ? { mismatch } : {}),
    actions,
    ...(jellyfinIssues.includes('jellyfinUnavailable') ? { jellyfinNote: "Jellyfin didn't respond." } : {}),
  };
}

/**
 * The Usenet step's Continue: a provider is saved, wherever it was saved (Settings
 * too), so the step moves on without a second save.
 * A disabled row is only a Test login's (configStateText).
 */
export const usenetSaved = (usenet: DownloadClientsDetail['usenet']): boolean => usenet.enabled && usenet.server !== undefined;

export const usenetStepCanContinue = (usenet: DownloadClientsDetail['usenet'], backupsUnsaved: boolean): boolean => usenetSaved(usenet) && !backupsUnsaved;

const ended = (scan: ScanStatus) => scan.run?.trigger === 'firstRun' && ['ready', 'failed', 'cancelled'].includes(scan.run.state);

/** The finish step starts `scan.start('firstRun')` once, when no first-run scan exists. */
export const shouldStartScan = (scan: ScanStatus): boolean => scan.run?.trigger !== 'firstRun';

/** "Continue to omnarr": the worker is connected and the first-run scan has ended; an open Jellyfin Issue doesn't block it. */
export const canContinue = (status: SystemStatus, scan: ScanStatus): boolean => Boolean(status.worker?.connected) && ended(scan);

/** The finish step's `advance`: the existing-media step when the scan found untracked files, otherwise done. */
export const advanceTarget = (scan: ScanStatus): 'existingMedia' | 'done' =>
  scan.run && scan.run.counts.read - scan.run.counts.tracked > 0 ? 'existingMedia' : 'done';

const clock = (until: number) => new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The account step's text for each refusal of `setup.createAdmin`. */
export function refusalText(result: Extract<CreateAdminResult, { error: unknown }>, formatTime: (until: number) => string = clock): string {
  switch (result.error) {
    case 'wrongSetupPassword':
      return "That isn't the setup password. No account was created.";
    case 'locked':
      return `Too many wrong setup passwords. Try again at ${formatTime(result.until ?? Date.now())}.`;
    case 'invalidUsername':
      return 'Use 3–30 letters, digits, _ or .';
    case 'weakPassword':
      return 'Use at least 8 characters.';
    case 'adminExists':
      return 'An admin account already exists. Sign in instead.';
  }
}

/** The sign-in, first-run and password copy. */
export const COPY = {
  signInHint: 'Jellyfin uses the same username and password.',
  wrongCredentials: 'Wrong username or password.',
  rateLimited: 'Too many attempts. Try again in a few minutes.',
  forgot: 'Forgot your password? Run `docker compose exec backend reset-admin-password` on the server.',
  accountHint: 'You sign in to omnarr and to Jellyfin with this account.',
  setupPasswordHint: "You'll find it on the server: run `docker compose logs setup`, or use the `OMNARR_SETUP_PASSWORD` you set in `.env`.",
  usenetHint: "You won't need to open NZBGet.",
  passwordChangeJellyfin: 'Jellyfin will sign you out on every device. Sign in there again with the new password.',
  done: 'Setup complete. Your library is empty.',
} as const;

/** The address step's lines: each URL as configured, or this browser's address on its port. */
export function addressLines(config: {
  webUrl: string;
  convexUrl: string;
  convexSiteUrl: string;
  jellyfinUrl: string;
  ports: Record<'web' | 'convex' | 'convexSite' | 'jellyfin', string>;
}) {
  const line = (label: string, url: string, port: string) => ({ label, value: url || `This browser's address on port ${port}` });
  return {
    lines: [
      line('Web app', config.webUrl, config.ports.web),
      line('Convex', config.convexUrl, config.ports.convex),
      line('Sign-in (auth)', config.convexSiteUrl, config.ports.convexSite),
      line('Jellyfin', config.jellyfinUrl, config.ports.jellyfin),
    ],
    note: config.webUrl
      ? `Sign-in works only at ${config.webUrl}.`
      : `omnarr accepts sign-in from any address on port ${config.ports.web}. To use a domain, set OMNARR_WEB_URL, OMNARR_CONVEX_URL and OMNARR_CONVEX_SITE_URL in .env and run docker compose up -d.`,
  };
}
