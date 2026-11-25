// The scan's match step and review decisions.
// `run` is an action in the metadataPool, 20 folders per invocation: it
// finds each folder's Work (an ID tag, the library's Works, then TMDB) and
// hands the folder to `resolveFolder`, which reads each file's numbers in
// the ordering trial, marks conflicts, compares each probe with the
// library's target and labels the naming. `setNumbering` and `matchFolder`
// re-read a folder with the user's choice.
import {
  compare,
  DEFAULT_LIMITS,
  mostExpensive,
  type ParsedEpisode,
  type ReadAs,
  ScanFolderRef,
  type ScanMatch,
  type ScanMatchFolderRequest,
  ScanNumbering,
  type ScanSuggestion,
  ScanSuggestion as ScanSuggestionSchema,
  type ScanUnitLabel,
  type UnmatchedReason,
  WorkKind,
} from '@omnarr/contracts';
import { normalizeTitle, parseRelease } from '@omnarr/parser';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from '../_generated/server';
import { findWorkByTmdbId } from '../library/works';
import { withProvider } from '../metadata/keys';
import { metadataPool } from '../metadata/pool';
import type { ProviderHit, WorkMetadata } from '../metadata/provider';
import { findWorksByTitle, resolveUnits } from '../metadata/resolve';
import { targetOf } from '../playback/target';
import { folderItems, foldersOf } from './review';

const kindOf = (library: Doc<'libraries'>): z.infer<typeof WorkKind> => (library.kind === 'movies' ? 'movie' : 'series');

// ── Counts ───────────────────────────────────────────────────────────────

/** Recomputes a run's item counts; `read` and `tracked` come from the worker's result. */
export async function recount(ctx: MutationCtx, scanRunId: Id<'scanRuns'>): Promise<void> {
  const run = await ctx.db.get(scanRunId);
  if (!run) return;
  const of = async (status: Doc<'scanItems'>['status']) =>
    (
      await ctx.db
        .query('scanItems')
        .withIndex('by_run_status', (q) => q.eq('scanRunId', scanRunId).eq('status', status))
        .collect()
    ).length;
  await ctx.db.patch(scanRunId, {
    counts: {
      ...run.counts,
      matched: await of('matched'),
      unmatched: (await of('unmatched')) + (await of('conflict')),
      ignored: await of('ignored'),
      imported: await of('imported'),
    },
  });
}

// ── The Work of a folder ─────────────────────────────────────────────────

/** `[tmdbid-1]`, `{tmdb-1}`, `[tvdbid-1]`, `{tvdb-1}`, `[imdbid-tt1]`, `{imdb-tt1}` in a folder name. */
const ID_TAG = /[[{](tmdb|tvdb|imdb)(?:id)?-(tt\d+|\d+)[\]}]/i;

export function idTagOf(folder: string): { provider: 'tmdb' | 'tvdb' | 'imdb'; value: string } | null {
  const match = ID_TAG.exec(folder);
  return match ? { provider: match[1]!.toLowerCase() as 'tmdb' | 'tvdb' | 'imdb', value: match[2]! } : null;
}

/** The folder name without its ID tags, for the title and year. */
const withoutTags = (folder: string) => folder.replace(new RegExp(ID_TAG.source, 'gi'), '').trim();

/**
 * A Work folder's title and year: `Title (Year)` as Sonarr, Radarr and
 * Jellyfin name folders, else what the release parser reads (a movie folder
 * named like its release), else the whole name. The series parser reads no
 * title from a name without episode numbers, so it isn't enough alone.
 */
export function folderTitleOf(folder: string, kind: 'series' | 'movie'): { title: string; year?: number } {
  const name = withoutTags(folder);
  const tagged = /^(.*?)[\s.]*\(((?:19|20)\d{2})\)\s*$/.exec(name);
  if (tagged && tagged[1]!.trim() !== '') return { title: tagged[1]!.trim(), year: Number(tagged[2]) };
  const parsed = parseRelease(name, kind);
  if (parsed.title !== '') return { title: parsed.title, ...(parsed.year === undefined ? {} : { year: parsed.year }) };
  return { title: name };
}

