// The item page's wording: run headers, search summaries, the candidate
// table, and the plays. It only reads stored decision records. Kept in .ts
// so the type checker sees it.
import type {
  CandidateReason,
  CandidateRow,
  CandidateUnit,
  FailureCode,
  GrabCandidateResponse,
  LostOn,
  PlayRow,
  ScoreBreakdown,
  StoredPlayMethod,
  Timeline,
  TimelineRun,
  TimelineSearch,
  TimelineSearchIndexer,
  TimelineStage,
  TranscodeReason,
} from '@omnarr/contracts';

import { qualityLabel } from './labels';
import type { PreparationEntry } from './preparation';
import type { BadgeColor } from './unitStates';

const TRIGGERS: Record<TimelineSearch['trigger'], string> = {
  subscribe: 'Subscribe',
  rss: 'RSS',
  backfill: 'Backfill',
  manual: 'Search now',
  nextBest: 'Next-best',
  interactive: 'Search and pick',
  upgrade: 'Upgrade search',
};
export const triggerLabel = (trigger: TimelineSearch['trigger']): string => TRIGGERS[trigger];

const REASONS: Record<CandidateReason, string> = {
  notInProfile: 'Not in profile',
  sizeOutOfRange: 'Size out of range',
  belowMinimumScore: 'Below the minimum score',
  language: 'Language',
  noSeeders: 'No seeders',
  wrongTitleOrEpisode: 'Wrong title or episode',
  blocklisted: 'Blocklisted',
  lowerScore: 'Ranked lower',
  needsMorePreparation: 'Ranked lower',
  unitBusy: 'Episode already being grabbed',
  notAnUpgrade: 'Not an upgrade',
  partialUpgrade: 'Leaves other episodes on the old file',
};

const LOST_ON: Record<LostOn, string> = {
  seasonPack: 'season pack preferred',
  preparation: 'needs more preparation',
  quality: 'quality',
  score: 'score',
  tieBreak: 'tie-break',
};

/**
 * The Decision column: "Picked" (by you), an offered row's "Would pick" or
 * "Ranked n", a rejection reason, or "Ranked lower: <key>". A wrong
 * title or episode says which, and unclear numbering says so.
 */
export function decisionText(candidate: CandidateRow): string {
  if (candidate.outcome === 'picked') return candidate.pickedBy === 'user' ? 'Picked by you' : 'Picked';
  if (candidate.outcome === 'pending') return candidate.rank === 1 ? 'Would pick' : candidate.rank !== undefined ? `Ranked ${candidate.rank}` : 'Pending';
  if (candidate.reason === 'wrongTitleOrEpisode') {
    if (candidate.matchProblem === 'ambiguous') return 'Unclear numbering';
    if (candidate.matchDetail === 'title') return 'Wrong title';
    if (candidate.matchDetail === 'episode' || candidate.matchDetail === 'otherEpisode') return 'Wrong episode';
  }
  const reason = candidate.reason ? REASONS[candidate.reason] : 'Rejected';
  return candidate.lostOn ? `${reason}: ${LOST_ON[candidate.lostOn]}` : reason;
}

