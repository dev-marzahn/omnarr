import type { UnitRow, WorkSummary } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { activePreparationsLine, filePreparingText, posterBadge, preparingProgress, unitPreparingLine } from '../lib/preparingProgress';

type Preparation = NonNullable<UnitRow['preparation']>;
const renditionId = 'r1' as Preparation['renditionId'];

describe('preparingProgress', () => {
  test("running: the worker's step and the percent", () => {
    expect(preparingProgress({ detail: 'Audio conversion DTS → AAC', fraction: 0.204 })).toEqual({
      stage: 'Preparing',
      text: 'Audio conversion DTS → AAC',
      percent: 20,
    });
  });

  test('a step without a known length: the step, no percent', () => {
    expect(preparingProgress({ detail: 'Checking the file' })).toEqual({ stage: 'Preparing', text: 'Checking the file' });
    expect(preparingProgress({ detail: 'Moving into the library', fraction: 0 })).toEqual({ stage: 'Preparing', text: 'Moving into the library' });
  });

  test('queued: waiting for the worker', () => {
    expect(preparingProgress({})).toEqual({ stage: 'Queued', text: 'Waiting for the worker' });
    expect(preparingProgress({ fraction: 0 })).toEqual({ stage: 'Queued', text: 'Waiting for the worker' });
  });
});

describe('unitPreparingLine and filePreparingText', () => {
  test('the percent while the step reports one', () => {
    const preparation: Preparation = { renditionId, steps: ['subtitle'], detail: 'Subtitle extraction', fraction: 0.4 };
    expect(unitPreparingLine(preparation)).toEqual({ text: 'Subtitle extraction', percent: 40 });
    expect(filePreparingText(preparation)).toBe('Preparing · Subtitle extraction · 40%');
  });

  test('no percent while the fraction is 0', () => {
    const preparation: Preparation = { renditionId, steps: ['audio'], detail: 'Checking the new file', fraction: 0 };
    expect(unitPreparingLine(preparation)).toEqual({ text: 'Checking the new file' });
    expect(filePreparingText(preparation)).toBe('Preparing · Checking the new file');
  });
});

describe('activePreparationsLine', () => {
  test('one preparation: "Preparing" and its percent', () => {
    expect(activePreparationsLine({ count: 1, fraction: 0.62 })).toEqual({ line: 'Preparing · 62%', badge: '62%' });
  });

  test('without a percent: the badge says Preparing', () => {
    expect(activePreparationsLine({ count: 1 })).toEqual({ line: 'Preparing', badge: 'Preparing' });
    expect(activePreparationsLine({ count: 1, fraction: 0 })).toEqual({ line: 'Preparing', badge: 'Preparing' });
  });

  test('several: the count, and the running one’s percent; the badge stays short', () => {
    expect(activePreparationsLine({ count: 3, fraction: 0.1 })).toEqual({ line: '3 preparing · 10%', badge: '3 · 10%' });
  });

  test('several without a percent: the count only', () => {
    expect(activePreparationsLine({ count: 3 })).toEqual({ line: '3 preparing', badge: '3' });
  });

  test('none', () => {
    expect(activePreparationsLine(undefined)).toBeUndefined();
  });
});

describe('posterBadge', () => {
  const work = (overrides: Partial<Pick<WorkSummary, 'states' | 'activePreparations'>> = {}) => ({ states: [], ...overrides });

  test('a running preparation shows like a download', () => {
    expect(posterBadge(work({ activePreparations: { count: 1, fraction: 0.35 } }), undefined)).toEqual({
      label: '35%',
      icon: 'i-lucide-wand-sparkles',
      color: 'secondary',
    });
  });

  test('a download wins the badge when both run', () => {
    expect(posterBadge(work({ activePreparations: { count: 1, fraction: 0.35 } }), { badge: '61%' })).toEqual({
      label: '61%',
      icon: 'i-lucide-download',
      color: 'info',
    });
  });

  test('a preparation wins over failed Units; failed shows when nothing runs', () => {
    const failed: WorkSummary['states'] = [{ state: 'failed', count: 2 }];
    expect(posterBadge(work({ states: failed, activePreparations: { count: 1 } }), undefined)?.label).toBe('Preparing');
    expect(posterBadge(work({ states: failed }), undefined)).toEqual({ label: '2 failed', icon: 'i-lucide-circle-x', color: 'error' });
    expect(posterBadge(work(), undefined)).toBeUndefined();
  });
});
