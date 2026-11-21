// The item page's wording: run headers, search summaries and the candidate
// table's decision and breakdown text.
import type { CandidateRow, PlayRow, TimelineRun, TimelineSearch, TimelineSearchIndexer, TimelineStage } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { entryTitle, offersPrepareNow, preparationEntries } from '../lib/preparation';
import {
  breakdownText,
  decisionText,
  failureText,
  playText,
  qualityText,
  runHeader,
  runPercent,
  searchIndexerLines,
  searchOptions,
  searchSummary,
  shortRunId,
  timelineCards,
  triggerLabel,
} from '../lib/timeline';

const candidate = (overrides: Partial<CandidateRow> = {}): CandidateRow =>
  ({
    candidateId: 'c1',
    title: 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB',
    indexerName: 'Newznab Main',
    protocol: 'usenet',
    sizeBytes: 2e9,
    publishedAt: 0,
    parsed: {},
    quality: 'webdl-1080p',
    qualityAssumed: false,
    baseScore: 150,
    score: 150,
    breakdown: [],
    preparationStep: 'none',
    preparationAssumed: false,
    outcome: 'picked',
    rank: 1,
    coversUnit: true,
    ...overrides,
  }) as CandidateRow;

describe('decisionText', () => {
  test('a pick', () => expect(decisionText(candidate())).toBe('Picked'));
  test('a lower-ranked release names the key it lost on', () => {
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'lowerScore', lostOn: 'quality' }))).toBe('Ranked lower: quality');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'lowerScore', lostOn: 'tieBreak' }))).toBe('Ranked lower: tie-break');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'needsMorePreparation', lostOn: 'preparation' }))).toBe(
      'Ranked lower: needs more preparation',
    );
  });
  test('each rejection reason has its text', () => {
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'blocklisted' }))).toBe('Blocklisted');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'notInProfile' }))).toBe('Not in profile');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'wrongTitleOrEpisode' }))).toBe('Wrong title or episode');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'unitBusy' }))).toBe('Episode already being grabbed');
  });
});

describe('breakdownText and qualityText', () => {
  test('a preparation entry says when the prediction assumed a field', () => {
    expect(breakdownText({ name: 'Audio conversion', points: -300, kind: 'preparation' }, true)).toBe('Audio conversion −300 (assumed)');
    expect(breakdownText({ name: 'Release group tier 1', points: 1500, kind: 'format' }, true)).toBe('Release group tier 1 +1500');
  });
  test('an assumed quality says so', () => {
    expect(qualityText(candidate({ qualityAssumed: true }))).toBe('WEB-DL 1080p (assumed)');
    expect(qualityText(candidate())).toBe('WEB-DL 1080p');
  });
});

