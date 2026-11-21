// "Might be this episode" on the item page's Candidates tab: each release of
// the last search the parser may have misread, with a short explanation in
// words, where it came from, and its way to grab: Grab while the search is
// open, else Search again.
import type { CandidateRow, MisreadRow, TimelineSearch } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { misreadExplanation, misreadRows } from '../lib/misread';

const row = (overrides: Partial<MisreadRow> = {}): MisreadRow =>
  ({
    candidateId: 'c1',
    title: '[Grp] Harbour Lights Part 7 Tide Road - 03 (1080p)',
    indexerName: 'Nyaa',
    protocol: 'torrent',
    seeders: 42,
    episodes: [{ absolute: 3 }],
    matchDetail: 'episode',
    ...overrides,
  }) as MisreadRow;

/** The search's own row of the release, as the timeline has it. */
const candidate = (overrides: object = {}): CandidateRow =>
  ({
    candidateId: 'c1',
    title: '[Grp] Harbour Lights Part 7 Tide Road - 03 (1080p)',
    parsed: { title: 'Harbour Lights Part 7 Tide Road', normalizedTitle: 'harbour lights part 7 tide road', episodes: [{ absolute: 3 }], languages: [] },
    outcome: 'rejected',
    reason: 'wrongTitleOrEpisode',
    matchDetail: 'episode',
    covers: [],
    ...overrides,
  }) as unknown as CandidateRow;

const AT = Date.UTC(2026, 10, 19, 21, 0);
const search = (overrides: Partial<TimelineSearch> = {}): TimelineSearch =>
  ({
    searchAttemptId: 'a1',
    trigger: 'interactive',
    state: 'offered',
    at: AT,
    offeredUntil: AT + 3_600_000,
    candidates: [candidate()],
    ...overrides,
  }) as TimelineSearch;

describe('Might be this episode', () => {
  test('a row: the title, the explanation, and its indexer and seeders', () => {
    expect(misreadRows([row()], search(), AT)).toEqual([
      {
        key: 'c1',
        title: '[Grp] Harbour Lights Part 7 Tide Road - 03 (1080p)',
        explanation: 'Matched the title but read episode 3 of the whole series',
        source: 'Nyaa · 42 seeders',
        action: { kind: 'grab', candidate: candidate() },
      },
    ]);
  });

  test('a usenet row, or a torrent without seeders, has no seeders', () => {
    expect(misreadRows([row({ protocol: 'usenet', seeders: undefined, indexerName: 'Usenet Hub' })], search(), AT)[0]!.source).toBe('Usenet Hub');
    expect(misreadRows([row({ seeders: 1 })], search(), AT)[0]!.source).toBe('Nyaa · 1 seeder');
  });

  test('once the offer window has closed, or for an automatic search, a row offers Search again instead of a stale grab', () => {
    expect(misreadRows([row()], search(), AT + 3_600_001)[0]!.action).toEqual({ kind: 'searchAgain' });
    expect(misreadRows([row()], search({ trigger: 'manual', state: 'noAcceptable', offeredUntil: undefined }), AT)[0]!.action).toEqual({ kind: 'searchAgain' });
  });

  test("a pack's Grab is disabled: a manual grab imports one episode", () => {
    const pack = candidate({
      parsed: { title: 'Harbour Lights', normalizedTitle: 'harbour lights', episodes: [], pack: { seasons: [1], full: true }, languages: [] },
    });
    expect(misreadRows([row({ episodes: [], pack: { seasons: [1], full: true } })], search({ candidates: [pack] }), AT)[0]!.action).toEqual({
      kind: 'grab',
      candidate: pack,
      disabled: 'A pack needs a clear season',
    });
  });

  test('a row the shown search no longer has is left out', () => {
    expect(misreadRows([row({ candidateId: 'gone' as MisreadRow['candidateId'] })], search(), AT)).toEqual([]);
  });
});

describe('the explanation', () => {
  test("a title that wasn't recognised says so, with the numbers it read", () => {
    expect(misreadExplanation(row({ matchDetail: 'title', episodes: [{ season: 1, episode: 3 }] }))).toBe('Title not recognised (read S01E03)');
    expect(misreadExplanation(row({ matchDetail: 'title', episodes: [] }))).toBe('Title not recognised');
  });

  test('a recognised title names the numbers that matched no episode', () => {
    expect(misreadExplanation(row({ episodes: [{ season: 2, episode: 14 }] }))).toBe('Matched the title but read S02E14');
    expect(misreadExplanation(row({ episodes: [], pack: { seasons: [3], full: false } }))).toBe('Matched the title but read a pack of season 3');
    expect(misreadExplanation(row({ episodes: [], airDate: '2021-03-11' }))).toBe('Matched the title but read the date 2021-03-11');
    expect(misreadExplanation(row({ episodes: [] }))).toBe('Matched the title but read no episode number');
  });

  test('numbers that could be more than one episode say so', () => {
    expect(misreadExplanation(row({ matchProblem: 'ambiguous', episodes: [], airDate: '2021-03-11' }))).toBe(
      'Matched the title, but the date 2021-03-11 could be more than one episode',
    );
  });
});
