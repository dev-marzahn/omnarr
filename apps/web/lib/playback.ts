// The playback-profile page's wording and draft logic: device cards, the
// target table and its cap field, "Edit directly", and the save dialog's
// counts. The step and codec labels are shared with the
// preparation wording (lib/preparation.ts). Kept in .ts so the type checker
// sees it.
import {
  type ChangePreview,
  DEFAULT_LIMITS,
  type DeviceCard,
  DeviceId,
  type PlanStep,
  type PlaybackDraft,
  type PlaybackProfileDetail,
  type SubtitleMode,
  type TargetContainer,
  type TargetFormat,
  targetForDevices,
  type TargetHdr,
} from '@omnarr/contracts';

const STEP_LABEL: Record<PlanStep, string> = {
  video: 'Video transcode',
  audio: 'Audio conversion',
  subtitle: 'Subtitle conversion',
  remux: 'Remux',
};

/** A preparation step as the item page and the playback page name it. */
export const stepLabel = (step: PlanStep): string => STEP_LABEL[step];

/** ffprobe's and the target's codec and container names, as the UI writes them. */
const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  vc1: 'VC-1',
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  opus: 'Opus',
  flac: 'FLAC',
  mp3: 'MP3',
  truehd: 'TrueHD',
  dts: 'DTS',
  vorbis: 'Vorbis',
  mp4: 'MP4',
  mkv: 'MKV',
  matroska: 'Matroska',
  webm: 'WebM',
  mpegts: 'MPEG-TS',
  avi: 'AVI',
  subrip: 'SubRip',
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  mov_text: 'MP4 text',
  text: 'Text',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  xsub: 'XSUB',
};

/** "H.264", "E-AC-3", "SubRip"; a codec not listed here keeps ffprobe's name. */
export const codecLabel = (codec: string): string => CODEC_LABEL[codec] ?? codec;

const formats = (list: readonly string[]): string => list.map(codecLabel).join(', ');

const HDR_LABEL: Record<TargetHdr, string> = { sdrOnly: 'SDR only', hdr10: 'HDR10', dv: 'Dolby Vision' };
export const hdrLabel = (hdr: TargetHdr): string => HDR_LABEL[hdr];

const CHANNELS_LABEL: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };
/** "2.0", "5.1"; another count as "4 channels". */
export const channelsLabel = (channels: number): string => CHANNELS_LABEL[channels] ?? `${channels} channels`;

/** "8 Mbit/s", "800 kbit/s"; null is "none". */
export const bitrateLabel = (kbps: number | null): string => (kbps === null ? 'none' : kbps >= 1000 ? `${kbps / 1000} Mbit/s` : `${kbps} kbit/s`);

const SUBTITLE_MODE_LABEL: Record<SubtitleMode, string> = {
  text: 'Convert to text, separate file',
  keep: 'Keep in the file',
  burnIn: 'Burn in forced subtitles, the rest as separate files',
};

/** "a", "a and b", "a, b and c". */
export const listOf = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// ---- The resolution cap ----

/** The caps the field offers, highest first. */
const HEIGHTS = [2160, 1440, 1080, 720, 480] as const;

/** "1080p"; null is "No cap". */
export const heightLabel = (height: number | null): string => (height === null ? 'No cap' : `${height}p`);

export type SelectItem<V extends string = string> = { value: V; label: string };

/**
 * The cap field in devices mode (`maxHeightOverride`): its
 * placeholder is the cap the ticked devices give, which shows while no
 * override is set; "From the devices" clears the override, "No cap" sets null.
 */
export function capField(derived: number | null): { placeholder: string; items: SelectItem[] } {
  return {
    placeholder: `${heightLabel(derived)}, from the devices`,
    items: [
      { value: 'derived', label: `From the devices (${heightLabel(derived)})` },
      { value: 'none', label: 'No cap' },
      ...HEIGHTS.map((height) => ({ value: String(height), label: heightLabel(height) })),
    ],
  };
}

