import { describe, expect, test } from 'vite-plus/test';

import { seriesTitleYear, titleInitials } from '../../src/passes/title.ts';
import { release } from './release.ts';

describe('seriesTitleYear (the author’s rule)', () => {
  test('splits a year off the end of a series title', () => {
    expect(seriesTitleYear('Copper.Valley.2024.S04E06.1080p', release({ title: 'Copper Valley 2024', normalizedTitle: 'copper valley 2024' }))).toMatchObject({
      title: 'Copper Valley',
      normalizedTitle: 'copper valley',
      year: 2024,
    });
  });

  test('splits a year followed by a country code', () => {
    expect(seriesTitleYear('Copper.Valley.2007.CA.S20E04.1080p', release({ title: 'Copper Valley 2007 CA' }))).toMatchObject({
      title: 'Copper Valley CA',
      normalizedTitle: 'copper valley ca',
      year: 2007,
    });
  });

  test('leaves a title that is only a year, or has no year at its end', () => {
    expect(seriesTitleYear('1923.S01E01.1080p', release({ title: '1923' }))).toMatchObject({ title: '1923' });
    expect(seriesTitleYear('Blade.2049.Station.S01E01', release({ title: 'Blade 2049 Station' }))).toMatchObject({ title: 'Blade 2049 Station' });
  });

  test('keeps a year the library already found', () => {
    expect(seriesTitleYear('Copper.Valley.2024.S01E01', release({ title: 'Copper Valley 2024', year: 2024 }))).toMatchObject({
      title: 'Copper Valley',
      year: 2024,
    });
  });
});

describe('titleInitials', () => {
  test('drops the dot the library leaves after a one-letter word of a dotted title', () => {
    expect(titleInitials('I.Know.What.You.Saw.2025.1080p', release({ title: 'I. Know What You Saw', normalizedTitle: 'i know what you saw' }))).toMatchObject({
      title: 'I Know What You Saw',
    });
  });

  test('leaves titles written with spaces', () => {
    expect(titleInitials('J. Edgar Road 2011 1080p', release({ title: 'J. Edgar Road' })).title).toBe('J. Edgar Road');
  });
});
