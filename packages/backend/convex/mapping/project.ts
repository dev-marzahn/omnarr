// Projecting a Work's mapping rows from TMDB, XEM and Anime-Lists.
// Pure: every row is keyed by its Unit's TMDB episode ID, and the write
// mutations resolve keys to Unit IDs. No Convex imports.
import type { MappingSource, MappingStatus } from '@omnarr/contracts';

import type { TmdbNumber } from '../metadata/numbering';
import type { AnimeListEntry, AnimeListMapping } from './animeListsParse';
import type { XemEntry, XemNumber } from './xem';

/** A Unit TMDB lists (retired Units are left out), keyed by its TMDB episode ID. */
export type ProjectUnit = { key: string; kind: 'episode' | 'special'; tmdbSeason: number; tmdbEpisode: number };

/** A user's mapping row, for precedence only: projections never write `manual` rows. */
export type ManualRow = { key: string; ordering: string; season?: number; episode?: number; absolute?: number };

export type MappingRow = {
  key: string;
  ordering: string;
  season?: number;
  episode?: number;
  absolute?: number;
  source: Exclude<MappingSource, 'manual' | 'tvdb'>;
  sourceVersion?: string;
};

export type ProjectInput = {
  units: ProjectUnit[];
  /** The Absolute group's order, when one is used (`selectAbsoluteOrder`); else TMDB order. */
  absoluteOrder?: TmdbNumber[];
  /** TMDB's `tvdb_id`; with the entries' IDs it decides the Work's one TVDB ID (`chooseTvdbId`). */
  tmdbTvdbId?: number;
  /** The Work's Anime-Lists entries (`by_tmdb_tv`). */
  animeListEntries: AnimeListEntry[];
  /** XEM's `/map/all`; absent when the fetch failed, which keeps the stored `xem` rows. */
  xemEntries?: XemEntry[];
  manualRows: ManualRow[];
  versions: { animeLists?: string; xem?: string };
};

export type Projection = { rows: MappingRow[]; status: MappingStatus; notes: string[] };

/**
 * The AniDB IDs of the entries whose first episode (AniDB S1E1) is the Unit
 * with TMDB absolute 1, read from projected rows. Decides which entry names
 * may share an alias with a TMDB title.
 */
export function entriesStartingAtAbsoluteOne(rows: MappingRow[]): Set<number> {
  const first = rows.find((row) => row.ordering === 'absolute' && row.absolute === 1)?.key;
  const starting = new Set<number>();
  for (const row of rows) {
    const anidb = row.ordering.match(/^anidb:(\d+)$/);
    if (anidb && first !== undefined && row.key === first && row.season === 1 && row.episode === 1) starting.add(Number(anidb[1]));
  }
  return starting;
}

/** One TVDB ID per Work: TMDB's, else the one most Anime-Lists entries carry; another one is noted. */
export function chooseTvdbId(tmdbTvdbId: number | undefined, entries: AnimeListEntry[]): { tvdbId?: number; note?: string } {
  const counts = new Map<number, number>();
  for (const { tvdbId } of entries) if (tvdbId !== undefined) counts.set(tvdbId, (counts.get(tvdbId) ?? 0) + 1);
  const tvdbId = tmdbTvdbId ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (tvdbId === undefined) return {};
  const others = [...counts.keys()].filter((id) => id !== tvdbId);
  return others.length ? { tvdbId, note: `Anime-Lists also links TVDB ID ${others.join(', ')}; numbering uses ${tvdbId}.` } : { tvdbId };
}

const se = (season: number, episode: number) => `${season}:${episode}`;

/** A TVDB number as Anime-Lists gives it: a season and episode, or an absolute number (`'a'`). */
type TvdbPosition = { season: number; episode: number } | { absolute: number };

/** The precedence order within an ordering: a lower row is not written over a higher one. */
const RANK: Record<MappingRow['source'] | 'manual', number> = { manual: 3, xem: 2, animeLists: 1, tmdb: 0 };

