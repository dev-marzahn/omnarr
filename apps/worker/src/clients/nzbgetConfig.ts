// The options the platform owns in NZBGet's configuration. NZBGet's
// `saveconfig` writes the whole file, so the adapter reads the file with
// `loadconfig`, replaces these options, drops every server past the main one
// and the backups (Server2.* and higher without backups) and every
// Category3.* and higher, leaves all other options as NZBGet has them,
// and saves only when something changed. `ControlUsername` and
// `ControlPassword` belong to the setup container: they are written back
// as read.
import type { UsenetServer } from '@omnarr/contracts';

/** One entry of `loadconfig` and `saveconfig`. */
export type NzbgetOption = { Name: string; Value: string };

/** The CA bundle of the pinned image (`nzbgetcom/nzbget:v26.3`), as its own config template sets it. */
export const NZBGET_CERT_STORE = '/app/nzbget/cacert.pem';

/** The main server, and the backup servers at level 1; without backups, one provider. */
export type NzbgetDesired = { server: UsenetServer; backupServers?: UsenetServer[] };

/** `Server<n>.*`. `Optional` is written for a backup only, so a config without backups stays as it was. */
function serverOptions(n: number, name: string, server: UsenetServer, optional: boolean): [string, string][] {
  const key = (option: string) => `Server${n}.${option}`;
  return [
    [key('Active'), 'yes'],
    [key('Name'), name],
    [key('Level'), String(server.level)],
    ...(optional ? [[key('Optional'), 'yes'] as [string, string]] : []),
    [key('Group'), '0'],
    [key('Host'), server.host],
    [key('Port'), String(server.port)],
    [key('Encryption'), server.ssl ? 'yes' : 'no'],
    [key('CertVerification'), 'strict'],
    [key('Username'), server.username],
    [key('Password'), server.password],
    [key('Connections'), String(server.connections)],
    [key('Retention'), '0'],
  ];
}

function owned({ server, backupServers = [] }: NzbgetDesired): [string, string][] {
  return [
    // Paths: completed downloads land in completed/<category>/<name>.
    ['MainDir', '/data/downloads/usenet'],
    ['DestDir', '${MainDir}/completed'],
    ['InterDir', '${MainDir}/intermediate'],
    ['NzbDir', '${MainDir}/nzb'],
    ['QueueDir', '${MainDir}/queue'],
    ['TempDir', '${MainDir}/tmp'],
    ['LockFile', '/config/nzbget.lock'],
    ['LogFile', '/config/nzbget.log'],
    // The pinned image's template, as its own nzbget.conf sets it; without it NZBGet logs
    // "Could not read configuration templates" at every start.
    ['ConfigTemplate', '${AppDir}/webui/nzbget.conf.template'],
    ['CertStore', NZBGET_CERT_STORE],
    // Built-in `no` leaves certificate checks off even with a CertStore.
    ['CertCheck', 'yes'],
    ['Category1.Name', 'platform-series'],
    ['Category1.DestDir', ''],
    ['Category2.Name', 'platform-movies'],
    ['Category2.DestDir', ''],
    ['AppendCategoryDir', 'yes'],
    ...serverOptions(1, 'provider', server, false),
    // Backup servers: one level below the main server and
    // optional, so NZBGet asks them only for articles Level 0 lacks, and a dead one doesn't fail a download.
    ...backupServers.flatMap((backup, index) => serverOptions(index + 2, `backup-${index + 1}`, backup, true)),
    // Post-processing: par repair and unpack, no scripts.
    ['HealthCheck', 'delete'],
    ['ParCheck', 'auto'],
    ['ParRepair', 'yes'],
    ['ParRename', 'yes'],
    ['RarRename', 'yes'],
    ['DirectRename', 'yes'],
    ['Unpack', 'yes'],
    ['UnpackCleanupDisk', 'yes'],
    ['Extensions', ''],
    // Built-in `no` makes an apply's reload fetch the current file's finished articles again.
    ['ContinuePartial', 'yes'],
    // The platform decides what to grab (DupeMode FORCE at append) and removes its own history entries.
    ['DupeCheck', 'no'],
    ['KeepHistory', '30'],
    // Built-in `no` keeps every NZB's `.queued` copy in NzbDir; `yes` deletes it once the entry leaves the
    // queue and history, which the platform's `HistoryFinalDelete` does.
    ['NzbCleanupDisk', 'yes'],
    ['ControlIP', '0.0.0.0'],
    ['ControlPort', '6789'],
    ['SecureControl', 'no'],
    ['AuthorizedIP', ''],
    ['FormAuth', 'no'],
    ['UpdateCheck', 'none'],
  ];
}

const SERVER = /^Server(\d+)\./;
const CATEGORY = /^Category(\d+)\./;

/** A server past the main one and the backups, or Category3.* and higher: the platform has only its two categories. */
function dropped(name: string, servers: number): boolean {
  const server = SERVER.exec(name);
  if (server) return Number(server[1]) > servers;
  const category = CATEGORY.exec(name);
  return category !== null && Number(category[1]) > 2;
}

export function mergeOwnedOptions(current: NzbgetOption[], desired: NzbgetDesired): { options: NzbgetOption[]; changed: boolean } {
  const wanted = new Map(owned(desired));
  const servers = 1 + (desired.backupServers?.length ?? 0);
  const seen = new Set<string>();
  let changed = false;
  const options: NzbgetOption[] = [];
  for (const option of current) {
    if (dropped(option.Name, servers)) {
      changed = true;
      continue;
    }
    const value = wanted.get(option.Name);
    if (value === undefined) {
      options.push(option);
      continue;
    }
    seen.add(option.Name);
    if (option.Value !== value) changed = true;
    options.push({ Name: option.Name, Value: value });
  }
  for (const [Name, Value] of wanted) {
    if (seen.has(Name)) continue;
    changed = true;
    options.push({ Name, Value });
  }
  return { options, changed };
}