/** The field's value for an override: undefined (the placeholder) while the devices' cap applies. */
export const capKey = (override: number | null | undefined): string | undefined =>
  override === undefined ? undefined : override === null ? 'none' : String(override);

/** The override a picked item sets. */
export const capOverride = (key: string): number | null | undefined => (key === 'derived' ? undefined : key === 'none' ? null : Number(key));

// ---- The device cards ----

/** A card's two lines: container, video and resolution; audio and channels. `videoCodecs` reads "h264 8-bit". */
export function deviceLines(card: DeviceCard): [string, string] {
  const video = card.videoCodecs.map((entry) => {
    const [codec = '', ...rest] = entry.split(' ');
    return [codecLabel(codec), ...rest].join(' ');
  });
  const resolution = card.maxHeight === null ? 'any resolution' : `up to ${heightLabel(card.maxHeight)}`;
  return [`${formats(card.containers)} · ${video.join(', ')} · ${resolution}`, `${formats(card.audioCodecs)} · up to ${channelsLabel(card.maxChannels)}`];
}

/** Ticks or unticks a device, in the table's order. The last ticked device can't be unticked (devices mode needs one). */
export function toggleDevice(devices: readonly DeviceId[], device: DeviceId, on: boolean): DeviceId[] {
  const next = on ? [...new Set([...devices, device])] : devices.filter((id) => id !== device);
  return next.length ? DeviceId.options.filter((id) => next.includes(id)) : [...devices];
}

// ---- The draft ----

/** What the page edits, from the stored profile. */
export function draftOf(detail: PlaybackProfileDetail): PlaybackDraft {
  if (detail.mode === 'custom') return { mode: 'custom', target: detail.target, keepOriginal: detail.keepOriginal };
  return {
    mode: 'devices',
    devices: [...detail.devices],
    ...(detail.maxHeightOverride === undefined ? {} : { maxHeightOverride: detail.maxHeightOverride }),
    keepOriginal: detail.keepOriginal,
  };
}

/** The target the draft saves: the ticked devices' with the cap override, or the one edited directly. */
export const draftTarget = (draft: PlaybackDraft): TargetFormat =>
  draft.mode === 'custom' ? draft.target : targetForDevices(draft.devices, draft.maxHeightOverride);

/** "Edit directly": custom mode, starting from a copy of the target the draft has now (a JSON copy: the draft may be a Vue proxy). */
export const editDirectly = (draft: PlaybackDraft): PlaybackDraft => ({
  mode: 'custom',
  target: JSON.parse(JSON.stringify(draftTarget(draft))) as TargetFormat,
  keepOriginal: draft.keepOriginal,
});

/** "Reset to devices": back to the stored devices and cap, which custom mode keeps. */
export const resetToDevices = (draft: PlaybackDraft, detail: PlaybackProfileDetail): PlaybackDraft => ({
  mode: 'devices',
  devices: [...detail.devices],
  ...(detail.maxHeightOverride === undefined ? {} : { maxHeightOverride: detail.maxHeightOverride }),
  keepOriginal: draft.keepOriginal,
});

/** Deep equality for the plain objects a target is made of, ignoring key order. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

/** The line beside Save ("You changed the device list"); undefined when nothing changed. */
export function changeLine(draft: PlaybackDraft, detail: PlaybackProfileDetail): string | undefined {
  const changed: string[] = [];
  const others: string[] = [];
  if (draft.mode === 'custom') {
    if (detail.mode !== 'custom' || !same(draft.target, detail.target)) others.push('edited the target');
  } else {
    if (detail.mode === 'custom') others.push('reset the target to the devices');
    if (!same([...draft.devices].sort(), [...detail.devices].sort())) changed.push('the device list');
    if (draft.maxHeightOverride !== detail.maxHeightOverride) changed.push('the resolution cap');
  }
  if (draft.keepOriginal !== detail.keepOriginal) changed.push('"Keep the original"');
  const parts = [...others, ...(changed.length ? [`changed ${listOf(changed)}`] : [])];
  return parts.length ? `You ${listOf(parts)}` : undefined;
}