const pad2 = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
/** `S03E02`. */
export const unitLabel = (unit: CandidateUnit): string => `S${pad2(unit.tmdbSeason)}E${pad2(unit.tmdbEpisode)}`;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
/** "German", "German and French": the release's languages in words. */
function languagesText(candidate: CandidateRow): string | undefined {
  const codes = (candidate.parsed.languages ?? []).filter((code) => code !== 'multi');
  if (codes.length === 0) return undefined;
  const names = codes.map((code) => {
    try {
      return languageNames.of(code) ?? code;
    } catch {
      return code;
    }
  });
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The Decision column's second line: what an unclear release could be, the language, or when and why it was blocklisted. */
export function decisionDetail(candidate: CandidateRow): string | undefined {
  if (candidate.matchProblem === 'ambiguous' && candidate.possibleUnits?.length) return `Could be ${candidate.possibleUnits.map(unitLabel).join(' or ')}`;
  if (candidate.reason === 'language') return languagesText(candidate);
  if (candidate.reason === 'blocklisted' && candidate.blocklisted)
    return `${capitalised(candidate.blocklisted.reason === 'manual' ? 'blocklisted by you' : failureText(candidate.blocklisted.reason))}, ${shortDate.format(candidate.blocklisted.at)}`;
  return undefined;
}

/** The releases of unclear numbering that may be this Unit: the Candidates tab's alert counts them. */
export const unclearCount = (search: TimelineSearch): number =>
  search.candidates.filter((candidate) => candidate.matchProblem === 'ambiguous' && candidate.coversUnit).length;

export type OfferState = { state: 'running' } | { state: 'offered'; minutesLeft: number } | { state: 'expired' } | { state: 'picked' } | { state: 'auto' };

/** "Search and pick": running, then offered for an hour, then read-only; an automatic search is never offered. */
export function searchOfferState(search: TimelineSearch, now: number): OfferState {
  if (search.trigger !== 'interactive') return { state: 'auto' };
  if (search.state === 'running') return { state: 'running' };
  if (search.state !== 'offered') return { state: 'picked' };
  const left = (search.offeredUntil ?? search.at) - now;
  return left > 0 ? { state: 'offered', minutesLeft: Math.ceil(left / 60_000) } : { state: 'expired' };
}

/**
 * A release whose numbering didn't decide its Units, or whose title wasn't
 * recognised ("Possibly misread"), which a manual grab imports as the
 * search's Unit.
 */
const importedAsChosen = (candidate: CandidateRow) =>
  candidate.reason === 'wrongTitleOrEpisode' &&
  (candidate.matchDetail === 'episode' || candidate.matchDetail === 'otherEpisode' || candidate.matchDetail === 'title');

/**
 * A row's Grab: shown on every row of an offered search; the
 * row ranked first is primary, else the first row; a pack of unclear
 * numbering is disabled, since v1 imports a manual grab as one Unit.
 */
export function grabButton(candidate: CandidateRow, search: TimelineSearch, now: number): { show: boolean; primary?: boolean; disabled?: string } {
  if (searchOfferState(search, now).state !== 'offered') return { show: false };
  const best = search.candidates.find((row) => row.outcome === 'pending' && row.rank === 1) ?? search.candidates[0];
  const primary = best?.candidateId === candidate.candidateId;
  if (importedAsChosen(candidate) && candidate.parsed.pack) return { show: true, primary: false, disabled: 'A pack needs a clear season' };
  return { show: true, primary };
}

/** The Units a grab covers, as the confirm names them: one episode, a range of one season, or a whole season for a pack. */
export function grabUnitsLabel(candidate: CandidateRow): string {
  const units = [...candidate.covers].sort((a, b) => (a.tmdbSeason ?? 0) - (b.tmdbSeason ?? 0) || (a.tmdbEpisode ?? 0) - (b.tmdbEpisode ?? 0));
  const pack = candidate.parsed.pack;
  if (pack?.full && pack.seasons.length === 1) return `Season ${pack.seasons[0]}`;
  if (units.length === 0) return 'this episode';
  if (units.length === 1) return unitLabel(units[0]!);
  const first = units[0]!;
  const last = units.at(-1)!;
  const consecutive = units.every((unit, i) => unit.tmdbSeason === first.tmdbSeason && unit.tmdbEpisode === (first.tmdbEpisode ?? 0) + i);
  return consecutive ? `${unitLabel(first)}–E${pad2(last.tmdbEpisode)}` : units.map(unitLabel).join(', ');
}

export type GrabConfirmText = { title: string; button: string; boxes: { kind: 'warning' | 'info'; text: string }[]; note: string };

const IMPORTS_NORMALLY: Partial<Record<CandidateReason, string>> = {
  notInProfile: "Not in profile: its quality isn't in the release profile.",
  sizeOutOfRange: "Size out of range: it is outside the profile's size limits for this episode.",
  belowMinimumScore: 'Below the minimum score: it scores lower than the release profile takes.',
  noSeeders: 'No seeders: the indexer listed none, so it may never finish.',
  lowerScore: 'It ranked lower than another release.',
  needsMorePreparation: 'It needs more preparation than another release.',
};

/**
 * The grab confirm: its title and button name the Units, and a
 * box says what the rejection means for this grab; a release the user picks
 * is never followed by another by itself.
 */
export function grabConfirm(candidate: CandidateRow, context: { unitTitle?: string; workTitle?: string }): GrabConfirmText {
  const units = grabUnitsLabel(candidate);
  const wrongTitle = candidate.reason === 'wrongTitleOrEpisode' && candidate.matchDetail === 'title';
  const boxes: GrabConfirmText['boxes'] = [];
  if (importedAsChosen(candidate)) {
    const could =
      candidate.matchProblem === 'ambiguous' && candidate.possibleUnits?.length
        ? `it could be ${candidate.possibleUnits.map(unitLabel).join(' or ')}`
        : undefined;
    const as = `${units}${context.unitTitle ? ` · ${context.unitTitle}` : ''}`;
    const why = wrongTitle
      ? `This looks like another series: ${candidate.parsed.title || candidate.title}.`
      : could
        ? `Its numbering is unclear: ${could}.`
        : "Its numbers don't name this episode.";
    boxes.push({ kind: 'warning', text: `${why} omnarr imports it as ${as}, whatever its name says. Check the title before you grab it.` });
  } else if (candidate.reason === 'blocklisted') {
    const entry = candidate.blocklisted;
    const why = entry
      ? entry.reason === 'manual'
        ? `You blocklisted it on ${shortDate.format(entry.at)}.`
        : `It failed on ${shortDate.format(entry.at)} with ${failureText(entry.reason)}.`
      : '';
    boxes.push({
      kind: 'warning',
      text: `This release is blocklisted${context.workTitle ? ` for ${context.workTitle}` : ''}.${why ? ` ${why}` : ''} Grabbing removes it from the blocklist first.`,
    });
  } else if (candidate.reason === 'language')
    boxes.push({ kind: 'info', text: `Language: ${languagesText(candidate) ?? 'unknown'}, which the release profile doesn't take. It imports normally.` });
  else if (candidate.reason && IMPORTS_NORMALLY[candidate.reason])
    boxes.push({ kind: 'info', text: `${IMPORTS_NORMALLY[candidate.reason]} It imports normally.` });
  return {
    title: `Grab this release for ${units}?`,
    button: `${wrongTitle ? 'Grab anyway' : 'Grab'} for ${units}`,
    boxes,
    note: "If this download fails, omnarr blocklists it and doesn't try another release by itself, because you picked this one.",
  };
}

/** A refused grab: what to say and which way out to offer. */
export function grabRefusal(
  response: Exclude<GrabCandidateResponse, { outcome: 'grabbed' }>,
  units: string,
  runNumber?: number,
): { text: string; action?: 'searchAgain' | 'cancelGrab' } {
  if (response.outcome === 'expired') return { text: 'These results are over an hour old. Search again to grab from fresh ones.', action: 'searchAgain' };
  if (response.outcome === 'busy')
    return { text: `${units} is already downloading${runNumber ? ` (Run ${runNumber})` : ''}. Cancel that grab first.`, action: 'cancelGrab' };
  return { text: 'A pack needs a clear season.' };
}

export const grabbedToast = (units: string, runNumber: number): string => `Grabbed for ${units} · Run ${runNumber} started`;

/** The pick step of a manual grab: the search's decision that names the picked release. */
export const isPickStage = (stage: TimelineStage): boolean => stage.stage === 'search' && stage.kind === 'decision' && stage.message.startsWith('You picked');

/** The pick step's text: what the user picked it over. */
export function pickStepText(stage: TimelineStage, picked: CandidateRow | undefined): string {
  switch (stage.confirmReason) {
    case 'wrongTitleOrEpisode':
      if (picked?.matchProblem === 'ambiguous' || picked?.matchDetail === 'episode') return 'You picked a release with unclear numbering';
      return picked?.matchDetail === 'title' ? 'You picked a release of another title' : 'You picked a release of another episode';
    case 'language': {
      const language = picked && languagesText(picked);
      return language ? `You picked a release in ${language}` : 'You picked a release in another language';
    }
    case 'blocklisted':
      return 'You picked a release that was blocklisted (removed from the blocklist)';
    case undefined:
      return 'You picked this release';
    default:
      return `You picked a release the profile rejected (${REASONS[stage.confirmReason].toLowerCase()})`;
  }
}

const searchTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The Candidates tab's choice of search: the last search without a run, then each run's, newest first, each once. */
export function searchOptions(timeline: Pick<Timeline, 'runs' | 'lastSearch'>): { value: string; label: string; search: TimelineSearch }[] {
  const all = [...(timeline.lastSearch ? [timeline.lastSearch] : []), ...timeline.runs.map((run) => run.search)];
  const seen = new Set<string>();
  return all
    .filter((search) => (seen.has(search.searchAttemptId) ? false : (seen.add(search.searchAttemptId), true)))
    .sort((a, b) => b.at - a.at)
    .map((search) => ({ value: search.searchAttemptId, label: `${triggerLabel(search.trigger)} · ${searchTime.format(search.at)}`, search }));
}

const BAD_RELEASE: readonly FailureCode[] = [
  'missingArticles',
  'parFailed',
  'unpackFailed',
  'passwordProtected',
  'noMediaFile',
  'fakeOrWrongContent',
  'torrentStalled',
  'importMismatch',
  'releaseFileInvalid',
];

/**
 * The picked-release alert: the newest run is a release the user picked that failed
 * as a bad release, so omnarr tried no other; it shows until a newer search
 * or run exists.
 */
export function pickedReleaseFailed(timeline: Pick<Timeline, 'runs' | 'lastSearch'>): boolean {
  const newest = [...timeline.runs].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!newest || newest.pickedBy !== 'user' || newest.state !== 'failed' || !newest.failureCode || !BAD_RELEASE.includes(newest.failureCode)) return false;
  return !(timeline.lastSearch && timeline.lastSearch.at > newest.startedAt);
}

