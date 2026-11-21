// Library names: the Work folder, chosen once and stored, the season
// folder, and TRaSH's Jellyfin file-name scheme. `libraryFileName` is the only
// function that names a library file; the worker calls it at import and
// preparation, the backend for renames.
import { z } from 'zod';

import { WorkKind } from './dto/library.ts';
import type { AudioStream, ProbeSummary, VideoStream } from './playback.ts';
import { type Edition, type EditionFlag, ISO639_2_TO_1, LanguageCode, ParsedRelease, QualityId, type Revision } from './release.ts';

/** What names a Work's files: its folder's title and year, its TMDB ID, and the release. Inside job payloads. */
export const NamingContext = z.object({
  kind: WorkKind,
  /** From `works.folder`, never the current TMDB title. */
  title: z.string(),
  year: z.number().optional(),
  tmdbId: z.number(),
  /** The Work's numbering scheme is `anime`: the anime template, with the absolute number and audio languages. */
  anime: z.boolean(),
  release: ParsedRelease.extend({ quality: QualityId }),
});
export type NamingContext = z.infer<typeof NamingContext>;

/** A Unit as a file name names it. A movie has no numbers. */
export const NamedUnit = z.object({
  season: z.number().optional(),
  episode: z.number().optional(),
  absolute: z.number().optional(),
  title: z.string().optional(),
});
export type NamedUnit = z.infer<typeof NamedUnit>;

/** A sidecar subtitle file beside a library file (`files.sidecars`). */
export const Sidecar = z.object({
  path: z.string(),
  language: LanguageCode.optional(),
  forced: z.boolean(),
  sdh: z.boolean(),
  format: z.enum(['srt', 'ass']),
});
export type Sidecar = z.infer<typeof Sidecar>;

/** At most this many bytes before the extension. */
export const MAX_NAME_BYTES = 240;

/**
 * Jellyfin 12.4's extras suffixes (`NamingOptions.cs`). A name that, without
 * its extension and trailing digits and ignoring case, ends in one is filed
 * as an extra and hidden. Versioned with the pinned Jellyfin.
 */
export const JELLYFIN_EXTRAS_SUFFIXES: readonly string[] = [
  '-trailer',
  '.trailer',
  '_trailer',
  '- trailer',
  '-sample',
  '.sample',
  '_sample',
  '- sample',
  '-scene',
  '-clip',
  '-interview',
  '-behindthescenes',
  '-deleted',
  '-deletedscene',
  '-featurette',
  '-short',
  '-extra',
  '-other',
];

/** `{Title} ({Year}) [tmdbid-{tmdbId}]`, or without the year when it is unknown. */
export function workFolderName(work: { kind: WorkKind; title: string; year?: number; tmdbId: number }): string {
  return `${titleWithYear(cleanTitle(work.title), work.year)} [tmdbid-${work.tmdbId}]`;
}

const titleWithYear = (title: string, year: number | undefined): string => (year === undefined ? title : `${title} (${year})`);

/** Sonarr's, Radarr's and Jellyfin's ID tags: `[tmdbid-1]`, `{tmdb-1}`, `{tvdb-1}`, `[imdbid-tt1]`. */
const ID_TAG = /\s*[[{](?:tmdb|tvdb|imdb)(?:id)?-[^\]}]*[\]}]/gi;

/**
 * The title and year a stored Work folder names, without its ID tags. Scanned
 * folders may carry Sonarr's or Radarr's tags, or none, and no year.
 */
