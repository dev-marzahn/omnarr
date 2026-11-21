// Interactive search and manual grab on the item page: the Candidates tab's
// search choice and offer state, the decision column, the Grab buttons, the
// grab confirm and its refusals, and the pick on the timeline.
import type { CandidateRow, CandidateUnit, Timeline, TimelineRun, TimelineSearch, TimelineStage } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  decisionDetail,
  decisionText,
  grabButton,
  grabConfirm,
  grabRefusal,
  grabbedToast,
  grabUnitsLabel,
  isPickStage,
  pickedReleaseFailed,
  pickStepText,
  searchOfferState,
  searchOptions,
  triggerLabel,
  unclearCount,
} from '../lib/timeline';

const S3E2 = { unitId: 'u32', tmdbSeason: 3, tmdbEpisode: 2 } as unknown as CandidateUnit;
const S4E2 = { unitId: 'u42', tmdbSeason: 4, tmdbEpisode: 2 } as unknown as CandidateUnit;

const candidate = (overrides: object = {}): CandidateRow =>
  ({
    candidateId: 'c1',
    title: 'Sky.Courier.S03E02.1080p.WEB.H264-GRPK',
    indexerName: 'NZBgeek',
    protocol: 'usenet',
    sizeBytes: 1.4e9,
    publishedAt: Date.UTC(2026, 10, 15),
    parsed: { title: 'Sky Courier', normalizedTitle: 'sky courier', episodes: [], languages: [] },
    quality: 'webdl-1080p',
    qualityAssumed: false,
    baseScore: 900,
    score: 900,
    breakdown: [],
    preparationStep: 'none',
    preparationAssumed: false,
    outcome: 'pending',
    rank: 1,
    coversUnit: true,
    covers: [S3E2],
    ...overrides,
  }) as unknown as CandidateRow;

const unclear = (overrides: object = {}) =>
  candidate({
    title: '[Kaze] Sky Courier - Storm Run - 02 (1080p) [B1C2D3E4].mkv',
    outcome: 'rejected',
    rank: undefined,
    reason: 'wrongTitleOrEpisode',
    matchDetail: 'episode',
    matchProblem: 'ambiguous',
    possibleUnits: [S3E2, S4E2],
    ...overrides,
  });

const search = (overrides: Partial<TimelineSearch> = {}): TimelineSearch => ({
  searchAttemptId: 's1' as TimelineSearch['searchAttemptId'],
  trigger: 'interactive',
  state: 'offered',
  at: 1_000_000,
  offeredUntil: 1_000_000 + 3_600_000,
  candidates: [candidate()],
  indexers: [],
  ...overrides,
});

test('triggerLabel: "Search and pick" for an interactive search, "Search now" for a manual one', () => {
  expect(triggerLabel('interactive')).toBe('Search and pick');
  expect(triggerLabel('manual')).toBe('Search now');
});

describe('the decision column', () => {
  test('an offered row: "Would pick" on rank 1, "Ranked n" below it', () => {
    expect(decisionText(candidate())).toBe('Would pick');
    expect(decisionText(candidate({ rank: 3 }))).toBe('Ranked 3');
  });

  test('a pick by the user says so', () => {
    expect(decisionText(candidate({ outcome: 'picked', pickedBy: 'user' }))).toBe('Picked by you');
    expect(decisionText(candidate({ outcome: 'picked', pickedBy: 'auto' }))).toBe('Picked');
  });

  test('unclear numbering, with the Units it could be', () => {
    expect(decisionText(unclear())).toBe('Unclear numbering');
    expect(decisionDetail(unclear())).toBe('Could be S03E02 or S04E02');
  });

  test('a wrong title and a wrong episode', () => {
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'wrongTitleOrEpisode', matchDetail: 'title' }))).toBe('Wrong title');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'wrongTitleOrEpisode', matchDetail: 'otherEpisode' }))).toBe('Wrong episode');
  });

  test('a language rejection names the language; a blocklisted row when and why', () => {
    const german = candidate({ outcome: 'rejected', reason: 'language', parsed: { ...candidate().parsed, languages: ['de'] } as CandidateRow['parsed'] });
    expect(decisionDetail(german)).toBe('German');
    const blocked = candidate({ outcome: 'rejected', reason: 'blocklisted', blocklisted: { at: Date.UTC(2026, 10, 9), reason: 'missingArticles' } });
    expect(decisionDetail(blocked)).toBe('Missing articles, 9 Nov');
  });
});

describe('searchOfferState: an offered search for an hour, then read-only', () => {
  test('running, offered with the minutes left, expired, picked, and an automatic search', () => {
    expect(searchOfferState(search({ state: 'running', offeredUntil: undefined }), 1_000_500)).toEqual({ state: 'running' });
    expect(searchOfferState(search(), 1_000_000 + 8 * 60_000)).toEqual({ state: 'offered', minutesLeft: 52 });
    expect(searchOfferState(search(), 1_000_000 + 3_600_001)).toEqual({ state: 'expired' });
    expect(searchOfferState(search({ state: 'picked', offeredUntil: undefined }), 1_000_000)).toEqual({ state: 'picked' });
    expect(searchOfferState(search({ trigger: 'manual', state: 'picked', offeredUntil: undefined }), 1_000_000)).toEqual({ state: 'auto' });
  });
});