/** Same year; ±1 for a movie. A folder without a year matches no year. */
const sameYear = (kind: 'series' | 'movie', folderYear: number | undefined, year: number | undefined) =>
  folderYear !== undefined && year !== undefined && Math.abs(folderYear - year) <= (kind === 'movie' ? 1 : 0);

const WorkRef = z.object({ workId: zid('works').optional(), tmdbId: z.string(), kind: WorkKind, title: z.string(), year: z.number().optional() });
type WorkRef = z.infer<typeof WorkRef>;

/** `ScanMatch.workFolder`: the stored folder of a Work in the library, when it has one. */
async function workFolderOf(ctx: QueryCtx, work: WorkRef | null): Promise<{ workFolder?: string }> {
  const folder = work?.workId ? (await ctx.db.get(work.workId))?.folder : undefined;
  return folder === undefined ? {} : { workFolder: folder };
}

async function refOfWork(ctx: QueryCtx, workId: Id<'works'>): Promise<WorkRef | null> {
  const work = await ctx.db.get(workId);
  if (!work) return null;
  const tmdb = await ctx.db
    .query('externalIds')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .filter((q) => q.eq(q.field('provider'), 'tmdb'))
    .first();
  return { workId, tmdbId: tmdb?.value ?? '', kind: work.kind, title: work.title, ...(work.year === undefined ? {} : { year: work.year }) };
}

/**
 * What the library alone says of a folder: the Work its ID
 * tag names, else the one Work of the library with the folder's title and
 * year; otherwise the tag or the title and year TMDB has to answer.
 */
export const identifyFolder = internalQuery({
  args: zodToConvexFields({ libraryId: zid('libraries'), folder: z.string() }),
  returns: zodToConvex(
    z.object({
      work: WorkRef.nullable(),
      tag: z.object({ provider: z.enum(['tmdb', 'tvdb', 'imdb']), value: z.string() }).nullable(),
      title: z.string(),
      normalizedTitle: z.string(),
      year: z.number().optional(),
    }),
  ),
  handler: async (ctx, { libraryId, folder }) => {
    const library = (await ctx.db.get(libraryId))!;
    const kind = kindOf(library);
    const tag = idTagOf(folder);
    const parsed = folderTitleOf(folder, kind);
    const base = { tag, title: parsed.title, normalizedTitle: normalizeTitle(parsed.title), ...(parsed.year === undefined ? {} : { year: parsed.year }) };
    if (tag) {
      const workId =
        tag.provider === 'tmdb'
          ? await findWorkByTmdbId(ctx, tag.value, kind)
          : ((
              await Promise.all(
                (
                  await ctx.db
                    .query('externalIds')
                    .withIndex('by_provider_value', (q) => q.eq('provider', tag.provider).eq('value', tag.value))
                    .collect()
                ).map(async (row) => (row.workId && (await ctx.db.get(row.workId))?.kind === kind ? row.workId : null)),
              )
            ).find((id) => id !== null) ?? null);
      return { ...base, work: workId ? await refOfWork(ctx, workId) : null };
    }
    const works = new Set<Id<'works'>>();
    for (const { workId } of await findWorksByTitle(ctx, base.normalizedTitle)) {
      const work = await ctx.db.get(workId);
      if (work && work.kind === kind && work.libraryId === libraryId && sameYear(kind, parsed.year, work.year)) works.add(workId);
    }
    return { ...base, work: works.size === 1 ? await refOfWork(ctx, [...works][0]!) : null };
  },
});

/** The Works in the library for these TMDB results. */
export const worksOfHits = internalQuery({
  args: zodToConvexFields({ hits: z.array(z.object({ tmdbId: z.string(), kind: WorkKind })) }),
  returns: zodToConvex(z.array(zid('works').nullable())),
  handler: (ctx, { hits }) => Promise.all(hits.map((hit) => findWorkByTmdbId(ctx, hit.tmdbId, hit.kind))),
});

