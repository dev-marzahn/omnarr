// The preparation wording: the "Prepare now" table from
// `units.preparationPlan`, the Preparing row, "Prepare all", the item
// page's Files tab and the timeline's preparation entries. Kept in .ts so the type checker sees it.
import {
  type Comparison,
  type FileRow,
  type PlanStep,
  type PreparationPlan,
  ORIGINAL_RESTORED,
  type RenditionState,
  RESTORE_QUEUED,
  type Sidecar,
  type StreamReason,
  subtitleFormatOf,
  type TimelineStage,
  type UnitRow,
  type WorkFileRow,
} from '@omnarr/contracts';

import { seedingBadge } from './downloads';
import { qualityLabel } from './labels';
import { codecLabel, listOf, stepLabel } from './playback';
import { formatBytes } from './system';
import type { BadgeColor } from './unitStates';

type StreamPlan = Comparison['streams'][number];

/** One row of the table: what happens to a stream or the container, and the step it belongs to. */
export type PlanRow = { text: string; step?: PlanStep };

/** Why a video is transcoded when its codec alone wouldn't say. */
const VIDEO_REASON: Partial<Record<StreamReason, string>> = {
  resolution: 'above the resolution cap',
  bitrate: 'above the bit-rate cap',
  hdr: 'HDR to SDR',
  bitDepth: 'bit depth above the target',
  interlaced: 'deinterlaced',
  dvNoFallback: "Dolby Vision without an HDR10 base layer can't be converted on CPU",
};

/** Why an image subtitle is dropped. For now every image track without a text twin is dropped: OCR comes later. */
const DROP_REASON: Partial<Record<StreamReason, string>> = {
  textTwin: 'a text track has the same language',
  imageSubtitle: 'OCR comes later',
  noOcrLanguage: 'no OCR for its language',
};

/** "HEVC → H.264", or just "H.264" when the codec stays. */
const change = (from: string, to: string | undefined): string =>
  to === undefined || to === from ? codecLabel(from) : `${codecLabel(from)} → ${codecLabel(to)}`;

function videoRow(stream: StreamPlan): PlanRow {
  if (stream.action === 'drop') return { text: `Video ${codecLabel(stream.from)} · dropped (extra video stream)` };
  if (stream.action !== 'transcode') return { text: `Video ${codecLabel(stream.from)} · copied` };
  // A transcode without a reason of its own burns in a subtitle.
  const why = stream.reason === undefined ? 'to burn in subtitles' : VIDEO_REASON[stream.reason];
  return { text: `Video transcode ${change(stream.from, stream.to)}${why ? ` · ${why}` : ''}`, step: 'video' };
}

function audioRow(stream: StreamPlan): PlanRow {
  if (stream.action !== 'transcode') return { text: `Audio ${codecLabel(stream.from)} · copied` };
  return { text: `Audio ${change(stream.from, stream.to)}${stream.reason === 'channels' ? ' · downmixed' : ''}`, step: 'audio' };
}

function subtitleRow(stream: StreamPlan): PlanRow {
  const name = subtitleFormatOf(stream.from) === 'image' ? `${codecLabel(stream.from)} (image)` : `Subtitle ${codecLabel(stream.from)}`;
  switch (stream.action) {
    case 'copy':
      return { text: `${name} · kept in the file` };
    case 'extract':
      return { text: `${name} → sidecar .${stream.to ?? 'srt'}`, step: 'subtitle' };
    case 'ocr':
      return { text: `${name} → text by OCR`, step: 'subtitle' };
    case 'burnIn':
      return { text: `${name} → burned into the video`, step: 'subtitle' };
    default: {
      const why = stream.reason === undefined ? undefined : DROP_REASON[stream.reason];
      return { text: `${name} → dropped${why ? ` (${why})` : ''}`, step: 'subtitle' };
    }
  }
}

const ROW = { video: videoRow, audio: audioRow, subtitle: subtitleRow } as const;

// ---- The modal around the table ----

const pad = (n: number | undefined): string => String(n ?? 0).padStart(2, '0');

