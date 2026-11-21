import { describe, expect, test } from 'vite-plus/test';

import { JellyfinConnection, localeFields, SetupStep } from '../src/jellyfin.ts';
import { JobPayload, JobResult } from '../src/jobs.ts';
import { FailRequest } from '../src/protocol.ts';

describe('localeFields', () => {
  test('a tag with a region gives its country and language', () => {
    expect(localeFields('de-DE')).toEqual({ uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' });
    expect(localeFields('pt-BR')).toEqual({ uiCulture: 'pt-BR', metadataCountry: 'BR', metadataLanguage: 'pt' });
  });

  test("a tag without a region gives Jellyfin's default country, US", () => {
    expect(localeFields('en')).toEqual({ uiCulture: 'en', metadataCountry: 'US', metadataLanguage: 'en' });
  });
});

test('the setup steps run in checklist order', () => {
  expect(SetupStep.options).toEqual(['reachable', 'wizard', 'apiKey', 'libraries', 'testRefresh']);
});

test('JellyfinConnection parses with and without a key', () => {
  const ready = { state: 'ready', apiKey: 'k', adminUserId: 'u', libraries: [{ libraryId: 'l1', itemId: 'i1' }] };
  expect(JellyfinConnection.parse(ready)).toEqual(ready);
  const settingUp = { state: 'settingUp', libraries: [] };
  expect(JellyfinConnection.parse(settingUp)).toEqual(settingUp);
});

test("job.fail carries the setup's structured reason and step", () => {
  const request = { jobId: 'j', leaseEpoch: 1, failureCode: 'jellyfinSetupNeeded', detail: 'd', data: { reason: 'credentialsNeeded', step: 'apiKey' } };
  expect(FailRequest.parse(request)).toEqual(request);
  expect(() => FailRequest.parse({ ...request, data: { reason: 'nope' } })).toThrow();
});

describe('maintenance.setupJellyfin', () => {
  const payload = {
    class: 'maintenance',
    action: 'setupJellyfin',
    mode: 'firstRun',
    admin: { username: 'leon', password: 'p' },
    locale: { uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' },
    libraries: [{ libraryId: 'l1', name: 'Series', kind: 'series', rootPath: '/data/library/series' }],
    remoteAccess: true,
  };

  test('the payload parses, with offline only for the tests', () => {
    expect(JobPayload.parse(payload)).toEqual(payload);
    expect(JobPayload.parse({ ...payload, offline: true })).toEqual({ ...payload, offline: true });
  });

  test('the result carries the key only when a new one was made', () => {
    const result = {
      class: 'maintenance',
      action: 'setupJellyfin',
      serverId: 's',
      version: '12.4.0',
      adminUserId: 'u',
      libraries: [{ libraryId: 'l1', itemId: 'i1' }],
      steps: [{ step: 'reachable', state: 'done', at: 1 }],
    };
    expect(JobResult.parse(result)).toEqual(result);
    expect(JobResult.parse({ ...result, apiKey: 'k' })).toEqual({ ...result, apiKey: 'k' });
  });
});
