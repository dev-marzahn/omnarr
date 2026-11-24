// An in-process fake of the Jellyfin 12.4 endpoints the worker calls: the
// unauthenticated wizard until it completes, the admin sign-in, API keys,
// libraries, item refreshes and listings, the password route, and the
// clients' sessions the play poller reads. Its
// answers take their shapes from fixtures/jellyfin/, recorded from a real
// 12.4 container; its status codes are the ones that container gave
// (fixtures/jellyfin/README.md). Like 12.x it accepts only the
// `Authorization: MediaBrowser …` header.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/jellyfin/${name}.json`, import.meta.url), 'utf8')) as T;
const id = () => randomUUID().replaceAll('-', '');

/** A file's item type: an episode, a movie, or a plain video. */
export type FileType = 'Episode' | 'Movie' | 'Video';
/** The season and episode Jellyfin read from an episode's path: by default its `SxxEyy`, else none. */
export type Numbers = {
  season?: number;
  episode?: number;
  episodeEnd?: number;
  /** Listings that show the episode without its numbers first, as 12.4 did for a new file (recorded in the scan e2e). */
  afterPolls?: number;
};
export type FakeItem = {
  Id: string;
  Name: string;
  Type: 'Series' | FileType;
  Path: string;
  ParentId: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  IndexNumberEnd?: number;
  /** Listings left before the numbers show. */
  unnumberedPolls?: number;
};
export type FakeFolder = { Name: string; ItemId: string; Locations: string[]; CollectionType: string; LibraryOptions: Record<string, unknown> };
export type FakeRequest = { method: string; path: string; query: URLSearchParams; authorization?: string; body?: unknown; legacyAuth: boolean };
/** A client's session as `GET /Sessions` lists it; `playing` is what it reported through `POST /Sessions/Playing`. */
export type FakeSession = {
  userId: string;
  deviceId: string;
  deviceName: string;
  client: string;
  /**
   * `transcodeReasons` gives the session a `TranscodingInfo`; `copied` sets its
   * `IsVideoDirect` and `IsAudioDirect` (the recording's: video copied, audio not).
   */
  playing?: { itemId: string; playMethod: string; transcodeReasons?: string[]; copied?: { video: boolean; audio: boolean } };
};

export type FakeJellyfin = {
  url: string;
  /** Every request, authorized or not. */
  requests: FakeRequest[];
  serverId: string;
  version: string;
  wizardCompleted: boolean;
  admin: { id: string; name: string; password: string } | undefined;
  keys: { AccessToken: string; AppName: string; DateCreated: string }[];
  sessionTokens: Set<string>;
  folders: FakeFolder[];
  serverConfiguration: Record<string, unknown>;
  brandingConfiguration: Record<string, unknown>;
  /** What Jellyfin has indexed and lists. */
  items: FakeItem[];
  /**
   * Files on disk Jellyfin hasn't indexed yet: a refresh of a scope that
   * holds one indexes it after `afterPolls` listings (0: at once).
   */
  onDisk: { path: string; type: FileType; afterPolls: number; numbers?: Numbers }[];
  /** The clients' sessions `GET /Sessions` lists; the API key's calls make none (recorded). */
  sessions: FakeSession[];
  /** `METHOD /path` → status, answered before anything else. */
  failures: Map<string, number>;
  /** Every answer waits this long. */
  delayMs: number;
  /** Adds a library folder as setup would. */
  addFolder(name: string, collectionType: 'tvshows' | 'movies', path: string): FakeFolder;
  /** Indexes a file at once, under its series (created if needed) or its library. */
  index(path: string, type: FileType, numbers?: Numbers): FakeItem;
  /** Puts a file on disk; Jellyfin indexes it on the next refresh of its scope. */
  addOnDisk(path: string, type: FileType, afterPolls?: number, numbers?: Numbers): void;
  close(): Promise<void>;
};

