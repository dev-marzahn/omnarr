import type { Condition } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { evaluateRule } from '../src/conditions.ts';
import { release } from './release.ts';

const web = release({
  source: 'webdl',
  videoCodec: 'h264',
  audioCodec: 'eac3',
  audioChannels: '5.1',
  streamingService: 'NF',
  group: 'GrpA',
  resolution: 1080,
  bitDepth: 10,
  hdr: ['dv', 'hdr10'],
  languages: ['en', 'de'],
  subtitleLanguages: ['fr'],
  atmos: true,
  revision: { version: 2, real: 0, repack: true },
  edition: { imax: true },
  container: 'mkv',
});
const one = (condition: Condition) => evaluateRule({ all: [condition] }, web);

describe('conditions', () => {
  test.each<[Condition, boolean]>([
    [{ field: 'source', op: 'in', values: ['webdl', 'bluray'] }, true],
    [{ field: 'source', op: 'notIn', values: ['webdl'] }, false],
    [{ field: 'videoCodec', op: 'in', values: ['h265'] }, false],
    [{ field: 'audioCodec', op: 'in', values: ['eac3'] }, true],
    [{ field: 'audioChannels', op: 'in', values: ['5.1'] }, true],
    [{ field: 'streamingService', op: 'in', values: ['NF'] }, true],
    [{ field: 'modifier', op: 'notIn', values: ['remux'] }, true],
    [{ field: 'container', op: 'in', values: ['mkv'] }, true],
  ])('string field %o → %s', (condition, result) => {
    expect(one(condition)).toBe(result);
  });

  test('group compares ignoring case', () => {
    expect(one({ field: 'group', op: 'in', values: ['GRPA'] })).toBe(true);
    expect(one({ field: 'group', op: 'notIn', values: ['grpa'] })).toBe(false);
  });

  test('a field the release lacks is in no list', () => {
    expect(one({ field: 'modifier', op: 'in', values: ['remux'] })).toBe(false);
    expect(evaluateRule({ all: [{ field: 'group', op: 'notIn', values: ['GRPA'] }] }, release())).toBe(true);
  });

  test.each<[Condition, boolean]>([
    [{ field: 'resolution', op: 'in', values: [1080, 2160] }, true],
    [{ field: 'resolution', op: 'notIn', values: [1080] }, false],
    [{ field: 'resolution', op: 'gte', values: [1080] }, true],
    [{ field: 'resolution', op: 'gte', values: [2160] }, false],
    [{ field: 'resolution', op: 'lte', values: [720] }, false],
    [{ field: 'bitDepth', op: 'in', values: [10] }, true],
    [{ field: 'bitDepth', op: 'lte', values: [8] }, false],
  ])('number field %o → %s', (condition, result) => {
    expect(one(condition)).toBe(result);
  });

  test('an unknown number never satisfies gte or lte', () => {
    expect(evaluateRule({ all: [{ field: 'bitDepth', op: 'gte', values: [8] }] }, release())).toBe(false);
    expect(evaluateRule({ all: [{ field: 'bitDepth', op: 'lte', values: [10] }] }, release())).toBe(false);
  });

  test.each<[Condition, boolean]>([
    [{ field: 'hdr', op: 'any', values: ['dv', 'hlg'] }, true],
    [{ field: 'hdr', op: 'all', values: ['dv', 'hdr10'] }, true],
    [{ field: 'hdr', op: 'all', values: ['dv', 'hlg'] }, false],
    [{ field: 'hdr', op: 'none', values: ['hlg'] }, true],
    [{ field: 'languages', op: 'any', values: ['de'] }, true],
    [{ field: 'languages', op: 'none', values: ['de'] }, false],
    [{ field: 'subtitleLanguages', op: 'all', values: ['fr'] }, true],
  ])('set field %o → %s', (condition, result) => {
    expect(one(condition)).toBe(result);
  });

  test.each<[Condition, boolean]>([
    [{ field: 'atmos', op: 'is', value: true }, true],
    [{ field: 'hardcodedSubs', op: 'is', value: true }, false],
    [{ field: 'hardcodedSubs', op: 'is', value: false }, true],
    [{ field: 'repack', op: 'is', value: true }, true],
    [{ field: 'edition.imax', op: 'is', value: true }, true],
    [{ field: 'edition.extended', op: 'is', value: true }, false],
    [{ field: 'edition.extended', op: 'is', value: false }, true],
  ])('boolean field %o → %s', (condition, result) => {
    expect(one(condition)).toBe(result);
  });

  test('a PROPER counts as a repack', () => {
    expect(evaluateRule({ all: [{ field: 'repack', op: 'is', value: true }] }, release({ revision: { version: 2, real: 0, repack: false } }))).toBe(true);
  });
});

describe('rules: all of all, at least one of any, none of none', () => {
  const yes: Condition = { field: 'atmos', op: 'is', value: true };
  const no: Condition = { field: 'atmos', op: 'is', value: false };

  test.each([
    [{ all: [yes, yes] }, true],
    [{ all: [yes, no] }, false],
    [{ any: [no, yes] }, true],
    [{ any: [no, no] }, false],
    [{ none: [no] }, true],
    [{ none: [yes] }, false],
    [{ all: [yes], any: [no, yes], none: [no] }, true],
    [{ all: [yes], any: [no], none: [no] }, false],
    [{ all: [yes], any: [], none: [] }, true],
  ])('%o → %s', (rule, result) => {
    expect(evaluateRule(rule, web)).toBe(result);
  });
});