export function projectMappings(input: ProjectInput): Projection {
  const notes: string[] = [];
  let partial = false;
  const rows: MappingRow[] = [];

  const byNumber = new Map(input.units.map((u) => [se(u.tmdbSeason, u.tmdbEpisode), u.key]));
  const regular = input.units.filter((u) => u.kind === 'episode').sort((a, b) => a.tmdbSeason - b.tmdbSeason || a.tmdbEpisode - b.tmdbEpisode);
  const seasonSize = new Map<number, number>();
  for (const u of input.units) seasonSize.set(u.tmdbSeason, (seasonSize.get(u.tmdbSeason) ?? 0) + 1);

  // absolute rows (source tmdb)
  const order = input.absoluteOrder?.flatMap((n) => byNumber.get(se(n.tmdbSeason, n.tmdbEpisode)) ?? []) ?? regular.map((u) => u.key);
  const byAbsolute = new Map(order.map((key, i) => [i + 1, key]));
  for (const [absolute, key] of byAbsolute) rows.push({ key, ordering: 'absolute', absolute, source: 'tmdb' });

  // Anime-Lists: anidb rows, and TVDB pins (bridge rule 1)
  const { tvdbId, note: tvdbNote } = chooseTvdbId(input.tmdbTvdbId, input.animeListEntries);
  if (tvdbNote) {
    notes.push(tvdbNote);
    partial = true;
  }
  const pins = new Map<string, string>();
  const pinsByAbsolute = new Map<number, string>();
  const alVersion = input.versions.animeLists;
  for (const entry of input.animeListEntries) {
    const covered = anidbEpisodes(entry, input.animeListEntries, byNumber, byAbsolute);
    // A season TMDB merged away: no rows, so its alias can't send a number to another season's Unit.
    if (covered.size === 0 && typeof entry.tmdbSeason === 'number' && !seasonSize.has(entry.tmdbSeason)) {
      notes.push(
        `Anime-Lists maps AniDB ${entry.anidbId} (${entry.name}) to TMDB season ${entry.tmdbSeason}, which TMDB doesn't list; its episodes are not mapped.`,
      );
      partial = true;
    }
    for (const [anidbKey, keys] of covered) {
      const [anidbSeason, anidbEpisode] = anidbKey.split(':').map(Number) as [number, number];
      for (const key of keys)
        rows.push({ key, ordering: `anidb:${entry.anidbId}`, season: anidbSeason, episode: anidbEpisode, source: 'animeLists', sourceVersion: alVersion });
    }
    if (tvdbId === undefined || entry.tvdbId !== tvdbId) continue;
    for (const [anidbKey, positions] of tvdbPositions(entry, covered)) {
      for (const key of covered.get(anidbKey) ?? []) {
        for (const position of positions) {
          if ('absolute' in position) {
            if (!pinsByAbsolute.has(position.absolute)) pinsByAbsolute.set(position.absolute, key);
            rows.push({ key, ordering: 'tvdb', absolute: position.absolute, source: 'animeLists', sourceVersion: alVersion });
          } else {
            if (!pins.has(se(position.season, position.episode))) pins.set(se(position.season, position.episode), key);
            rows.push({ key, ordering: 'tvdb', season: position.season, episode: position.episode, source: 'animeLists', sourceVersion: alVersion });
          }
        }
      }
    }
  }

  // XEM: scene and tvdb rows on the Units the bridge links them to
  if (input.xemEntries) {
    const xemVersion = input.versions.xem;
    const tvdbSeasonSize = new Map<number, number>();
    for (const { tvdb } of input.xemEntries) tvdbSeasonSize.set(tvdb.season, (tvdbSeasonSize.get(tvdb.season) ?? 0) + 1);
    const tvdbRegular = input.xemEntries.filter((e) => e.tvdb.season > 0).length;
    const sameTotal = tvdbRegular === regular.length;
    const bridge = ({ season, episode, absolute }: XemNumber): string | undefined =>
      pins.get(se(season, episode)) ??
      (absolute ? pinsByAbsolute.get(absolute) : undefined) ??
      (tvdbSeasonSize.get(season) === seasonSize.get(season) ? byNumber.get(se(season, episode)) : undefined) ??
      (season > 0 && sameTotal && absolute ? byAbsolute.get(absolute) : undefined);
    let unlinkedRegular = 0;
    let unlinkedSpecials = 0;
    for (const entry of input.xemEntries) {
      const key = bridge(entry.tvdb);
      if (!key) {
        if (entry.tvdb.season > 0) unlinkedRegular++;
        else unlinkedSpecials++;
        continue;
      }
      for (const scene of [entry.scene, entry.scene2]) {
        if (scene)
          rows.push({
            key,
            ordering: 'scene',
            season: scene.season,
            episode: scene.episode,
            absolute: scene.absolute || undefined,
            source: 'xem',
            sourceVersion: xemVersion,
          });
      }
      rows.push({ key, ordering: 'tvdb', season: entry.tvdb.season, episode: entry.tvdb.episode, source: 'xem', sourceVersion: xemVersion });
    }
    if (unlinkedRegular) notes.push(`XEM lists ${tvdbRegular} regular episodes, TMDB ${regular.length}; XEM numbers are not linked.`);
    if (unlinkedSpecials) notes.push(`XEM lists ${tvdbSeasonSize.get(0) ?? 0} specials, TMDB ${seasonSize.get(0) ?? 0}; XEM special numbers are not linked.`);
    partial ||= unlinkedRegular + unlinkedSpecials > 0;
  }

  const hasData = input.animeListEntries.length > 0 || (input.xemEntries?.length ?? 0) > 0;
  const status: MappingStatus = !hasData ? 'tmdbOnly' : partial ? 'partial' : 'complete';
  return { rows: applyPrecedence(rows.map(withoutUndefined), input.manualRows), status, notes };
}

