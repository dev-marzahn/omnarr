// The NZBGet adapter of the DownloadClient port:
// JSON-RPC on the internal network at nzbget:6789, with the control login the
// setup container generated. Behaviour was checked against NZBGet 26.3
// (test/fixtures/nzbget/README.md); failures.ts holds the history table.
import { limitReached, usagePeriod } from '@omnarr/contracts';
import type { ClientStatus, DesiredClientConfig, UsenetServerUsage } from '@omnarr/contracts';

import { errorFailureCode, nzbgetHistoryState } from '../failures.ts';
import { JobFailure } from '../runtime/lease.ts';
import type { ClientItem, DownloadClient } from './downloadClient.ts';
import { mergeOwnedOptions, type NzbgetOption } from './nzbgetConfig.ts';

export type NzbgetOptions = {
  /** The base URL on the internal network: http://nzbget:6789. */
  url: string;
  /** NZBGet's ControlUsername and ControlPassword. */
  username: string;
  password: string;
  /** Per call; 30 s by default. */
  timeoutMs?: number;
  /** How long an apply waits for NZBGet to come back after `reload` (60 s), and how often it looks. */
  reloadWaitMs?: number;
  reloadPollMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

type Parameter = { Name: string; Value: string };

/** The fields the adapter reads from a `history` entry (NZBGet 24–26). */
export type NzbgetHistoryEntry = {
  NZBID: number;
  NZBName?: string;
  Kind: string;
  Status: string;
  ParStatus: string;
  UnpackStatus: string;
  MoveStatus: string;
  DeleteStatus: string;
  Health: number;
  CriticalHealth: number;
  FailedArticles: number;
  TotalArticles: number;
  DestDir: string;
  FinalDir: string;
  Category: string;
  Parameters: Parameter[];
};

/** The fields the adapter reads from a `listgroups` entry. */
export type NzbgetGroup = Omit<NzbgetHistoryEntry, 'FinalDir'> & {
  FileSizeLo: number;
  FileSizeHi: number;
  RemainingSizeLo: number;
  RemainingSizeHi: number;
  PausedSizeLo: number;
  PausedSizeHi: number;
};

/** The login "Test login" checks. */
export type UsenetLogin = { host: string; port: number; ssl: boolean; username: string; password: string };

/** The NZBGet-only parts of the adapter: the provider test and the servers' monthly limits. */
export type NzbgetClient = DownloadClient & {
  testServer(login: UsenetLogin, signal: AbortSignal): Promise<'ok' | 'authRejected' | 'failed'>;
  /**
   * Each server with a limit is paused at run time
   * (`editserver`) once its period's traffic reaches it, and resumed in the next period. A server
   * without one is left alone. Answers each limited server's usage, for the card.
   */
  enforceLimits(desired: NzbgetServers, now: number, signal: AbortSignal): Promise<UsenetServerUsage[]>;
};

/** The servers NZBGet runs as Server1 (the main one) and Server2… (the backups), as `applyConfig` wrote them. */
export type NzbgetServers = NonNullable<DesiredClientConfig['nzbget']>;

/** One `servervolumes` entry: the 64-bit bytes per UTC day, from `FirstDay` (days since the epoch). */
export type NzbgetServerVolume = { ServerID?: number; FirstDay: number; BytesPerDays: { SizeLo: number; SizeHi: number }[] };

const DAY_MS = 86_400_000;

/** A server's bytes from the period's first day on; no stats is none. */
export function periodBytes(volume: Pick<NzbgetServerVolume, 'FirstDay' | 'BytesPerDays'> | undefined, periodStart: number): number {
  if (!volume) return 0;
  const from = Math.floor(periodStart / DAY_MS) - volume.FirstDay;
  return volume.BytesPerDays.slice(Math.max(0, from)).reduce((sum, day) => sum + day.SizeHi * 2 ** 32 + day.SizeLo, 0);
}

/** The post-processing parameter that carries the correlation tag. */
const TAG_PARAMETER = 'omnarr';

/** NZBGet's queue statuses as stages. An unknown status is queued: no failure is decided from a queue status. */
const QUEUE_STAGES: Record<string, ClientItem['stage']> = {
  QUEUED: 'queued',
  PAUSED: 'queued',
  DOWNLOADING: 'downloading',
  FETCHING: 'downloading',
  PP_QUEUED: 'postProcessing',
  LOADING_PARS: 'postProcessing',
  VERIFYING_SOURCES: 'postProcessing',
  REPAIRING: 'postProcessing',
  VERIFYING_REPAIRED: 'postProcessing',
  RENAMING: 'postProcessing',
  UNPACKING: 'postProcessing',
  MOVING: 'postProcessing',
  EXECUTING_SCRIPT: 'postProcessing',
  PP_FINISHED: 'postProcessing',
};

/** `testserver`'s answer naming a refused login: the word, or NNTP's 481, 482 or 502. */
const AUTH_REJECTED = /authori[sz]ation|authentication|\b48[12]\b|\b502\b/i;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason as Error)), { once: true });
  });

