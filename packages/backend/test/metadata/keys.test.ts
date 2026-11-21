// TMDB tokens and a revoked built-in token, through metadata.testKey, search
// and the settings page's query.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../../convex/_generated/api';
import { asAdmin, seedLibraries, setup, useMetadataFakes, type Backend, type Libraries } from '../setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
  useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const USER_TOKEN = 'user-read-access-token';
const search = () => admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' });
const openIssues = () =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issues')
        .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
        .collect()
    ).map(({ failureCode, fixActions, detail }) => ({ failureCode, fixActions, detail })),
  );

describe('the token in use', () => {
  test("the deployment's token while no user token is saved", async () => {
    expect(await search()).toHaveLength(1);
    expect(await admin.query(api.api.metadata.settings, {})).toMatchObject({ tokenSource: 'deployment', language: 'en-US' });
  });

  test('testKey stores a token TMDB accepts, and every call then uses it', async () => {
    useMetadataFakes({ apiKey: USER_TOKEN });
    await expect(search()).rejects.toThrow(/metadataKeyRejected/);
    expect(await admin.action(api.api.metadata.testKey, { token: USER_TOKEN })).toEqual({ outcome: 'valid' });
    expect(await search()).toHaveLength(1);
    expect(await admin.query(api.api.metadata.settings, {})).toMatchObject({ tokenSource: 'user', userTokenCheckedAt: expect.any(Number) });
  });

  test('testKey never stores a token TMDB rejects; the previous token stays in use', async () => {
    expect(await admin.action(api.api.metadata.testKey, { token: 'not-a-token' })).toEqual({ outcome: 'rejected' });
    expect(await admin.query(api.api.metadata.settings, {})).toMatchObject({ tokenSource: 'deployment' });
    expect(await search()).toHaveLength(1);
  });

  test('testKey says when TMDB cannot be reached, and stores nothing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await admin.action(api.api.metadata.testKey, { token: USER_TOKEN })).toEqual({ outcome: 'unreachable' });
    expect(await admin.query(api.api.metadata.settings, {})).toMatchObject({ tokenSource: 'deployment' });
  });

  test('a stored user token that TMDB later rejects does not fall back to the deployment token', async () => {
    useMetadataFakes({ apiKey: USER_TOKEN });
    await admin.action(api.api.metadata.testKey, { token: USER_TOKEN });
    useMetadataFakes();
    await expect(search()).rejects.toThrow(/TMDB rejected your token/);
    expect(await openIssues()).toEqual([
      { failureCode: 'metadataKeyRejected', fixActions: ['enterMetadataKey'], detail: 'TMDB rejected your token. Enter a new one.' },
    ]);
  });

  test('removing the user token returns to the deployment token', async () => {
    useMetadataFakes({ apiKey: USER_TOKEN });
    await admin.action(api.api.metadata.testKey, { token: USER_TOKEN });
    useMetadataFakes();
    await admin.mutation(api.api.metadata.clearUserToken, {});
    expect(await search()).toHaveLength(1);
    expect(await admin.query(api.api.metadata.settings, {})).toMatchObject({ tokenSource: 'deployment' });
  });

  test("the user's token is in no DTO", async () => {
    useMetadataFakes({ apiKey: USER_TOKEN });
    await admin.action(api.api.metadata.testKey, { token: USER_TOKEN });
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
    const unitId = (await admin.query(api.api.library.detail, { workId }))!.units[1]!.unitId;
    const dtos = [
      await admin.query(api.api.metadata.settings, {}),
      await admin.query(api.api.metadata.workInfo, { workId }),
      await admin.query(api.api.metadata.unitMappings, { unitId }),
      await admin.query(api.api.library.detail, { workId }),
      await admin.query(api.api.library.list, { kind: 'series' }),
    ];
    for (const dto of dtos) expect(JSON.stringify(dto)).not.toContain(USER_TOKEN);
  });

  test('only an admin can test or clear a token, or read the settings', async () => {
    await expect(t.action(api.api.metadata.testKey, { token: USER_TOKEN })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.metadata.clearUserToken, {})).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.api.metadata.settings, {})).rejects.toThrow(/unauthorized/);
  });
});

describe('the built-in token is revoked', () => {
  beforeEach(() => {
    useMetadataFakes({ apiKey: 'some-other-token' });
  });

  test('a search opens one system Issue with the fix action "Enter a TMDB token", and says why', async () => {
    await expect(search()).rejects.toThrow(/TMDB rejected the built-in token/);
    await expect(search()).rejects.toThrow(/metadataKeyRejected/);
    expect(await openIssues()).toEqual([
      { failureCode: 'metadataKeyRejected', fixActions: ['enterMetadataKey'], detail: 'TMDB rejected the built-in token. Enter your own TMDB token.' },
    ]);
  });

  test('a sync opens the same Issue, and the library keeps its stored data', async () => {
    useMetadataFakes();
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
    useMetadataFakes({ apiKey: 'some-other-token' });
    await expect(t.action(internal.metadata.sync.syncWork, { workId })).rejects.toThrow(/metadataKeyRejected/);
    expect(await openIssues()).toHaveLength(1);
    expect((await admin.query(api.api.library.detail, { workId }))!.units).toHaveLength(13);
  });

  test('a token that passes the test resolves the Issue', async () => {
    await expect(search()).rejects.toThrow();
    expect(await admin.action(api.api.metadata.testKey, { token: 'some-other-token' })).toEqual({ outcome: 'valid' });
    expect(await openIssues()).toEqual([]);
    expect(await search()).toHaveLength(1);
  });
});