/** The switch: the original goes outside the library, not beside the prepared file. */
export const KEEP_ORIGINAL = {
  label: 'Keep the original',
  description: 'The original is kept outside the library for re-preparation. Jellyfin only sees the prepared file. Applies to later preparations.',
};

// ---- The target edited directly ----

/** A select's or checkbox group's items for codecs or containers. */
export const optionItems = <V extends string>(values: readonly V[]): SelectItem<V>[] => values.map((value) => ({ value, label: codecLabel(value) }));

export const CHANNEL_ITEMS = [1, 2, 6, 8].map((value) => ({ value, label: channelsLabel(value) }));

export const BIT_DEPTH_ITEMS = [8, 10].map((value) => ({ value, label: `${value}-bit` }));

/** The max height in custom mode: no "from the devices" there. */
export const HEIGHT_ITEMS: SelectItem[] = capField(null).items.slice(1);

export const HDR_ITEMS: SelectItem<TargetHdr>[] = (['sdrOnly', 'hdr10', 'dv'] as const).map((value) => ({ value, label: hdrLabel(value) }));

/** Makes `value` the list's first entry: what a remux or transcode produces. */
export const setFirst = <T>(list: readonly T[], value: T): T[] => [value, ...list.filter((entry) => entry !== value)];

/**
 * Adds or removes an entry. The first entry stays first and the others
 * follow `order`; the last entry can't be removed (a target lists at least one).
 */
export function setIncluded<T>(list: readonly T[], value: T, on: boolean, order: readonly T[]): T[] {
  if (!on) {
    const rest = list.filter((entry) => entry !== value);
    return rest.length ? rest : [...list];
  }
  if (list.includes(value)) return [...list];
  const [first, ...rest] = list;
  if (first === undefined) return [value];
  return [first, ...order.filter((entry) => entry === value || rest.includes(entry))];
}

/** Why a target edited directly can't be saved (`keep` only with MKV first). */
export function targetProblems(target: TargetFormat): string[] {
  const problems: string[] = [];
  if (target.subtitles.mode === 'keep' && target.containers[0] !== 'mkv') problems.push('Keep in the file needs MKV as the first container.');
  if (target.subtitles.mode !== 'keep' && target.subtitles.textFormats.length === 0) problems.push('Pick at least one text subtitle format.');
  return problems;
}

/** The subtitle select; "Keep in the file" is offered only when MKV is the first container. */
export const subtitleModeItems = (containers: readonly TargetContainer[]): (SelectItem<SubtitleMode> & { disabled?: boolean })[] => [
  { value: 'text', label: SUBTITLE_MODE_LABEL.text },
  { value: 'keep', label: 'Keep in the file (MKV first)', disabled: containers[0] !== 'mkv' },
  { value: 'burnIn', label: SUBTITLE_MODE_LABEL.burnIn },
];

// ---- The save dialog ----

const grouped = (n: number): string => n.toLocaleString('en-US');

/** `playback.previewChange` reads at most this many file versions. */
const LIMIT = DEFAULT_LIMITS.previewChangeLimit;

export type SaveDialog = {
  title: string;
  /** "142 files no longer fit"; absent when none stop fitting. */
  headline?: string;
  /** The files that stop fitting, by their most expensive step, cheapest first. */
  steps: { label: string; value: string }[];
  lines: string[];
  /** Past `previewChangeLimit` versions: the counts are lower bounds. */
  note?: string;
  help?: string;
  confirm: string;
};

/** Cheapest first. */
const DIALOG_STEPS: { step: PlanStep; label: string; suffix: string }[] = [
  { step: 'remux', label: 'Remux only', suffix: ' · fast' },
  { step: 'subtitle', label: 'Subtitle conversion', suffix: '' },
  { step: 'audio', label: 'Audio conversion', suffix: '' },
  { step: 'video', label: 'Video transcode', suffix: ' · slow, CPU' },
];