const signed = (points: number) => (points < 0 ? `−${-points}` : `+${points}`);

/** One score entry; a preparation entry from an assumed field says so. */
export const breakdownText = (entry: ScoreBreakdown[number], preparationAssumed: boolean): string =>
  `${entry.name} ${signed(entry.points)}${entry.kind === 'preparation' && preparationAssumed ? ' (assumed)' : ''}`;

export const qualityText = (candidate: CandidateRow): string => `${qualityLabel(candidate.quality)}${candidate.qualityAssumed ? ' (assumed)' : ''}`;

const FAILURES: Partial<Record<FailureCode, string>> = {
  missingArticles: 'missing articles',
  parFailed: 'repair failed',
  unpackFailed: 'unpack failed',
  passwordProtected: 'password protected',
  noMediaFile: 'no video file',
  fakeOrWrongContent: 'not a video',
  torrentStalled: 'stalled',
  importMismatch: 'wrong episode',
  releaseFileInvalid: 'release file missing or invalid',
  releaseFetchFailed: "couldn't fetch the release file",
  clientUnreachable: 'download client unreachable',
  unknownClientFailure: 'unknown download client answer',
  leaseExpired: 'worker lost the job',
  jellyfinUnavailable: 'Jellyfin unavailable',
  diskFull: 'disk full',
  pipelineError: 'pipeline error',
  transcodeFailed: 'preparation failed',
  storageUnavailable: 'storage unavailable',
  vpnDown: 'VPN down',
};
export const failureText = (code: FailureCode): string => FAILURES[code] ?? code;

