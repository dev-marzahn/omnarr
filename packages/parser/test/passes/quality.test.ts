import { describe, expect, test } from 'vite-plus/test';

import { quality } from '../../src/passes/quality.ts';
import { release } from './release.ts';

const movie = (title: string, overrides = {}) => quality(title, release({ title: 'Quiet Orchard', group: 'GRPB', ...overrides }));

describe('quality: what the library reads as a disc, or misses', () => {
  test.each([
    ['an HEVC 10-bit encode', 'Quiet.Orchard.2026.1080p.BluRay.HEVC.10bit.AAC5.1-GRPB', 1080, 1080],
    ['a 2160p HEVC encode, whose resolution the library forced to 1080', 'Quiet.Orchard.2026.2160p.UHD.BluRay.HEVC.10bit.DTS-HD.MA7.1-GRPB', 1080, 2160],
    ['an HEVC encode without 10bit', 'Quiet.Orchard.1997.2160p.UHD.BluRay.DoVi.HDR10.HEVC.Atmos.TrueHD.7.1-GRPB', 1080, 2160],
  ])('%s is no disc', (_name, title, libraryResolution, resolution) => {
    const result = movie(title, { source: 'bluray', modifier: 'brdisk', resolution: libraryResolution });
    expect(result.modifier).toBeUndefined();
    expect(result.resolution).toBe(resolution);
  });

  test.each([
    ['COMPLETE', 'Quiet.Orchard.2020.COMPLETE.UHD.BLURAY.HEVC-GRPB'],
    ['an AVC disc', 'Quiet.Orchard.2020.1080p.BluRay.AVC.DTS-HD.MA.5.1-GRPB'],
    ['BDMV', 'Quiet.Orchard.2020.2160p.BDMV.HEVC-GRPB'],
  ])('a disc stays a disc: %s', (_name, title) => {
    expect(movie(title, { source: 'bluray', modifier: 'brdisk', resolution: 1080 }).modifier).toBe('brdisk');
  });

  test.each(['Quiet.Orchard.2026.br.remux.avc-grpb', 'Quiet.Orchard.1972.BD.REMUX.AVC-grpb'])('%s is a Bluray remux', (title) => {
    expect(movie(title, { modifier: 'remux' })).toMatchObject({ source: 'bluray', modifier: 'remux' });
  });

  test('a DVD remux is a DVD source with the remux modifier', () => {
    expect(quality('The.Long.Harbor.S01.480p.NTSC.DVD.REMUX.MPEG-2.DD.2.0-grpd86', release({ source: 'bluray', resolution: 480 }))).toMatchObject({
      source: 'dvd',
      modifier: 'remux',
    });
  });

  test('an HD DVD is no DVD', () => {
    expect(movie('Quiet.Orchard.2007.1080p.HD-DVD.REMUX.VC-1-GRPB', { source: 'bluray', modifier: 'remux' }).source).toBe('bluray');
  });

  test('leaves an ordinary release alone', () => {
    const plain = release({ title: 'Quiet Orchard', source: 'webdl', resolution: 1080, group: 'GRPB' });
    expect(quality('Quiet.Orchard.2026.1080p.WEB-DL.H.264-GRPB', plain)).toEqual(plain);
  });
});
