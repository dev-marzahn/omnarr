// `parseRelease`: clean-up, then @ctrl/video-filename-parser, mapped field by
// field into ParsedRelease, then the platform's passes. This is the only file
// that imports the library.
import {
  AudioCodec as LibAudioCodec,
  Channels,
  filenameParse,
  parseSource,
  QualityModifier,
  Source,
  VideoCodec as LibVideoCodec,
  type ParsedFilename,
} from '@ctrl/video-filename-parser';
import type {
  AudioChannels,
  AudioCodec,
  Edition,
  ParsedEpisode,
  ParsedRelease,
  ReleaseSource,
  Resolution,
  SourceModifier,
  VideoCodec,
} from '@omnarr/contracts';

import { normalizeTitle } from './normalize.ts';
import { audio } from './passes/audio.ts';
import { cleanup } from './passes/cleanup.ts';
import { group } from './passes/group.ts';
import { languages } from './passes/languages.ts';
import { numbers } from './passes/numbers.ts';
import { quality } from './passes/quality.ts';
import { streaming } from './passes/streaming.ts';
import { seriesTitleYear, titleInitials, withTitle } from './passes/title.ts';
import { tailTokens } from './passes/tokens.ts';
import { video } from './passes/video.ts';

const RESOLUTIONS: readonly Resolution[] = [2160, 1080, 720, 576, 540, 480, 360];

const SOURCES: Partial<Record<Source, ReleaseSource>> = {
  [Source.BLURAY]: 'bluray',
  [Source.WEBDL]: 'webdl',
  [Source.WEBRIP]: 'webrip',
  [Source.DVD]: 'dvd',
  [Source.CAM]: 'cam',
  [Source.SCREENER]: 'screener',
  [Source.PPV]: 'ppv',
  [Source.TELESYNC]: 'telesync',
  [Source.TELECINE]: 'telecine',
  [Source.WORKPRINT]: 'workprint',
};

const MODIFIERS: Record<QualityModifier, SourceModifier> = {
  [QualityModifier.REMUX]: 'remux',
  [QualityModifier.BRDISK]: 'brdisk',
  [QualityModifier.RAWHD]: 'rawhd',
};

const VIDEO_CODECS: Partial<Record<LibVideoCodec, VideoCodec>> = {
  [LibVideoCodec.X264]: 'h264',
  [LibVideoCodec.H264]: 'h264',
  [LibVideoCodec.X265]: 'h265',
  [LibVideoCodec.H265]: 'h265',
  [LibVideoCodec.XVID]: 'xvid',
  [LibVideoCodec.AV1]: 'av1',
  [LibVideoCodec.VP9]: 'vp9',
};

const AUDIO_CODECS: Partial<Record<LibAudioCodec, AudioCodec>> = {
  [LibAudioCodec.MP3]: 'mp3',
  [LibAudioCodec.DOLBY]: 'ac3',
  [LibAudioCodec.EAC3]: 'eac3',
  [LibAudioCodec.AAC]: 'aac',
  [LibAudioCodec.FLAC]: 'flac',
  [LibAudioCodec.DTS]: 'dts',
  [LibAudioCodec.DTSHD]: 'dtshd',
  [LibAudioCodec.TRUEHD]: 'truehd',
  [LibAudioCodec.OPUS]: 'opus',
  [LibAudioCodec.PCM]: 'pcm',
  [LibAudioCodec.LPCM]: 'pcm',
};

const CHANNELS: Record<Channels, AudioChannels> = {
  [Channels.SEVEN]: '7.1',
  [Channels.SIX]: '5.1',
  [Channels.STEREO]: '2.0',
  [Channels.MONO]: '1.0',
};

const WEB_TAG = /^web(-?dl|-?rip)?$/i;

const EDITION_KEYS = ['extended', 'directors', 'unrated', 'theatrical', 'imax', 'remastered', 'threeD'] as const;