const RUN_STATES: Record<TimelineRun['state'], { state: string; color: BadgeColor }> = {
  submitting: { state: 'Sending to the client', color: 'info' },
  downloading: { state: 'Downloading', color: 'info' },
  importing: { state: 'Importing', color: 'info' },
  publishing: { state: 'Publishing', color: 'info' },
  done: { state: 'Done', color: 'success' },
  failed: { state: 'Failed', color: 'error' },
  cancelled: { state: 'Cancelled', color: 'neutral' },
};

/** "Run 2 · Done": the run's number on the page (oldest is 1), its state, and why it failed. */
export function runHeader(run: TimelineRun, number: number): { label: string; state: string; color: BadgeColor } {
  const label = run.kind === 'upgrade' ? `Run ${number} · Upgrade` : `Run ${number}`;
  if (run.cancelRequested && run.state !== 'cancelled') return { label, state: 'Cancelling…', color: 'warning' };
  if (run.paused) return { label, state: 'Paused · waiting for a fix', color: 'warning' };
  const { state, color } = RUN_STATES[run.state];
  return { label, state: run.state === 'failed' && run.failureCode ? `${state} · ${failureText(run.failureCode)}` : state, color };
}

/** The run ID, as the copy button shows it: `k97f3a2c…c21`. */
export const shortRunId = (grabId: string): string => (grabId.length > 14 ? `${grabId.slice(0, 8)}…${grabId.slice(-3)}` : grabId);

const PLAY_METHODS: Record<StoredPlayMethod, string> = {
  directPlay: 'direct play',
  remux: 'remuxed',
  transcode: 'transcoded',
  // A play stored before the method came from Jellyfin's transcode job; it may have converted the audio.
  directStream: 'direct stream',
};

const TRANSCODE_REASONS: Record<TranscodeReason, string> = {
  container: 'container',
  videoCodec: 'video codec',
  videoProfile: 'video profile',
  videoLevel: 'video level',
  videoResolution: 'resolution',
  videoBitDepth: 'bit depth',
  videoRange: 'HDR',
  videoFramerate: 'frame rate',
  audioCodec: 'audio codec',
  audioChannels: 'audio channels',
  audioProfile: 'audio profile',
  subtitle: 'subtitles',
  bitrate: 'bitrate',
  other: 'other',
  externalAudio: 'external audio',
  secondaryAudio: 'second audio track',
  refFrames: 'reference frames',
  anamorphic: 'anamorphic video',
  interlaced: 'interlaced video',
  audioSampleRate: 'audio sample rate',
  audioBitDepth: 'audio bit depth',
  unknownStream: 'unknown stream',
  directPlayFailed: 'direct play failed',
  videoCodecTag: 'video codec tag',
  streamCount: 'too many streams',
  videoRotation: 'rotated video',
};

