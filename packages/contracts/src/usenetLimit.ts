// A Usenet server's optional monthly download limit. The worker sums NZBGet's
// per-server traffic since the period's start and pauses the server at the
// limit until the next period; Settings › Downloads shows the same period.
// Days are UTC days, as NZBGet's day slots are in its container, which sets no
// time zone.
import { z } from 'zod';

/** `monthlyLimitGb` in decimal GB (10⁹ bytes); `resetDay` is the provider's billing day, 1–28 so every month has it. */
export const UsenetLimit = z.object({
  monthlyLimitGb: z.number().positive(),
  resetDay: z.number().int().min(1).max(28),
});
export type UsenetLimit = z.infer<typeof UsenetLimit>;

const BYTES_PER_GB = 1e9;

/** The billing period holding `now`: from the last reset day (00:00 UTC) to the next. */
export function usagePeriod(resetDay: number, now: number): { start: number; next: number } {
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() - (today.getUTCDate() >= resetDay ? 0 : 1);
  // Date.UTC carries a month of -1 or 12 into the year before or after.
  return { start: Date.UTC(year, month, resetDay), next: Date.UTC(year, month + 1, resetDay) };
}

/** Whether a period's traffic has used the whole limit. */
export const limitReached = (usedBytes: number, monthlyLimitGb: number): boolean => usedBytes >= monthlyLimitGb * BYTES_PER_GB;

/** What the worker last read of a server's period: `backupId` absent is the main server. */
export const UsenetServerUsage = z.object({
  backupId: z.string().optional(),
  usedBytes: z.number().min(0),
  limitReached: z.boolean(),
});
export type UsenetServerUsage = z.infer<typeof UsenetServerUsage>;
