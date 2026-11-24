import { type Limits, limitsFrom } from '@omnarr/contracts';

export const CONVEX_ACTION_LIMIT_MS = 10 * 60_000;

export const limits = (): Limits => limitsFrom(process.env.OMNARR_TEST_LIMITS);
