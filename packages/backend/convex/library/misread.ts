// "Might be this episode" on the episode's Candidates tab: its last
// search's releases rejected as a wrong title or episode whose name still
// contains one of the Work's aliases, so a release the parser misread can be grabbed instead of a silent "no releases".
// Read from the stored candidates only; they expire with `ttl.candidates`.
import { MISREAD_ROW_CAP, type MisreadRow } from '@omnarr/contracts';
import { compactTitle, normalizeTitle } from '@omnarr/parser';

import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { coveredBy } from '../pipeline/manualGrab';

/**
 * A title not recognised, or numbers that named no Unit or could be more
 * than one. `otherEpisode`, numbers that name another episode cleanly, is
 * left out: old releases of other episodes would crowd out the real ones.
 */
const MISREAD_DETAILS = new Set(['title', 'episode']);

/** The search's wrong-title-or-episode rows the list reads: Nyaa answers up to 75 a page. */
export const MISREAD_ROWS_READ = 150;

/** The episode's misread rows of its last search. */
export async function mightBeThisEpisode(ctx: QueryCtx, unitId: Id<'units'>): Promise<MisreadRow[]> {
  const unit = await ctx.db.get(unitId);
  const attempt = unit?.lastSearchAttemptId && (await ctx.db.get(unit.lastSearchAttemptId));
  if (!unit || !attempt || attempt.state === 'running') return [];
  // A picked release, or an acceptable one waiting for the user's grab: the list isn't needed.
  for (const outcome of ['picked', 'pending'] as const) {
    const rows = await ctx.db
      .query('candidates')
      .withIndex('by_attempt_outcome', (q) => q.eq('searchAttemptId', attempt._id).eq('outcome', outcome))
      .collect();
    if (rows.some((row) => coveredBy(row, attempt).includes(unitId))) return [];
  }
  const aliases = await ctx.db
    .query('workAliases')
    .withIndex('by_work', (q) => q.eq('workId', unit.workId))
    .collect();
  const compacts = aliases.map((alias) => alias.compact).filter((compact) => compact.length > 0);
  const candidates = await ctx.db
    .query('candidates')
    .withIndex('by_attempt_reason', (q) => q.eq('searchAttemptId', attempt._id).eq('reason', 'wrongTitleOrEpisode'))
    .order('desc')
    .take(MISREAD_ROWS_READ);
  const listed: typeof candidates = [];
  // One row per title: an indexer can answer several of the search's requests with the same release.
  const seen = new Set<string>();
  for (const row of candidates) {
    if (seen.has(row.title) || !row.matchDetail || !MISREAD_DETAILS.has(row.matchDetail)) continue;
    seen.add(row.title);
    const title = compactTitle(normalizeTitle(row.title));
    if (compacts.some((compact) => title.includes(compact))) listed.push(row);
  }
  // Torrents with the most seeders first (a usenet release has none), then the newest.
  const seeders = (row: (typeof candidates)[number]) => row.torrent?.seeders ?? -1;
  listed.sort((a, b) => seeders(b) - seeders(a) || b.publishedAt - a.publishedAt);
  const indexerNames = new Map<Id<'indexers'>, string>();
  const rows: MisreadRow[] = [];
  for (const row of listed.slice(0, MISREAD_ROW_CAP)) {
    if (!indexerNames.has(row.indexerId)) indexerNames.set(row.indexerId, (await ctx.db.get(row.indexerId))?.name ?? 'Removed');
    rows.push({
      candidateId: row._id,
      title: row.title,
      indexerName: indexerNames.get(row.indexerId)!,
      protocol: row.protocol,
      ...(row.torrent?.seeders !== undefined ? { seeders: row.torrent.seeders } : {}),
      episodes: row.parsed.episodes,
      ...(row.parsed.pack ? { pack: row.parsed.pack } : {}),
      ...(row.parsed.airDate ? { airDate: row.parsed.airDate } : {}),
      matchDetail: row.matchDetail as MisreadRow['matchDetail'],
      ...(row.matchProblem ? { matchProblem: row.matchProblem } : {}),
    });
  }
  return rows;
}