/** The save dialog from `playback.previewChange`. */
export function saveDialog(preview: ChangePreview, libraryName: string): SaveDialog {
  const plus = preview.truncated ? '+' : '';
  /** "1 file" or "142 files"; a lower bound is always plural ("1+ files"). */
  const files = (n: number) => `${grouped(n)}${plus} ${n === 1 && !plus ? 'file' : 'files'}`;
  const one = (n: number) => n === 1 && !plus;
  const stopFitting = Object.values(preview.noLongerFit).reduce((sum, n) => sum + n, 0);

  const lines: string[] = [];
  if (stopFitting > 0) lines.push(`${one(stopFitting) ? 'It stays' : 'They stay'} playable as Not yet in target format.`);
  if (preview.willPrepare > 0) lines.push(`${files(preview.willPrepare)} ${one(preview.willPrepare) ? 'is' : 'are'} prepared automatically, one at a time.`);
  if (preview.scannedOnDemand > 0)
    lines.push(
      one(preview.scannedOnDemand)
        ? '1 scanned file stays as it is until you prepare it.'
        : `${grouped(preview.scannedOnDemand)}${plus} scanned files stay as they are until you prepare them.`,
    );
  if (preview.nowFit > 0) lines.push(`${files(preview.nowFit)} now ${one(preview.nowFit) ? 'fits' : 'fit'}.`);

  return {
    title: `Save the ${libraryName} playback profile?`,
    ...(stopFitting > 0 ? { headline: `${files(stopFitting)} no longer ${one(stopFitting) ? 'fits' : 'fit'}` } : {}),
    steps: DIALOG_STEPS.filter(({ step }) => preview.noLongerFit[step] > 0).map(({ step, label, suffix }) => ({
      label,
      value: `${files(preview.noLongerFit[step])}${suffix}`,
    })),
    lines,
    ...(preview.truncated ? { note: `The library has more than ${grouped(LIMIT)} files; these counts are from the first ${grouped(LIMIT)}.` } : {}),
    ...(preview.willPrepare > 0 ? { help: "Preparing runs in its own queue, so downloads and imports aren't held up." } : {}),
    confirm: preview.willPrepare > 0 ? 'Save and prepare' : 'Save',
  };
}

/** Nothing stops or starts fitting: the page saves without the dialog. */
export const changesNoFile = (preview: ChangePreview): boolean =>
  !preview.truncated &&
  preview.willPrepare === 0 &&
  preview.scannedOnDemand === 0 &&
  preview.nowFit === 0 &&
  Object.values(preview.noLongerFit).every((n) => n === 0);

export const savedToast = (libraryName: string) => ({ title: 'Saved', description: `Every file in ${libraryName} still fits.` });

// ---- The target table ----

/** "H.264, HEVC 10-bit": a codec the target plays at 10 bits says so. */
const videoCodecs = (video: TargetFormat['video']): string =>
  video.codecs.map((codec) => (video.maxBitDepth[codec] === 10 ? `${codecLabel(codec)} 10-bit` : codecLabel(codec))).join(', ');

/** The Target format card, one row per part. */
export function targetRows(target: TargetFormat): { label: string; value: string }[] {
  const { video, audio, subtitles } = target;
  const textFormats = subtitles.mode === 'keep' ? '' : ` (${formats(subtitles.textFormats)})`;
  return [
    {
      label: 'Video',
      value: `${videoCodecs(video)} · ${hdrLabel(video.hdr)} · resolution cap ${video.maxHeight === null ? 'none' : heightLabel(video.maxHeight)} · bit-rate cap ${bitrateLabel(video.maxBitrateKbps)}`,
    },
    { label: 'Audio', value: `${formats(audio.codecs)} · channels kept up to ${channelsLabel(audio.maxChannels)}` },
    { label: 'Subtitles', value: `${SUBTITLE_MODE_LABEL[subtitles.mode]}${textFormats}` },
    { label: 'Container', value: formats(target.containers) },
  ];
}