/** TMDB's results as suggestions, with the Work each is in the library as. */
async function suggestionsOf(ctx: ActionCtx, hits: ProviderHit[]): Promise<ScanSuggestion[]> {
  const top = hits.slice(0, 5);
  const workIds = await ctx.runQuery(internal.scan.match.worksOfHits, { hits: top.map(({ tmdbId, kind }) => ({ tmdbId, kind })) });
  return top.map((hit, i) => ({
    tmdbId: hit.tmdbId,
    kind: hit.kind,
    title: hit.title,
    ...(hit.year === undefined ? {} : { year: hit.year }),
    ...(workIds[i] ? { workId: workIds[i]! } : {}),
  }));
}

/** `scan.searchTitle`: TMDB's results for the match-by-hand title step. */
export async function searchTitles(ctx: ActionCtx, query: string, kind: z.infer<typeof WorkKind>): Promise<ScanSuggestion[]> {
  return suggestionsOf(ctx, await withProvider(ctx, (provider) => provider.search(query, kind)));
}

/** A new title's Units as labels, from TMDB's snapshot: regular episodes and specials with their numbers and titles, or the movie. */
const SnapshotUnit = z.object({ season: z.number().optional(), episode: z.number().optional(), title: z.string().optional() });
const snapshotUnitsOf = (work: WorkMetadata): z.infer<typeof SnapshotUnit>[] =>
  work.units.map((unit) => ({
    ...(unit.tmdbSeason === undefined ? {} : { season: unit.tmdbSeason }),
    ...(unit.tmdbEpisode === undefined ? {} : { episode: unit.tmdbEpisode }),
    ...(unit.title === undefined ? {} : { title: unit.title }),
  }));

type Found = { work: WorkRef | null; snapshot?: z.infer<typeof SnapshotUnit>[]; suggestions: ScanSuggestion[] };

/** A TMDB title for the folder: the Work in the library, else the title with its snapshot. */
async function foundTitle(
  ctx: ActionCtx,
  hit: { tmdbId: string; kind: 'series' | 'movie'; title: string; year?: number },
  suggestions: ScanSuggestion[],
): Promise<Found> {
  const [workId] = await ctx.runQuery(internal.scan.match.worksOfHits, { hits: [{ tmdbId: hit.tmdbId, kind: hit.kind }] });
  if (workId) return { work: await ctx.runQuery(internal.scan.match.workRef, { workId }), suggestions };
  const snapshot = await withProvider(ctx, (provider) => provider.lookupWork(hit.tmdbId, hit.kind));
  if (!snapshot) return { work: null, suggestions };
  return {
    work: { tmdbId: hit.tmdbId, kind: hit.kind, title: snapshot.title, ...(snapshot.year === undefined ? {} : { year: snapshot.year }) },
    snapshot: snapshotUnitsOf(snapshot),
    suggestions,
  };
}

export const workRef = internalQuery({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(WorkRef.nullable()),
  handler: (ctx, { workId }) => refOfWork(ctx, workId),
});

/**
 * The Work of one folder: an ID tag looks up the library,
 * then TMDB (`/find` for TVDB and IMDb); a title and year look up the
 * library's Works, then TMDB search, which counts only as the single result
 * with the same normalized title and year (±1 for movies). Anything else
 * has no Work, with up to 5 suggestions.
 */
async function findWork(ctx: ActionCtx, library: { libraryId: Id<'libraries'>; kind: 'series' | 'movie' }, folder: string): Promise<Found> {
  if (folder === '') return { work: null, suggestions: [] };
  const known = await ctx.runQuery(internal.scan.match.identifyFolder, { libraryId: library.libraryId, folder });
  if (known.work) return { work: known.work, suggestions: [] };
  if (known.tag) {
    const tag = known.tag;
    const hits =
      tag.provider === 'tmdb'
        ? [{ tmdbId: tag.value, kind: library.kind, title: known.title, ...(known.year === undefined ? {} : { year: known.year }) }]
        : (await withProvider(ctx, (provider) => provider.findByExternalId(tag.provider as 'tvdb' | 'imdb', tag.value))).filter(
            (hit) => hit.kind === library.kind,
          );
    if (hits.length === 1) return foundTitle(ctx, hits[0]!, []);
  }
  const hits = known.title === '' ? [] : await withProvider(ctx, (provider) => provider.search(known.title, library.kind));
  const exact = hits.filter((hit) => normalizeTitle(hit.title) === known.normalizedTitle && sameYear(library.kind, known.year, hit.year));
  const suggestions = await suggestionsOf(ctx, hits);
  if (exact.length === 1) return foundTitle(ctx, exact[0]!, suggestions);
  return { work: null, suggestions };
}