/** 'Prepare S01E01 "Pilot"?', or 'Prepare "Northern Line"?' for a movie. */
export function prepareTitle(unit: Pick<UnitRow, 'kind' | 'tmdbSeason' | 'tmdbEpisode' | 'title'>, workTitle: string): string {
  if (unit.kind === 'movie') return `Prepare "${unit.title ?? workTitle}"?`;
  const numbers = `S${pad(unit.tmdbSeason)}E${pad(unit.tmdbEpisode)}`;
  return `Prepare ${numbers}${unit.title ? ` "${unit.title}"` : ''}?`;
}

const SOURCE: Record<PreparationPlan['origin'], string> = {
  scan: 'File from the untracked-media scan',
  download: 'Downloaded file',
  prepared: 'Prepared file',
};
export const planSource = (plan: PreparationPlan): string => SOURCE[plan.origin];

export type Notice = { color: 'warning' | 'success'; title: string; description: string };

/** The alert above the table: already queued, already fitting, or only cheap steps. */
export function planNotice(plan: PreparationPlan): Notice | undefined {
  if (plan.queued)
    return { color: 'warning', title: 'This file is already queued for preparation', description: 'Preparing now replaces that queued job with this one.' };
  const { steps } = plan.comparison;
  if (plan.comparison.fits) return { color: 'success', title: 'This file already fits the target', description: 'There is nothing to prepare.' };
  if (steps.includes('video')) return undefined;
  return {
    color: 'success',
    title: 'Video already fits',
    description: `Steps: ${stepsText(steps)}. No video transcode, so this takes minutes.`,
  };
}

/** The preparation plan's "While it runs" box. */
export function whileItRuns(plan: PreparationPlan, kind: UnitRow['kind']): string {
  const slow = plan.comparison.steps.includes('video')
    ? 'The video transcode is the slow step; preparation runs one file at a time.'
    : 'Preparation runs one file at a time.';
  return `The ${kind === 'movie' ? 'movie' : 'episode'} shows "Preparing". The current file stays in the library and plays as it is until the new file passes the ffprobe check. ${slow}`;
}

/** "audio conversion and remux". */
const stepsText = (steps: readonly PlanStep[]): string => listOf(steps.map((step) => stepLabel(step).toLowerCase()));

// ---- The Preparing row and Prepare all ----

/** The Work page's Preparing row: the worker's detail and progress; the steps while it has no detail; "Waiting for the worker" while queued. */
export function preparingLine(preparation: NonNullable<UnitRow['preparation']>): { text: string; percent?: number } {
  const percent = preparation.fraction === undefined ? {} : { percent: Math.floor(preparation.fraction * 100) };
  if (preparation.detail) return { text: preparation.detail, ...percent };
  if (preparation.fraction === undefined || preparation.steps.length === 0) return { text: 'Waiting for the worker' };
  const steps = stepsText(preparation.steps);
  return { text: steps.charAt(0).toUpperCase() + steps.slice(1), ...percent };
}

export const prepareAllLabel = (count: number): string => `Prepare all (${count})`;

/**
 * The confirm dialog of "Prepare all". `library.detail` doesn't say
 * how many of the files were scanned, so the dialog says what happens to
 * scanned files without a count.
 */
export function prepareAllDialog({ count, workTitle, keepOriginal }: { count: number; workTitle: string; keepOriginal: boolean }) {
  const one = count === 1;
  return {
    title: `Prepare ${one ? '1 file' : `all ${count} files`}?`,
    lines: [
      `${count} ${one ? 'file' : 'files'} of ${workTitle} ${one ? "isn't" : "aren't"} in the target format.`,
      one
        ? "It is prepared after new downloads' preparations. It plays as it is until its prepared copy passes the check."
        : "They are prepared one at a time, after new downloads' preparations. Each plays as it is until its prepared copy passes the check.",
      keepOriginal
        ? 'Originals are kept outside the library for re-preparation.'
        : 'Scanned files are replaced by their prepared copies: each is deleted once its copy passes the check.',
    ],
    confirm: prepareAllLabel(count),
  };
}

