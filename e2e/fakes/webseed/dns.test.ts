import { Resolver } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import { createDnsResponder } from './dns.ts';

const responder = createDnsResponder('10.213.3.210');
const resolver = new Resolver({ timeout: 2000, tries: 1 });

beforeAll(async () => {
  await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve));
  resolver.setServers([`127.0.0.1:${(responder.address() as AddressInfo).port}`]);
});
afterAll(() => responder.close());

test('every A query is answered with the one address, as gluetun asks for github.com', async () => {
  expect(await resolver.resolve4('github.com')).toEqual(['10.213.3.210']);
  expect(await resolver.resolve4('anything.example')).toEqual(['10.213.3.210']);
});

test('another type has no record, and no error', async () => {
  await expect(resolver.resolve6('github.com')).rejects.toMatchObject({ code: 'ENODATA' });
});