describe('runs and searches', () => {
  const run = (overrides: Partial<TimelineRun>): TimelineRun =>
    ({
      grabId: 'k97f3a2c1234567c21',
      title: 'T',
      state: 'done',
      startedAt: 0,
      cancelRequested: false,
      paused: false,
      outcome: 'imported',
      stages: [],
      ...overrides,
    }) as TimelineRun;

  test('a run header shows its number, state and why it failed', () => {
    expect(runHeader(run({ state: 'done' }), 2)).toEqual({ label: 'Run 2', state: 'Done', color: 'success' });
    expect(runHeader(run({ state: 'failed', failureCode: 'missingArticles' }), 1)).toEqual({
      label: 'Run 1',
      state: 'Failed · missing articles',
      color: 'error',
    });
    expect(runHeader(run({ state: 'downloading', cancelRequested: true }), 3)).toEqual({ label: 'Run 3', state: 'Cancelling…', color: 'warning' });
    expect(runHeader(run({ state: 'importing', paused: true }), 3)).toEqual({ label: 'Run 3', state: 'Paused · waiting for a fix', color: 'warning' });
  });

  test('an upgrade run is labelled "Upgrade"', () => {
    expect(runHeader(run({ state: 'downloading', kind: 'upgrade' }), 2)).toEqual({ label: 'Run 2 · Upgrade', state: 'Downloading', color: 'info' });
  });

  test('an upgrade search and a notAnUpgrade rejection have their words', () => {
    expect(triggerLabel('upgrade')).toBe('Upgrade search');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'notAnUpgrade' }))).toBe('Not an upgrade');
    expect(decisionText(candidate({ outcome: 'rejected', reason: 'partialUpgrade' }))).toBe('Leaves other episodes on the old file');
  });

  // The release fetch's two codes and the fallback for a client state omnarr doesn't know.
  test.each([
    ['releaseFetchFailed', "couldn't fetch the release file"],
    ['releaseFileInvalid', 'release file missing or invalid'],
    ['unknownClientFailure', 'unknown download client answer'],
    // A failed preparation and the storage check.
    ['transcodeFailed', 'preparation failed'],
    ['storageUnavailable', 'storage unavailable'],
    // The system Issue while a chosen VPN isn't up.
    ['vpnDown', 'VPN down'],
  ] as const)('%s has its own label', (code, label) => expect(failureText(code)).toBe(label));

  test('the run ID is shortened for display', () => expect(shortRunId('k97f3a2c1234567c21')).toBe('k97f3a2c…c21'));

  test('a search summary counts results and names the pick', () => {
    const search = {
      searchAttemptId: 's1',
      trigger: 'nextBest',
      state: 'picked',
      at: 0,
      candidates: [
        candidate(),
        candidate({ candidateId: 'c2' as CandidateRow['candidateId'], outcome: 'rejected', reason: 'blocklisted' }),
        candidate({ candidateId: 'c3' as CandidateRow['candidateId'], outcome: 'rejected', reason: 'wrongTitleOrEpisode', coversUnit: false }),
      ],
    } as TimelineSearch;
    expect(triggerLabel(search.trigger)).toBe('Next-best');
    expect(searchSummary(search)).toBe('3 results · 2 for this episode · picked Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB (score 150)');
    expect(searchSummary({ ...search, state: 'noAcceptable', candidates: [] })).toBe('0 results · no acceptable release');
  });
});

describe('searchIndexerLines (the Candidates tab)', () => {
  const line = (overrides: Partial<TimelineSearchIndexer>): TimelineSearchIndexer => ({ indexerName: 'Nyaa', status: 'error', count: 0, ...overrides });

  test.each([
    [{ status: 'ok', count: 12 }, 'searched', 'Searched: 12 results'],
    [{ status: 'ok', count: 1 }, 'searched', 'Searched: 1 result'],
    [{ status: 'ok', skipped: 'noRequest' }, 'skipped', 'Not searched: no query fits this episode'],
    [{ skipped: 'disabled' }, 'skipped', 'Skipped: disabled'],
    [{ skipped: 'rateLimited' }, 'skipped', 'Skipped: waiting out a rate limit'],
    [{ skipped: 'share' }, 'skipped', "Skipped: its share of today's requests is used"],
    [{ skipped: 'protocol' }, 'skipped', 'Skipped: the release profile or the download client excludes its protocol'],
    [{ skipped: 'noCategories' }, 'skipped', 'Skipped: it has no categories for this kind'],
    [{ skipped: 'category' }, 'skipped', 'Skipped: none of its categories fit (an anime-only indexer, or no categories for this kind)'],
    [{ skipped: 'animeOnly' }, 'skipped', "Skipped: anime-only, and this series isn't numbered as anime"],
    [{ skipped: 'paced' }, 'skipped', 'Skipped: paced, its next request slot was too far off'],
    [{ status: 'timeout', failureCode: 'indexerTimeout' }, 'failed', 'Failed: timed out'],
    [{ status: 'rateLimited', failureCode: 'indexerRateLimited' }, 'failed', 'Failed: rate-limited'],
    [{ status: 'error', failureCode: 'indexerError' }, 'failed', 'Failed: an error, or no answer'],
  ] as const)('%o', (overrides, tone, text) => {
    expect(searchIndexerLines([line(overrides)])).toEqual([{ name: 'Nyaa', tone, text }]);
  });

  test("each search option has its own lines: the last search's, and an older run's", () => {
    const search = (id: string, at: number, indexers: TimelineSearchIndexer[]): TimelineSearch => ({
      searchAttemptId: id as TimelineSearch['searchAttemptId'],
      trigger: 'subscribe',
      state: 'picked',
      at,
      candidates: [],
      indexers,
    });
    const run: TimelineRun = {
      grabId: 'g1' as TimelineRun['grabId'],
      title: 'T',
      state: 'done',
      startedAt: 100,
      cancelRequested: false,
      paused: false,
      pickedBy: 'auto',
      kind: 'initial',
      outcome: 'imported',
      stages: [],
      search: search('s-run', 100, [line({ indexerName: 'Indexer B', status: 'ok', count: 3 })]),
    };
    const lastSearch = search('s-last', 200, [line({ indexerName: 'Indexer A', status: 'timeout' })]);
    const options = searchOptions({ lastSearch, runs: [run] });
    expect(options.map((option) => [option.value, searchIndexerLines(option.search.indexers)])).toEqual([
      ['s-last', [{ name: 'Indexer A', tone: 'failed', text: 'Failed: timed out' }]],
      ['s-run', [{ name: 'Indexer B', tone: 'searched', text: 'Searched: 3 results' }]],
    ]);
  });
});

