// The backend image's hooks against a fake admin API.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

import { runHook } from '../../image/hooks.ts';

const KEY = 'planted-admin-key';
const PLANTED = { workerToken: 'planted-worker-token', authSecret: 'planted-auth-secret', setupPassword: 'planted-setup-password' };

type Call = { path: string; body: unknown; auth: string | undefined };
let server: Server;
let url: string;
let calls: Call[];
let variables: Record<string, string>;
let secretsDir: string;

beforeEach(async () => {
  calls = [];
  variables = {};
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => {
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      calls.push({ path: req.url!, body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/query' && body?.path === '_system/cli/queryEnvironmentVariables') {
        res.end(JSON.stringify({ status: 'success', value: Object.entries(variables).map(([name, value]) => ({ name, value })) }));
      } else if (req.url === '/api/update_environment_variables') {
        for (const { name, value } of (body as { changes: { name: string; value: string | null }[] }).changes) {
          if (value === null) delete variables[name];
          else variables[name] = value;
        }
        res.end('{}');
      } else if (req.url === '/api/function') {
        res.end(JSON.stringify({ status: 'success', value: [] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  secretsDir = mkdtempSync(join(tmpdir(), 'omnarr-backend-secrets-'));
  writeFileSync(join(secretsDir, 'worker_token'), `${PLANTED.workerToken}\n`);
  writeFileSync(join(secretsDir, 'better_auth_secret'), PLANTED.authSecret);
  writeFileSync(join(secretsDir, 'setup_password'), PLANTED.setupPassword);
});
afterEach(() => {
  server.close();
  rmSync(secretsDir, { recursive: true, force: true });
});

const run = async (name: string, env: Record<string, string> = {}) => {
  const lines: string[] = [];
  const code = await runHook(name, {
    env: { CONVEX_URL: url, CONVEX_ADMIN_KEY: KEY, ...env },
    secretsDir,
    tmdbTokenFile: join(secretsDir, 'no-such-token'),
    log: (line) => lines.push(line),
  });
  return { code, output: lines.join('\n') };
};
const writes = () => calls.filter((call) => call.path === '/api/update_environment_variables');

test('pre-push writes the variables with the admin key, then nothing on a second run', async () => {
  expect((await run('pre-push')).code).toBe(0);
  expect(variables).toMatchObject({ WORKER_TOKEN: PLANTED.workerToken, BETTER_AUTH_SECRET: PLANTED.authSecret, WEB_PORT: '3000', UPDATE_CHECK: 'on' });
  expect(calls.every((call) => call.auth === `Convex ${KEY}`)).toBe(true);
  calls = [];
  expect((await run('pre-push')).code).toBe(0);
  expect(writes()).toEqual([]);
});

test('pre-push writes only the variables that differ, and removes a managed one now unset', async () => {
  await run('pre-push', {
    OMNARR_WEB_URL: 'https://a.example.net',
    OMNARR_CONVEX_URL: 'https://b.example.net',
    OMNARR_CONVEX_SITE_URL: 'https://c.example.net',
  });
  variables.TMDB_API_URL = 'http://tmdb:8000';
  calls = [];
  await run('pre-push', { OMNARR_UPDATE_CHECK: 'off' });
  expect(writes().map((call) => call.body)).toEqual([
    {
      changes: [
        { name: 'UPDATE_CHECK', value: 'off' },
        { name: 'SITE_URL', value: null },
      ],
    },
  ]);
  expect(variables.TMDB_API_URL).toBe('http://tmdb:8000');
});

test('a validation failure writes nothing, exits 1, and names the variable but no secret', async () => {
  const { code, output } = await run('pre-push', {
    OMNARR_CONVEX_URL: `https://${PLANTED.setupPassword}.example.net/path`,
    OMNARR_SETUP_PASSWORD: 'chosen-planted',
  });
  expect(code).toBe(1);
  expect(writes()).toEqual([]);
  expect(output).toContain('[omnarr] pre-push failed: OMNARR_CONVEX_URL is not an http(s) URL without a path');
  for (const secret of [...Object.values(PLANTED), KEY, 'chosen-planted']) expect(output).not.toContain(secret);
});

test('post-apply runs the reference seeds', async () => {
  expect((await run('post-apply')).code).toBe(0);
  expect(calls.map((call) => call.body)).toEqual([{ path: 'seeds/_reference:apply', format: 'json', args: {} }]);
});

test('an unknown hook exits 1', async () => {
  expect((await run('later')).code).toBe(1);
});