const SETUP_CLIENT = /^MediaBrowser Client="[^"]+", Device="[^"]+", DeviceId="[^"]+", Version="[^"]+"$/;

export async function startFakeJellyfin(): Promise<FakeJellyfin> {
  const publicInfo = fixture<Record<string, unknown>>('system-info-public');
  const fake: Omit<FakeJellyfin, 'url' | 'close'> = {
    requests: [],
    serverId: id(),
    version: publicInfo.Version as string,
    wizardCompleted: false,
    admin: undefined,
    keys: [],
    sessionTokens: new Set(),
    folders: [],
    serverConfiguration: fixture('system-configuration'),
    brandingConfiguration: fixture('branding-configuration'),
    items: [],
    onDisk: [],
    sessions: [],
    failures: new Map(),
    delayMs: 0,
    addFolder(name, collectionType, path) {
      const folder: FakeFolder = {
        ...fixture<FakeFolder[]>('virtualfolders')[0]!,
        Name: name,
        ItemId: id(),
        Locations: [path],
        CollectionType: collectionType,
      };
      fake.folders.push(folder);
      return folder;
    },
    index(path, type, numbers) {
      const folder = fake.folders.find((f) => f.Locations.some((root) => path.startsWith(`${root}/`)));
      if (!folder) throw new Error(`no library holds ${path}`);
      let parentId = folder.ItemId;
      let read: FakeItem | Record<string, never> = {};
      if (type === 'Episode') {
        const named = /S(\d+)E(\d+)/i.exec(path.split('/').at(-1)!);
        const { season, episode, episodeEnd, afterPolls } = numbers ?? (named ? { season: Number(named[1]), episode: Number(named[2]) } : {});
        read = {
          ...(season === undefined ? {} : { ParentIndexNumber: season }),
          ...(episode === undefined ? {} : { IndexNumber: episode }),
          ...(episodeEnd === undefined ? {} : { IndexNumberEnd: episodeEnd }),
          ...(afterPolls === undefined ? {} : { unnumberedPolls: afterPolls }),
        } as FakeItem;
        const seriesPath = seriesFolder(folder, path);
        let series = fake.items.find((item) => item.Type === 'Series' && item.Path === seriesPath);
        if (!series) {
          series = { Id: id(), Name: seriesPath.split('/').at(-1)!, Type: 'Series', Path: seriesPath, ParentId: folder.ItemId };
          fake.items.push(series);
        }
        parentId = series.Id;
      }
      const item: FakeItem = { ...read, Id: id(), Name: path.split('/').at(-1)!, Type: type, Path: path, ParentId: parentId };
      fake.items.push(item);
      return item;
    },
    addOnDisk(path, type, afterPolls = 0, numbers) {
      fake.onDisk.push({ path, type, afterPolls, ...(numbers ? { numbers } : {}) });
    },
  };

  const seriesFolder = (folder: FakeFolder, path: string) => {
    const root = folder.Locations.find((r) => path.startsWith(`${r}/`))!;
    return `${root}/${path.slice(root.length + 1).split('/')[0]}`;
  };

  /** Files whose refresh has run, indexed once their polls are counted down. */
  let scheduled: { path: string; type: FileType; polls: number; numbers?: Numbers }[] = [];
  const schedule = ({ path, type, afterPolls, numbers }: FakeJellyfin['onDisk'][number]) => ({
    path,
    type,
    polls: afterPolls,
    ...(numbers ? { numbers } : {}),
  });

  const refreshScope = (itemId: string) => {
    const folder = fake.folders.find((f) => f.ItemId === itemId);
    const series = fake.items.find((item) => item.Id === itemId && item.Type === 'Series');
    // 12.4: a library-item refresh never indexes the first content of a library created empty (README, recorded).
    if (folder && !fake.items.some((item) => item.ParentId === folder.ItemId)) return;
    const inScope = ({ path }: { path: string }) =>
      folder ? folder.Locations.some((root) => path.startsWith(`${root}/`)) : series ? path.startsWith(`${series.Path}/`) : false;
    scheduled.push(...fake.onDisk.filter(inScope).map(schedule));
    fake.onDisk = fake.onDisk.filter((entry) => !inScope(entry));
    settle();
  };

  const settle = () => {
    for (const entry of scheduled.filter((e) => e.polls <= 0)) fake.index(entry.path, entry.type, entry.numbers);
    scheduled = scheduled.filter((e) => e.polls > 0);
  };

  /**
   * A session in the recorded shape (sessions-playing.json): the transcoding
   * one carries `TranscodingInfo`, the direct play doesn't, and a session
   * that stopped keeps no `NowPlayingItem` and no `PlayMethod`.
   */
  const recordedSessions = fixture<Record<string, unknown>[]>('sessions-playing');
  const listedSession = ({ userId, deviceId, deviceName, client, playing }: FakeSession) => {
    const [transcoding, direct] = recordedSessions as [Record<string, Record<string, unknown>>, Record<string, Record<string, unknown>>];
    const { NowPlayingItem: _item, TranscodingInfo: _info, PlayState: recordedState, ...session } = direct;
    const base = { ...session, UserId: userId, DeviceId: deviceId, DeviceName: deviceName, Client: client, ServerId: fake.serverId };
    if (!playing) return { ...base, PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' } };
    return {
      ...base,
      PlayState: { ...recordedState, MediaSourceId: playing.itemId, PlayMethod: playing.playMethod },
      NowPlayingItem: { ...direct.NowPlayingItem, ServerId: fake.serverId, Id: playing.itemId },
      ...(playing.transcodeReasons
        ? {
            TranscodingInfo: {
              ...transcoding.TranscodingInfo,
              ...(playing.copied && { IsVideoDirect: playing.copied.video, IsAudioDirect: playing.copied.audio }),
              TranscodeReasons: playing.transcodeReasons,
            },
          }
        : {}),
    };
  };

  const authorized = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? '';
    const token = /Token="([^"]+)"/.exec(header)?.[1];
    if (!header.startsWith('MediaBrowser ') || !token) return undefined;
    if (fake.keys.some((key) => key.AccessToken === token)) return { kind: 'key' as const, token };
    if (fake.sessionTokens.has(token)) return { kind: 'session' as const, token };
    return undefined;
  };

  const json = (res: ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const empty = (res: ServerResponse, status: number) => void res.writeHead(status).end(status >= 400 ? 'pl4nted server error text' : undefined);

  const server: Server = createServer(async (req, res) => {
    const text = await read(req);
    const url = new URL(req.url!, 'http://jellyfin');
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const legacyAuth = Boolean(
      req.headers['x-emby-authorization'] || req.headers['x-emby-token'] || req.headers['x-mediabrowser-token'] || url.searchParams.has('api_key'),
    );
    fake.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, authorization: req.headers.authorization, body, legacyAuth });
    if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    const route = `${req.method} ${url.pathname}`;
    const failure = fake.failures.get(route) ?? fake.failures.get(route.replace(/\/Items\/[0-9a-f]+\//, '/Items/:id/'));
    if (failure) return empty(res, failure);

    // Unauthenticated: the public info, and the wizard until it completes.
    if (route === 'GET /System/Info/Public')
      return json(res, 200, { ...publicInfo, Id: fake.serverId, Version: fake.version, StartupWizardCompleted: fake.wizardCompleted });
    if (url.pathname.startsWith('/Startup/')) {
      if (fake.wizardCompleted) return empty(res, 401);
      if (route === 'POST /Startup/Configuration' || route === 'POST /Startup/RemoteAccess') return empty(res, 204);
      if (route === 'GET /Startup/User') {
        // The wizard creates its user on the first read.
        fake.admin ??= { id: id(), name: 'root', password: '' };
        return json(res, 200, { Name: fake.admin.name });
      }
      if (route === 'POST /Startup/User') {
        if (!fake.admin) return empty(res, 500);
        const { Name, Password } = body as { Name: string; Password: string };
        Object.assign(fake.admin, { name: Name, password: Password });
        return empty(res, 204);
      }
      if (route === 'POST /Startup/Complete') {
        fake.wizardCompleted = true;
        return empty(res, 204);
      }
      return empty(res, 404);
    }
    if (route === 'POST /Users/AuthenticateByName') {
      // 12.x answers 400 to the legacy header (spike).
      if (req.headers['x-emby-authorization']) return empty(res, 400);
      if (!SETUP_CLIENT.test(req.headers.authorization ?? '')) return empty(res, 400);
      const { Username, Pw } = body as { Username: string; Pw: string };
      if (!fake.admin || !fake.wizardCompleted || Username !== fake.admin.name || Pw !== fake.admin.password) return empty(res, 401);
      const token = id();
      fake.sessionTokens.add(token);
      const answer = fixture<{ User: Record<string, unknown> }>('authenticate');
      return json(res, 200, {
        ...answer,
        User: { ...answer.User, Id: fake.admin.id, Name: fake.admin.name, ServerId: fake.serverId },
        AccessToken: token,
        ServerId: fake.serverId,
      });
    }

    const caller = authorized(req);
    if (!caller || legacyAuth) return empty(res, 401);

    if (route === 'GET /System/Info') return json(res, 200, { ...fixture<Record<string, unknown>>('system-info'), Id: fake.serverId, Version: fake.version });
    if (route === 'POST /Auth/Keys') {
      if (caller.kind !== 'session') return empty(res, 403);
      fake.keys.push({ AccessToken: id(), AppName: url.searchParams.get('app') ?? '', DateCreated: new Date(Date.now() + fake.keys.length).toISOString() });
      return empty(res, 204);
    }
    if (route === 'GET /Auth/Keys') {
      const template = fixture<{ Items: Record<string, unknown>[] }>('auth-keys-get').Items[0]!;
      return json(res, 200, { Items: fake.keys.map((key, i) => ({ ...template, Id: i, ...key })), TotalRecordCount: fake.keys.length, StartIndex: 0 });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/Auth/Keys/')) {
      const token = url.pathname.split('/').at(-1);
      fake.keys = fake.keys.filter((key) => key.AccessToken !== token);
      return empty(res, 204);
    }
    if (route === 'POST /Sessions/Logout') {
      fake.sessionTokens.delete(caller.token);
      return empty(res, 204);
    }
    if (route === 'GET /System/Configuration') return json(res, 200, fake.serverConfiguration);
    if (route === 'POST /System/Configuration') {
      fake.serverConfiguration = body as Record<string, unknown>;
      return empty(res, 204);
    }
    if (route === 'GET /System/Configuration/branding') return json(res, 200, fake.brandingConfiguration);
    if (route === 'POST /System/Configuration/branding') {
      fake.brandingConfiguration = body as Record<string, unknown>;
      return empty(res, 204);
    }
    if (route === 'GET /Library/VirtualFolders') return json(res, 200, fake.folders);
    if (route === 'POST /Library/VirtualFolders') {
      const name = url.searchParams.get('name')!;
      const folder = fake.addFolder(name, url.searchParams.get('collectionType') as 'tvshows' | 'movies', url.searchParams.get('paths')!);
      folder.LibraryOptions = (body as { LibraryOptions?: Record<string, unknown> } | undefined)?.LibraryOptions ?? {};
      return empty(res, 204);
    }
    if (route === 'POST /Library/Refresh') {
      for (const folder of fake.folders) {
        const inLibrary = ({ path }: { path: string }) => folder.Locations.some((root) => path.startsWith(`${root}/`));
        scheduled.push(...fake.onDisk.filter(inLibrary).map(schedule));
        fake.onDisk = fake.onDisk.filter((entry) => !inLibrary(entry));
      }
      settle();
      return empty(res, 204);
    }
    const refresh = /^\/Items\/([0-9a-f]+)\/Refresh$/.exec(url.pathname);
    if (req.method === 'POST' && refresh) {
      const itemId = refresh[1]!;
      if (!fake.folders.some((f) => f.ItemId === itemId) && !fake.items.some((item) => item.Id === itemId)) return empty(res, 404);
      refreshScope(itemId);
      return empty(res, 204);
    }
    if (route === 'GET /Items') {
      const parentId = url.searchParams.get('ParentId');
      const parent = parentId && (fake.folders.find((f) => f.ItemId === parentId) ?? fake.items.find((item) => item.Id === parentId));
      // 12.4 answers 400 to a listing under an unknown parent (recorded).
      if (parentId && !parent) return empty(res, 400);
      for (const entry of scheduled) entry.polls--;
      settle();
      const types = url.searchParams.get('IncludeItemTypes')?.split(',');
      const under = (item: FakeItem): boolean => !parentId || item.ParentId === parentId || fake.items.some((p) => p.Id === item.ParentId && under(p));
      const withPath = url.searchParams.get('Fields')?.split(',').includes('Path');
      // The recorded episode, without its Path unless `Fields=Path` asks for it. An episode carries its own
      // numbers and series, as 12.4 lists them without being asked; other items carry none.
      const {
        Path: _recorded,
        ParentIndexNumber: _season,
        IndexNumber: _episode,
        SeriesId: _series,
        ...template
      } = fixture<{ Items: Record<string, unknown>[] }>('items-episodes').Items[0]!;
      const items = fake.items
        .filter((item) => (!types || types.includes(item.Type)) && under(item))
        .map((item) => {
          const numbered = !item.unnumberedPolls;
          if (item.unnumberedPolls) item.unnumberedPolls--;
          return {
            ...template,
            ServerId: fake.serverId,
            Id: item.Id,
            Name: item.Name,
            Type: item.Type,
            ...(withPath ? { Path: item.Path } : {}),
            ...(item.Type === 'Episode' ? { SeriesId: item.ParentId } : {}),
            ...(!numbered || item.ParentIndexNumber === undefined ? {} : { ParentIndexNumber: item.ParentIndexNumber }),
            ...(!numbered || item.IndexNumber === undefined ? {} : { IndexNumber: item.IndexNumber }),
            ...(!numbered || item.IndexNumberEnd === undefined ? {} : { IndexNumberEnd: item.IndexNumberEnd }),
          };
        });
      return json(res, 200, { Items: items, TotalRecordCount: items.length, StartIndex: 0 });
    }
    if (route === 'POST /Users/Password') {
      if (!fake.admin || url.searchParams.get('userId') !== fake.admin.id) return empty(res, 404);
      fake.admin.password = (body as { NewPw: string }).NewPw;
      // Jellyfin signs the user out on every device (spike).
      fake.sessionTokens.clear();
      return empty(res, 204);
    }
    if (route === 'GET /Sessions') return json(res, 200, fake.sessions.map(listedSession));
    empty(res, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

async function read(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}
