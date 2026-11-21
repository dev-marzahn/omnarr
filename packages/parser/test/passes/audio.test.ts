import { describe, expect, test } from 'vite-plus/test';

import { audio } from '../../src/passes/audio.ts';
import { release } from './release.ts';

const run = (tags: string, overrides = {}) =>
  audio(`Quiet.Orchard.2023.${tags}-GRPB`, release({ title: 'Quiet Orchard', year: 2023, group: 'GRPB', ...overrides }));

describe('audio (pass 4)', () => {
  test.each([
    ['2160p.BluRay.REMUX.TrueHD.7.1.Atmos.HEVC', true],
    ['2160p.WEB-DL.DDP5.1.ATMOS.H.265', true],
    ['1080p.WEB-DL.DDP5.1.H.264', false],
  ])('%s → atmos %s', (tags, atmos) => {
    expect(run(tags).atmos).toBe(atmos);
  });

  test('reads no Atmos from the title', () => {
    expect(audio('Atmos.Rising.2023.1080p.WEB.h264-GRPB', release({ title: 'Atmos Rising', group: 'GRPB' })).atmos).toBe(false);
  });

  test.each(['2160p.BluRay.DTS-X.7.1', '2160p.BluRay.DTS:X.7.1', '2160p.BluRay.DTSX.7.1'])('%s is DTS:X, whatever the library read', (tags) => {
    expect(run(tags, { audioCodec: 'dtshd' }).audioCodec).toBe('dtsx');
  });

  test("keeps the library's codec otherwise", () => {
    expect(run('1080p.BluRay.DTS-HD.MA.5.1', { audioCodec: 'dtshd' }).audioCodec).toBe('dtshd');
  });
});