export function prepareAllToast(queued: number): { title: string; description?: string } {
  if (queued === 0) return { title: 'Nothing to prepare', description: 'Every file fits or is already queued.' };
  return { title: `Queued ${queued} ${queued === 1 ? 'file' : 'files'} for preparation` };
}

// ---- The Files tab ----

const KIND_ORDER: FileRow['kind'][] = ['primary', 'staged', 'original', 'alternate'];
const KIND_LABEL: Record<FileRow['kind'], string> = {
  primary: 'In the library',
  staged: 'Prepared · waiting for Jellyfin',
  original: 'Kept original',
  alternate: 'Alternate version',
};
const ORIGIN_LABEL: Record<FileRow['origin'], string> = { download: 'Downloaded', scan: 'Scanned', prepared: 'Prepared' };

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const languageName = (language: Sidecar['language']): string =>
  language === undefined ? 'Unknown language' : language === 'multi' ? 'Multiple languages' : (languageNames.of(language) ?? language);

/** "English forced · SRT". */
const sidecarLabel = (sidecar: Sidecar): string =>
  `${[languageName(sidecar.language), ...(sidecar.forced ? ['forced'] : []), ...(sidecar.sdh ? ['SDH'] : [])].join(' ')} · ${sidecar.format.toUpperCase()}`;

export type FileTabRow = {
  fileId: FileRow['fileId'];
  name: string;
  folder: string;
  kind: string;
  origin: string;
  fit: { text: string; fits: boolean };
  sidecars: string[];
};

function fitOf(file: FileRow): FileTabRow['fit'] {
  if (file.kind === 'original') return { text: 'Kept outside the library for re-preparation', fits: file.fits };
  if (file.fits) return { text: 'Fits the target', fits: true };
  return { text: file.steps.length ? `Needs ${stepsText(file.steps)}` : "Doesn't fit the target", fits: false };
}

/** The Unit's file versions, primary first, then the staged one, the kept original and alternates. */
export function fileRows(files: readonly FileRow[]): FileTabRow[] {
  return [...files]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((file) => {
      const slash = file.path.lastIndexOf('/');
      return {
        fileId: file.fileId,
        name: file.path.slice(slash + 1),
        folder: file.path.slice(0, Math.max(slash, 0)),
        kind: file.missingSince === undefined ? KIND_LABEL[file.kind] : 'Missing from disk',
        origin: ORIGIN_LABEL[file.origin],
        fit: fitOf(file),
        sidecars: file.sidecars.map(sidecarLabel),
      };
    });
}

export type WorkFileTabRow = Omit<FileTabRow, 'fileId'> & {
  key: string;
  unitId: WorkFileRow['unitId'];
  unit: string;
  size: string;
  quality?: string;
  /** A pending Rendition of the Unit: "Preparing · Audio conversion · 40%". */
  preparing?: string;
  /** The file's torrent still seeds: "Seeding 40%". */
  seeding?: string;
  /** The one file action: "Prepare now" on a primary that doesn't fit. */
  prepareNow: boolean;
};

/** The Work page's Files tab: the item page's rows, each with its episode, size and quality, in the backend's episode order. */
export function workFileRows(files: readonly WorkFileRow[], units: readonly UnitRow[]): WorkFileTabRow[] {
  const unitOf = new Map(units.map((unit) => [unit.unitId, unit]));
  return files.map((file) => {
    const { fileId: _, ...row } = fileRows([file])[0]!;
    const unit = unitOf.get(file.unitId);
    const preparing = file.kind === 'primary' && unit?.preparation ? preparingLine(unit.preparation) : undefined;
    return {
      key: `${file.fileId}:${file.unitId}:${file.kind}`,
      unitId: file.unitId,
      unit: `S${pad(file.tmdbSeason)}E${pad(file.tmdbEpisode)}`,
      ...row,
      size: formatBytes(file.sizeBytes),
      ...(file.quality ? { quality: qualityLabel(file.quality) } : {}),
      ...(preparing ? { preparing: ['Preparing', preparing.text, ...(preparing.percent === undefined ? [] : [`${preparing.percent}%`])].join(' · ') } : {}),
      ...(file.seeding ? { seeding: seedingBadge(file.seeding) } : {}),
      prepareNow: file.kind === 'primary' && !file.fits && unit?.state === 'notInTargetFormat' && !unit.preparation,
    };
  });
}