export function nzbgetClient(options: NzbgetOptions): NzbgetClient {
  const endpoint = `${options.url.replace(/\/+$/, '')}/jsonrpc`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reloadWaitMs = options.reloadWaitMs ?? 60_000;
  const reloadPollMs = options.reloadPollMs ?? 500;
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;

  /**
   * One JSON-RPC call. Every failure becomes a JobFailure whose detail names
   * NZBGet, the endpoint path and the method, never the URL, the credentials
   * or NZBGet's own error text. A cancelled job's abort passes through
   * unchanged for the lease runtime.
   */
  async function rpc<T>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
    const where = `(POST /jsonrpc ${method})`;
    let body: { result?: T; error?: { code?: unknown } };
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params, id: 1 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      // The control login is generated, so a 401 means setup and NZBGet disagree; `docker compose down` and `up` rewrite it.
      if (response.status === 401) throw new JobFailure('clientUnreachable', `NZBGet rejected the control username or password ${where}.`);
      if (!response.ok) throw new JobFailure('clientUnreachable', `NZBGet answered HTTP ${response.status} ${where}.`);
      body = await response.json().catch(() => {
        throw new JobFailure('clientUnreachable', `NZBGet sent an answer that is not JSON-RPC ${where}.`);
      });
    } catch (error) {
      if (error instanceof JobFailure || signal.aborted) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const code = errorFailureCode(error) ?? 'clientUnreachable';
      throw new JobFailure(code, timedOut ? `NZBGet did not answer in time ${where}.` : `NZBGet did not answer ${where}.`);
    }
    if (body.error) {
      // A refused call is a bug in this adapter or an NZBGet it doesn't support; retrying won't help.
      const code = typeof body.error.code === 'number' ? ` ${body.error.code}` : '';
      throw new JobFailure('pipelineError', `NZBGet refused ${method} with JSON-RPC error${code} (POST /jsonrpc).`);
    }
    return body.result as T;
  }

  /** The queue, then the history. `history(false)` leaves out hidden records, but keeps DELETED/* ones. */
  async function entries(signal: AbortSignal) {
    const [groups, history] = await Promise.all([rpc<NzbgetGroup[]>('listgroups', [0], signal), rpc<NzbgetHistoryEntry[]>('history', [false], signal)]);
    return { groups, history };
  }

  async function list(signal: AbortSignal): Promise<ClientItem[]> {
    const { groups, history } = await entries(signal);
    return [...groups.map(queueItem), ...history.map(historyItem)];
  }

  const uptime = async (signal: AbortSignal) => (await rpc<{ UpTimeSec: number }>('status', [], signal)).UpTimeSec;

  /**
   * After `reload`, NZBGet restarts in the same container: the old instance
   * answers for a moment, the port refuses, and the new one answers within
   * about a second (fixtures README). The apply is done once a call has
   * failed and NZBGet answers again, or it answers with a new, lower uptime.
   */
  async function waitForRestart(before: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + reloadWaitMs;
    let wentDown = false;
    while (Date.now() < deadline) {
      try {
        const now = await uptime(signal);
        if (wentDown || now < before) return;
      } catch (error) {
        if (signal.aborted) throw error;
        wentDown = true;
      }
      await sleep(reloadPollMs, signal);
    }
    throw new JobFailure('clientUnreachable', 'NZBGet did not come back after reloading its config (POST /jsonrpc reload).');
  }

  return {
    kind: 'nzbget',
    async findByTag(correlationTag, signal) {
      return (await list(signal)).find((item) => item.correlationTags.includes(correlationTag)) ?? null;
    },
    /**
     * `append` with the NZB as content, so NZBGet keeps no URL record and never
     * sees the indexer's key. The NZB is named after the release
     * title: NZBGet skips its post-unpack renaming for a name like a Grab ID
     *. `DupeMode FORCE`: the platform decides what
     * to grab, and `DupeCheck=no`. NZBGet reads each struct member as one
     * parameter, so the tag is `{ omnarr: tag }`.
     */
    async submit(release, { correlationTag, category }, signal) {
      if (release.kind !== 'nzb') throw new JobFailure('pipelineError', 'NZBGet takes NZBs only.');
      const name = nzbName(release.name) || correlationTag;
      const content = Buffer.from(release.bytes).toString('base64');
      const params = [`${name}.nzb`, content, category, 0, false, false, '', 0, 'FORCE', [{ [TAG_PARAMETER]: correlationTag }]];
      const nzbId = await rpc<unknown>('append', params, signal);
      if (typeof nzbId !== 'number' || nzbId <= 0) throw new JobFailure('clientUnreachable', 'NZBGet did not accept the NZB (POST /jsonrpc append).');
      return { clientRef: String(nzbId) };
    },
    list,
    /**
     * A queued download: `GroupFinalDelete` with data (NZBGet deletes
     * what it downloaded and keeps no record),
     * `GroupParkDelete` without (the files stay, with a DELETED/MANUAL record).
     * A history entry: `HistoryFinalDelete` either way; NZBGet then deletes the
     * files of a failed download itself and keeps those of a successful one,
     * which `maintenance.removeDownload` deletes by its path.
     */
    async remove(clientRef, _correlationTag, deleteData, signal) {
      const id = Number(clientRef);
      const { groups, history } = await entries(signal);
      let command: string;
      if (groups.some((g) => g.NZBID === id)) command = deleteData ? 'GroupFinalDelete' : 'GroupParkDelete';
      else if (history.some((h) => h.NZBID === id)) command = 'HistoryFinalDelete';
      else return { removed: false };
      // editqueue(Command, Param, IDs) answers false for an ID it doesn't hold.
      const removed = await rpc<boolean>('editqueue', [command, '', [id]], signal);
      return { removed: removed === true };
    },
    /**
     * `saveconfig` writes the whole file, so the options `loadconfig` read
     * get the platform's owned ones merged in; nothing is written when
     * nothing differs. A save is followed by `reload` and a wait for the
     * restarted NZBGet; the queue survives it (fixtures README).
     */
    async applyConfig(desired, signal) {
      const server = desired.nzbget?.server;
      if (!server) throw new JobFailure('pipelineError', 'The NZBGet config has no Usenet provider to apply.');
      const current = await rpc<NzbgetOption[]>('loadconfig', [], signal);
      const { options: merged, changed } = mergeOwnedOptions(current, { server, backupServers: desired.nzbget?.backupServers ?? [] });
      if (changed) {
        if ((await rpc<boolean>('saveconfig', [merged], signal)) !== true)
          throw new JobFailure('clientUnreachable', 'NZBGet did not save its config (POST /jsonrpc saveconfig).');
        const before = await uptime(signal);
        await rpc<boolean>('reload', [], signal);
        await waitForRestart(before, signal);
      } else {
        // A reload resumes every server; without one, resume those paused at run time, as `ServerN.Active=yes`
        // says. A removed limit changes no file, so this is what un-pauses its server; the next limit
        // check pauses again whatever is still over its limit.
        const { NewsServers = [] } = await rpc<{ NewsServers?: { ID: number; Active: boolean }[] }>('status', [], signal);
        for (const news of NewsServers) if (!news.Active) await rpc<boolean>('editserver', [news.ID, true], signal);
      }
      return { applied: true, changed, clientVersion: await rpc<string>('version', [], signal) };
    },
    async status(signal) {
      try {
        return { reachable: true, version: await rpc<string>('version', [], signal) };
      } catch (error) {
        if (signal.aborted || !(error instanceof JobFailure)) throw error;
        return { reachable: false };
      }
    },
    /**
     * NZBGet's own login test with strict certificate checks. Its
     * answer is mapped to three outcomes and never passed on: "" is a login
     * that worked, a refused login names authentication or NNTP's 481, 482 or
     * 502, anything else is `failed`.
     */
    async enforceLimits({ server, backupServers = [] }, now, signal) {
      const servers = [server, ...backupServers].map((entry, index) => ({ entry, id: index + 1 }));
      const limited = servers.filter(({ entry }) => entry.limit);
      if (limited.length === 0) return [];
      const [volumes, status] = await Promise.all([
        rpc<NzbgetServerVolume[]>('servervolumes', [], signal),
        rpc<{ NewsServers?: { ID: number; Active: boolean }[] }>('status', [], signal),
      ]);
      const usage: UsenetServerUsage[] = [];
      for (const { entry, id } of limited) {
        const { monthlyLimitGb, resetDay } = entry.limit!;
        const usedBytes = periodBytes(
          volumes.find((volume) => volume.ServerID === id),
          usagePeriod(resetDay, now).start,
        );
        const reached = limitReached(usedBytes, monthlyLimitGb);
        const active = status.NewsServers?.find((news) => news.ID === id)?.Active;
        // Run time only: a later `reload` restores the config's Active=yes, and the next pass pauses it again.
        if (active !== undefined && active === reached) await rpc<boolean>('editserver', [id, !reached], signal);
        usage.push({ ...(entry.id ? { backupId: entry.id } : {}), usedBytes, limitReached: reached });
      }
      return usage;
    },
    async testServer(login, signal) {
      const result = await rpc<unknown>('testserver', [login.host, login.port, login.username, login.password, login.ssl, '', 15, 2], signal);
      if (result === '') return 'ok';
      return typeof result === 'string' && AUTH_REJECTED.test(result) ? 'authRejected' : 'failed';
    },
  };
}