/** Each AniDB episode (`season:episode`) of an entry, with the TMDB Units it covers. */
function anidbEpisodes(entry: AnimeListEntry, all: AnimeListEntry[], byNumber: Map<string, string>, byAbsolute: Map<number, string>): Map<string, string[]> {
  const covered = new Map<string, string[]>();
  const add = (anidbSeason: number, anidbEpisode: number, key: string | undefined) => {
    if (!key || anidbEpisode < 1) return;
    const k = se(anidbSeason, anidbEpisode);
    covered.set(k, [...(covered.get(k) ?? []), key]);
  };
  const explicit = new Set<number>();
  for (const mapping of entry.mappings) {
    if (mapping.tmdbSeason === undefined) continue;
    for (const [anidbEpisode, target] of targets(mapping)) {
      if (mapping.anidbSeason === 1) explicit.add(anidbEpisode);
      add(mapping.anidbSeason, anidbEpisode, target > 0 ? byNumber.get(se(mapping.tmdbSeason, target)) : undefined);
    }
  }
  if (entry.tmdbSeason === undefined) return covered;
  // The default covers the TMDB episodes after the entry's offset, up to the next entry's offset on the same season.
  const offset = entry.tmdbOffset ?? 0;
  const bound = Math.min(...all.filter((e) => e.tmdbSeason === entry.tmdbSeason && (e.tmdbOffset ?? 0) > offset).map((e) => e.tmdbOffset ?? 0));
  const inRange = (n: number) => n > offset && n <= bound && !explicit.has(n - offset);
  if (entry.tmdbSeason === 'a') {
    for (const [absolute, key] of byAbsolute) if (inRange(absolute)) add(1, absolute - offset, key);
  } else {
    const season = entry.tmdbSeason;
    for (const [number, key] of byNumber) {
      const [s, e] = number.split(':').map(Number) as [number, number];
      if (s === season && inRange(e)) add(1, e - offset, key);
    }
  }
  return covered;
}