/** What every parse starts from: no numbers, no flags, no languages. */
function emptyRelease(title: string, container: ParsedRelease['container']): ParsedRelease {
  const release: ParsedRelease = {
    title,
    normalizedTitle: normalizeTitle(title),
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
  if (container) release.container = container;
  return release;
}

/**
 * The library fills in WEB-DL when a title names a resolution but no source;
 * the platform leaves the source empty then, so the quality table's
 * "resolution only" row applies.
 */
function sourceOf(cleanTitle: string, tail: string[], lib: ParsedFilename, resolution: Resolution | undefined): ReleaseSource | undefined {
  // The library's own source reading misses a bracketed `(WEB 1080p)`, so a WEB tag after the title also counts.
  if (parseSource(cleanTitle).length === 0 && !tail.some((token) => WEB_TAG.test(token))) return undefined;
  const first = lib.sources[0];
  if (first === undefined) return undefined;
  if (first === Source.TV) return resolution !== undefined && resolution >= 720 ? 'hdtv' : 'sdtv';
  return SOURCES[first];
}

function episodesOf(lib: ParsedFilename): { episodes: ParsedEpisode[]; pack?: ParsedRelease['pack'] } {
  if (!('isTv' in lib)) return { episodes: [] };
  const { seasons, episodeNumbers } = lib;
  // Without a season, the library's episode numbers are absolute numbers (anime).
  if (seasons.length === 0) return { episodes: episodeNumbers.map((absolute) => ({ absolute })) };
  if (episodeNumbers.length > 0) return { episodes: seasons.flatMap((season) => episodeNumbers.map((episode) => ({ season, episode }))) };
  if (!lib.fullSeason && !lib.isPartialSeason && !lib.isMultiSeason) return { episodes: [] };
  const full = !lib.isPartialSeason;
  const pack: NonNullable<ParsedRelease['pack']> = { seasons: [...seasons], full };
  if (lib.isPartialSeason && lib.seasonPart > 0) pack.part = lib.seasonPart;
  // A full-season pack names its seasons as `{ season }` entries, which resolveUnits expands.
  return { episodes: full ? seasons.map((season) => ({ season })) : [], pack };
}

function editionOf(lib: ParsedFilename): Edition {
  const edition: Edition = {};
  for (const key of EDITION_KEYS) if (lib.edition[key]) edition[key] = true;
  return edition;
}

/** Maps the library's result field by field. */
function fromLibrary(lib: ParsedFilename, cleanTitle: string, base: ParsedRelease): ParsedRelease {
  const title = repairTitle(lib.title, cleanTitle);
  const release = withTitle(base, title);
  const resolution = RESOLUTIONS.find((r) => `${r}P` === lib.resolution);
  if (lib.year) release.year = Number(lib.year);
  const { episodes, pack } = episodesOf(lib);
  release.episodes = episodes;
  if (pack) release.pack = pack;
  if ('isTv' in lib) {
    release.special = lib.isSpecial;
    release.extras = lib.isSeasonExtra;
    if (lib.airDate) release.airDate = calendarDate(lib.airDate);
  }
  if (resolution !== undefined) release.resolution = resolution;
  if (lib.group) release.group = lib.group;
  const source = sourceOf(cleanTitle, tailTokens(cleanTitle, release), lib, resolution);
  if (source) release.source = source;
  if (lib.modifier) release.modifier = MODIFIERS[lib.modifier];
  const videoCodec = lib.videoCodec && VIDEO_CODECS[lib.videoCodec];
  if (videoCodec) release.videoCodec = videoCodec;
  const audioCodec = lib.audioCodec && AUDIO_CODECS[lib.audioCodec];
  if (audioCodec) release.audioCodec = audioCodec;
  if (lib.audioChannels) release.audioChannels = CHANNELS[lib.audioChannels];
  release.hardcodedSubs = lib.edition.hardcodedSubs === true;
  release.edition = editionOf(lib);
  release.revision = { version: lib.revision.version, real: lib.revision.real, repack: lib.revision.isRepack === true };
  return withTokenFlags(cleanTitle, release);
}

const EXTRAS_TOKEN = /^(extras|featurettes?|subpack|sample)$/i;

/** `extras` and `edition.criterion` also come from tokens the library doesn't read. */
function withTokenFlags(cleanTitle: string, release: ParsedRelease): ParsedRelease {
  const tail = tailTokens(cleanTitle, release);
  if (tail.some((token) => EXTRAS_TOKEN.test(token))) release.extras = true;
  if (tail.some((token) => /^criterion$/i.test(token))) release.edition = { ...release.edition, criterion: true };
  return release;
}

/**
 * The library drops non-ASCII letters at the end of a title word
 * (`Lumière.Café` comes back as `Lumière Caf`). Each word that the raw title
 * continues with only such letters gets them back.
 */
function repairTitle(title: string, cleanTitle: string): string {
  if (!/[^\p{ASCII}]/u.test(cleanTitle)) return title;
  const raw = cleanTitle.split(/[.\s_]+/);
  let j = 0;
  return title
    .split(' ')
    .map((word) => {
      const at = raw.findIndex((token, i) => i >= j && token.startsWith(word));
      if (at < 0) return word;
      j = at + 1;
      const rest = raw[at]!.slice(word.length);
      return rest !== '' && /^[^\p{ASCII}]+$/u.test(rest) && /^\p{L}+$/u.test(rest) ? raw[at]! : word;
    })
    .join(' ');
}

/**
 * The library builds an air date as local midnight, so in UTC+1 `2024.10.05`
 * comes back as `2024-10-04T23:00Z`. Its local calendar fields are the date
 * the title names.
 */
function calendarDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses a release title. Pure, deterministic and total: any string gives a
 * ParsedRelease, with unknown fields left empty.
 */
export function parseRelease(raw: string, kind: 'series' | 'movie'): ParsedRelease {
  const { cleanTitle, container } = cleanup(raw);
  const base = emptyRelease(cleanTitle, container);
  let lib: ParsedFilename;
  try {
    lib = filenameParse(cleanTitle, kind === 'series');
  } catch {
    return { ...base, notes: ['libraryError'] };
  }
  let release = quality(cleanTitle, group(cleanTitle, titleInitials(cleanTitle, fromLibrary(lib, cleanTitle, base))));
  if (kind === 'series') release = seriesTitleYear(cleanTitle, release);
  for (const pass of [numbers, video, audio, streaming, languages]) release = pass(cleanTitle, release);
  return release;
}
