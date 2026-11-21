// Parsing Anime-Lists' anime-list.xml into `animeListEntries`. Attributes
// are read as strings, so `tvdbid="movie"` and `'a'` survive. Pure apart
// from `crypto.subtle`, which every Convex runtime has.
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

/** A season number, or `'a'` for absolute numbering. */
const SeasonOrAbsolute = z.union([z.number(), z.literal('a')]);

/** One `<mapping>`: AniDB episode → target episodes, by explicit pairs or by `start`–`end` plus `offset`. */
export const AnimeListMapping = z.object({
  anidbSeason: z.number(),
  tvdbSeason: z.number().optional(),
  tmdbSeason: z.number().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  offset: z.number().optional(),
  pairs: z.array(z.tuple([z.number(), z.array(z.number())])),
});
export type AnimeListMapping = z.infer<typeof AnimeListMapping>;

export const AnimeListEntry = z.object({
  anidbId: z.number(),
  /** AniDB's main title. */
  name: z.string(),
  /** Absent when the source holds a type word (`movie`, `OVA`, …). */
  tvdbId: z.number().optional(),
  defaultTvdbSeason: SeasonOrAbsolute.optional(),
  episodeOffset: z.number().optional(),
  tmdbTvId: z.number().optional(),
  /** `'a'` isn't documented; it is read as absolute. */
  tmdbSeason: SeasonOrAbsolute.optional(),
  tmdbOffset: z.number().optional(),
  mappings: z.array(AnimeListMapping),
  /** SHA-256 of the parsed entry, so a fetch rewrites only changed rows. */
  contentHash: z.string(),
});
export type AnimeListEntry = z.infer<typeof AnimeListEntry>;

type RawMapping = Record<string, string | undefined> & { '#text'?: string };
type RawAnime = Record<string, string | undefined> & { name?: string; 'mapping-list'?: { mapping?: RawMapping[] } | string };

const integer = (value: string | undefined): number | undefined => (value !== undefined && /^-?\d+$/.test(value.trim()) ? Number(value) : undefined);
const seasonOf = (value: string | undefined) => (value?.trim() === 'a' ? ('a' as const) : integer(value));

/** `;1-5;2-6;` → `[[1, [5]], [2, [6]]]`; `+` joins targets (`;1-1+2;`). Malformed parts are skipped. */
export function parseMappingPairs(text: string): [number, number[]][] {
  const pairs: [number, number[]][] = [];
  for (const part of text.split(';')) {
    const match = part.trim().match(/^(\d+)-(\d+(?:\+\d+)*)$/);
    if (match) pairs.push([Number(match[1]), match[2]!.split('+').map(Number)]);
  }
  return pairs;
}

/** Drops absent fields, so equal entries hash and compare equal. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function mappingOf(raw: RawMapping): AnimeListMapping {
  return defined({
    anidbSeason: integer(raw.anidbseason) ?? 1,
    tvdbSeason: integer(raw.tvdbseason),
    tmdbSeason: integer(raw.tmdbseason),
    start: integer(raw.start),
    end: integer(raw.end),
    offset: integer(raw.offset),
    pairs: parseMappingPairs(raw['#text'] ?? ''),
  });
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every `<anime>` entry with an AniDB ID, in file order. */
export async function parseAnimeList(xml: string): Promise<AnimeListEntry[]> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (name) => name === 'anime' || name === 'mapping',
  });
  const root = parser.parse(xml) as { 'anime-list'?: { anime?: RawAnime[] } };
  const entries: AnimeListEntry[] = [];
  for (const raw of root['anime-list']?.anime ?? []) {
    const anidbId = integer(raw.anidbid);
    if (anidbId === undefined) continue;
    const list = typeof raw['mapping-list'] === 'object' ? (raw['mapping-list'].mapping ?? []) : [];
    const entry = defined({
      anidbId,
      name: String(raw.name ?? '').trim(),
      tvdbId: integer(raw.tvdbid),
      defaultTvdbSeason: seasonOf(raw.defaulttvdbseason),
      episodeOffset: integer(raw.episodeoffset),
      tmdbTvId: integer(raw.tmdbtv),
      tmdbSeason: seasonOf(raw.tmdbseason),
      tmdbOffset: integer(raw.tmdboffset),
      mappings: list.map(mappingOf),
    });
    entries.push({ ...entry, contentHash: await sha256(JSON.stringify(entry)) });
  }
  return entries;
}