describe('playText (the "Plays" block)', () => {
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const play = (overrides: Partial<PlayRow> = {}): PlayRow => ({
    deviceName: 'Spike Tablet',
    client: 'Jellyfin Android',
    method: 'directPlay',
    reasons: [],
    startedAt: Date.UTC(2026, 10, 18, 21, 4),
    ...overrides,
  });

  test('a direct play', () => expect(playText(play(), time)).toBe('Spike Tablet · direct play · 21:04'));

  test('a transcode names its reasons', () => {
    expect(playText(play({ deviceName: 'Chrome', method: 'transcode', reasons: ['audioCodec'] }), time)).toBe('Chrome · transcoded: audio codec · 21:04');
    expect(playText(play({ deviceName: 'Chrome', method: 'transcode', reasons: ['container', 'videoRange', 'bitrate'] }), time)).toBe(
      'Chrome · transcoded: container, HDR, bitrate · 21:04',
    );
  });

  test('a transcode without reasons, and a direct stream', () => {
    expect(playText(play({ method: 'transcode' }), time)).toBe('Spike Tablet · transcoded · 21:04');
    expect(playText(play({ method: 'directStream', reasons: ['container'] }), time)).toBe('Spike Tablet · direct stream: container · 21:04');
  });

  test.each([
    ['container', 'container'],
    ['videoCodec', 'video codec'],
    ['videoProfile', 'video profile'],
    ['videoLevel', 'video level'],
    ['videoResolution', 'resolution'],
    ['videoBitDepth', 'bit depth'],
    ['videoRange', 'HDR'],
    ['videoFramerate', 'frame rate'],
    ['audioCodec', 'audio codec'],
    ['audioChannels', 'audio channels'],
    ['audioProfile', 'audio profile'],
    ['subtitle', 'subtitles'],
    ['bitrate', 'bitrate'],
    ['other', 'other'],
  ] as const)('the reason %s reads "%s"', (reason, text) => {
    expect(playText(play({ method: 'transcode', reasons: [reason] }), time)).toBe(`Spike Tablet · transcoded: ${text} · 21:04`);
  });
});

