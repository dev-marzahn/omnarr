// A run blocked on `awaitEvent` survives an upgrade: release
// 1 starts it, release 2 (a new step before the wait, with its migration) is
// deployed over it, the event is sent, and the run resumes and completes on
// release 2's code, with the migration's stand-in for the step it never ran.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import { startBackend, type Backend } from '../scripts/backend.ts';
import { PROJECT } from './host.ts';

const APPS = join(import.meta.dirname, 'apps');
let backend: Backend;

function convex(release: 'upgrade-v1' | 'upgrade-v2', args: string[]): string {
  const cwd = join(APPS, release);
  const result = spawnSync(join(cwd, 'node_modules/.bin/convex'), args, { cwd, env: backend.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`convex ${args.join(' ')} (${release}) failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const deploy = (release: 'upgrade-v1' | 'upgrade-v2') => convex(release, ['deploy', '--typecheck', 'disable', '--yes']);
const call = (release: 'upgrade-v1' | 'upgrade-v2', fn: string, args: object = {}) => JSON.parse(convex(release, ['run', fn, JSON.stringify(args)]) || 'null');

beforeAll(async () => {
  // Named per E2E_PROJECT, as stack.ts's compose project is, so two checkouts' runs don't remove each other's backend.
  backend = await startBackend(`${PROJECT}-upgrade`);
}, 180_000);
afterAll(() => backend?.stop());

test('a run waiting on an event across a release with a new step and its migration resumes and completes on the new code', async () => {
  deploy('upgrade-v1');
  const workflowId = call('upgrade-v1', 'run:start') as string;
  // Let the run reach its wait.
  for (let i = 0; i < 50 && (await sleep(200), true); i++) {
    const steps = convex('upgrade-v1', ['data', '--component', 'workflow', 'steps', '--format', 'jsonLines']);
    if (steps.includes('"go"')) break;
  }
  expect(call('upgrade-v1', 'run:status', { workflowId })).toMatchObject({ type: 'inProgress' });

  deploy('upgrade-v2');
  call('upgrade-v2', 'run:send', { workflowId });

  let status: { type: string; result?: unknown } = { type: 'inProgress' };
  for (let i = 0; i < 100 && status.type === 'inProgress'; i++) {
    await sleep(300);
    status = call('upgrade-v2', 'run:status', { workflowId });
  }
  expect(status).toEqual({
    type: 'completed',
    // `first` ran on release 1; `last` ran on release 2 and got the stand-in's `at: null`.
    result: { started: { release: 1 }, ended: { release: 2, notifiedAt: null } },
  });
}, 240_000);
