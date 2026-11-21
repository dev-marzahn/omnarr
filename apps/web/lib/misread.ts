// "Might be this episode" on the item page's Candidates tab: releases of the
// last search rejected as a wrong title or episode whose name contains one of
// the Work's aliases, each with a short explanation in words. A row's Grab is
// the search's own manual grab, imported as this episode; once
// the search is no longer open, the row offers Search again instead.
import type { CandidateRow, MisreadRow, TimelineSearch } from '@omnarr/contracts';

import { episodeLabel } from './issues';
import { grabButton } from './timeline';

export type MisreadAction = { kind: 'grab'; candidate: CandidateRow; disabled?: string } | { kind: 'searchAgain' };

export type MisreadListRow = {
  key: string;
  title: string;
  explanation: string;
  source: string;
  action: MisreadAction;
};

/** What the parser read, in words: "episode 3 of the whole series", "S02E14", "a pack of season 3", "the date 2021-03-11". */
function readAs(row: MisreadRow): string | undefined {
  const first = row.episodes[0];
  if (first?.season !== undefined && first.episode !== undefined)
    return row.episodes.map((e) => episodeLabel({ tmdbSeason: e.season, tmdbEpisode: e.episode })).join(', ');
  if (first?.absolute !== undefined)
    return row.episodes.length === 1
      ? `episode ${first.absolute} of the whole series`
      : `episodes ${row.episodes.map((e) => e.absolute).join(', ')} of the whole series`;
  if (row.pack) return row.pack.full ? 'a pack of the whole series' : `a pack of season ${row.pack.seasons.join(', ')}`;
  if (row.airDate) return `the date ${row.airDate}`;
  return undefined;
}

/** Why the release wasn't matched to this episode, with what was read, in one line. */
export function misreadExplanation(row: MisreadRow): string {
  const read = readAs(row);
  if (row.matchDetail === 'title') return read ? `Title not recognised (read ${read})` : 'Title not recognised';
  if (row.matchProblem === 'ambiguous' && read) return `Matched the title, but ${read} could be more than one episode`;
  return `Matched the title but read ${read ?? 'no episode number'}`;
}

const seedersOf = (n: number) => `${n} ${n === 1 ? 'seeder' : 'seeders'}`;

/**
 * Each release with its explanation, indexer and seeders, and its action:
 * the search's Grab while it is open, else Search again. A row the search
 * no longer has (a newer search replaced it) is left out.
 */
export function misreadRows(rows: readonly MisreadRow[], search: TimelineSearch, now: number): MisreadListRow[] {
  return rows.flatMap((row) => {
    const candidate = search.candidates.find((c) => c.candidateId === row.candidateId);
    if (!candidate) return [];
    const grab = grabButton(candidate, search, now);
    const action: MisreadAction = grab.show ? { kind: 'grab', candidate, ...(grab.disabled ? { disabled: grab.disabled } : {}) } : { kind: 'searchAgain' };
    return [
      {
        key: row.candidateId,
        title: row.title,
        explanation: misreadExplanation(row),
        source: [row.indexerName, ...(row.protocol === 'torrent' && row.seeders !== undefined ? [seedersOf(row.seeders)] : [])].join(' · '),
        action,
      },
    ];
  });
}
