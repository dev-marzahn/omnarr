import { describe, expect, test } from 'vite-plus/test';

import { video } from '../../src/passes/video.ts';
import { release } from './release.ts';

const T = (tags: string) => `The.Long.Harbor.S01E01.${tags}-GRPA`;
const run = (tags: string, overrides = {}) => video(T(tags), release({ group: 'GRPA', episodes: [{ season: 1, episode: 1 }], ...overrides }));

describe('video (pass 3)', () => {
  test.each([
    ['2160p.WEB-DL.DV.H.265', ['dv']],
    ['2160p.WEB-DL.DoVi.H.265', ['dv']],
    ['2160p.WEB-DL.HDR10+.H.265', ['hdr10plus']],
    ['2160p.WEB-DL.HDR10P.H.265', ['hdr10plus']],
    ['2160p.WEB-DL.HDR10Plus.H.265', ['hdr10plus']],
    ['2160p.WEB-DL.HDR10.H.265', ['hdr10']],
    ['2160p.WEB-DL.HLG.H.265', ['hlg']],
    ['2160p.WEB-DL.HDR.H.265', ['hdr']],
    ['2160p.WEB-DL.DV.HDR10.H.265', ['dv', 'hdr10']],
    ['2160p.WEB-DL.DV-HDR10+.H.265', ['dv', 'hdr10plus']],
    ['2160p.WEB-DL.HDR.DV.H.265', ['dv', 'hdr']],
    ['1080p.WEB-DL.H.264', []],
  ])('%s → hdr %j', (tags, hdr) => {
    expect(run(tags).hdr).toEqual(hdr);
  });

  test('reads no HDR tag from the title', () => {
    expect(video('HDR.Hunters.S01E01.1080p.WEB.h264-GRPA', release({ title: 'HDR Hunters', group: 'GRPA' })).hdr).toEqual([]);
  });

  test.each([
    ['1080p.BluRay.x265.10bit', 10],
    ['1080p.BluRay.x265.10-bit', 10],
    ['1080p.BluRay.Hi10P', 10],
    ['1080p.BluRay.8bit.x264', 8],
    ['1080p.BluRay.x264', undefined],
  ])('%s → bit depth %s', (tags, bitDepth) => {
    expect(run(tags).bitDepth).toBe(bitDepth);
  });

  test.each([
    ['1080p.BluRay.AVC', 'h264'],
    ['1080p.BluRay.HEVC', 'h265'],
    ['1080p.BluRay.VC-1', 'vc1'],
    ['1080p.BluRay.VC1', 'vc1'],
    ['576p.DVD.MPEG2', 'mpeg2'],
    ['576p.DVD.MPEG-2', 'mpeg2'],
  ])('%s → codec %s when the library found none', (tags, videoCodec) => {
    expect(run(tags).videoCodec).toBe(videoCodec);
  });

  test("keeps the library's codec", () => {
    expect(run('1080p.BluRay.AVC', { videoCodec: 'h265' }).videoCodec).toBe('h265');
  });
});
