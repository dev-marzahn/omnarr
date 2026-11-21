// Public API discipline: every public function in convex/
// is built from one of the wrappers (`__wrapped`) and declares a `returns`
// validator, and no returned shape has a field that names a secret, except
// the worker calls that carry secrets to the worker by design.
import { describe, expect, test } from 'vite-plus/test';

import { modules } from './setup';

type Registered = {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  __wrapped?: string;
  exportReturns?: () => string | null;
};

/** Every public Convex function, by its path (`api/issues:list`). */
async function publicFunctions(): Promise<[string, Registered][]> {
  const found: [string, Registered][] = [];
  for (const [file, load] of Object.entries(modules)) {
    // Generated code and the app config, which only loads in the Convex runtime, define no function.
    if (file.includes('/_generated/') || file.endsWith('convex.config.ts')) continue;
    const module = (await load()) as Record<string, unknown>;
    const path = file.replace(/^\.\.\/convex\//, '').replace(/\.ts$/, '');
    for (const [name, value] of Object.entries(module)) {
      const fn = value as Registered;
      if (typeof fn !== 'function' && typeof fn !== 'object') continue;
      if (!fn || !(fn.isQuery || fn.isMutation || fn.isAction) || !fn.isPublic) continue;
      found.push([`${path}:${name}`, fn]);
    }
  }
  return found.sort(([a], [b]) => a.localeCompare(b));
}

/** Field names that hold a secret: keys, passwords, tokens, URLs that can carry an API key or passkey, and job payloads. */
const SECRET_FIELDS = new Set(['apiKey', 'downloadUrl', 'magnetUrl', 'password', 'newPassword', 'passkey', 'workerToken', 'privateKey', 'secret', 'payload']);

/**
 * Worker calls that hand secrets to the worker, which needs them: a leased
 * job's payload, the clients' desired config and Jellyfin's
 * API key.
 */
const CARRIES_SECRETS = new Set(['jobs/queue:claim', 'jobs/clients:desired', 'jellyfin/setup:connection']);

/** Every object field name in a Convex validator's JSON. */
function fieldNames(json: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(json)) for (const item of json) fieldNames(item, names);
  else if (json && typeof json === 'object') {
    const node = json as { type?: string; value?: unknown };
    if (node.type === 'object' && node.value && typeof node.value === 'object') for (const name of Object.keys(node.value)) names.add(name);
    for (const value of Object.values(node)) fieldNames(value, names);
  }
  return names;
}

describe('the public API', () => {
  test('every public function is built from a wrapper', async () => {
    const functions = await publicFunctions();
    expect(functions.length).toBeGreaterThan(50);
    const unwrapped = functions.filter(([, fn]) => !fn.__wrapped).map(([path]) => path);
    expect(unwrapped).toEqual([]);
  });

  test('only setup.state and setup.createAdmin run without a session or the worker token', async () => {
    const setupWrapped = (await publicFunctions()).filter(([, fn]) => fn.__wrapped?.startsWith('setup')).map(([path, fn]) => `${path} ${fn.__wrapped}`);
    expect(setupWrapped).toEqual(['api/setup:createAdmin setupAction', 'api/setup:state setupQuery']);
  });

  test('every public function declares a returns validator', async () => {
    const missing = (await publicFunctions()).filter(([, fn]) => !fn.exportReturns?.()).map(([path]) => path);
    expect(missing).toEqual([]);
  });

  test('no returned shape has a secret field, but the worker calls that carry them', async () => {
    const leaking = (await publicFunctions())
      .filter(([path]) => !CARRIES_SECRETS.has(path))
      .flatMap(([path, fn]) =>
        [...fieldNames(JSON.parse(fn.exportReturns!() ?? 'null'))].filter((name) => SECRET_FIELDS.has(name)).map((name) => `${path}: ${name}`),
      );
    expect(leaking).toEqual([]);
  });

  test('only worker functions carry secrets, and each still does', async () => {
    const functions = new Map(await publicFunctions());
    for (const path of CARRIES_SECRETS) {
      const fn = functions.get(path)!;
      expect(fn.__wrapped, path).toMatch(/^worker/);
      expect(
        [...fieldNames(JSON.parse(fn.exportReturns!()!))].some((name) => SECRET_FIELDS.has(name)),
        path,
      ).toBe(true);
    }
  });
});
