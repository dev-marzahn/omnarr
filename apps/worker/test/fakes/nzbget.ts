// An in-process fake of NZBGet's JSON-RPC API (POST /jsonrpc, HTTP basic
// auth), behaving as the real NZBGet 26.3 did when the fixtures were recorded
// (test/fixtures/nzbget/README.md).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NzbgetGroup, NzbgetHistoryEntry } from '../../src/clients/nzbget.ts';
import type { NzbgetOption } from '../../src/clients/nzbgetConfig.ts';
import { nzbgetFixture, queueEntry } from '../fixtures/nzbget/load.ts';

export type RpcCall = { method: string; params: unknown[] };

export type FakeNzbget = {
  /** The base URL, as the platform stores it. */
  url: string;
  calls: RpcCall[];
  /** `Content` is the decoded NZB an `append` uploaded. */
  queue: (NzbgetGroup & { Content?: string })[];
  history: NzbgetHistoryEntry[];
  /** The config file `loadconfig` reads and `saveconfig` replaces; it starts as the setup container leaves it. */
  config: NzbgetOption[];
  /** How many times `reload` ran. */
  reloads: number;
  /** After a `reload`, every call fails as a restarting NZBGet does, for this long. */
  reloadDownMs: number;
  /** What `testserver` answers; NZBGet 26.3 answers "" for a login that worked. */
  testServerResult: string;
  /** What `append` returns instead of a new NZBID, when set. */
  appendResult?: number;
  /** Every call answers with this HTTP status, when set. */
  httpStatus?: number;
  /** Every call answers 200 with this body, when set. */
  rawBody?: string;
  /** JSON-RPC errors to answer per method. */
  rpcErrors?: Record<string, { code: number; message: string }>;
  /** Every answer waits this long. */
  delayMs?: number;
  /** `servervolumes`' per-server traffic: bytes per UTC day from `firstDay` (days since the epoch), by ServerID. */
  volumes: Record<number, { firstDay: number; days: number[] }>;
  /** `editserver`'s run-time Active per ServerID; a `reload` clears it, back to the config's `ServerN.Active`. */
  serverActive: Map<number, boolean>;
  close(): Promise<void>;
};

/** The ServerIDs the config defines, as NZBGet numbers them. */
const configuredServers = (config: NzbgetOption[]) =>
  [...new Set(config.flatMap((option) => /^Server(\d+)\.Host$/.exec(option.Name)?.[1] ?? []).map(Number))].sort((a, b) => a - b);

/** NZBGet's 64-bit counter as SizeLo, SizeHi and SizeMB. */
const size = (bytes: number) => ({ SizeLo: bytes % 2 ** 32, SizeHi: Math.floor(bytes / 2 ** 32), SizeMB: Math.floor(bytes / 2 ** 20) });

const RPC_ERRORS = { procedure: { code: 1, message: 'Invalid procedure' }, action: { code: 3, message: 'Invalid action' } };

