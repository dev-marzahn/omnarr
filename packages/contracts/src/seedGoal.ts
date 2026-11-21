// A torrent's seeding goal and the rule that sets it. Its own module
// because jobs.ts (the submit payload) and downloadClients.ts both need it.
import { z } from 'zod';

/**
 * A torrent's seeding goal: qBittorrent stops the torrent at the
 * first limit it reaches. At least one of the two.
 */
export const SeedGoal = z
  .object({ ratio: z.number().positive().optional(), seedTimeMs: z.number().int().positive().optional() })
  .refine((goal) => goal.ratio !== undefined || goal.seedTimeMs !== undefined, { message: 'A seeding goal needs a ratio or a seed time' });
export type SeedGoal = z.infer<typeof SeedGoal>;

/** Ratio 2.0 or 14 days, whichever comes first. */
export const DEFAULT_SEED_GOAL = { ratio: 2, seedTimeMs: 1_209_600_000 } as const satisfies SeedGoal;

/**
 * How far a seeding torrent is towards its goal, 0 to 1: the closer of the
 * goal's dimensions, since qBittorrent stops at the first it reaches. None
 * without a reading or a goal.
 */
export function seedingFraction(goal: SeedGoal | undefined, seed: { ratio?: number; seedTimeMs?: number }): number | undefined {
  const parts = [
    ...(goal?.ratio !== undefined && seed.ratio !== undefined ? [seed.ratio / goal.ratio] : []),
    ...(goal?.seedTimeMs !== undefined && seed.seedTimeMs !== undefined ? [seed.seedTimeMs / goal.seedTimeMs] : []),
  ];
  return parts.length === 0 ? undefined : Math.min(1, Math.max(0, ...parts));
}

/**
 * The goal a torrent gets. Without a tracker minimum, the user's goal.
 * With one, only the dimensions the tracker reports may stop the torrent, each
 * raised to the user's value on it, so a quick ratio never ends seeding before
 * a time the tracker asks for. A minimum of 0 is no minimum.
 */
export function seedGoalFor(user: SeedGoal, torrent?: { minimumRatio?: number; minimumSeedTimeSec?: number }): SeedGoal {
  const minimumRatio = torrent?.minimumRatio ? torrent.minimumRatio : undefined;
  const minimumSeedTimeMs = torrent?.minimumSeedTimeSec ? torrent.minimumSeedTimeSec * 1000 : undefined;
  if (minimumRatio === undefined && minimumSeedTimeMs === undefined) return { ...user };
  return {
    ...(minimumRatio === undefined ? {} : { ratio: Math.max(minimumRatio, user.ratio ?? 0) }),
    ...(minimumSeedTimeMs === undefined ? {} : { seedTimeMs: Math.max(minimumSeedTimeMs, user.seedTimeMs ?? 0) }),
  };
}