/** The TVDB numbers an entry gives the AniDB episodes it covers on TMDB. */
function tvdbPositions(entry: AnimeListEntry, covered: Map<string, string[]>): Map<string, TvdbPosition[]> {
  const positions = new Map<string, TvdbPosition[]>();
  const add = (anidbKey: string, position: TvdbPosition) => positions.set(anidbKey, [...(positions.get(anidbKey) ?? []), position]);
  const explicit = new Set<string>();
  for (const mapping of entry.mappings) {
    if (mapping.tvdbSeason === undefined) continue;
    for (const [anidbEpisode, target] of targets(mapping)) {
      const anidbKey = se(mapping.anidbSeason, anidbEpisode);
      explicit.add(anidbKey);
      if (target > 0) add(anidbKey, { season: mapping.tvdbSeason, episode: target });
    }
  }
  if (entry.defaultTvdbSeason === undefined) return positions;
  const offset = entry.episodeOffset ?? 0;
  for (const anidbKey of covered.keys()) {
    const [anidbSeason, anidbEpisode] = anidbKey.split(':').map(Number) as [number, number];
    if (anidbSeason !== 1 || explicit.has(anidbKey) || anidbEpisode + offset < 1) continue;
    add(anidbKey, entry.defaultTvdbSeason === 'a' ? { absolute: anidbEpisode + offset } : { season: entry.defaultTvdbSeason, episode: anidbEpisode + offset });
  }
  return positions;
}

/** A mapping's `[anidbEpisode, targetEpisode]` pairs: explicit pairs, plus `start`–`end` shifted by `offset`. */
function targets(mapping: AnimeListMapping): [number, number][] {
  const pairs: [number, number][] = mapping.pairs.flatMap(([anidb, list]) => list.map((t): [number, number] => [anidb, t]));
  const listed = new Set(mapping.pairs.map(([anidb]) => anidb));
  if (mapping.start !== undefined && mapping.end !== undefined) {
    for (let anidb = mapping.start; anidb <= mapping.end; anidb++) if (!listed.has(anidb)) pairs.push([anidb, anidb + (mapping.offset ?? 0)]);
  }
  return pairs;
}

/** The numbers a row puts on its Unit, for conflicts within its ordering. */
function numberKeys(row: { ordering: string; season?: number; episode?: number; absolute?: number }): string[] {
  const keys: string[] = [];
  if (row.season !== undefined && row.episode !== undefined) keys.push(`${row.ordering}|se|${row.season}:${row.episode}`);
  if (row.absolute) keys.push(`${row.ordering}|abs|${row.absolute}`);
  return keys;
}

/**
 * Within one ordering, a number on one Unit blocks lower-ranked rows that put
 * it on another Unit (`manual` > `xem` > `animeLists` > `tmdb`). Rows of one
 * source never block each other: one AniDB episode can cover two Units.
 */
function applyPrecedence(rows: MappingRow[], manualRows: ManualRow[]): MappingRow[] {
  const claims = new Map<string, { rank: number; units: Set<string> }>();
  const claim = (keys: string[], rank: number, unit: string) => {
    for (const k of keys) {
      const existing = claims.get(k);
      if (!existing || existing.rank < rank) claims.set(k, { rank, units: new Set([unit]) });
      else if (existing.rank === rank) existing.units.add(unit);
    }
  };
  for (const row of manualRows) claim(numberKeys(row), RANK.manual, row.key);
  const ranked = [...rows].sort((a, b) => RANK[b.source] - RANK[a.source]);
  const kept = new Set<MappingRow>();
  for (const row of ranked) {
    const keys = numberKeys(row);
    const blocked = keys.some((k) => {
      const existing = claims.get(k);
      return existing !== undefined && existing.rank > RANK[row.source] && !existing.units.has(row.key);
    });
    if (blocked) continue;
    kept.add(row);
    claim(keys, RANK[row.source], row.key);
  }
  return rows.filter((row) => kept.has(row));
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