const tagsOf = (entry: Pick<NzbgetHistoryEntry, 'Parameters'>) => entry.Parameters.filter((p) => p.Name === TAG_PARAMETER).map((p) => p.Value);

function queueItem(group: NzbgetGroup): ClientItem {
  return {
    clientRef: String(group.NZBID),
    correlationTags: tagsOf(group),
    ...(group.NZBName ? { name: group.NZBName } : {}),
    stage: QUEUE_STAGES[group.Status] ?? 'queued',
    status: { stage: group.Status, progress: progress(group), ...sizes(group), raw: raw(group) },
  };
}

function historyItem(entry: NzbgetHistoryEntry): ClientItem {
  const base = {
    clientRef: String(entry.NZBID),
    correlationTags: tagsOf(entry),
    ...(entry.NZBName ? { name: entry.NZBName } : {}),
    status: { stage: entry.Status, progress: 1, raw: raw(entry) },
  };
  const state = nzbgetHistoryState(entry);
  if (state.stage === 'completed') return { ...base, stage: 'completed', contentPath: entry.FinalDir || entry.DestDir };
  if (state.stage === 'removed') return { ...base, stage: 'removed' };
  return { ...base, stage: 'failed', failureCode: state.failureCode };
}

/** The longest NZB name, in characters: NZBGet makes folders from it and adds `.#<NZBID>`. */
const NZB_NAME_MAX = 150;

