// The parser's output as candidates store it, the quality catalogue's
// IDs and the decision fields scoring writes.
import { z } from 'zod';

/** The numbers a release title names. Anime titles often carry only `absolute`. */
export const ParsedEpisode = z.object({
  season: z.number().optional(),
  episode: z.number().optional(),
  absolute: z.number().optional(),
});
export type ParsedEpisode = z.infer<typeof ParsedEpisode>;

/** ISO 639-1 codes the parser can read from a title, plus `multi`. */
export const LanguageCode = z.enum([
  'en',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'ru',
  'ja',
  'ko',
  'zh',
  'sv',
  'no',
  'da',
  'fi',
  'tr',
  'el',
  'hu',
  'cs',
  'uk',
  'he',
  'ar',
  'hi',
  'th',
  'vi',
  'multi',
]);
export type LanguageCode = z.infer<typeof LanguageCode>;

/** ffprobe's ISO 639-2 language tags (bibliographic and terminology forms) as `LanguageCode`s. */
export const ISO639_2_TO_1: Readonly<Record<string, Exclude<LanguageCode, 'multi'>>> = {
  eng: 'en',
  ger: 'de',
  deu: 'de',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  dut: 'nl',
  nld: 'nl',
  pol: 'pl',
  rus: 'ru',
  jpn: 'ja',
  kor: 'ko',
  chi: 'zh',
  zho: 'zh',
  swe: 'sv',
  nor: 'no',
  nob: 'no',
  nno: 'no',
  dan: 'da',
  fin: 'fi',
  tur: 'tr',
  gre: 'el',
  ell: 'el',
  hun: 'hu',
  cze: 'cs',
  ces: 'cs',
  ukr: 'uk',
  heb: 'he',
  ara: 'ar',
  hin: 'hi',
  tha: 'th',
  vie: 'vi',
};

export const Resolution = z.union([z.literal(2160), z.literal(1080), z.literal(720), z.literal(576), z.literal(540), z.literal(480), z.literal(360)]);
export type Resolution = z.infer<typeof Resolution>;

export const ReleaseSource = z.enum(['bluray', 'webdl', 'webrip', 'hdtv', 'dvd', 'sdtv', 'cam', 'telesync', 'telecine', 'screener', 'workprint', 'ppv']);
export type ReleaseSource = z.infer<typeof ReleaseSource>;

export const SourceModifier = z.enum(['remux', 'brdisk', 'rawhd']);
export type SourceModifier = z.infer<typeof SourceModifier>;

export const VideoCodec = z.enum(['h264', 'h265', 'av1', 'vp9', 'xvid', 'mpeg2', 'vc1']);
export type VideoCodec = z.infer<typeof VideoCodec>;

export const HdrType = z.enum(['dv', 'hdr10', 'hdr10plus', 'hlg', 'hdr']);
export type HdrType = z.infer<typeof HdrType>;

export const AudioCodec = z.enum(['aac', 'ac3', 'eac3', 'truehd', 'dts', 'dtshd', 'dtsx', 'flac', 'opus', 'mp3', 'pcm']);
export type AudioCodec = z.infer<typeof AudioCodec>;

export const AudioChannels = z.enum(['1.0', '2.0', '5.1', '7.1']);
export type AudioChannels = z.infer<typeof AudioChannels>;

export const Container = z.enum(['mkv', 'mp4', 'avi', 'm2ts', 'ts']);
export type Container = z.infer<typeof Container>;

export const EDITION_FLAGS = ['extended', 'directors', 'unrated', 'theatrical', 'imax', 'remastered', 'criterion', 'threeD'] as const;
export const EditionFlag = z.enum(EDITION_FLAGS);
export type EditionFlag = z.infer<typeof EditionFlag>;

export const Edition = z.object(
  Object.fromEntries(EDITION_FLAGS.map((flag) => [flag, z.boolean().optional()])) as Record<EditionFlag, z.ZodOptional<z.ZodBoolean>>,
);
export type Edition = z.infer<typeof Edition>;

export const Revision = z.object({ version: z.number(), real: z.number(), repack: z.boolean() });
export type Revision = z.infer<typeof Revision>;

/** A season pack: which seasons, whether whole, and the part of a split season. */
export const ReleasePack = z.object({ seasons: z.array(z.number()), full: z.boolean(), part: z.number().optional() });
export type ReleasePack = z.infer<typeof ReleasePack>;

