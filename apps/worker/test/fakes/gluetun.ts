// An in-process fake of gluetun's control server and health server, as
// v3.41.3 answered when it was tried by hand: the
// three routes of the worker's role with `X-API-Key`, 401 without the key or
// for any other route, and the health server's plain `GET /` (200, or 500 with
// the error). The state is scripted by the test.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeGluetun = {
  url: string;
  /** Every request: method, path, and whether it carried the right key. */
  calls: { method: string; path: string; keyed: boolean }[];
  status: string;
  healthy: boolean;
  publicIp: string;
  port: number;
  /** Requests are held this long before an answer. */
  delayMs: number;
  close(): Promise<void>;
};

const ROUTES = new Set(['GET /v1/vpn/status', 'GET /v1/publicip/ip', 'GET /v1/portforward']);

export async function startFakeGluetun(apiKey: string): Promise<FakeGluetun> {
  const fake: Omit<FakeGluetun, 'url' | 'close'> = { calls: [], status: 'running', healthy: true, publicIp: '', port: 0, delayMs: 0 };
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const keyed = req.headers['x-api-key'] === apiKey;
    fake.calls.push({ method: req.method ?? 'GET', path, keyed });
    if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    if (res.destroyed) return;
    if (path === '/') {
      if (fake.healthy) res.writeHead(200).end();
      else res.writeHead(500, { 'content-type': 'text/plain' }).end('startup check: all check tries failed: dialing: i/o timeout\n');
      return;
    }
    if (!keyed || !ROUTES.has(`${req.method} ${path}`)) return void res.writeHead(401).end('Unauthorized\n');
    const body =
      path === '/v1/vpn/status'
        ? { status: fake.status }
        : path === '/v1/publicip/ip'
          ? { public_ip: fake.publicIp }
          : { port: fake.port, ports: fake.port > 0 ? [fake.port] : [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