/**
 * The release title as an NZB name: without the characters a file system
 * refuses, capped, and without leading or trailing dots and spaces. Empty
 * when nothing usable is left.
 */
function nzbName(title: string | undefined): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what this drops.
  const safe = (title ?? '').replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '');
  return safe.slice(0, NZB_NAME_MAX).replace(/^[\s.]+|[\s.]+$/g, '');
}

const bytes = (lo: number, hi: number) => hi * 2 ** 32 + lo;

/**
 * The bytes of the files NZBGet will fetch, and of those done: paused par
 * volumes it may never need are left out. NZBGet's
 * `listgroups` has no rate per item; the reconciler derives one.
 */
function sizes(group: NzbgetGroup): { doneBytes: number; totalBytes: number } {
  const paused = bytes(group.PausedSizeLo, group.PausedSizeHi);
  const total = Math.max(0, bytes(group.FileSizeLo, group.FileSizeHi) - paused);
  const remaining = Math.max(0, bytes(group.RemainingSizeLo, group.RemainingSizeHi) - paused);
  return { doneBytes: Math.min(total, Math.max(0, total - remaining)), totalBytes: total };
}

/** Downloaded share of the files NZBGet will fetch. */
function progress(group: NzbgetGroup): number {
  const { doneBytes, totalBytes } = sizes(group);
  return totalBytes <= 0 ? 0 : Math.min(1, Math.max(0, doneBytes / totalBytes));
}

/** The raw status the platform stores and shows: NZBGet's own fields, never its URL or paths. */
function raw(entry: Omit<NzbgetHistoryEntry, 'FinalDir'>): ClientStatus['raw'] {
  const { Kind, Status, ParStatus, UnpackStatus, MoveStatus, DeleteStatus, Health, CriticalHealth, FailedArticles, TotalArticles } = entry;
  return { Kind, Status, ParStatus, UnpackStatus, MoveStatus, DeleteStatus, Health, CriticalHealth, FailedArticles, TotalArticles };
}
