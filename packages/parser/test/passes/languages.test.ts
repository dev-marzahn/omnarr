import { describe, expect, test } from 'vite-plus/test';

import { languages } from '../../src/passes/languages.ts';
import { release } from './release.ts';

const series = (tags: string, overrides = {}) =>
  languages(`The.Long.Harbor.S01E02.${tags}-GRPA`, release({ group: 'GRPA', episodes: [{ season: 1, episode: 2 }], ...overrides }));
const movie = (title: string, name: string, overrides = {}) => languages(title, release({ title: name, group: 'GRPB', ...overrides }));

describe('languages (pass 5)', () => {
  test("ignores the library's English and assumes nothing: no tag gives no language and languageAssumed", () => {
    expect(series('1080p.WEB-DL.DDP5.1.H.264', { languages: ['en'] })).toMatchObject({ languages: [], notes: ['languageAssumed'] });
  });

  test.each([
    ['GERMAN.1080p.WEB.h264', ['de']],
    ['German.DL.1080p.WEB.h264', ['de', 'multi']],
    ['MULTi.1080p.WEB.h264', ['multi']],
    ['multi.FRENCH.1080p.WEB.h264', ['multi', 'fr']],
    ['TRUEFRENCH.1080p.WEB.h264', ['fr']],
    ['VFF.1080p.WEB.h264', ['fr']],
    ['iTALiAN.1080p.WEB.h264', ['it']],
    ['ITA.ENG.1080p.WEB.h264', ['it', 'en']],
    ['SPANISH.LATINO.1080p.WEB.h264', ['es']],
    ['CASTELLANO.1080p.WEB.h264', ['es']],
    ['BRAZILIAN.1080p.WEB.h264', ['pt']],
    ['DUTCH.1080p.WEB.h264', ['nl']],
    ['FLEMISH.1080p.WEB.h264', ['nl']],
    ['POLISH.1080p.WEB.h264', ['pl']],
    ['RUS.1080p.WEB.h264', ['ru']],
    ['JAPANESE.1080p.WEB.h264', ['ja']],
    ['KOR.1080p.WEB.h264', ['ko']],
    ['MANDARIN.1080p.WEB.h264', ['zh']],
    ['CANTONESE.1080p.WEB.h264', ['zh']],
    ['NORDiC.1080p.WEB.h264', ['sv', 'no', 'da', 'fi']],
    ['SWEDISH.1080p.WEB.h264', ['sv']],
    ['NORWEGIAN.1080p.WEB.h264', ['no']],
    ['DANISH.1080p.WEB.h264', ['da']],
    ['FINNISH.1080p.WEB.h264', ['fi']],
    ['TURKISH.1080p.WEB.h264', ['tr']],
    ['GREEK.1080p.WEB.h264', ['el']],
    ['HUNGARIAN.1080p.WEB.h264', ['hu']],
    ['CZECH.1080p.WEB.h264', ['cs']],
    ['UKRAINIAN.1080p.WEB.h264', ['uk']],
    ['HEBREW.1080p.WEB.h264', ['he']],
    ['ARABIC.1080p.WEB.h264', ['ar']],
    ['HINDI.1080p.WEB.h264', ['hi']],
    ['THAI.1080p.WEB.h264', ['th']],
    ['VIETNAMESE.1080p.WEB.h264', ['vi']],
  ])('%s → %j', (tags, codes) => {
    expect(series(tags)).toMatchObject({ languages: codes, notes: [] });
  });

  test.each([
    ['DE', 'de'],
    ['FR', 'fr'],
    ['IT', 'it'],
    ['ES', 'es'],
    ['NL', 'nl'],
    ['PL', 'pl'],
    ['PT', 'pt'],
    ['RU', 'ru'],
    ['JA', 'ja'],
    ['KO', 'ko'],
    ['ZH', 'zh'],
  ])('the two-letter %s counts', (token, code) => {
    expect(series(`${token}.1080p.WEB.h264`).languages).toEqual([code]);
  });

  test.each(['EN', 'US', 'UK', 'SE', 'NO', 'DK', 'HI'])('the two-letter %s is not on the list, so it does not count', (token) => {
    expect(series(`${token}.1080p.WEB.h264`).languages).toEqual([]);
  });

  test.each([
    ['WEB-DL', '1080p.WEB-DL.H.264'],
    ['WEBDL', '1080p.WEBDL.H.264'],
    ['a DL- compound', 'GERMAN.1080p.WEB.DL-Mux.H.264'],
  ])('%s never adds multi', (_name, tags) => {
    expect(series(tags).languages).not.toContain('multi');
  });

  test('a DL that the group is hyphenated onto is a DL- compound, so it adds no multi', () => {
    expect(languages('Quiet.Orchard.2023.German.1080p.WEB.x264.DL-GRPB', release({ title: 'Quiet Orchard', group: 'GRPB' })).languages).toEqual(['de']);
  });

  test('reads tokens only after the title and numbers', () => {
    expect(movie('French.Kiss.Road.2023.1080p.WEB.h264-GRPB', 'French Kiss Road').languages).toEqual([]);
    expect(movie('De.Lange.Haven.2023.1080p.WEB.h264-GRPB', 'De Lange Haven').languages).toEqual([]);
  });

  test("skips the streaming pass's token, so iT is no Italian", () => {
    expect(movie('Quiet.Orchard.2023.1080p.iT.WEB-DL.DDP5.1.H.264-GRPB', 'Quiet Orchard', { streamingService: 'iT' }).languages).toEqual([]);
  });

  test("ignores the group's name", () => {
    expect(languages('Quiet.Orchard.2023.1080p.WEB.h264-ITA', release({ title: 'Quiet Orchard', group: 'ITA' })).languages).toEqual([]);
  });

  describe("the author's rules", () => {
    test.each([
      ['DUAL as a token', '1080p.DUAL.WEB-DL.x264', ['multi']],
      ['German before DUAL, in token order', 'German.1080p.WEB-DL.DUAL.AAC2.0.H.264', ['de', 'multi']],
      ['VOF', 'VOF.2160p.WEB.AV1', ['fr']],
      ['MULTi then VOF', 'MULTi.VOF.2160p.WEB.H265', ['multi', 'fr']],
    ])('%s', (_name, tags, codes) => {
      expect(series(tags).languages).toEqual(codes);
    });

    test('DUAL-<group> adds multi, whatever its case', () => {
      expect(
        languages('The.Long.Harbor.S01E02.1080p.WEB-DL.H.264.DUAL-GRPX', release({ group: 'GRPX', episodes: [{ season: 1, episode: 2 }] })).languages,
      ).toEqual(['multi']);
      expect(languages('Quiet.Orchard.2023.1080p.BluRay.REMUX-GRPB.Dual-GRPY', release({ title: 'Quiet Orchard', group: 'GRPB' })).languages).toEqual([
        'multi',
      ]);
    });

    test.each(['MSubs', 'MultiSub', 'Multi-Subs'])('%s adds multi subtitles and is no hardcoded subtitle', (token) => {
      expect(series(`1080p.WEB-DL.AAC2.0.H.264.${token}`, { hardcodedSubs: true })).toMatchObject({
        subtitleLanguages: ['multi'],
        hardcodedSubs: false,
        languages: [],
      });
    });
  });

  test('two-letter tokens count only in capitals, so words of an episode title are no language', () => {
    expect(series('Le.Chateau.de.Cartes.1080p.WEB.h264').languages).toEqual([]);
    expect(series('I.Did.It.My.Way.1080p.WEB.h264').languages).toEqual([]);
    expect(series('DE.1080p.WEB.h264').languages).toEqual(['de']);
  });

  test('a bracketed list of two-letter codes names those languages', () => {
    expect(movie('Quiet Orchard [2023] 2160p UHD Blu-ray [EN-TR] DTS-HD MA 5.1 X265-GRPB', 'Quiet Orchard').languages).toEqual(['en', 'tr']);
    expect(movie('Quiet Orchard 2023 2160p EN-TR X265-GRPB', 'Quiet Orchard').languages).toEqual([]);
  });

  test('DUBBED adds the dubbed note', () => {
    expect(series('GERMAN.DUBBED.720p.WEB.x264')).toMatchObject({ languages: ['de'], notes: ['dubbed'] });
    expect(series('DUBBED.720p.WEB.x264')).toMatchObject({ languages: [], notes: ['dubbed', 'languageAssumed'] });
  });

  describe('subtitles', () => {
    test.each([
      ['VOSTFR.1080p.WEB.h264', [], ['fr']],
      ['ENG.SUBS.1080p.WEB.h264', [], ['en']],
      ['GERMAN.ENG.SUBS.1080p.WEB.h264', ['de'], ['en']],
      ['NORDiC.SUBS.1080p.WEB.h264', [], ['sv', 'no', 'da', 'fi']],
      ['1080p.WEB.h264.Multi-Subs', [], ['multi']],
      ['FRENCH.1080p.WEB.h264.MULTi-SUBS', ['fr'], ['multi']],
    ])('%s → audio %j, subtitles %j', (tags, audio, subtitles) => {
      expect(series(tags)).toMatchObject({ languages: audio, subtitleLanguages: subtitles });
    });

    test.each([
      ['HC', true],
      ['KORSUB', true],
      ['SUBBED', false],
    ])('%s → hardcoded %s', (token, hardcoded) => {
      expect(series(`1080p.WEB.${token}.h264`).hardcodedSubs).toBe(hardcoded);
    });

    test("keeps the library's hardcoded flag", () => {
      expect(series('1080p.WEB.h264', { hardcodedSubs: true }).hardcodedSubs).toBe(true);
    });
  });
});
