import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createSceneMappingFake, SCENE_MAPPINGS } from './server.ts';

let base: string;
const fake = createSceneMappingFake();
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

describe('the scene-mapping fake', () => {
  test('serves the list at /v1/scenemapping and logs the User-Agent, its own log left out', async () => {
    const res = await fetch(`${base}/v1/scenemapping`, { headers: { 'user-agent': 'omnarr/test' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SCENE_MAPPINGS);
    const log = await (await fetch(`${base}/_fake/requests`)).json();
    expect(log).toEqual([{ at: expect.any(Number), path: '/v1/scenemapping', userAgent: 'omnarr/test' }]);
  });

  test('any other path is a 404', async () => {
    expect((await fetch(`${base}/v1/other`)).status).toBe(404);
  });
});
