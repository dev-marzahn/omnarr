import type { ParsedRelease, PreparationStep } from '@omnarr/contracts';
import { STREAMING_SERVICES } from '@omnarr/parser';
import { describe, expect, test } from 'vite-plus/test';

import { BUILT_IN_FORMATS, matchingFormats } from '../src/formats.ts';
import { release } from './release.ts';

const groupTiers = [
  { formatId: 'group.tier1', groups: ['GRPA'] },
  { formatId: 'group.lowQuality', groups: ['lqgrp'] },
  { formatId: 'anime.tier1', groups: ['SubGroup'] },
];
const ids = (parsed: ParsedRelease, step: PreparationStep = 'none') => matchingFormats(parsed, { groupTiers, preparation: step }).map((format) => format.id);

describe('the built-in formats', () => {
  test('have unique IDs, a name and a kind', () => {
    const all = BUILT_IN_FORMATS.map((format) => format.id);
    expect(new Set(all).size).toBe(all.length);
    expect(BUILT_IN_FORMATS.every((format) => format.name.length > 0)).toBe(true);
    expect(BUILT_IN_FORMATS.filter((format) => format.kind === 'preparation').map((format) => format.id)).toEqual([
      'prep.video',
      'prep.remux',
      'prep.audioOrSubtitle',
    ]);
  });

  test('list a streaming format for every service the parser reads', () => {
    expect(BUILT_IN_FORMATS.filter((format) => format.id.startsWith('streaming.')).map((format) => format.id)).toEqual(
      STREAMING_SERVICES.map((s) => `streaming.${s}`),
    );
  });

  test.each<[PreparationStep, string[]]>([
    ['video', ['prep.video']],
    ['remux', ['prep.remux']],
    ['audio', ['prep.audioOrSubtitle']],
    ['subtitle', ['prep.audioOrSubtitle']],
    ['none', []],
  ])('a predicted %s step matches %j', (step, expected) => {
    expect(ids(release(), step).filter((id) => id.startsWith('prep.'))).toEqual(expected);
  });

  test('group tiers read the profile’s lists, ignoring case', () => {
    expect(ids(release({ group: 'grpa' }))).toContain('group.tier1');
    expect(ids(release({ group: 'LQGRP' }))).toContain('group.lowQuality');
    expect(ids(release({ group: 'subgroup' }))).toContain('anime.tier1');
    expect(ids(release({ group: 'GRPZ' })).filter((id) => id.includes('tier') || id.includes('lowQuality'))).toEqual([]);
    expect(ids(release()).filter((id) => id.includes('tier'))).toEqual([]);
  });

  test.each<[string, Partial<ParsedRelease>, Partial<ParsedRelease>]>([
    ['source.webdl', { source: 'webdl' }, { source: 'webrip' }],
    ['source.bluray', { source: 'bluray' }, { source: 'webdl' }],
    ['repack', { revision: { version: 2, real: 0, repack: false } }, {}],
    ['hdr.dv', { hdr: ['dv', 'hdr10'] }, { hdr: ['hdr10'] }],
    ['hdr.dvNoFallback', { hdr: ['dv'] }, { hdr: ['dv', 'hdr10'] }],
    ['hdr.hdr10plus', { hdr: ['hdr10plus'] }, { hdr: ['hdr10'] }],
    ['hdr.hdr10', { hdr: ['hdr10'] }, { hdr: ['hdr10plus'] }],
    ['audio.atmos', { atmos: true }, {}],
    ['audio.truehd', { audioCodec: 'truehd' }, { audioCodec: 'dtshd' }],
    ['audio.dtsx', { audioCodec: 'dtsx' }, { audioCodec: 'dts' }],
    ['audio.dtshd', { audioCodec: 'dtshd' }, { audioCodec: 'dts' }],
    ['audio.eac3', { audioCodec: 'eac3' }, { audioCodec: 'ac3' }],
    ['audio.aac', { audioCodec: 'aac' }, { audioCodec: 'opus' }],
    ['streaming.NF', { streamingService: 'NF' }, { streamingService: 'AMZN' }],
    ['bitDepth.10', { bitDepth: 10 }, { bitDepth: 8 }],
    ['hardcodedSubs', { hardcodedSubs: true }, {}],
    ['language.multi', { languages: ['de', 'multi'] }, { languages: ['de'] }],
    ['edition.criterion', { edition: { criterion: true } }, { edition: { extended: true } }],
    ['edition.threeD', { edition: { threeD: true } }, {}],
  ])('%s matches %o and not %o', (id, yes, no) => {
    expect(ids(release(yes))).toContain(id);
    expect(ids(release(no))).not.toContain(id);
  });
});
