// Predicting the preparation step from the title, before download. The real
// file is compared after import; a wrong guess costs ranking, not correctness.
import type { AudioChannels, ParsedRelease, PreparationStep, QualityId, ReleaseProfileContent, ReleaseSource, TargetFormat } from '@omnarr/contracts';

/** What a library's playback profile accepts without preparation: `toPreparationTarget` of its `TargetFormat`. */
export type PreparationTarget = {
  videoCodecs: ('h264' | 'h265' | 'av1')[];
  maxResolution: number;
  hdr: 'sdrOnly' | 'hdr10' | 'dv';
  audioCodecs: string[];
  maxChannels: number;
  container: 'mp4' | 'mkv';
};

/** The brief's default target: H.264 up to 1080p, SDR only, AAC stereo, MP4. The fallback for a library without a target. */
export const DEFAULT_PREPARATION_TARGET: PreparationTarget = {
  videoCodecs: ['h264'],
  maxResolution: 1080,
  hdr: 'sdrOnly',
  audioCodecs: ['aac'],
  maxChannels: 2,
  container: 'mp4',
};

/**
 * Scoring's view of a library's target: `hevc` is `h265`, no height cap is
 * 4320, and the container is the one a remux produces.
 */
export function toPreparationTarget(target: TargetFormat): PreparationTarget {
  return {
    videoCodecs: target.video.codecs.map((codec) => (codec === 'hevc' ? 'h265' : codec)),
    maxResolution: target.video.maxHeight ?? 4320,
    hdr: target.video.hdr,
    audioCodecs: [...target.audio.codecs],
    maxChannels: target.audio.maxChannels,
    container: target.containers[0]!,
  };
}

const CHANNELS: Record<AudioChannels, number> = { '1.0': 1, '2.0': 2, '5.1': 6, '7.1': 8 };

/** One reason a step is needed, and whether it rests on an assumed field. */
type Reason = { fires: boolean; assumed: boolean };

/** The default audio codec for a source the title names but whose audio it doesn't. */
function assumedAudio(source: ReleaseSource | undefined): string {
  if (source === 'webdl' || source === 'webrip') return 'eac3';
  if (source === 'bluray') return 'dts';
  return 'aac';
}

function videoReasons(parsed: ParsedRelease, target: PreparationTarget): Reason[] {
  const resolution = parsed.resolution ?? 1080;
  const hdr = new Set(parsed.hdr);
  const codec = parsed.videoCodec ?? (resolution <= 1080 && hdr.size === 0 ? 'h264' : 'h265');
  const dvOnly = hdr.has('dv') && !hdr.has('hdr10') && !hdr.has('hdr10plus');
  return [
    { fires: !(target.videoCodecs as string[]).includes(codec), assumed: parsed.videoCodec === undefined },
    { fires: resolution > target.maxResolution, assumed: parsed.resolution === undefined },
    { fires: hdr.size > 0 && target.hdr === 'sdrOnly', assumed: false },
    { fires: dvOnly && target.hdr !== 'dv', assumed: false },
    // HLG fits a dv target, whose devices all play it; an hdr10 target needs PQ.
    { fires: hdr.has('hlg') && target.hdr === 'hdr10', assumed: false },
  ];
}

function audioReasons(parsed: ParsedRelease, target: PreparationTarget): Reason[] {
  const codec = parsed.audioCodec ?? assumedAudio(parsed.source);
  const channels = parsed.audioChannels === undefined ? undefined : CHANNELS[parsed.audioChannels];
  return [
    { fires: !target.audioCodecs.includes(codec), assumed: parsed.audioCodec === undefined },
    { fires: channels !== undefined && channels > target.maxChannels, assumed: false },
  ];
}

/**
 * The most expensive step a release would need for `target`: video, then
 * audio, then remux, else none. `assumed` is true when the answer rests on a
 * field the title doesn't give.
 */
export function predictPreparation(parsed: ParsedRelease, target: PreparationTarget): { step: PreparationStep; assumed: boolean } {
  const rules: [PreparationStep, Reason[]][] = [
    ['video', videoReasons(parsed, target)],
    ['audio', audioReasons(parsed, target)],
    // A release with no extension is most likely MKV, as most scene and P2P releases are.
    ['remux', [{ fires: (parsed.container ?? 'mkv') !== target.container, assumed: false }]],
  ];
  let assumedEarlier = false;
  for (const [step, reasons] of rules) {
    const fired = reasons.filter((reason) => reason.fires);
    if (fired.length > 0) return { step, assumed: assumedEarlier || fired.every((reason) => reason.assumed) };
    assumedEarlier ||= reasons.some((reason) => reason.assumed);
  }
  return { step: 'none', assumed: assumedEarlier };
}

/** The source and resolution a quality stands for, to predict its preparation with the default assumptions. */
function releaseFor(quality: QualityId): Pick<ParsedRelease, 'source' | 'resolution' | 'modifier'> {
  const [kind, size] = quality.split('-') as [string, string | undefined];
  const resolution = size ? (Number(size.replace('p', '')) as ParsedRelease['resolution']) : undefined;
  if (kind === 'remux') return { source: 'bluray', modifier: 'remux', resolution };
  if (kind === 'brdisk' || kind === 'rawhd') return { source: 'bluray', modifier: kind, resolution: 1080 };
  if (kind === 'unknown') return {};
  return { source: kind as ReleaseSource, resolution };
}

/**
 * True when more than half of a profile's allowed qualities would need a
 * video transcode for `target` (the subscribe panel's warning).
 */
export function wouldNeedTranscode(profile: Pick<ReleaseProfileContent, 'qualities'>, target: PreparationTarget): boolean {
  const allowed = profile.qualities.filter((entry) => entry.allowed);
  const transcoding = allowed.filter((entry) => {
    const fields = releaseFor(entry.quality);
    const release: ParsedRelease = {
      title: '',
      normalizedTitle: '',
      episodes: [],
      special: false,
      extras: false,
      hdr: [],
      atmos: false,
      languages: [],
      subtitleLanguages: [],
      hardcodedSubs: false,
      edition: {},
      revision: { version: 1, real: 0, repack: false },
      notes: [],
    };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) Object.assign(release, { [key]: value });
    return predictPreparation(release, target).step === 'video';
  });
  return transcoding.length * 2 > allowed.length;
}
