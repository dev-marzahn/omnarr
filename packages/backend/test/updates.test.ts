// The update check: one daily request to GitHub's latest
// release, compared by semantic version with the applied release, and the
// System page's "omnarr <latest> is available".
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import { asAdmin, setup, useFetchFakes, type Backend, type GithubFake } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONVEX_RELEASE_VERSION;
  delete process.env.UPDATE_CHECK;
});

const shownRelease = async () => (await admin.query(api.api.system.status, {})).release;

async function check(current: string, github: GithubFake) {
  process.env.CONVEX_RELEASE_VERSION = current;
  const requests = useFetchFakes({ github });
  await t.action(internal.updates.check, {});
  return { release: await shownRelease(), requests, row: await t.run((ctx) => ctx.db.query('settings').first()) };
}

const releaseUrl = (tag: string) => `https://github.com/dev-marzahn/omnarr/releases/tag/${tag}`;
const latest = (tag: string): GithubFake => ({ latest: { tag_name: tag, html_url: releaseUrl(tag) } });
const upToDate = { state: 'upToDate', checkedAt: expect.any(Number) };

describe('the comparison', () => {
  test('a newer release is available, with its link and the time of the check', async () => {
    const { release } = await check('1.2.0', latest('v1.3.0'));
    expect(release).toEqual({
      version: '1.2.0',
      check: { state: 'available', newer: { latest: '1.3.0', releaseUrl: releaseUrl('v1.3.0') }, checkedAt: expect.any(Number) },
    });
  });

  test('the same release and an older one are up to date, with the time of the check', async () => {
    expect((await check('1.3.0', latest('v1.3.0'))).release).toEqual({ version: '1.3.0', check: upToDate });
    expect((await check('1.3.0', latest('v1.2.9'))).release).toEqual({ version: '1.3.0', check: upToDate });
  });

  test('versions compare by number, not as text: 1.10.0 is newer than 1.9.0', async () => {
    expect((await check('1.9.0', latest('v1.10.0'))).release.check).toMatchObject({ newer: { latest: '1.10.0' } });
  });

  test('a pre-release is never offered to a release install, but is to a pre-release one', async () => {
    expect((await check('1.2.0', latest('v1.3.0-p1'))).release.check).toEqual(upToDate);
    expect((await check('0.1.0-p1', latest('v0.1.0-p2'))).release.check).toMatchObject({ newer: { latest: '0.1.0-p2' } });
    expect((await check('0.1.0-p2', latest('v0.1.0'))).release.check).toMatchObject({ newer: { latest: '0.1.0' } });
  });

  test('0.0.0-dev is never offered a release', async () => {
    expect((await check('0.0.0-dev', latest('v1.0.0'))).release).toEqual({ version: '0.0.0-dev', check: upToDate });
  });
});

describe('the state before and after a failure', () => {
  test('an install whose check has not run yet is not checked yet', async () => {
    process.env.CONVEX_RELEASE_VERSION = '1.2.0';
    expect(await shownRelease()).toEqual({ version: '1.2.0', check: { state: 'notYet' } });
  });

  test('a failure with no earlier result has only its time', async () => {
    expect((await check('1.2.0', { down: true })).release.check).toEqual({ state: 'failed', failedAt: expect.any(Number) });
  });

  test('a failure after an up-to-date check says when the check last answered', async () => {
    await check('1.3.0', latest('v1.3.0'));
    expect((await check('1.3.0', { down: true })).release.check).toEqual({ state: 'failed', failedAt: expect.any(Number), lastCheckedAt: expect.any(Number) });
  });

  test('a failure keeps the newer release an earlier check found', async () => {
    await check('1.2.0', latest('v1.3.0'));
    expect((await check('1.2.0', { down: true })).release.check).toEqual({
      state: 'failed',
      failedAt: expect.any(Number),
      lastCheckedAt: expect.any(Number),
      knownNewer: { latest: '1.3.0', releaseUrl: releaseUrl('v1.3.0') },
    });
  });

  test('a success after a failure clears it', async () => {
    await check('1.3.0', { down: true });
    expect((await check('1.3.0', latest('v1.3.0'))).release.check).toEqual(upToDate);
  });
});

describe('the request', () => {
  test('one GET to the latest release, with only Accept and User-Agent', async () => {
    const seen: Headers[] = [];
    const { requests } = await check('1.2.0', { ...latest('v1.3.0'), seen });
    expect(requests.map((url) => url.href)).toEqual(['https://api.github.com/repos/dev-marzahn/omnarr/releases/latest']);
    const [headers] = seen as [Headers];
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('user-agent')).toBe('omnarr');
  });

  test('a failed fetch writes failedAt and nothing else, keeps the last result, and raises no Issue', async () => {
    await check('1.2.0', latest('v1.3.0'));
    const { row } = await check('1.2.0', { down: true });
    expect(row!.updateCheck).toMatchObject({ latestVersion: '1.3.0', failedAt: expect.any(Number) });
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual([]);
  });

  test('an answer GitHub gives as an error (rate limit) counts as a failure', async () => {
    const { row } = await check('1.2.0', { status: 403 });
    expect(row?.updateCheck).toEqual({ failedAt: expect.any(Number) });
  });

  test('UPDATE_CHECK=off makes no request and shows the check turned off, whatever an earlier check found', async () => {
    await check('1.2.0', latest('v1.3.0'));
    process.env.UPDATE_CHECK = 'off';
    const { requests, release } = await check('1.2.0', latest('v1.3.0'));
    expect(requests).toEqual([]);
    expect(release).toEqual({ version: '1.2.0', check: { state: 'off' } });
  });
});