export async function startFakeNzbget(credentials: { username: string; password: string }): Promise<FakeNzbget> {
  let nextId = 1;
  let downUntil = 0;
  // An NZBGet that has run for an hour.
  let startedAt = Date.now() - 3_600_000;
  const template = queueEntry('grab-slownzb');
  const expectedAuth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;

  const fake: Omit<FakeNzbget, 'url' | 'close'> = {
    calls: [],
    queue: [],
    history: [],
    config: nzbgetFixture<NzbgetOption>('loadconfig'),
    reloads: 0,
    // NZBGet 26.3's port refused for a few hundred ms during a reload (fixtures README).
    reloadDownMs: 20,
    testServerResult: '',
    volumes: {},
    serverActive: new Map(),
  };
  const activeOf = (id: number) => fake.serverActive.get(id) ?? fake.config.find((option) => option.Name === `Server${id}.Active`)?.Value !== 'no';

  // NZBGet reads each member of each PPParameters struct as one parameter.
  const parameters = (pp: unknown): NzbgetGroup['Parameters'] =>
    (Array.isArray(pp) ? pp : []).flatMap((struct: Record<string, string>) => Object.entries(struct).map(([Name, Value]) => ({ Name, Value: String(Value) })));

  const methods: Record<string, (params: unknown[]) => unknown> = {
    version: () => '26.3',
    // Only the fields the adapter reads; UpTimeSec starts again at 0 when NZBGet restarts.
    status: () => ({
      UpTimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      NewsServers: configuredServers(fake.config).map((ID) => ({ ID, Active: activeOf(ID) })),
    }),
    // Entry 0 is every server's total, as NZBGet 26.3 answers; the adapter reads only BytesPerDays.
    servervolumes: () => {
      const ids = configuredServers(fake.config);
      const entry = (ServerID: number, volume: { firstDay: number; days: number[] }) => ({
        ServerID,
        FirstDay: volume.firstDay,
        DaySlot: volume.days.length - 1,
        BytesPerDays: volume.days.map(size),
      });
      const today = Math.floor(Date.now() / 86_400_000);
      return [0, ...ids].map((id) => entry(id, fake.volumes[id] ?? { firstDay: today, days: [0] }));
    },
    // editserver(ServerID, Active): run time only, the config file stays; false for an ID NZBGet doesn't have.
    editserver: ([id, active]) => {
      if (!configuredServers(fake.config).includes(Number(id))) return false;
      fake.serverActive.set(Number(id), Boolean(active));
      return true;
    },
    append: ([name, content, category, , , paused, , , , pp]) => {
      if (fake.appendResult !== undefined) return fake.appendResult;
      const id = nextId++;
      fake.queue.push({
        ...template,
        NZBID: id,
        Kind: 'NZB',
        NZBFilename: String(name),
        NZBName: String(name).replace(/\.nzb$/, ''),
        Content: Buffer.from(String(content), 'base64').toString('utf8'),
        Status: paused ? 'PAUSED' : 'QUEUED',
        Category: String(category),
        DestDir: '',
        Parameters: parameters(pp),
      } as NzbgetGroup & { Content: string });
      return id;
    },
    listgroups: () => fake.queue,
    history: () => fake.history,
    loadconfig: () => fake.config.map((option) => ({ ...option })),
    saveconfig: ([options]) => {
      fake.config = (options as NzbgetOption[]).map((option) => ({ ...option }));
      return true;
    },
    reload: () => {
      fake.reloads += 1;
      fake.serverActive.clear();
      downUntil = Date.now() + fake.reloadDownMs;
      startedAt = downUntil;
      return true;
    },
    testserver: () => fake.testServerResult,
    editqueue: ([command, , ids]) => {
      const [id] = ids as number[];
      const inQueue = fake.queue.findIndex((g) => g.NZBID === id);
      const inHistory = fake.history.findIndex((h) => h.NZBID === id);
      switch (command) {
        case 'GroupFinalDelete':
          if (inQueue < 0) return false;
          fake.queue.splice(inQueue, 1);
          return true;
        case 'GroupParkDelete': {
          if (inQueue < 0) return false;
          const [group] = fake.queue.splice(inQueue, 1);
          fake.history.unshift({ ...group!, Status: 'DELETED/MANUAL', DeleteStatus: 'MANUAL', FinalDir: '' });
          return true;
        }
        case 'HistoryFinalDelete':
          if (inHistory < 0) return false;
          fake.history.splice(inHistory, 1);
          return true;
        default:
          throw RPC_ERRORS.action;
      }
    },
  };

  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as { method: string; params: unknown[]; id: number };
    if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    // A restarting NZBGet drops the connection.
    if (Date.now() < downUntil) return void res.destroy();
    if (fake.httpStatus) return void res.writeHead(fake.httpStatus).end();
    if (fake.rawBody) return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(fake.rawBody);
    if (req.method !== 'POST' || req.url !== '/jsonrpc') return void res.writeHead(404).end();
    if (req.headers.authorization !== expectedAuth) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NZBGet"' }).end();
    fake.calls.push({ method: body.method, params: body.params });
    const reply = (payload: object) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: '1.1', id: body.id, ...payload }));
    const method = methods[body.method];
    if (!method) return void reply({ error: { name: 'JSONRPCError', ...RPC_ERRORS.procedure } });
    const planted = fake.rpcErrors?.[body.method];
    if (planted) return void reply({ error: { name: 'JSONRPCError', ...planted } });
    try {
      reply({ result: method(body.params) });
    } catch (error) {
      reply({ error: { name: 'JSONRPCError', ...(error as object) } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

async function read(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}
