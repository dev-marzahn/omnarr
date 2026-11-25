import { describe, expect, test } from 'vite-plus/test';

import { MAX_NAMES_PER_SHOW, parseAllNames } from '../../convex/mapping/xemNamesParse';
import jojoPartsNames from '../fixtures/xem/jojoPartsNames.json';

const allNames = (data: unknown) => ({ result: 'success', data, message: '' });

describe('parseAllNames', () => {
  test('a name under -1 has no scene season; one under a single scene season carries it, and part names come first', () => {
    expect(parseAllNames(allNames({ 7700009: jojoPartsNames }))).toEqual([
      {
        tvdbId: 7700009,
        names: [
          { title: "JoJo's Bizarre Adventure - Stardust Crusaders", sceneSeason: 2 },
          { title: "JoJo's Bizarre Adventure - Stone Ocean", sceneSeason: 5 },
          { title: 'JoJo no Kimyou na Bouken: Steel Ball Run', sceneSeason: 6 },
          { title: "JoJo's Bizarre Adventure (2012)" },
          { title: 'JoJo no Kimyou na Bouken' },
        ],
      },
    ]);
  });

  test('a name under several scene seasons, or under -1 and a scene season, has no scene season: it names the show in every season', () => {
    const names = [{ 'Two Cours': 4 }, { 'Two Cours': 5 }, { 'Everywhere Too': -1 }, { 'Everywhere Too': 3 }];
    expect(parseAllNames(allNames({ 7700010: names }))).toEqual([{ tvdbId: 7700010, names: [{ title: 'Two Cours' }, { title: 'Everywhere Too' }] }]);
  });

  test('a scene season sent as a string reads as its number', () => {
    expect(parseAllNames(allNames({ 7700010: [{ 'Final Part': '5' }, { Everywhere: '-1' }] }))).toEqual([
      { tvdbId: 7700010, names: [{ title: 'Final Part', sceneSeason: 5 }, { title: 'Everywhere' }] },
    ]);
  });

  test('skips a bad entry, a blank, over-long or control-character title, a season that is not a whole number, and a show ID that is not a TVDB ID; trims the rest', () => {
    const names = [
      { ' Kept ': 1 },
      'not an object',
      { Bad: 'season one' },
      { Half: 1.5 },
      { Signed: '+2' },
      { Low: -2 },
      { '  ': 1 },
      { ['x'.repeat(201)]: 1 },
      { 'Bidi‮Name': 1 },
    ];
    expect(parseAllNames(allNames({ 7700010: names, abc: [{ Lost: 1 }], '-5': [{ Lost: 1 }], 0: [{ Lost: 1 }], 7700011: 'not a list' }))).toEqual([
      { tvdbId: 7700010, names: [{ title: 'Kept', sceneSeason: 1 }] },
    ]);
  });

  test(`keeps at most ${MAX_NAMES_PER_SHOW} names per show`, () => {
    const names = Array.from({ length: MAX_NAMES_PER_SHOW + 5 }, (_, i) => ({ [`Name ${i}`]: -1 }));
    expect(parseAllNames(allNames({ 7700010: names }))[0]!.names).toHaveLength(MAX_NAMES_PER_SHOW);
  });

  test.each([
    ['a failure envelope', { result: 'failure', data: [], message: 'no show found' }],
    ['an empty object', allNames({})],
    ['an empty list', allNames([])],
    ['no show with a usable name', allNames({ 7700010: [{ '': -1 }] })],
    ['a body in another shape', { result: 'success', data: 'html' }],
  ])('%s throws, so the fetch fails and the stored names stay', (_case, json) => {
    expect(() => parseAllNames(json)).toThrow();
  });
});
