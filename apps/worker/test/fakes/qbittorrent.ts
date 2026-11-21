// An in-process fake of qBittorrent's WebUI API v2, behaving as the real
// qbittorrent-nox 5.3.0-2 did when the fixtures were recorded
// (test/fixtures/qbittorrent/README.md): a cookie session from
// `auth/login`, 403 without one, torrents keyed by info hash with
// comma-separated tags, categories, preferences, trackers and transfer info.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTorrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  downloaded: number;
  /** The selected files' size, the bytes of them done, and the download rate in bytes per second. */
  total_size?: number;
  completed?: number;
  dlspeed?: number;
  ratio: number;
  /** Seconds. */
  seeding_time: number;
  category: string;
  /** qBittorrent's spelling: tags joined by ", ". */
  tags: string;
  save_path: string;
  content_path: string;
  /** The torrent's top folder under the Subfolder layout; `content_path` is the file inside it for a single-file torrent. */
  root_path: string;
  private: boolean | null;
  ratio_limit: number;
  /** Minutes; −1 is none, −2 the global limit. */
  seeding_time_limit: number;
  inactive_seeding_time_limit: number;
  trackers?: { url: string; status: number; msg: string }[];
};

export type QbtCall = { method: string; path: string; form: Record<string, string>; files: string[] };

export type FakeQbittorrent = {
  url: string;
  calls: QbtCall[];
  torrents: FakeTorrent[];
  preferences: Record<string, unknown>;
  categories: Record<string, { name: string; savePath: string }>;
  connectionStatus: string;
  version: string;
  /** Drops every session, as a qBittorrent restart does: the next call is 403 until a new login. */
  expireSessions(): void;
  /** Every call answers with this HTTP status, when set. */
  httpStatus?: number;
  /** `torrents/add` takes this long before the torrent is listed. */
  listDelayMs: number;
  /** Hashes the next `torrents/info` leaves out, once each. */
  hiddenOnce: Set<string>;
  /** Teaches the fake the hash of a .torrent file, as qBittorrent computes it. */
  knowTorrent(bytes: Uint8Array, hash: string): void;
  /** Every `torrents/delete`, per hash. */
  deleted: { hash: string; deleteFiles: boolean }[];
  close(): Promise<void>;
};

