import type { Timeline, UnitRow, WorkSummary } from '@omnarr/contracts';

import { preparingLine } from './preparation';

const percentOf = (fraction: number | undefined): number | undefined => (fraction ? Math.floor(fraction * 100) : undefined);
const withPercent = (percent: number | undefined): { percent?: number } => (percent === undefined ? {} : { percent });

export type PreparingProgress = { stage: 'Preparing' | 'Queued'; text: string; percent?: number };

export function preparingProgress(preparation: NonNullable<Timeline['preparation']>): PreparingProgress {
  if (!preparation.detail) return { stage: 'Queued', text: 'Waiting for the worker' };
  return { stage: 'Preparing', text: preparation.detail, ...withPercent(percentOf(preparation.fraction)) };
}

export function unitPreparingLine(preparation: NonNullable<UnitRow['preparation']>): { text: string; percent?: number } {
  const { text } = preparingLine(preparation);
  return { text, ...withPercent(percentOf(preparation.fraction)) };
}

export function filePreparingText(preparation: NonNullable<UnitRow['preparation']>): string {
  const { text, percent } = unitPreparingLine(preparation);
  return ['Preparing', text, ...(percent === undefined ? [] : [`${percent}%`])].join(' · ');
}

export function activePreparationsLine(active: WorkSummary['activePreparations']): { line: string; badge: string } | undefined {
  if (!active) return undefined;
  const percent = percentOf(active.fraction);
  const shown = percent === undefined ? [] : [`${percent}%`];
  const head = active.count === 1 ? 'Preparing' : `${active.count} preparing`;
  return {
    line: [head, ...shown].join(' · '),
    badge: active.count === 1 ? (shown[0] ?? 'Preparing') : [String(active.count), ...shown].join(' · '),
  };
}

export type PosterBadge = { label: string; icon: string; color: 'info' | 'secondary' | 'error' };

export function posterBadge(work: Pick<WorkSummary, 'states' | 'activePreparations'>, downloading: { badge: string } | undefined): PosterBadge | undefined {
  if (downloading) return { label: downloading.badge, icon: 'i-lucide-download', color: 'info' };
  const preparing = activePreparationsLine(work.activePreparations);
  if (preparing) return { label: preparing.badge, icon: 'i-lucide-wand-sparkles', color: 'secondary' };
  const failed = work.states.find((s) => s.state === 'failed')?.count ?? 0;
  return failed > 0 ? { label: `${failed} failed`, icon: 'i-lucide-circle-x', color: 'error' } : undefined;
}
