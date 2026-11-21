// Built-in formats: a fixed ID, a name and a predicate.
// Profiles set their scores, not their conditions.
import { EDITION_FLAGS, type GroupTier, type ParsedRelease, type PreparationStep } from '@omnarr/contracts';
import { STREAMING_SERVICES } from '@omnarr/parser';

import { isRepack } from './conditions.ts';

/** What a format's predicate reads besides the release. */
export type FormatContext = { groupTiers: readonly GroupTier[]; preparation: PreparationStep };

export type BuiltInFormat = {
  id: string;
  name: string;
  /** Preparation formats order candidates and never reject one. */
  kind: 'format' | 'preparation';
  test: (release: ParsedRelease, ctx: FormatContext) => boolean;
};

const format = (id: string, name: string, test: BuiltInFormat['test']): BuiltInFormat => ({ id, name, kind: 'format', test });

/** The group-tier formats compare the release group with the profile's list, ignoring case. */
const tier = (id: string, name: string): BuiltInFormat =>
  format(id, name, (release, ctx) => {
    const group = release.group?.toLowerCase();
    if (group === undefined) return false;
    return ctx.groupTiers.some((entry) => entry.formatId === id && entry.groups.some((name) => name.toLowerCase() === group));
  });

const EDITION_NAMES: Record<(typeof EDITION_FLAGS)[number], string> = {
  extended: 'Extended edition',
  directors: "Director's cut",
  unrated: 'Unrated',
  theatrical: 'Theatrical cut',
  imax: 'IMAX',
  remastered: 'Remastered',
  criterion: 'Criterion',
  threeD: '3D',
};

export const BUILT_IN_FORMATS: readonly BuiltInFormat[] = [
  { id: 'prep.video', name: 'Needs video transcode', kind: 'preparation', test: (_r, ctx) => ctx.preparation === 'video' },
  { id: 'prep.remux', name: 'Needs remux', kind: 'preparation', test: (_r, ctx) => ctx.preparation === 'remux' },
  {
    id: 'prep.audioOrSubtitle',
    name: 'Needs audio or subtitle conversion',
    kind: 'preparation',
    test: (_r, ctx) => ctx.preparation === 'audio' || ctx.preparation === 'subtitle',
  },
  tier('group.tier1', 'Group tier 1'),
  tier('group.tier2', 'Group tier 2'),
  tier('group.tier3', 'Group tier 3'),
  tier('group.lowQuality', 'Low-quality group'),
  tier('anime.tier1', 'Anime group tier 1'),
  tier('anime.tier2', 'Anime group tier 2'),
  tier('anime.tier3', 'Anime group tier 3'),
  format('source.webdl', 'WEB-DL', (r) => r.source === 'webdl'),
  format('source.bluray', 'Bluray', (r) => r.source === 'bluray'),
  format('repack', 'Repack or proper', (r) => isRepack(r)),
  format('hdr.dv', 'Dolby Vision', (r) => r.hdr.includes('dv')),
  format('hdr.dvNoFallback', 'Dolby Vision without HDR10', (r) => r.hdr.includes('dv') && !r.hdr.includes('hdr10') && !r.hdr.includes('hdr10plus')),
  format('hdr.hdr10plus', 'HDR10+', (r) => r.hdr.includes('hdr10plus')),
  format('hdr.hdr10', 'HDR10', (r) => r.hdr.includes('hdr10')),
  format('audio.atmos', 'Atmos', (r) => r.atmos),
  format('audio.truehd', 'TrueHD', (r) => r.audioCodec === 'truehd'),
  format('audio.dtsx', 'DTS:X', (r) => r.audioCodec === 'dtsx'),
  format('audio.dtshd', 'DTS-HD', (r) => r.audioCodec === 'dtshd'),
  format('audio.eac3', 'E-AC-3', (r) => r.audioCodec === 'eac3'),
  format('audio.aac', 'AAC', (r) => r.audioCodec === 'aac'),
  ...STREAMING_SERVICES.map((service) => format(`streaming.${service}`, `Streaming: ${service}`, (r) => r.streamingService === service)),
  format('bitDepth.10', '10-bit', (r) => r.bitDepth === 10),
  format('hardcodedSubs', 'Hardcoded subtitles', (r) => r.hardcodedSubs),
  format('language.multi', 'Multi-language', (r) => r.languages.includes('multi')),
  ...EDITION_FLAGS.map((flag) => format(`edition.${flag}`, EDITION_NAMES[flag], (r) => r.edition[flag] === true)),
];

/** The built-in formats a release matches, in catalogue order. */
export function matchingFormats(release: ParsedRelease, ctx: FormatContext): BuiltInFormat[] {
  return BUILT_IN_FORMATS.filter((entry) => entry.test(release, ctx));
}
