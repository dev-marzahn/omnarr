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

  test.each([
    ['[Fansub] Lantern Keeper S2-05v2 [1080p]', '[Fansub] Lantern Keeper S02E05.v2 [1080p]'],
    ['Lantern Keeper S2-01v2', 'Lantern Keeper S02E01.v2'],
    ['Lantern.Keeper.S12-03.1080p', 'Lantern.Keeper.S12E03.1080p'],
    ['Lantern Keeper S2-02', 'Lantern Keeper S02E02'],
    ['Lantern Keeper S2-05', 'Lantern Keeper S2-05'],
    ['Lantern Keeper S1-10 Complete', 'Lantern Keeper S1-10 Complete'],
    ['Lantern Keeper S2-1080p', 'Lantern Keeper S2-1080p'],
    ['Lantern Keeper S01-03', 'Lantern Keeper S01-03'],
    ['Lantern Keeper S01E05 S2-01', 'Lantern Keeper S01E05 S2-01'],
    ['[Grp] Lantern Keeper S2-01-12', '[Grp] Lantern Keeper S02E01E12'],
    ['Lantern Keeper S2-01-12v2 [1080p]', 'Lantern Keeper S02E01E12.v2 [1080p]'],
    ['Lantern Keeper S2-12-01', 'Lantern Keeper S2-12-01'],
    ['Lantern Keeper S2-01-1080p', 'Lantern Keeper S02E01-1080p'],
    ['Lantern.Keeper.S2-01E05-GRP', 'Lantern.Keeper.S02E05-GRP'],
    ['Lantern Keeper S2-01E05-1080p', 'Lantern Keeper S02E05-1080p'],
    ['Lantern Keeper S2-01E05E06E07', 'Lantern Keeper S02E05E07'],
    ['Lantern Keeper S2-01E05-E06-E07', 'Lantern Keeper S02E05E07'],
    ['Lantern Keeper S2-01E07E05', 'Lantern Keeper S2-01E07E05'],
    ['[Grp] Lantern Keeper S2-01v2-12', '[Grp] Lantern Keeper S02E01E12.v2'],
    ['[Grp] Lantern Keeper S2-01v10', '[Grp] Lantern Keeper S02E01.v10'],
    ['Lantern Keeper S2-01E05', 'Lantern Keeper S02E05'],
    ['[Grp] Lantern Keeper S2-01E05 [1080p]', '[Grp] Lantern Keeper S02E05 [1080p]'],
    ['Lantern Keeper S2-01-012', 'Lantern Keeper S02E01E12'],
    ['Lantern Keeper S2-001-012', 'Lantern Keeper S02E01E12'],
    ['[Grp] Lantern Keeper S2-01-01', '[Grp] Lantern Keeper S02E01'],
    ['Lantern Keeper S2-01v1000', 'Lantern Keeper S02E01.v1000'],
    ['Lantern Keeper S2-01E05v2', 'Lantern Keeper S02E05.v2'],
    ['Lantern Keeper S2-01E05-06', 'Lantern Keeper S02E05E06'],
    ['Lantern Keeper S2-01E05E06', 'Lantern Keeper S02E05E06'],
    ['Lantern Keeper S01E05 S2-01E06', 'Lantern Keeper S01E05 S2-01E06'],
    ['Lantern Keeper S2-01v2rip', 'Lantern Keeper S02E01v2rip'],
    ['Lantern.Keeper.S2-01E05-EVO', 'Lantern.Keeper.S02E05-EVO'],
    ['Lantern Keeper S2-01E05E06-GRP', 'Lantern Keeper S02E05E06-GRP'],
    ['Lantern Keeper S2-01E05E6', 'Lantern Keeper S02E05E06'],
    ['Lantern Keeper S2-01E05-6', 'Lantern Keeper S02E05E06'],
    ['Lantern Keeper S2-01-2019', 'Lantern Keeper S02E01 2019'],
    ['Lantern Keeper S2-01-480', 'Lantern Keeper S02E01 480'],
    ['Lantern Keeper S2-01-12-480', 'Lantern Keeper S02E01E12 480p'],
    ['Lantern Keeper S2-01-12v2-480', 'Lantern Keeper S02E01E12.v2 480p'],
    ['Lantern Keeper S2-01-12v2-2019', 'Lantern Keeper S02E01E12.v2 2019'],
    ['[Grp] Lantern Keeper S2-01-480', '[Grp] Lantern Keeper S02E01 480'],
    ['[1080p] Lantern Keeper S1-10', '[1080p] Lantern Keeper S1-10'],
    ['[WEB 1080p] Lantern Keeper S1-10', '[WEB 1080p] Lantern Keeper S1-10'],
  ])('writes a season-numbered episode %s as SxxEyy only where a season range cannot be meant', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show S02E01-12-480', 'Show S02E01-12 480p'],
    ['Show S01E06E07-720', 'Show S01E06E07 720p'],
    ['Show S01E06-E07-720', 'Show S01E06-E07 720p'],
    ['Show S02E01-12v2-480', 'Show S02E01-12v2 480p'],
    ['Show S02E01-12-480-GRP', 'Show S02E01-12 480p-GRP'],
  ])('moves a dashed resolution after a range off it, as a resolution: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show.S01E05-2019', 'Show.S01E05 2019'],
    ['Show S01E05v2-2019', 'Show S01E05v2 2019'],
    ['Show S01E05-06-2019', 'Show S01E05-06 2019'],
  ])('moves a dashed year after SxxEyy off it: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show S01E05-720', 'Show S01E05-720'],
    ['[Grp] Show S01E05-720', '[Grp] Show S01E05-720'],
    ['Show S01E701-720', 'Show S01E701-720'],
  ])('leaves a dashed resolution after a single episode, which may be its absolute number or range end: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show S01E1990-2000', 'Show S01E1990-2000'],
    ['Show S20E1999-2001-1080p', 'Show S20E1999-2001-1080p'],
  ])('leaves a dashed year after a four-digit episode, which may be the range end: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show S02E01-12-1080p', 'Show S02E01-12-1080p'],
    ['Show S01E05-06-720i', 'Show S01E05-06-720i'],
    ['Show S01E05-06-2019v2', 'Show S01E05-06-2019v2'],
  ])('leaves a dashed year or resolution with a suffix: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test.each([
    ['Show S01E05-1071', 'Show S01E05-1071'],
    ['Show S01E05-06-12', 'Show S01E05-06-12'],
  ])('leaves a dashed number that is neither a year nor a resolution: %s', (raw, cleanTitle) => {
    expect(cleanup(raw).cleanTitle).toBe(cleanTitle);
  });

  test('trims whitespace', () => {
    expect(cleanup(`  ${BASE}  `).cleanTitle).toBe(BASE);
  });
});