/** A field of the multipart or urlencoded body, as qBittorrent reads it. */
async function readBody(req: IncomingMessage): Promise<{ form: Record<string, string>; files: { name: string; bytes: Buffer }[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  const form: Record<string, string> = {};
  const files: { name: string; bytes: Buffer }[] = [];
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  if (boundary) {
    const parts = await new Response(body, { headers: { 'content-type': type } }).formData();
    for (const [key, value] of parts.entries()) {
      if (typeof value === 'string') form[key] = value;
      else files.push({ name: key, bytes: Buffer.from(await value.arrayBuffer()) });
    }
  } else for (const [key, value] of new URLSearchParams(body.toString('utf8'))) form[key] = value;
  return { form, files };
}

const tagsOf = (torrent: FakeTorrent) => torrent.tags.split(', ').filter(Boolean);

export async function startFakeQbittorrent(credentials: { username: string; password: string }): Promise<FakeQbittorrent> {
  const sessions = new Set<string>();
  let nextSid = 1;
  const pending: { torrent: FakeTorrent; at: number }[] = [];

  const fake: Omit<FakeQbittorrent, 'url' | 'close' | 'knowTorrent' | 'deleted'> = {
    calls: [],
    torrents: [],
    preferences: {
      save_path: '/downloads',
      temp_path_enabled: false,
      auto_tmm_enabled: false,
      torrent_content_layout: 'Original',
      listen_port: 6881,
      random_port: false,
      upnp: true,
      current_network_interface: '',
      max_ratio_enabled: false,
      max_seeding_time_enabled: false,
      max_inactive_seeding_time_enabled: false,
      max_ratio_act: 0,
      queueing_enabled: true,
      bypass_local_auth: false,
      bypass_auth_subnet_whitelist_enabled: false,
      web_ui_upnp: false,
      add_trackers_enabled: false,
      auto_delete_mode: 0,
      add_stopped_enabled: false,
      dht: true,
    },
    categories: {},
    connectionStatus: 'connected',
    version: 'v5.3.0',
    expireSessions: () => sessions.clear(),
    listDelayMs: 0,
    hiddenOnce: new Set(),
  };

  /** The torrents, with those whose listing delay has passed. */
  const listed = () => {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--)
      if (pending[i]!.at <= now) {
        fake.torrents.push(pending[i]!.torrent);
        pending.splice(i, 1);
      }
    return fake.torrents;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://qbittorrent');
    const path = url.pathname.replace(/^\/api\/v2\//, '');
    const { form, files } = await readBody(req);
    fake.calls.push({ method: req.method ?? 'GET', path, form: { ...Object.fromEntries(url.searchParams), ...form }, files: files.map((file) => file.name) });
    const send = (status: number, body: string | object) => {
      const json = typeof body === 'object';
      res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=UTF-8' });
      res.end(json ? JSON.stringify(body) : body);
    };
    if (fake.httpStatus) return send(fake.httpStatus, 'Error');
    // calls.json: loginOk (204, QBT_SID_<port>), loginWrongPassword (401), noCookie and staleSid (403).
    if (path === 'auth/login') {
      if (form.username !== credentials.username || form.password !== credentials.password) return send(401, 'Unauthorized');
      const sid = `sid${nextSid++}`;
      sessions.add(sid);
      res.writeHead(204, { 'set-cookie': `QBT_SID_8080=${sid}; HttpOnly; SameSite=Lax; path=/` });
      return void res.end();
    }
    const sid = /(?:^|;\s*)QBT_SID_8080=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid || !sessions.has(sid)) return send(403, 'Forbidden');
    const params = { ...Object.fromEntries(url.searchParams), ...form };
    const hashes = (value: string | undefined) => (value === 'all' ? listed().map((t) => t.hash) : (value ?? '').split('|').filter(Boolean));

    switch (path) {
      case 'app/version':
        return send(200, fake.version);
      case 'app/preferences':
        return send(200, fake.preferences);
      case 'app/setPreferences':
        Object.assign(fake.preferences, JSON.parse(params.json ?? '{}'));
        return send(200, '');
      case 'transfer/info':
        return send(200, { connection_status: fake.connectionStatus, dl_info_speed: 0, up_info_speed: 0 });
      case 'torrents/categories':
        return send(200, fake.categories);
      case 'torrents/createCategory':
        if (fake.categories[params.category!]) return send(409, 'Category already exists');
        fake.categories[params.category!] = { name: params.category!, savePath: params.savePath ?? '' };
        return send(200, '');
      case 'torrents/editCategory':
        if (!fake.categories[params.category!]) return send(404, 'Category does not exist');
        fake.categories[params.category!] = { name: params.category!, savePath: params.savePath ?? '' };
        return send(200, '');
      case 'torrents/info': {
        let list = listed().filter((t) => !fake.hiddenOnce.delete(t.hash));
        if (params.hashes) list = list.filter((t) => hashes(params.hashes).includes(t.hash));
        if (params.category !== undefined) list = list.filter((t) => t.category === params.category);
        if (params.tag !== undefined) list = list.filter((t) => tagsOf(t).includes(params.tag!));
        return send(200, list);
      }
      case 'torrents/trackers': {
        const torrent = listed().find((t) => t.hash === params.hash);
        return torrent ? send(200, torrent.trackers ?? []) : send(404, 'Not Found');
      }
      case 'torrents/add': {
        const added: FakeTorrent[] = [];
        const add = (hash: string, name: string) =>
          added.push({
            hash,
            name,
            state: 'metaDL',
            progress: 0,
            downloaded: 0,
            ratio: 0,
            seeding_time: 0,
            category: params.category ?? '',
            tags: params.tags ?? '',
            save_path: fake.categories[params.category ?? '']?.savePath ?? String(fake.preferences.save_path),
            content_path: '',
            root_path: '',
            // `null` until the metadata arrives (torrents-info-metaDL.json).
            private: null,
            ratio_limit: Number(params.ratioLimit ?? -2),
            seeding_time_limit: Number(params.seedingTimeLimit ?? -2),
            inactive_seeding_time_limit: Number(params.inactiveSeedingTimeLimit ?? -2),
          });
        // calls.json: addFile/addMagnet (200, JSON), addFileNotATorrent (415), addFileDuplicate,
        // addMagnetDuplicate, addMagnetNoHash and addNothing (409 Conflict).
        for (const file of files) {
          const hash = fakeHashes.get(file.bytes.toString('latin1'));
          if (!hash) return send(415, `Error: '${file.name}' is not a valid torrent file.`);
          add(hash, 'torrent');
        }
        for (const uri of (params.urls ?? '').split('\n').filter(Boolean)) {
          const hash = /xt=urn:btih:([0-9a-f]{40})/i.exec(uri)?.[1]?.toLowerCase();
          if (!hash) return send(409, 'Conflict');
          add(hash, hash);
        }
        if (added.length === 0 || added.some((torrent) => listed().some((t) => t.hash === torrent.hash))) return send(409, 'Conflict');
        for (const torrent of added) {
          if (fake.listDelayMs > 0) pending.push({ torrent, at: Date.now() + fake.listDelayMs });
          else fake.torrents.push(torrent);
        }
        return send(200, { added_torrent_ids: added.map((torrent) => torrent.hash), failure_count: 0, pending_count: 0, success_count: added.length });
      }
      case 'torrents/addTags':
      case 'torrents/removeTags': {
        const changed = (params.tags ?? '').split(',').filter(Boolean);
        for (const torrent of listed().filter((t) => hashes(params.hashes).includes(t.hash))) {
          const tags = new Set(tagsOf(torrent));
          for (const tag of changed) {
            if (path === 'torrents/addTags') tags.add(tag);
            else tags.delete(tag);
          }
          torrent.tags = [...tags].sort().join(', ');
        }
        return send(200, '');
      }
      case 'torrents/delete': {
        const gone = hashes(params.hashes);
        fake.torrents = listed().filter((t) => !gone.includes(t.hash));
        deleted.push(...gone.map((hash) => ({ hash, deleteFiles: params.deleteFiles === 'true' })));
        return send(200, '');
      }
      default:
        return send(404, 'Not Found');
    }
  });

  /** The hash qBittorrent computes for a .torrent body, registered by the test that uploads it. */
  const fakeHashes = new Map<string, string>();
  const deleted: { hash: string; deleteFiles: boolean }[] = [];

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    knowTorrent: (bytes: Uint8Array, hash: string) => void fakeHashes.set(Buffer.from(bytes).toString('latin1'), hash),
    deleted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
