import { describe, expect, test } from 'vite-plus/test';

import { COMMITTED_CATALOGUE, E2E_CATALOGUE, GENERATED_MEDIA, loadCatalogue, readMedia } from './catalogue.ts';

describe('the e2e catalogue', () => {
  test('holds S01E01, a damaged S01E02 and a complete one from another group, two season 2 releases for transcodes, and the unclear one', () => {
    expect(E2E_CATALOGUE.map(({ guid, title, fileName, media, damaged }) => ({ guid, title, fileName, media, damaged }))).toEqual([
      {
        guid: 'hl-s01e01',
        title: 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB',
        fileName: 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB.mkv',
        media: 'webdl.mkv',
        damaged: undefined,
      },
      {
        guid: 'hl-s01e02',
        title: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPF',
        fileName: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPF.mkv',
        media: 'sample.mkv',
        damaged: undefined,
      },
      {
        guid: 'hl-s01e02-bad',
        title: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB',
        fileName: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv',
        media: 'sample.mkv',
        damaged: true,
      },
      {
        guid: 'hl-s02e01',
        title: 'Harbour.Lights.S02E01.1080p.WEB-DL.DDP5.1-GRPB',
        fileName: 'Harbour.Lights.S02E01.1080p.WEB-DL.DDP5.1-GRPB.mkv',
        media: GENERATED_MEDIA.file,
        damaged: undefined,
      },
      {
        guid: 'hl-s02e02',
        title: 'Harbour.Lights.S02E02.1080p.WEB-DL.DDP5.1-GRPB',
        fileName: 'Harbour.Lights.S02E02.1080p.WEB-DL.DDP5.1-GRPB.mkv',
        media: 'cut-short.mkv',
        damaged: undefined,
      },
      {
        guid: 'hl-unclear-03',
        title: '[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4]',
        fileName: '[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4].mkv',
        media: 'sample.mkv',
        damaged: undefined,
      },
    ]);
    // Only the unclear release is listed under every query.
    expect(E2E_CATALOGUE.filter((item) => item.everyQuery).map((item) => item.guid)).toEqual(['hl-unclear-03']);
  });

  test('serves each release its Matroska file', () => {
    for (const release of loadCatalogue(COMMITTED_CATALOGUE)) {
      const media = readMedia(COMMITTED_CATALOGUE.find((item) => item.guid === release.entry.guid)!.media);
      expect([...media.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(release.content).toEqual(media);
    }
  });

  test('splits the small file finely enough that the damaged release is missing parts', () => {
    const [, good, bad] = loadCatalogue(COMMITTED_CATALOGUE);
    expect(good!.parts.length).toBeGreaterThanOrEqual(4);
    expect(good!.parts.some((part) => part.missing)).toBe(false);
    expect(bad!.parts.filter((part) => part.missing).length).toBeGreaterThanOrEqual(2);
  });
});