describe('preparation on the timeline and the Work page', () => {
  const event = (message: string, at: number, to?: string): TimelineStage => ({
    stage: 'prepare',
    kind: to === 'done' ? 'stageFinished' : 'stageStarted',
    message,
    at,
    ...(to ? { to } : {}),
  });

  test('a restore reads as "Original restored", not as a preparation', () => {
    const { entries } = preparationEntries([
      event("Restore queued: the kept original fits the library's target.", 1),
      event("Original restored: the kept original fits the library's target.", 2, 'done'),
    ]);
    expect(entries.map(entryTitle)).toEqual(['Original restored']);
  });

  test('a preparation reads as one', () => {
    const { entries } = preparationEntries([event('Preparation queued: audio, subtitle, remux.', 1), event('Prepared: audio, subtitle, remux.', 2, 'done')]);
    expect(entries.map(entryTitle)).toEqual(['Preparation']);
  });

  test('"Prepare now" is offered only while the primary doesn’t fit', () => {
    expect(offersPrepareNow({ state: 'notInTargetFormat' })).toBe(true);
    expect(offersPrepareNow({ state: 'ready' })).toBe(false);
    expect(offersPrepareNow({ state: 'preparing' })).toBe(false);
    expect(offersPrepareNow({ state: 'wanted' })).toBe(false);
  });

  // The item page's runs: newest first with a toggle; a failed run that a later one took over from collapses.
  const run = (overrides: Omit<Partial<TimelineRun>, 'grabId'> & { grabId?: string }): TimelineRun =>
    ({
      grabId: 'g',
      title: 'T',
      state: 'done',
      startedAt: 0,
      cancelRequested: false,
      paused: false,
      outcome: 'imported',
      stages: [],
      ...overrides,
    }) as TimelineRun;
  describe('timelineCards', () => {
    const runs = [
      run({ grabId: 'g3', state: 'downloading', startedAt: 300 }),
      run({ grabId: 'g2', state: 'failed', failureCode: 'parFailed', startedAt: 200 }),
      run({ grabId: 'g1', state: 'failed', failureCode: 'missingArticles', startedAt: 100 }),
    ];
    const entry = { state: 'done' as const, startedAt: 400, endedAt: 450, events: [] };
    const keys = (cards: ReturnType<typeof timelineCards>) => cards.map((card) => ('run' in card ? `run ${card.number}` : 'preparation'));

    test('newest first by default, runs numbered oldest first, preparations among them', () => {
      expect(keys(timelineCards(runs, [entry]))).toEqual(['preparation', 'run 3', 'run 2', 'run 1']);
    });

    test('oldest first on request', () => {
      expect(keys(timelineCards(runs, [entry], 'oldest'))).toEqual(['run 1', 'run 2', 'run 3', 'preparation']);
    });

    test('the runs come in any order', () => {
      expect(keys(timelineCards([...runs].reverse(), []))).toEqual(['run 3', 'run 2', 'run 1']);
    });

    test('a failed run with a later run collapses as recovered; the latest run and a failure with nothing after it stay open', () => {
      const cards = timelineCards(runs, []);
      expect(cards.map((card) => ('run' in card ? card.recovered : undefined))).toEqual([false, true, true]);
      expect(timelineCards([run({ grabId: 'g1', state: 'failed', startedAt: 100 })], []).map((card) => 'run' in card && card.recovered)).toEqual([false]);
    });
  });

  // The percent the client last reported.
  test('runPercent: the client status progress as a whole percent, none before the first report', () => {
    expect(
      runPercent(run({ state: 'downloading', download: { clientStage: 'downloading', clientStatus: { stage: 'DOWNLOADING', progress: 0.614, raw: {} } } })),
    ).toBe(61);
    expect(runPercent(run({ state: 'downloading', download: { clientStage: 'queued' } }))).toBeUndefined();
    expect(runPercent(run({ state: 'downloading' }))).toBeUndefined();
    expect(runPercent(run({ state: 'downloading', download: { clientStage: 'downloading', clientStatus: { stage: 'x', progress: 1.2, raw: {} } } }))).toBe(100);
  });
});