export function folderTitle(folder: string): { title: string; year?: number } {
  const base =
    folder
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  const rest = base.replace(ID_TAG, '').trim();
  const withYear = /^(.*\S)\s*\((\d{4})\)$/.exec(rest);
  return withYear ? { title: withYear[1] ?? '', year: Number(withYear[2]) } : { title: rest };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The season number a folder name spells (`Season 1`, `Season 01`, `S01`, `Specials`), or undefined. */
const seasonNumberOf = (folder: string): number | undefined => {
  if (/^specials$/i.test(folder)) return 0;
  const match = /^(?:season ?|s)(\d+)$/i.exec(folder);
  return match ? Number(match[1]) : undefined;
};

/**
 * The season's folder: an existing one with that number under any spelling,
 * else `Season {00}` (specials `Season 00`). `existingFolders` are the names
 * of the Work folder's subfolders. When the platform's own spelling exists
 * beside another, the platform's wins.
 */
export function seasonFolderFor(existingFolders: readonly string[], season: number): string {
  const own = `Season ${pad(season, 2)}`;
  if (existingFolders.includes(own)) return own;
  return existingFolders.find((folder) => seasonNumberOf(folder) === season) ?? own;
}

/** ffprobe's audio codec names as TRaSH writes them; `dts` is refined by its profile. */
const AUDIO_CODECS: Readonly<Record<string, string>> = {
  aac: 'AAC',
  ac3: 'AC3',
  eac3: 'EAC3',
  truehd: 'TrueHD',
  dts: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
};

const AUDIO_CHANNELS: Readonly<Record<number, string>> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };

/** ffprobe's video codec names as TRaSH writes them. */
const VIDEO_CODECS: Readonly<Record<string, string>> = {
  h264: 'h264',
  hevc: 'h265',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG2',
  vc1: 'VC1',
  mpeg4: 'XviD',
};

/** `[AudioCodec AudioChannels]`: the first audio stream. Left out when its codec has no name here. */
const audioPart = (stream: AudioStream | undefined): string | undefined => {
  if (stream === undefined) return undefined;
  // ffmpeg 6+ reports DTS:X as `DTS-HD MA + DTS:X`.
  const codec = stream.codec === 'dts' && stream.profile?.startsWith('DTS-HD MA') ? 'DTS-HD MA' : AUDIO_CODECS[stream.codec];
  if (codec === undefined) return undefined;
  const channels = AUDIO_CHANNELS[stream.channels];
  return channels === undefined ? codec : `${codec} ${channels}`;
};

/** `DynamicRange`; a Dolby Vision stream with an HDR10 base layer (compatibility 1) is `DV HDR10`. */
const dynamicRangePart = (stream: VideoStream | undefined): string | undefined => {
  switch (stream?.hdr) {
    case 'dv':
      return stream.dv?.compatibility === 1 ? 'DV HDR10' : 'DV';
    case 'hdr10plus':
      return 'HDR10Plus';
    case 'hdr10':
      return 'HDR10';
    case 'hlg':
      return 'HLG';
    default:
      return undefined;
  }
};