// ── The files of a folder ────────────────────────────────────────────────

/** `Season 1`, `Season 01`, `S01`, `Specials`: a season folder's number. */
const SEASON_FOLDER = /^(?:season ?(\d+)|s(\d+)|(specials))$/i;
export function seasonOfFolder(name: string | undefined): number | undefined {
  const match = name === undefined ? null : SEASON_FOLDER.exec(name.trim());
  if (!match) return undefined;
  return match[3] ? 0 : Number(match[1] ?? match[2]);
}

/** A file's numbers: its name's, with the season from its `Season N` folder when the name has none. */
function numbersOf(item: Doc<'scanItems'>): ParsedEpisode[] {
  const episodes = item.parsed?.episodes.filter((e) => e.episode !== undefined || e.absolute !== undefined) ?? [];
  const season = seasonOfFolder(item.path.split('/').at(-2));
  return episodes.map((e) => (e.season === undefined && e.episode !== undefined && season !== undefined ? { ...e, season } : e));
}

/** The scan review's "Read as": a label from the folder's tags and the file names' patterns. */
export function readAsOf(kind: 'series' | 'movie', folder: string, paths: string[]): ReadAs {
  if (/\{tvdb-/i.test(folder)) return 'sonarr';
  if (/\{(?:tmdb|imdb)-/i.test(folder)) return 'radarr';
  if (/\[(?:tmdbid|tvdbid|imdbid)-/i.test(folder)) return 'jellyfin';
  const names = paths.map((path) => path.split('/'));
  if (kind === 'series' && names.length > 0 && names.every((p) => / - S\d+E\d+/i.test(p.at(-1)!) && seasonOfFolder(p.at(-2)) !== undefined)) return 'sonarr';
  if (kind === 'movie' && /\(\d{4}\)$/.test(folder) && names.some((p) => p.at(-1)!.startsWith(folder))) return 'radarr';
  return 'unknown';
}

type Reading = { unitIds: Id<'units'>[]; units: ScanUnitLabel[] } | null;
type FolderInput = {
  scanRunId: Id<'scanRuns'>;
  library: Doc<'libraries'>;
  folder: string;
  work: WorkRef | null;
  snapshot?: z.infer<typeof SnapshotUnit>[];
  suggestions: ScanSuggestion[];
  /** A numbering the user chose; otherwise the trial picks one. */
  ordering?: z.infer<typeof ScanNumbering>;
};

const label = (unit: Doc<'units'>): ScanUnitLabel => ({
  ...(unit.tmdbSeason === undefined ? {} : { season: unit.tmdbSeason }),
  ...(unit.tmdbEpisode === undefined ? {} : { episode: unit.tmdbEpisode }),
  ...(unit.title === undefined ? {} : { title: unit.title }),
});

/** Reads a file's numbers in one ordering: through resolveUnits for a Work in the library, else against TMDB's snapshot. */
async function readIn(ctx: MutationCtx, input: FolderInput, ordering: z.infer<typeof ScanNumbering>, episodes: ParsedEpisode[]): Promise<Reading> {
  if (input.work?.workId) {
    const result = await resolveUnits(ctx, input.work.workId, episodes, undefined, { kind: 'plain' }, { orderings: [ordering] });
    if (result.problem || result.unitIds.length === 0) return null;
    const units = (await Promise.all(result.unitIds.map((id) => ctx.db.get(id)))).filter((unit) => unit !== null);
    return { unitIds: result.unitIds, units: units.map(label) };
  }
  // A new title: TMDB numbers, or the position among its regular episodes for absolute numbers. TVDB needs mapping rows it doesn't have yet.
  const snapshot = input.snapshot ?? [];
  const regular = snapshot.filter((unit) => (unit.season ?? 0) > 0);
  const units: ScanUnitLabel[] = [];
  for (const e of episodes) {
    const unit =
      ordering === 'tmdb' && e.season !== undefined && e.episode !== undefined
        ? snapshot.find((u) => u.season === e.season && u.episode === e.episode)
        : ordering === 'absolute' && e.absolute !== undefined
          ? regular[e.absolute - 1]
          : undefined;
    if (!unit) return null;
    units.push(unit);
  }
  return units.length > 0 ? { unitIds: [], units } : null;
}

const key = (reading: Reading) => (reading ? reading.units.map((u) => `${u.season}:${u.episode}`).join(',') : '');

/**
 * Matches one folder's files to its Work: the ordering
 * trial (TMDB, TVDB, then absolute for anime), conflicts with Units that
 * have a primary already, the comparison with the library's target and the
 * "Read as" label. Imported and ignored files are left as they are.
 */
export async function resolveFolder(ctx: MutationCtx, input: FolderInput): Promise<void> {
  const { library, work } = input;
  const all = await folderItems(ctx, input.scanRunId, library._id, input.folder);
  const items = all.filter((item) => item.status !== 'imported' && item.status !== 'ignored' && item.probe !== undefined);
  const target = await targetOf(ctx, library._id);
  const readAs = readAsOf(
    kindOf(library),
    input.folder,
    items.map((item) => item.path),
  );
  const workFolder = await workFolderOf(ctx, work);
  const set = async (
    item: Doc<'scanItems'>,
    status: 'matched' | 'unmatched',
    reason?: UnmatchedReason,
    reading?: Reading,
    ordering?: ScanMatch['ordering'],
  ) => {
    const comparison = compare(item.probe!, target);
    const match: ScanMatch | undefined = work
      ? { ...work, ordering: ordering ?? 'tmdb', unitIds: reading?.unitIds ?? [], units: reading?.units ?? [], readAs, ...workFolder }
      : undefined;
    await ctx.db.patch(item._id, {
      status,
      unmatchedReason: reason,
      match,
      suggestions: work ? undefined : input.suggestions,
      fits: comparison.fits,
      step: mostExpensive(comparison.steps),
    });
  };

  if (!work) {
    for (const item of items) await set(item, 'unmatched', 'noWork');
    return;
  }

  const readings = new Map<Id<'scanItems'>, Reading>();
  let ordering: ScanMatch['ordering'] = input.ordering ?? 'tmdb';
  if (work.kind === 'movie') {
    // The folder's largest video is the film; the others are extras.
    const film = [...items].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    const units = work.workId
      ? await ctx.db
          .query('units')
          .withIndex('by_work', (q) => q.eq('workId', work.workId!))
          .collect()
      : [];
    if (film) readings.set(film._id, { unitIds: units.map((unit) => unit._id), units: [{ title: work.title }] });
  } else {
    const numbered = items.filter((item) => numbersOf(item).length > 0);
    const workDoc = work.workId ? await ctx.db.get(work.workId) : null;
    const anime = workDoc?.numberingScheme === 'anime' || (!workDoc && numbered.some((item) => numbersOf(item).every((e) => e.episode === undefined)));
    const trial: z.infer<typeof ScanNumbering>[] = input.ordering ? [input.ordering] : ['tmdb', 'tvdb', ...(anime ? (['absolute'] as const) : [])];
    const results = new Map<string, Map<Id<'scanItems'>, Reading>>();
    for (const o of trial) {
      const read = new Map<Id<'scanItems'>, Reading>();
      for (const item of numbered) read.set(item._id, await readIn(ctx, input, o, numbersOf(item)));
      results.set(o, read);
    }
    // Every numbered file to a Unit, and no two files to the same one.
    const complete = (read: Map<Id<'scanItems'>, Reading>) => {
      const keys = [...read.values()].map(key);
      return numbered.length > 0 && keys.every((k) => k !== '') && new Set(keys).size === keys.length;
    };
    const winners = trial.filter((o) => complete(results.get(o)!));
    const agree = winners.every((o) => numbered.every((item) => key(results.get(o)!.get(item._id)!) === key(results.get(winners[0]!)!.get(item._id)!)));
    if (!input.ordering && winners.length > 1 && !agree) {
      for (const item of items) await set(item, 'unmatched', numbered.includes(item) ? 'ambiguous' : 'noNumbers');
      return;
    }
    const count = (o: string) => [...results.get(o)!.values()].filter((r) => r !== null).length;
    ordering = winners[0] ?? [...trial].sort((a, b) => count(b) - count(a))[0]!;
    for (const [id, reading] of results.get(ordering)!) readings.set(id, reading);
  }

  // Two files for one Unit: the larger is kept, the other waits for the user.
  const taken = new Map<string, Id<'scanItems'>>();
  for (const item of [...items].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
    const reading = readings.get(item._id);
    if (!reading) continue;
    const k = key(reading);
    if (taken.has(k)) readings.set(item._id, null);
    else taken.set(k, item._id);
  }

  for (const item of items) {
    const reading = readings.get(item._id);
    if (!reading) {
      const reason: UnmatchedReason = work.kind === 'movie' || numbersOf(item).length > 0 ? 'unitNotFound' : 'noNumbers';
      await set(item, 'unmatched', reason, null, ordering);
      continue;
    }
    if (await hasPrimary(ctx, reading.unitIds)) {
      await set(item, 'unmatched', undefined, reading, ordering);
      await ctx.db.patch(item._id, { status: 'conflict', unmatchedReason: undefined });
      continue;
    }
    await set(item, 'matched', undefined, reading, ordering);
  }
}

/** Whether any of the Units already has a primary file version. */
export async function hasPrimary(ctx: QueryCtx, unitIds: Id<'units'>[]): Promise<boolean> {
  for (const unitId of unitIds) {
    const versions = await ctx.db
      .query('fileVersions')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    if (versions.some((version) => version.kind === 'primary')) return true;
  }
  return false;
}

// ── The action and its mutations ─────────────────────────────────────────

const FolderPage = z.object({
  state: z.string(),
  folders: z.array(z.object({ libraryId: zid('libraries'), kind: WorkKind, folder: z.string() })),
  next: ScanFolderRef.nullable(),
});

/** The next `scanFoldersPerAction` folders of a run after `after`. */
export const folderPage = internalQuery({
  args: zodToConvexFields({ scanRunId: zid('scanRuns'), after: ScanFolderRef.nullable() }),
  returns: zodToConvex(FolderPage.nullable()),
  handler: async (ctx, { scanRunId, after }) => {
    const run = await ctx.db.get(scanRunId);
    if (!run) return null;
    const folders: z.infer<typeof FolderPage>['folders'] = [];
    let next: z.infer<typeof ScanFolderRef> | null = null;
    for await (const { library, folder } of foldersOf(ctx, scanRunId, after)) {
      if (folders.length === DEFAULT_LIMITS.scanFoldersPerAction) {
        const last = folders.at(-1)!;
        next = { libraryId: last.libraryId, folder: last.folder };
        break;
      }
      folders.push({ libraryId: library._id, kind: kindOf(library), folder });
    }
    return { state: run.state, folders, next };
  },
});

const FolderArgs = {
  scanRunId: zid('scanRuns'),
  libraryId: zid('libraries'),
  folder: z.string(),
  work: WorkRef.nullable(),
  snapshot: z.array(SnapshotUnit).optional(),
  suggestions: z.array(ScanSuggestionSchema),
  ordering: ScanNumbering.optional(),
};

/** Writes one folder's match, unless the run was cancelled meanwhile. */
export const applyFolder = internalMutation({
  args: zodToConvexFields(FolderArgs),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { scanRunId, libraryId, folder, work, snapshot, suggestions, ordering }) => {
    const run = await ctx.db.get(scanRunId);
    const library = await ctx.db.get(libraryId);
    if (!run || !library || run.state === 'cancelled') return null;
    await resolveFolder(ctx, {
      scanRunId,
      library,
      folder,
      work,
      suggestions,
      ...(snapshot ? { snapshot } : {}),
      ...(ordering ? { ordering } : {}),
    });
    await recount(ctx, scanRunId);
    return null;
  },
});

/** Enqueues the next page of a run's match in the metadata pool. */
export const continueRun = internalMutation({
  args: zodToConvexFields({ scanRunId: zid('scanRuns'), after: ScanFolderRef }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { scanRunId, after }) => {
    await metadataPool.enqueueAction(ctx, internal.scan.match.run, { scanRunId, after });
    return null;
  },
});

/** The match is done: the run waits for the review. */
export const finish = internalMutation({
  args: zodToConvexFields({ scanRunId: zid('scanRuns') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { scanRunId }) => {
    const run = await ctx.db.get(scanRunId);
    if (run?.state !== 'matching') return null;
    await recount(ctx, scanRunId);
    await ctx.db.patch(scanRunId, { state: 'ready', finishedAt: Date.now() });
    return null;
  },
});

/** `scan/match.run`: one page of folders, then the next page or the end. */
export const run = internalAction({
  args: zodToConvexFields({ scanRunId: zid('scanRuns'), after: ScanFolderRef.optional() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { scanRunId, after }): Promise<null> => {
    const page = await ctx.runQuery(internal.scan.match.folderPage, { scanRunId, after: after ?? null });
    if (!page || page.state !== 'matching') return null;
    for (const { libraryId, kind, folder } of page.folders) {
      const found = await findWork(ctx, { libraryId, kind }, folder);
      await ctx.runMutation(internal.scan.match.applyFolder, {
        scanRunId,
        libraryId,
        folder,
        work: found.work,
        suggestions: found.suggestions,
        ...(found.snapshot ? { snapshot: found.snapshot } : {}),
      });
    }
    if (page.next) await ctx.runMutation(internal.scan.match.continueRun, { scanRunId, after: page.next });
    else await ctx.runMutation(internal.scan.match.finish, { scanRunId });
    return null;
  },
});

/** Re-reads one folder with the user's title or numbering, in the metadata pool (TMDB's snapshot for a new title). */
export const rematch = internalAction({
  args: zodToConvexFields({
    scanRunId: zid('scanRuns'),
    libraryId: zid('libraries'),
    folder: z.string(),
    title: z.object({ tmdbId: z.string(), kind: WorkKind, title: z.string(), year: z.number().optional() }).optional(),
    ordering: ScanNumbering.optional(),
  }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { scanRunId, libraryId, folder, title, ordering }): Promise<null> => {
    const kind = await ctx.runQuery(internal.scan.match.kindOfLibrary, { libraryId });
    if (!kind) return null;
    const found = title ? await foundTitle(ctx, title, []) : await findWork(ctx, { libraryId, kind }, folder);
    await ctx.runMutation(internal.scan.match.applyFolder, {
      scanRunId,
      libraryId,
      folder,
      work: found.work,
      suggestions: found.suggestions,
      ...(found.snapshot ? { snapshot: found.snapshot } : {}),
      ...(ordering ? { ordering } : {}),
    });
    return null;
  },
});

export const kindOfLibrary = internalQuery({
  args: zodToConvexFields({ libraryId: zid('libraries') }),
  returns: zodToConvex(WorkKind.nullable()),
  handler: async (ctx, { libraryId }) => {
    const library = await ctx.db.get(libraryId);
    return library ? kindOf(library) : null;
  },
});

// ── Review decisions ─────────────────────────────────────

/** The Work a folder's items matched, as `resolveFolder` takes it. */
const workOfItems = (items: Doc<'scanItems'>[]): WorkRef | null => {
  const match = items.find((item) => item.match)?.match;
  if (!match) return null;
  return {
    ...(match.workId ? { workId: match.workId } : {}),
    tmdbId: match.tmdbId,
    kind: match.kind,
    title: match.title,
    ...(match.year === undefined ? {} : { year: match.year }),
  };
};

/**
 * `scan.setNumbering`: re-reads a folder in the chosen numbering. A Work in
 * the library is read at once; a new title is read again in the pool, which
 * fetches its TMDB snapshot.
 */
export async function setNumberingFor(
  ctx: MutationCtx,
  {
    scanRunId,
    libraryId,
    folder,
    ordering,
  }: { scanRunId: Id<'scanRuns'>; libraryId: Id<'libraries'>; folder: string; ordering: z.infer<typeof ScanNumbering> },
): Promise<void> {
  const library = await ctx.db.get(libraryId);
  const items = await folderItems(ctx, scanRunId, libraryId, folder);
  const work = workOfItems(items);
  if (!library || !work) return;
  await ctx.db.patch(scanRunId, { hasDecisions: true });
  if (work.workId) {
    await resolveFolder(ctx, { scanRunId, library, folder, work, suggestions: [], ordering });
    await recount(ctx, scanRunId);
  } else {
    await metadataPool.enqueueAction(ctx, internal.scan.match.rematch, { scanRunId, libraryId, folder, title: work, ordering });
  }
}

/**
 * `scan.matchFolder` ("Match by hand"): a title for the folder, then,
 * optionally, what each file is. Without `files` the folder is read again
 * against the title. With them only the assigned files are matched
 * (`manual`); a season and episode the Work doesn't have leaves the file
 * unmatched, and the files left out stay unmatched.
 */
export async function matchByHand(ctx: MutationCtx, request: ScanMatchFolderRequest): Promise<void> {
  const { scanRunId, libraryId, folder, title, files } = request;
  const library = await ctx.db.get(libraryId);
  if (!library) return;
  await ctx.db.patch(scanRunId, { hasDecisions: true });
  const workId = await findWorkByTmdbId(ctx, title.tmdbId, title.kind);
  const work: WorkRef = {
    ...(workId ? { workId } : {}),
    tmdbId: title.tmdbId,
    kind: title.kind,
    title: title.title,
    ...(title.year === undefined ? {} : { year: title.year }),
  };
  if (!files) {
    if (workId) {
      await resolveFolder(ctx, { scanRunId, library, folder, work, suggestions: [] });
      await recount(ctx, scanRunId);
    } else await metadataPool.enqueueAction(ctx, internal.scan.match.rematch, { scanRunId, libraryId, folder, title });
    return;
  }
  const target = await targetOf(ctx, libraryId);
  const items = await folderItems(ctx, scanRunId, libraryId, folder);
  const assigned = new Map(files.map((file) => [file.scanItemId, file]));
  const readAs = readAsOf(
    title.kind,
    folder,
    items.map((item) => item.path),
  );
  const workFolder = await workFolderOf(ctx, work);
  for (const item of items) {
    if (item.status === 'imported' || !item.probe) continue;
    const file = assigned.get(item._id);
    let reading: Reading = null;
    if (file?.movie && title.kind === 'movie') {
      const units = workId
        ? await ctx.db
            .query('units')
            .withIndex('by_work', (q) => q.eq('workId', workId))
            .collect()
        : [];
      reading = { unitIds: units.map((unit) => unit._id), units: [{ title: title.title }] };
    } else if (file?.season !== undefined && file.episode !== undefined && title.kind === 'series') {
      if (workId) {
        const unit = await ctx.db
          .query('units')
          .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', file.season).eq('tmdbEpisode', file.episode))
          .first();
        reading = unit ? { unitIds: [unit._id], units: [label(unit)] } : null;
      } else reading = { unitIds: [], units: [{ season: file.season, episode: file.episode }] };
    }
    const comparison = compare(item.probe, target);
    const conflict = reading !== null && (await hasPrimary(ctx, reading.unitIds));
    await ctx.db.patch(item._id, {
      status: reading === null ? 'unmatched' : conflict ? 'conflict' : 'matched',
      unmatchedReason: reading === null ? (file ? 'unitNotFound' : 'noNumbers') : undefined,
      match: { ...work, ordering: 'manual', unitIds: reading?.unitIds ?? [], units: reading?.units ?? [], readAs, ...workFolder },
      suggestions: undefined,
      fits: comparison.fits,
      step: mostExpensive(comparison.steps),
    });
  }
  await recount(ctx, scanRunId);
}