describe('grabButton: every row can be grabbed while the search is offered', () => {
  const offered = search({ candidates: [candidate(), unclear({ candidateId: 'c2' })] });

  test('rank 1 is the primary Grab and "Would pick"; the others are outline', () => {
    expect(grabButton(offered.candidates[0]!, offered, 1_000_000)).toEqual({ show: true, primary: true });
    expect(grabButton(offered.candidates[1]!, offered, 1_000_000)).toEqual({ show: true, primary: false });
  });

  test('with no acceptable row, the first row is primary', () => {
    const none = search({ candidates: [unclear({ candidateId: 'c2' }), unclear({ candidateId: 'c3' })] });
    expect(grabButton(none.candidates[0]!, none, 1_000_000).primary).toBe(true);
    expect(grabButton(none.candidates[1]!, none, 1_000_000).primary).toBe(false);
  });

  test('a pack of unclear numbering is disabled: a pack needs a clear season', () => {
    const pack = unclear({ parsed: { ...candidate().parsed, pack: { seasons: [3], full: true } } as CandidateRow['parsed'] });
    expect(grabButton(pack, offered, 1_000_000)).toEqual({ show: true, primary: false, disabled: 'A pack needs a clear season' });
  });

  test('no Grab on an expired, picked or automatic search', () => {
    expect(grabButton(candidate(), offered, 1_000_000 + 3_600_001).show).toBe(false);
    expect(grabButton(candidate(), search({ state: 'picked' }), 1_000_000).show).toBe(false);
    expect(grabButton(candidate(), search({ trigger: 'rss', state: 'picked' }), 1_000_000).show).toBe(false);
  });
});

test('unclearCount counts the releases of unclear numbering that may be this Unit', () => {
  expect(unclearCount(search({ candidates: [candidate(), unclear(), unclear({ coversUnit: false })] }))).toBe(1);
});

describe('grabUnitsLabel: the Units the grab covers', () => {
  test('one episode, a range, a season pack', () => {
    expect(grabUnitsLabel(candidate())).toBe('S03E02');
    expect(grabUnitsLabel(candidate({ covers: [{ unitId: 'a', tmdbSeason: 3, tmdbEpisode: 1 }, S3E2] }))).toBe('S03E01–E02');
    expect(grabUnitsLabel(candidate({ parsed: { ...candidate().parsed, pack: { seasons: [3], full: true } } as CandidateRow['parsed'], covers: [S3E2] }))).toBe(
      'Season 3',
    );
  });
});

describe('grabConfirm', () => {
  test('the row the search would pick: the title and button name the episode, no reason box, the always-there note', () => {
    expect(grabConfirm(candidate(), { unitTitle: 'Crosswind' })).toEqual({
      title: 'Grab this release for S03E02?',
      button: 'Grab for S03E02',
      boxes: [],
      note: "If this download fails, omnarr blocklists it and doesn't try another release by itself, because you picked this one.",
    });
  });

  test('unclear numbering: imported as the chosen episode, whatever its name says', () => {
    expect(grabConfirm(unclear(), { unitTitle: 'Crosswind' }).boxes).toEqual([
      {
        kind: 'warning',
        text: 'Its numbering is unclear: it could be S03E02 or S04E02. omnarr imports it as S03E02 · Crosswind, whatever its name says. Check the title before you grab it.',
      },
    ]);
  });

  test('a wrong title: "Grab anyway", imported as the chosen episode, whatever its name says', () => {
    const wrong = candidate({
      outcome: 'rejected',
      reason: 'wrongTitleOrEpisode',
      matchDetail: 'title',
      title: 'Sky.Couriers.S03E02-GRP',
      parsed: { ...candidate().parsed, title: 'Sky Couriers' } as CandidateRow['parsed'],
    });
    const confirm = grabConfirm(wrong, { unitTitle: 'Crosswind' });
    expect(confirm.button).toBe('Grab anyway for S03E02');
    expect(confirm.boxes).toEqual([
      {
        kind: 'warning',
        text: 'This looks like another series: Sky Couriers. omnarr imports it as S03E02 · Crosswind, whatever its name says. Check the title before you grab it.',
      },
    ]);
  });

  test('a wrong-title pack is disabled too: a pack needs a clear season', () => {
    const pack = candidate({
      outcome: 'rejected',
      reason: 'wrongTitleOrEpisode',
      matchDetail: 'title',
      parsed: { ...candidate().parsed, pack: { seasons: [], full: true } } as CandidateRow['parsed'],
    });
    expect(grabButton(pack, search({ candidates: [pack] }), 1_000_000)).toEqual({ show: true, primary: false, disabled: 'A pack needs a clear season' });
  });

  test('a language, size or score rejection imports normally', () => {
    const german = candidate({ outcome: 'rejected', reason: 'language', parsed: { ...candidate().parsed, languages: ['de'] } as CandidateRow['parsed'] });
    expect(grabConfirm(german, {}).boxes).toEqual([{ kind: 'info', text: "Language: German, which the release profile doesn't take. It imports normally." }]);
    expect(grabConfirm(candidate({ outcome: 'rejected', reason: 'notInProfile' }), {}).boxes[0]!.text).toBe(
      "Not in profile: its quality isn't in the release profile. It imports normally.",
    );
  });

  test('a blocklisted row: when and why, and it comes off the blocklist first', () => {
    const blocked = candidate({ outcome: 'rejected', reason: 'blocklisted', blocklisted: { at: Date.UTC(2026, 10, 9), reason: 'missingArticles' } });
    expect(grabConfirm(blocked, { workTitle: 'Sky Courier' }).boxes).toEqual([
      {
        kind: 'warning',
        text: 'This release is blocklisted for Sky Courier. It failed on 9 Nov with missing articles. Grabbing removes it from the blocklist first.',
      },
    ]);
  });
});