/** A name's parts, each already written as it appears; an absent one is left out with its brackets and separator. */
interface NameParts {
  kind: WorkKind;
  title: string;
  year?: number;
  tmdbId: number;
  /** `S01E02[-E03]`, then the anime absolute number. */
  numbers: string[];
  episodeTitle?: string;
  /** Movies only, without its braces. */
  edition?: string;
  customFormats?: string;
  quality?: string;
  audio?: string;
  /** Anime only. */
  audioLanguages?: string;
  dynamicRange?: string;
  video?: string;
  group?: string;
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A release's group or streaming service, cleaned like a title (an anime subgroup may hold any character); undefined when empty. */
const cleanOptional = (s: string | undefined): string | undefined => {
  const cleaned = s === undefined ? '' : cleanTitle(s);
  return cleaned === '' ? undefined : cleaned;
};

/** Renders the template for `parts.kind`, writing the group as `-{Group}` or, for the extras rule, `[{Group}]`. */
const render = (parts: NameParts, bracketGroup: boolean): string => {
  const brackets = [parts.customFormats, parts.quality, parts.audio, parts.audioLanguages, parts.dynamicRange, parts.video]
    .filter((value) => value !== undefined)
    .map((value) => `[${value}]`)
    .join('');
  const group = parts.group === undefined ? '' : bracketGroup ? `[${parts.group}]` : `-${parts.group}`;
  const tail = `${brackets}${group}`;
  const head = titleWithYear(parts.title, parts.year);
  if (parts.kind === 'movie') {
    const rest = [parts.edition === undefined ? undefined : `{${parts.edition}}`, tail === '' ? undefined : tail].filter((v) => v !== undefined).join(' ');
    return `${head} [tmdbid-${parts.tmdbId}]${rest === '' ? '' : ` - ${rest}`}`;
  }
  const segments = [head, ...parts.numbers, ...(parts.episodeTitle === undefined ? [] : [parts.episodeTitle])];
  return `${segments.join(' - ')}${tail === '' ? '' : ` ${tail}`}`;
};

/** Cuts at `max` characters (code points), then drops the spaces and dots the cut leaves at the end. */
const cutTitle = (title: string, max: number): string =>
  Array.from(title)
    .slice(0, max)
    .join('')
    .replace(/[\s.]+$/, '');

const EPISODE_TITLE_MAX = 90;

/** `S{00}E{00}[-E{00}]`: the first and last episode of the (sorted) Units. */
const episodeNumbers = (units: readonly NamedUnit[]): string | undefined => {
  const numbered = units.filter((unit) => unit.season !== undefined && unit.episode !== undefined);
  const first = numbered[0];
  const last = numbered.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const range = last === first ? '' : `-E${pad(last.episode ?? 0, 2)}`;
  return `S${pad(first.season ?? 0, 2)}E${pad(first.episode ?? 0, 2)}${range}`;
};

/** `{Absolute:000}`: the first and last absolute number of the (sorted) Units, `001` or `001-002`. */
const absoluteNumbers = (units: readonly NamedUnit[]): string | undefined => {
  const absolutes = units.map((unit) => unit.absolute).filter((n) => n !== undefined);
  const first = absolutes[0];
  const last = absolutes.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return first === last ? pad(first, 3) : `${pad(first, 3)}-${pad(last, 3)}`;
};

/** `AudioLanguages`: the audio streams' tagged languages, upper case, first appearance first, joined by `+`. */
const audioLanguagesOf = (probe: ProbeSummary): string | undefined => {
  const languages = new Set<string>();
  for (const stream of probe.streams) {
    if (stream.kind === 'audio' && stream.language !== undefined && stream.language !== 'und' && stream.language !== 'multi')
      languages.add(stream.language.toUpperCase());
  }
  return languages.size === 0 ? undefined : [...languages].join('+');
};

/** Edition flags as Radarr's `{Edition Tags}` writes them, in this order. `threeD` has no tag. */
const EDITION_TAGS: readonly (readonly [Exclude<EditionFlag, 'threeD'>, string])[] = [
  ['extended', 'Extended'],
  ['directors', "Director's Cut"],
  ['unrated', 'Unrated'],
  ['theatrical', 'Theatrical'],
  ['imax', 'IMAX'],
  ['remastered', 'Remastered'],
  ['criterion', 'Criterion'],
];

/** `{EditionTags}`, without the braces: the release's editions joined by a space. */
const editionOf = (edition: Edition): string | undefined => {
  const tags = EDITION_TAGS.filter(([flag]) => edition[flag] === true).map(([, tag]) => tag);
  return tags.length === 0 ? undefined : tags.join(' ');
};

/** `{EpisodeTitle:90}`: the cleaned titles joined by ` + `, left out while any is a placeholder (a real one renames the file). */
const episodeTitleOf = (units: readonly NamedUnit[]): string | undefined => {
  if (units.length === 0 || units.some((unit) => isPlaceholderTitle(unit.title))) return undefined;
  const joined = cutTitle(units.map((unit) => cleanTitle(unit.title ?? '')).join(' + '), EPISODE_TITLE_MAX);
  return joined === '' ? undefined : joined;
};

/** Jellyfin's extras check: the name without its extension and trailing digits, ignoring case, ends in a suffix. */
const endsInExtrasSuffix = (base: string): boolean => {
  const name = base.replace(/\d+$/, '').toLowerCase();
  return JELLYFIN_EXTRAS_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

/**
 * The built name, before its extension, never one Jellyfin files as an extra:
 * a group that would end it in an extras suffix is written `[{Group}]`. A name
 * with no bracket part and no group ends in its episode title; when that ends
 * in a suffix, the title is left out.
 */
const nameOf = (parts: NameParts): string => {
  const name = render(parts, false);
  if (!endsInExtrasSuffix(name)) return name;
  if (parts.group !== undefined) return render(parts, true);
  return render({ ...parts, episodeTitle: undefined }, false);
};

/** The library file's name with its extension (`ext` includes the dot). */
export function libraryFileName(input: { naming: NamingContext; units: readonly NamedUnit[]; probe: ProbeSummary; ext: string }): string {
  const { naming, units, probe } = input;
  const videoStream = probe.streams.find((stream): stream is VideoStream => stream.kind === 'video');
  const audioStream = probe.streams.find((stream): stream is AudioStream => stream.kind === 'audio');
  const sorted = [...units].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || (a.absolute ?? 0) - (b.absolute ?? 0));
  const numberTokens = naming.kind === 'movie' ? [] : naming.anime ? [episodeNumbers(sorted), absoluteNumbers(sorted)] : [episodeNumbers(sorted)];
  const numbers = numberTokens.filter((token) => token !== undefined);
  const videoCodec = videoStream === undefined ? undefined : VIDEO_CODECS[videoStream.codec];
  const parts: NameParts = {
    kind: naming.kind,
    title: cleanTitle(naming.title),
    year: naming.year,
    tmdbId: naming.tmdbId,
    numbers,
    episodeTitle: naming.kind === 'movie' ? undefined : episodeTitleOf(sorted),
    edition: naming.kind === 'movie' ? editionOf(naming.release.edition) : undefined,
    customFormats: cleanOptional(naming.release.streamingService),
    quality: trashQualityLabel(naming.release.quality, naming.release.revision, { anime: naming.anime }),
    audio: audioPart(audioStream),
    audioLanguages: naming.anime ? audioLanguagesOf(probe) : undefined,
    dynamicRange: dynamicRangePart(videoStream),
    // Anime: `[{VideoCodec} {BitDepth}bit]`, whose brackets TRaSH writes even without a codec.
    video: naming.anime && videoStream !== undefined ? [videoCodec, `${videoStream.bitDepth}bit`].filter((v) => v !== undefined).join(' ') : videoCodec,
    group: cleanOptional(naming.release.group),
  };
  return `${nameOf(fitLength(parts))}${input.ext}`;
}

const fits = (parts: NameParts): boolean => utf8Bytes(nameOf(parts)) <= MAX_NAME_BYTES;

/** Drops characters from the end of `value` until `withValue` fits; undefined when none fits. */
const shortened = (value: string, withValue: (v: string) => NameParts): NameParts | undefined => {
  const chars = Array.from(value);
  while (chars.length > 1) {
    chars.pop();
    const cut = chars.join('').replace(/[\s.]+$/, '');
    if (cut !== '' && fits(withValue(cut))) return withValue(cut);
  }
  return undefined;
};

/**
 * At most `MAX_NAME_BYTES` before the extension: the episode
 * title is shortened, then left out; then CustomFormats and AudioLanguages are
 * dropped. A Work title too long for any name (the folder would be refused
 * too) is cut as a last resort, so the name always fits.
 */
const fitLength = (parts: NameParts): NameParts => {
  if (fits(parts)) return parts;
  let next = parts;
  if (next.episodeTitle !== undefined) {
    const base = next;
    const cut = shortened(base.episodeTitle ?? '', (episodeTitle) => ({ ...base, episodeTitle }));
    if (cut !== undefined) return cut;
    next = { ...next, episodeTitle: undefined };
    if (fits(next)) return next;
  }
  next = { ...next, customFormats: undefined };
  if (fits(next)) return next;
  next = { ...next, audioLanguages: undefined };
  if (fits(next)) return next;
  const base = next;
  return shortened(base.title, (title) => ({ ...base, title })) ?? base;
};

/**
 * A sidecar's name beside `base` (the main file's name without its
 * extension): `<base>.<lang>[.sdh][.forced].<srt|ass>`, with the language
 * left out for `und` (and `multi`, which isn't an ISO 639-1 code). A name in
 * `taken` gets `.<n>` before the extension, from 2 (`….en.2.srt`); the name
 * returned is added to `taken`, so a caller naming a file's tracks passes one
 * set to every call.
 */
export function sidecarName(
  base: string,
  sidecar: { language?: LanguageCode | 'und'; sdh: boolean; forced: boolean; format: 'srt' | 'ass' },
  taken: Set<string>,
): string {
  const language = sidecar.language === undefined || sidecar.language === 'und' || sidecar.language === 'multi' ? '' : `.${sidecar.language}`;
  const stem = `${base}${language}${sidecar.sdh ? '.sdh' : ''}${sidecar.forced ? '.forced' : ''}`;
  let name = `${stem}.${sidecar.format}`;
  for (let n = 2; taken.has(name); n++) name = `${stem}.${n}.${sidecar.format}`;
  taken.add(name);
  return name;
}

/**
 * `sidecarName`'s inverse: the sidecar a file named
 * `<base>[.<lang>][.sdh|.hi|.cc][.forced][.<n>].<srt|ass>` is for the video
 * `<base>`, or undefined for any other name. The language is an ISO 639-1 or
 * 639-2 code; another word leaves it out.
 */
export function sidecarOf(base: string, fileName: string): Omit<Sidecar, 'path'> | undefined {
  if (!fileName.startsWith(`${base}.`)) return undefined;
  const parts = fileName.slice(base.length + 1).split('.');
  const format = parts.pop()?.toLowerCase();
  if (format !== 'srt' && format !== 'ass') return undefined;
  let language: Exclude<LanguageCode, 'multi'> | undefined;
  let sdh = false;
  let forced = false;
  for (const part of parts.map((p) => p.toLowerCase())) {
    if (part === 'forced') forced = true;
    else if (part === 'sdh' || part === 'hi' || part === 'cc') sdh = true;
    else if (language === undefined) {
      const code = ISO639_2_TO_1[part] ?? (part !== 'multi' && LanguageCode.safeParse(part).success ? (part as Exclude<LanguageCode, 'multi'>) : undefined);
      if (code) language = code;
    }
  }
  return { ...(language === undefined ? {} : { language }), forced, sdh, format };
}

/** Removes `/ \ * ? " < > |`, writes `:` as ` -`, collapses spaces, drops trailing dots. */
export function cleanTitle(s: string): string {
  return s
    .replace(/[/\\*?"<>|]/g, '')
    .replaceAll(':', ' -')
    .replace(/\s+/g, ' ')
    .replace(/[\s.]+$/, '')
    .trim();
}

/** Empty, or TMDB's placeholder `Episode <n>`. */
export function isPlaceholderTitle(s: string | undefined): boolean {
  const title = s?.trim() ?? '';
  return title === '' || /^Episode \d+$/.test(title);
}

const SOURCE_LABELS: Readonly<Record<string, string>> = { remux: 'Remux', bluray: 'Bluray', webdl: 'WEBDL', webrip: 'WEBRip', hdtv: 'HDTV' };

const PLAIN_QUALITY_LABELS: Readonly<Record<string, string>> = {
  dvd: 'DVD',
  sdtv: 'SDTV',
  brdisk: 'BR-DISK',
  rawhd: 'Raw-HD',
  workprint: 'WORKPRINT',
  telecine: 'TELECINE',
  telesync: 'TELESYNC',
  screener: 'DVDSCR',
  cam: 'CAM',
};

/**
 * A quality as TRaSH writes it, with the revision: `WEBDL-1080p Proper`;
 * undefined for `unknown`. The parser records PROPER and an anime `v2` alike
 * as version 2, so, as Sonarr does for its anime series type, an
 * anime Work's revision is written `v{n}` and any other's `Proper` or `Repack`.
 */
export function trashQualityLabel(quality: QualityId, revision?: Revision, options?: { anime?: boolean }): string | undefined {
  const [source = '', resolution] = quality.split('-');
  const base = resolution === undefined ? PLAIN_QUALITY_LABELS[source] : `${SOURCE_LABELS[source]}-${resolution}`;
  if (base === undefined || revision === undefined || revision.version <= 1) return base;
  if (options?.anime === true) return `${base} v${revision.version}`;
  return `${base} ${revision.repack ? 'Repack' : 'Proper'}`;
}
