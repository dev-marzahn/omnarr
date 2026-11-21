// The search action, in Convex's default runtime. Per
// indexer, in parallel: the skips, then the request plan one request at a
// time, each page parsed, matched, resolved and evaluated, and recorded in
// one mutation. Then finishAttempt picks.
import type { IndexerCall, IndexerItem, IndexerPage, IndexerRequest, ParsedRelease } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { evaluate, matchTitle, matchUnits, type MatchResult, type TitleMatch, toPreparationTarget } from '@omnarr/scoring';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { type ActionCtx, internalAction } from '../_generated/server';
import { createAdapter } from '../indexers/adapter';
import { atLimit, shareLeft } from '../indexers/rateLimit';
import { sendsRequest } from '../indexers/relay';
import { initialState, nextRequest, skipReason } from '../indexers/requestPlan';
import type { CandidateInsert, IndexerForSearch, PageResult, SearchContext } from './search';
import { upgradeVerdict } from './upgrades';

/** A challenge is a rate limit too. */
const statusOf = (kind: string): PageResult['status'] =>
  kind === 'timeout' ? 'timeout' : kind === 'rateLimited' || kind === 'challenged' ? 'rateLimited' : 'error';

/** A page's items parsed and evaluated against the Work, its group and profile. */
export async function evaluatePage(
  ctx: ActionCtx,
  context: Pick<SearchContext, 'work' | 'group' | 'profile' | 'blocklistKeys' | 'preferredLanguage' | 'originalLanguage' | 'target' | 'currents'>,
  items: IndexerItem[],
): Promise<{ rows: CandidateInsert[]; titleMatched: boolean }> {
  const parsed = items.map((item) => parseRelease(item.title, context.work.kind));
  const titles: TitleMatch[] = items.map((item, i) => matchTitle(parsed[i]!, item, context.work as Parameters<typeof matchTitle>[2]));
  const matched = titles.flatMap((title, i) => (title.ok ? [i] : []));
  const { results, runtimes } =
    matched.length === 0
      ? { results: [], runtimes: [] }
      : await ctx.runQuery(internal.pipeline.search.resolvePage, {
          workId: context.work.id,
          items: matched.map((i) => {
            const title = titles[i] as Extract<TitleMatch, { ok: true }>;
            return { episodes: parsed[i]!.episodes, airDate: parsed[i]!.airDate, anidbId: title.anidbId, season: title.season, sceneSeason: title.sceneSeason };
          }),
        });
  const runtime = new Map(runtimes.map((entry) => [entry.unitId, entry.runtimeMin]));
  const resolved = new Map(matched.map((i, n) => [i, results[n]!]));

  const rows = items.map((item, i): CandidateInsert => {
    const title = titles[i]!;
    const match: MatchResult | Extract<TitleMatch, { ok: false }> = title.ok
      ? matchUnits(resolved.get(i)! as Parameters<typeof matchUnits>[0], context.group as Parameters<typeof matchUnits>[1], parsed[i]!)
      : title;
    return candidateRow(item, parsed[i]!, match, runtime, context);
  });
  return { rows, titleMatched: matched.length > 0 };
}

/**
 * Evaluates one result against the Work's profile and turns the verdict into
 * the row the candidate stores. The preparation it predicts is against the
 * Work's library target.
 */
export function candidateRow(
  item: IndexerItem,
  parsed: ParsedRelease,
  match: MatchResult | Extract<TitleMatch, { ok: false }>,
  runtime: Map<string, number | undefined>,
  context: Pick<SearchContext, 'profile' | 'blocklistKeys' | 'preferredLanguage' | 'originalLanguage' | 'target' | 'currents'>,
): CandidateInsert {
  const units = match.ok ? [...match.coveredUnitIds, ...match.alsoContainsUnitIds] : [];
  const minutes = units.map((id) => runtime.get(id));
  const runtimeMinutes = minutes.length > 0 && minutes.every((m) => m !== undefined) ? minutes.reduce((sum, m) => sum + m!, 0) : undefined;
  const verdict = evaluate({
    parsed,
    item,
    match,
    profile: context.profile,
    blocklistKeys: context.blocklistKeys,
    target: toPreparationTarget(context.target),
    runtimeMinutes,
    originalLanguage: context.originalLanguage,
    preferredLanguage: context.preferredLanguage,
  });
  // A release covering a Unit that already plays must be an upgrade over its current release.
  const upgrade = verdict.accepted ? upgradeVerdict(verdict, parsed, context.profile, context.currents) : undefined;
  if (upgrade === false) Object.assign(verdict, { accepted: false, reason: 'notAnUpgrade' });
  if (upgrade === 'partial') Object.assign(verdict, { accepted: false, reason: 'partialUpgrade' });
  return {
    guid: item.guid,
    title: item.title,
    downloadUrl: item.downloadUrl,
    sizeBytes: item.sizeBytes,
    protocol: item.protocol,
    publishedAt: item.publishedAt,
    parsed,
    unitIds: verdict.coveredUnitIds as Id<'units'>[],
    alsoContainsUnitIds: verdict.alsoContainsUnitIds as Id<'units'>[],
    quality: verdict.quality,
    qualityRank: verdict.qualityRank,
    qualityAssumed: verdict.qualityAssumed,
    baseScore: verdict.baseScore,
    score: verdict.score,
    scoreBreakdown: verdict.breakdown,
    preparationStep: verdict.preparation.step,
    preparationAssumed: verdict.preparation.assumed,
    accepted: verdict.accepted,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.matchDetail ? { matchDetail: verdict.matchDetail } : {}),
    // A wrong episode keeps what numbering found, so the item page can say what it could be.
    ...(!match.ok && 'problem' in match && match.problem ? { matchProblem: match.problem } : {}),
    ...(!match.ok && 'possibleUnitIds' in match && match.possibleUnitIds ? { possibleUnitIds: match.possibleUnitIds as Id<'units'>[] } : {}),
    ...(item.torrent ? { torrent: item.torrent } : {}),
    ...(upgrade === true ? { isUpgrade: true } : {}),
  };
}