describe('grabRefusal and grabbedToast', () => {
  test('each refusal says what to do', () => {
    expect(grabRefusal({ outcome: 'expired' }, 'S03E02')).toEqual({
      text: 'These results are over an hour old. Search again to grab from fresh ones.',
      action: 'searchAgain',
    });
    expect(grabRefusal({ outcome: 'busy', grabId: 'g' as never }, 'S03E02', 3)).toEqual({
      text: 'S03E02 is already downloading (Run 3). Cancel that grab first.',
      action: 'cancelGrab',
    });
    expect(grabRefusal({ outcome: 'packNeedsSeason' }, 'S03E02')).toEqual({ text: 'A pack needs a clear season.' });
  });

  test('the toast after a grab', () => {
    expect(grabbedToast('S03E02', 4)).toBe('Grabbed for S03E02 · Run 4 started');
  });
});

describe('the pick on the timeline', () => {
  const stage = (overrides: Partial<TimelineStage> = {}): TimelineStage => ({
    stage: 'search',
    kind: 'decision',
    message: 'You picked [Kaze] Sky Courier - Storm Run - 02 (1080p).',
    at: 1,
    ...overrides,
  });

  test('the pick step is the search decision that names the release', () => {
    expect(isPickStage(stage())).toBe(true);
    expect(isPickStage(stage({ stage: 'grab', message: 'Grabbed x.' }))).toBe(false);
  });

  test('its text follows the rejection the user confirmed', () => {
    expect(pickStepText(stage({ confirmReason: 'wrongTitleOrEpisode' }), unclear())).toBe('You picked a release with unclear numbering');
    const german = candidate({ reason: 'language', parsed: { ...candidate().parsed, languages: ['de'] } as CandidateRow['parsed'] });
    expect(pickStepText(stage({ confirmReason: 'language' }), german)).toBe('You picked a release in German');
    expect(pickStepText(stage({ confirmReason: 'blocklisted' }), candidate())).toBe('You picked a release that was blocklisted (removed from the blocklist)');
    expect(pickStepText(stage(), candidate())).toBe('You picked this release');
  });
});

describe('searchOptions and pickedReleaseFailed', () => {
  const run = (overrides: Partial<TimelineRun> = {}): TimelineRun =>
    ({
      grabId: 'g1',
      title: 'x',
      state: 'failed',
      startedAt: 2_000,
      cancelRequested: false,
      paused: false,
      pickedBy: 'user',
      failureCode: 'missingArticles',
      outcome: 'failed',
      stages: [],
      search: search({ searchAttemptId: 's1' as never, state: 'picked', at: 1_000 }),
      ...overrides,
    }) as TimelineRun;
  const timeline = (overrides: Partial<Timeline>): Timeline => ({ runs: [], ...overrides }) as Timeline;

  test("the Candidates tab's searches: the last search first, then each run's, newest first, each once", () => {
    const t = timeline({
      lastSearch: search({ searchAttemptId: 's3' as never, at: 3_000 }),
      runs: [run(), run({ grabId: 'g0' as never, startedAt: 500, search: search({ searchAttemptId: 's0' as never, trigger: 'subscribe', at: 400 }) })],
    });
    expect(searchOptions(t).map((option) => [option.value, option.label])).toEqual(
      [
        ['s3', 'Search and pick · '],
        ['s1', 'Search and pick · '],
        ['s0', 'Subscribe · '],
      ].map(([value, label]) => [value, expect.stringContaining(label!)]),
    );
  });

  test('a picked release that failed as a bad release, with nothing newer: the alert shows', () => {
    expect(pickedReleaseFailed(timeline({ runs: [run()] }))).toBe(true);
    expect(pickedReleaseFailed(timeline({ runs: [run({ pickedBy: 'auto' })] }))).toBe(false);
    expect(pickedReleaseFailed(timeline({ runs: [run({ failureCode: 'clientUnreachable' })] }))).toBe(false);
    expect(pickedReleaseFailed(timeline({ runs: [run()], lastSearch: search({ at: 3_000 }) }))).toBe(false);
  });
});
