// `imports.resolveFiles`: which Units each
// file of a finished download holds. The worker asks before it assigns files
// to the Grab's Units, so a scene- or absolute-numbered file lands on the TMDB
// Unit the release was picked for, through the same resolveUnits
// that search and RSS used.
import { ResolveFilesRequest, ResolveFilesResponse, type IndexerItem, type MatchedAlias, type ParsedRelease, type ResolvedFile } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { matchTitle, type WorkForMatch } from '@omnarr/scoring';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { workerError, workerQuery } from '../lib/functions';
import { resolveUnits } from '../metadata/resolve';
import { workForSearch } from '../pipeline/search';

/** `fenced` for a query (jobs/queue.ts): the job, if it still holds this lease. Reads only. */
export async function leasedJob(ctx: QueryCtx, jobId: Id<'jobs'>, leaseEpoch: number): Promise<Doc<'jobs'>> {
  const job = await ctx.db.get(jobId);
  if (!job || job.status !== 'leased' || job.leaseEpoch !== leaseEpoch) throw workerError('staleLease');
  return job;
}

/** The candidate as matchTitle reads an indexer result; candidates don't store the result's IDs. */
const indexerItemOf = (candidate: Doc<'candidates'>): IndexerItem => ({
  guid: candidate.guid,
  title: candidate.title,
  downloadUrl: candidate.downloadUrl,
  sizeBytes: candidate.sizeBytes,
  protocol: candidate.protocol,
  publishedAt: candidate.publishedAt,
  categories: [],
  ids: {},
  ...(candidate.torrent ? { torrent: candidate.torrent } : {}),
});

/** A name names an episode: a number of one, or an air date. A season alone (`S01`, a pack's folder) is no file's number. */
const hasNumbers = (parsed: ParsedRelease): boolean =>
  parsed.airDate !== undefined || parsed.episodes.some((episode) => episode.episode !== undefined || episode.absolute !== undefined);

/** A season folder (`Season 01`, `S1`, `Specials`) is the layout's, not a release name, so it is no fallback. */
const SEASON_FOLDER = /^(?:season ?\d+|s\d+|specials)$/i;

/** The file's name, else its folder's when the name has no numbers; the download's own folder for a file at its root. */
function numbersOf(contentPath: string, relPath: string, kind: Doc<'works'>['kind']): ParsedRelease | undefined {
  const segments = `${contentPath}/${relPath}`.split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const parsed = parseRelease(name.replace(/\.[a-z0-9]{2,4}$/i, ''), kind);
  if (hasNumbers(parsed)) return parsed;
  const folder = segments.at(-2);
  if (folder === undefined || SEASON_FOLDER.test(folder)) return undefined;
  const fromFolder = parseRelease(folder, kind);
  return hasNumbers(fromFolder) ? fromFolder : undefined;
}

export const resolveFiles = workerQuery({
  args: ResolveFilesRequest.shape,
  returns: ResolveFilesResponse,
  handler: async (ctx, { jobId, leaseEpoch, files }): Promise<ResolvedFile[]> => {
    const job = await leasedJob(ctx, jobId, leaseEpoch);
    if (job.payload?.class !== 'import') throw workerError('invalidResult', { expected: job.class });
    const grab = (await ctx.db.get(job.payload.grabId))!;
    const candidate = (await ctx.db.get(grab.candidateId))!;
    const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
    const work = (await ctx.db.get(attempt.workId))!;
    // Movies skip this step: the worker takes the largest video.
    if (work.kind === 'movie') return files.map(({ relPath }) => ({ relPath, unitIds: [] }));

    // The alias the release was picked through, as search and RSS pass it; none when the title no longer matches.
    const match = matchTitle(parseRelease(candidate.title, work.kind), indexerItemOf(candidate), (await workForSearch(ctx, work)) as unknown as WorkForMatch);
    const alias: MatchedAlias = match.ok ? match.alias : { kind: 'plain' };

    const resolved: ResolvedFile[] = [];
    for (const { relPath } of files) {
      const parsed = numbersOf(job.payload.contentPath, relPath, work.kind);
      if (!parsed) {
        resolved.push({ relPath, unitIds: [], problem: 'noNumbers' });
        continue;
      }
      const result = await resolveUnits(ctx, work._id, parsed.episodes, parsed.airDate, alias);
      if (result.problem || result.unitIds.length === 0) {
        resolved.push({ relPath, unitIds: [], problem: 'unitNotFound' });
        continue;
      }
      // Above a first release (version 1, not REAL), the worker needs it to pick between two files for one Unit.
      const { version, real } = parsed.revision;
      resolved.push({ relPath, unitIds: result.unitIds, ...(version > 1 || real > 0 ? { revision: { version, real } } : {}) });
    }
    return resolved;
  },
});