/** One indexer's part of a search: skips, then the plan's requests until it ends, each page recorded. */
async function searchIndexer(ctx: ActionCtx, attemptId: Id<'searchAttempts'>, context: SearchContext, indexer: IndexerForSearch): Promise<void> {
  const record = (rows: CandidateInsert[], calls: IndexerCall[], result: PageResult) =>
    ctx.runMutation(internal.pipeline.search.recordCandidatesPage, { attemptId, indexerId: indexer.id, rows, calls, result });
  const now = Date.now();
  // A protocol whose client is off counts as one the profile excludes; `evaluate` is unchanged.
  const protocols = context.profile.protocols.filter((protocol) => !context.disabledProtocols.includes(protocol));
  const skipped = skipReason(indexer, {
    now,
    origin: context.origin,
    protocols,
    workKind: context.work.kind,
    numberingScheme: context.work.numberingScheme,
  });
  if (skipped) {
    await record([], [], { pages: 0, count: 0, status: 'error', skipped });
    return;
  }
  const target = await ctx.runQuery(internal.indexers.store.getForAction, { indexerId: indexer.id });
  if (!target) return;
  const adapter = createAdapter(target, ctx);

  // The action's own count of the day's requests: the snapshot, then each page's total.
  let usage = indexer.usage;
  let step = nextRequest(initialState(context.group, indexer, context.keys));
  let pages = 0;
  while (step.request) {
    // A page the adapter answers without a request is the empty page it would return: no call, no page,
    // and none of the plan's request budget.
    if (!sendsRequest(target, step.request.offset)) {
      step = nextRequest({ ...step.state, spent: step.state.spent - 1 }, { items: [] });
      continue;
    }
    if (shareLeft({ ...indexer, usage }, Date.now(), context.origin) < 1) {
      if (pages === 0) await record([], [], { pages: 0, count: 0, status: 'error', skipped: 'share' });
      return;
    }
    const request: IndexerRequest = step.request;
    const started = Date.now();
    const response = await adapter.search(request);
    const latencyMs = Date.now() - started;
    // A refused pacing slot sent nothing: a skip like the share's, with no call.
    if (!response.ok && response.skipped) {
      if (pages === 0) await record([], [], { pages: 0, count: 0, status: 'error', skipped: 'paced' });
      return;
    }
    pages += 1;
    if (!response.ok) {
      const failure = response.failure;
      await record([], [{ at: Date.now(), ok: false, latencyMs, kind: 'search', failure }], {
        pages: 1,
        count: 0,
        status: statusOf(failure.kind),
        failureCode: failure.code,
      });
      return;
    }
    const page: IndexerPage = response.value;
    const { rows, titleMatched } = await evaluatePage(ctx, context, page.items);
    step = nextRequest(
      { ...step.state, titleMatched: step.state.titleMatched || titleMatched, accepted: step.state.accepted || rows.some((row) => row.accepted) },
      page,
    );
    const call: IndexerCall = {
      at: Date.now(),
      ok: true,
      latencyMs,
      kind: 'search',
      count: page.items.length,
      ...(page.apiLimits ? { apiLimits: page.apiLimits } : {}),
    };
    const { total24h } = await record(rows, [call], {
      pages: 1,
      count: page.items.length,
      status: 'ok',
      ...(step.request === null && step.state.truncated ? { truncated: true } : {}),
    });
    usage = [{ hourStart: Date.now(), requests: total24h, errors: 0 }];
    // The page counted, but the indexer's day is spent: no further request.
    if (atLimit(page.apiLimits)) return;
  }
}

export const runSearch = internalAction({
  args: zodToConvexFields({ attemptId: zid('searchAttempts') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { attemptId }) => {
    const context = await ctx.runQuery(internal.pipeline.search.context, { attemptId });
    if (context) await Promise.all(context.indexers.map((indexer) => searchIndexer(ctx, attemptId, context, indexer)));
    await ctx.runMutation(internal.pipeline.search.finishAttempt, { attemptId });
    return null;
  },
});