/** What a release title names. Unknown fields are absent or empty; `parseRelease` never throws. */
export const ParsedRelease = z.object({
  title: z.string(),
  normalizedTitle: z.string(),
  year: z.number().optional(),
  episodes: z.array(ParsedEpisode),
  /** A calendar date, YYYY-MM-DD, for daily shows. */
  airDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  pack: ReleasePack.optional(),
  special: z.boolean(),
  extras: z.boolean(),
  resolution: Resolution.optional(),
  source: ReleaseSource.optional(),
  modifier: SourceModifier.optional(),
  streamingService: z.string().optional(),
  videoCodec: VideoCodec.optional(),
  bitDepth: z.union([z.literal(8), z.literal(10)]).optional(),
  hdr: z.array(HdrType),
  audioCodec: AudioCodec.optional(),
  audioChannels: AudioChannels.optional(),
  atmos: z.boolean(),
  languages: z.array(LanguageCode),
  subtitleLanguages: z.array(LanguageCode),
  hardcodedSubs: z.boolean(),
  edition: Edition,
  revision: Revision,
  group: z.string().optional(),
  container: Container.optional(),
  /** For example `languageAssumed`, `dubbed`, `libraryError`, `unparsedTokens:<…>`. */
  notes: z.array(z.string()),
});
export type ParsedRelease = z.infer<typeof ParsedRelease>;

/** The quality catalogue's IDs, best first: the order disallowed qualities rank in. */
export const QualityId = z.enum([
  'remux-2160p',
  'bluray-2160p',
  'webdl-2160p',
  'webrip-2160p',
  'hdtv-2160p',
  'remux-1080p',
  'bluray-1080p',
  'webdl-1080p',
  'webrip-1080p',
  'hdtv-1080p',
  'bluray-720p',
  'webdl-720p',
  'webrip-720p',
  'hdtv-720p',
  'bluray-576p',
  'bluray-480p',
  'webdl-480p',
  'webrip-480p',
  'dvd',
  'sdtv',
  'brdisk',
  'rawhd',
  'workprint',
  'telecine',
  'telesync',
  'screener',
  'cam',
  'unknown',
]);
export type QualityId = z.infer<typeof QualityId>;

/** Why a candidate wasn't picked (`candidates.reason`). */
export const CandidateReason = z.enum([
  'notInProfile',
  'belowMinimumScore',
  'language',
  'wrongTitleOrEpisode',
  'blocklisted',
  'lowerScore',
  'needsMorePreparation',
  'sizeOutOfRange',
  'noSeeders',
  'unitBusy',
  /** A playable Unit's current release already meets the cutoff, beats this one, or the Unit's upgrade cooldown runs. */
  'notAnUpgrade',
  /** It covers some of the Units a playable Unit's file holds, not all: the old file would stay for the others. */
  'partialUpgrade',
]);
export type CandidateReason = z.infer<typeof CandidateReason>;

/** One format that added or removed points, or the preparation format even at 0. */
export const ScoreBreakdownEntry = z.object({ name: z.string(), points: z.number(), kind: z.enum(['format', 'preparation']) });
export type ScoreBreakdownEntry = z.infer<typeof ScoreBreakdownEntry>;

export const ScoreBreakdown = z.array(ScoreBreakdownEntry);
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

/**
 * The ranking key a loser lost on against the pick that took its Units; keys
 * 4–10 are `tieBreak`. `seasonPack`: a full-season pack the profile
 * prefers took them.
 */
export const LostOn = z.enum(['seasonPack', 'preparation', 'quality', 'score', 'tieBreak']);
export type LostOn = z.infer<typeof LostOn>;

/** The Torznab fields a candidate keeps. `magnetUrl` can carry a tracker passkey: internal only. */
export const CandidateTorrent = z.object({
  infoHash: z.string().optional(),
  magnetUrl: z.string().optional(),
  seeders: z.number().optional(),
  peers: z.number().optional(),
  minimumRatio: z.number().optional(),
  minimumSeedTimeSec: z.number().optional(),
  downloadVolumeFactor: z.number().optional(),
});
export type CandidateTorrent = z.infer<typeof CandidateTorrent>;