/**
 * One line of "Plays": "Spike Tablet · direct play · 21:04", "Pixel ·
 * remuxed: direct play failed · 21:04", "Chrome · transcoded: audio codec · 21:04".
 */
export function playText(play: PlayRow, formatTime: (ms: number) => string): string {
  const method = PLAY_METHODS[play.method];
  const how = play.reasons.length ? `${method}: ${play.reasons.map((reason) => TRANSCODE_REASONS[reason]).join(', ')}` : method;
  return `${play.deviceName} · ${how} · ${formatTime(play.startedAt)}`;
}

export type TimelineCard =
  | { key: string; at: number; run: TimelineRun; number: number; recovered: boolean }
  | { key: string; at: number; entry: PreparationEntry };

/**
 * The item page's runs and preparation entries, newest first or
 * oldest first. Runs are numbered oldest first. A failed run that a later run
 * took over from is `recovered`: it shows collapsed.
 */
export function timelineCards(runs: readonly TimelineRun[], entries: readonly PreparationEntry[], order: 'newest' | 'oldest' = 'newest'): TimelineCard[] {
  const oldestFirst = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const cards: TimelineCard[] = [
    ...oldestFirst.map((run, i) => ({
      key: run.grabId,
      at: run.startedAt,
      run,
      number: i + 1,
      recovered: run.state === 'failed' && i < oldestFirst.length - 1,
    })),
    ...entries.map((entry) => ({ key: `prep:${entry.startedAt}`, at: entry.startedAt, entry })),
  ];
  return cards.sort((a, b) => (order === 'newest' ? b.at - a.at : a.at - b.at));
}

/** The percent the download client last reported for the run. */
export function runPercent(run: Pick<TimelineRun, 'download'>): number | undefined {
  const progress = run.download?.clientStatus?.progress;
  return progress === undefined ? undefined : Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** "23 results · 9 for this episode · picked <title> (score 1700)". */
const SKIPS: Record<NonNullable<TimelineSearchIndexer['skipped']>, string> = {
  noRequest: 'Not searched: no query fits this episode',
  disabled: 'Skipped: disabled',
  rateLimited: 'Skipped: waiting out a rate limit',
  share: "Skipped: its share of today's requests is used",
  protocol: 'Skipped: the release profile or the download client excludes its protocol',
  noCategories: 'Skipped: it has no categories for this kind',
  // Stored before `category` was split into `noCategories` and `animeOnly`, for either reason.
  category: 'Skipped: none of its categories fit (an anime-only indexer, or no categories for this kind)',
  animeOnly: "Skipped: anime-only, and this series isn't numbered as anime",
  paced: 'Skipped: paced, its next request slot was too far off',
};
const CALL_FAILURES: Record<Exclude<TimelineSearchIndexer['status'], 'ok'>, string> = {
  timeout: 'Failed: timed out',
  rateLimited: 'Failed: rate-limited',
  error: 'Failed: an error, or no answer',
};

export type SearchIndexerLine = { name: string; tone: 'searched' | 'skipped' | 'failed'; text: string };

/**
 * The Candidates tab's line per indexer of the chosen search, the last one or
 * a run's: what it found, or why it was skipped or failed.
 */
export function searchIndexerLines(indexers: TimelineSearchIndexer[]): SearchIndexerLine[] {
  return indexers.map(({ indexerName: name, status, count, skipped }) => {
    if (skipped) return { name, tone: 'skipped', text: SKIPS[skipped] };
    if (status !== 'ok') return { name, tone: 'failed', text: CALL_FAILURES[status] };
    return { name, tone: 'searched', text: `Searched: ${count} result${count === 1 ? '' : 's'}` };
  });
}

export function searchSummary(search: TimelineSearch): string {
  const parts = [`${search.candidates.length} result${search.candidates.length === 1 ? '' : 's'}`];
  const mine = search.candidates.filter((candidate) => candidate.coversUnit).length;
  if (mine > 0) parts.push(`${mine} for this episode`);
  const picked = search.candidates.find((candidate) => candidate.outcome === 'picked' && candidate.coversUnit);
  if (picked) parts.push(`picked ${picked.title} (score ${picked.score})`);
  else if (search.state === 'noAcceptable') parts.push('no acceptable release');
  else if (search.state === 'failed') parts.push('no indexer answered');
  return parts.join(' · ');
}