// ---- The timeline's preparation entries ----

export type PreparationEntry = { state: RenditionState; startedAt: number; endedAt?: number; events: TimelineStage[] };

const TERMINAL: readonly string[] = ['done', 'failed', 'cancelled'];

/**
 * Splits the Unit's events outside runs into one entry per Rendition (frames
 * 4.1, 5.3), newest first, and the rest. The DTO carries no Rendition ID, so
 * an entry starts at a `prepare` event that moves to `pending` (or one that
 * starts a stage after the last entry ended) and ends at its move to `done`,
 * `failed` or `cancelled`. Other `prepare` events, such as the dropped-track
 * note, and the `publish` events after it (the prepared file's Jellyfin
 * refresh) belong to the latest entry.
 */
export function preparationEntries(events: readonly TimelineStage[]): { entries: PreparationEntry[]; others: TimelineStage[] } {
  const entries: PreparationEntry[] = [];
  const others: TimelineStage[] = [];
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    let current = entries.at(-1);
    if (event.stage === 'prepare') {
      if (!current || event.to === 'pending' || (current.state !== 'pending' && event.kind === 'stageStarted')) {
        current = { state: 'pending', startedAt: event.at, events: [] };
        entries.push(current);
      }
      current.events.push(event);
      if (event.to && TERMINAL.includes(event.to)) {
        current.state = event.to as RenditionState;
        current.endedAt = event.at;
      }
    } else if (event.stage === 'publish' && current) {
      current.events.push(event);
      if (current.state !== 'pending') current.endedAt = event.at;
    } else others.push(event);
  }
  return { entries: entries.reverse(), others };
}

const ENTRY_STATE: Record<RenditionState, { state: string; color: BadgeColor }> = {
  pending: { state: 'Preparing', color: 'secondary' },
  done: { state: 'Done', color: 'success' },
  failed: { state: 'Failed', color: 'error' },
  cancelled: { state: 'Cancelled', color: 'neutral' },
};

export const entryHeader = (entry: PreparationEntry): { state: string; color: BadgeColor } => ENTRY_STATE[entry.state];

/** An entry's title: a restored kept original reads as one, not as a preparation. */
export const entryTitle = (entry: PreparationEntry): string =>
  entry.events.some((event) => event.message === RESTORE_QUEUED || event.message === ORIGINAL_RESTORED) ? 'Original restored' : 'Preparation';

/** "Prepare now" only while the primary doesn't fit: a fitting kept original is restored by a profile edit. */
export const offersPrepareNow = (unit: Pick<UnitRow, 'state'>): boolean => unit.state === 'notInTargetFormat';

/** What happens to the source once the prepared file passes the check. */
export function originalAfterwards(origin: PreparationPlan['origin'], keepOriginal: boolean): string {
  if (keepOriginal) return 'Afterwards the original is kept outside the library for re-preparation.';
  if (origin === 'scan') return 'Afterwards your scanned file is deleted: the prepared copy replaces it once it passes the check.';
  return 'Afterwards the prepared file replaces the original.';
}

/** The plan table's Step column: the video step says it is the slow one. */
export const stepTag = (step: PlanStep): string => (step === 'video' ? 'Full video transcode (CPU)' : stepLabel(step));

/** The plan table: each stream in file order, then the container. */
export function planRows(comparison: Comparison): PlanRow[] {
  const { container } = comparison;
  return [
    ...comparison.streams.map((stream) => ROW[stream.kind](stream)),
    container.change
      ? { text: `Remux ${codecLabel(container.from)} → ${codecLabel(container.to)}`, step: 'remux' }
      : { text: `Container ${codecLabel(container.to)} · kept` },
  ];
}
