import { describe, expect, test } from 'vite-plus/test';

import { cleanup } from '../../src/passes/cleanup.ts';

const BASE = 'The.Long.Harbor.S01E02.1080p.WEB.h264-GRPA';

describe('cleanup (pass 1)', () => {
  test('leaves a clean title alone', () => {
    expect(cleanup(BASE)).toEqual({ cleanTitle: BASE });
  });

  test.each([
    ['mkv', `${BASE}.mkv`],
    ['mp4', `${BASE}.MP4`],
    ['avi', `${BASE}.avi`],
    ['m2ts', `${BASE}.m2ts`],
    ['ts', `${BASE}.ts`],
  ])('strips the .%s extension and records it as the container', (container, raw) => {
    expect(cleanup(raw)).toEqual({ cleanTitle: BASE, container });
  });

  test.each([`${BASE}-Obfuscated`, `${BASE}-postbot`, `${BASE}[eztv]`, `${BASE}[RARTV]`, `${BASE}-Scrambled`, `${BASE}-xpost`, `${BASE}-xpost-Obfuscated`])(
    'strips the re-poster suffix of %s',
    (raw) => {
      expect(cleanup(raw).cleanTitle).toBe(BASE);
    },
  );

  test('strips a suffix before the extension', () => {
    expect(cleanup(`${BASE}-Obfuscated.mkv`)).toEqual({ cleanTitle: BASE, container: 'mkv' });
  });

  test.each([`www.example.org - ${BASE}`, `www.Example-Site.net  -  ${BASE}`, `[ www.example.org ] - ${BASE}`, `[www.example.org] ${BASE}`])(
    'strips the website prefix of %s',
    (raw) => {
      expect(cleanup(raw).cleanTitle).toBe(BASE);
    },
  );

  test('strips a leading [req]', () => {
    expect(cleanup(`[req] ${BASE}`).cleanTitle).toBe(BASE);
    expect(cleanup(`[REQ]${BASE}`).cleanTitle).toBe(BASE);
  });

  test('keeps a suffix-like word inside the title, and an unknown extension', () => {
    expect(cleanup('The.Xpost.Files.S01E01.720p.HDTV.x264-GRPC').cleanTitle).toBe('The.Xpost.Files.S01E01.720p.HDTV.x264-GRPC');
    expect(cleanup(`${BASE}.nfo`)).toEqual({ cleanTitle: `${BASE}.nfo` });
  });

  test('moves bracketed tags between a leading [Group] and the title behind the title', () => {
    expect(cleanup('[Fansub].[WEB][1080p].Lantern.Keeper-07.[ABCD1234]').cleanTitle).toBe('[Fansub] Lantern.Keeper-07.[ABCD1234] [WEB][1080p]');
    expect(cleanup('[Fansub] [WEB] Lantern.Keeper-07').cleanTitle).toBe('[Fansub] Lantern.Keeper-07 [WEB]');
    expect(cleanup('[Fansub] Lantern Keeper - 07 [1080p]').cleanTitle).toBe('[Fansub] Lantern Keeper - 07 [1080p]');
  });

  test('trims whitespace', () => {
    expect(cleanup(`  ${BASE}  `).cleanTitle).toBe(BASE);
  });
});
