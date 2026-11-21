import { describe, expect, test } from 'vite-plus/test';

import { group } from '../../src/passes/group.ts';
import { release } from './release.ts';

const run = (cleanTitle: string, libraryGroup: string | undefined) =>
  group(cleanTitle, release(libraryGroup === undefined ? {} : { group: libraryGroup })).group;

describe('group: a hyphenated tag the library took for the group', () => {
  test.each([
    ['E-AC-3', 'The.Long.Harbor.S01E06.MULTI.1080p.WEBRip.E-AC-3.5.1.x264-GRPA', 'AC', 'GRPA'],
    ['a hyphenated name in an episode title', 'Daily.Talk.2026.11.16.Guest.Ad-Lib.Name.XviD-GRPC', 'Lib', 'GRPC'],
    ['a service such as U-NEXT', 'Quiet.Orchard.2026.1080p.U-NEXT.WEB-DL.AAC2.0.H.264-GRPB', 'NEXT', 'GRPB'],
    ['a bracketed language list', 'Quiet Orchard [2026] 2160p Blu-ray [EN-TR] DTS-HD MA 5.1 X265-GRPB', 'TR', 'GRPB'],
    ['MPEG-2', 'The.Long.Harbor.S01.480p.DVD.REMUX.MPEG-2.DD.2.0-grpd86', '2', 'grpd86'],
    ['VC-1, before a re-tagger’s Dual-<name>', 'Quiet.Orchard.2009.BluRay.1080p.VC-1.REMUX-GRPB.Dual-GRPY', '1', 'GRPB'],
  ])('%s', (_name, title, libraryGroup, expected) => {
    expect(run(title, libraryGroup)).toBe(expected);
  });

  test.each([
    ['the group before a re-tagger’s DUAL-<name>', 'Quiet.Orchard.2025.2160p.BluRay.REMUX-GRPB.DUAL-GRPY', 'GRPB'],
    ['the group of DUAL-<group>', 'The.Long.Harbor.S01E02.2160p.WEB-DL.H.265.DUAL-GRPX', 'GRPX'],
    ['a group with dots', 'The.Long.Harbor.S01E05.2160p.BluRay.REMUX.HDR-Grp.With.Dots', 'Grp.With.Dots'],
    ['a site suffix after the group', 'quiet.orchard.2026.1080p.webrip.x264-grp.gg-grp.bz', 'grp'],
    ['a leading anime group', '[Fan-Subs].Lantern.Keeper-07.[1080p]', 'Fan-Subs'],
  ])('keeps %s', (_name, title, libraryGroup) => {
    expect(run(title, libraryGroup)).toBe(libraryGroup);
  });

  test.each(['NoGroup', 'NoGrp'])('%s means no group', (name) => {
    expect(run(`Quiet.Orchard.2026.1080p.U-NEXT.WEB-DL.H.264-${name}`, 'NEXT')).toBeUndefined();
    expect(run(`Quiet.Orchard.2026.1080p.WEB-DL.H.264-${name}`, name)).toBeUndefined();
  });

  test('leaves a release without a group alone', () => {
    expect(run('Quiet.Orchard.2026.1080p.WEB-DL', undefined)).toBeUndefined();
  });
});
