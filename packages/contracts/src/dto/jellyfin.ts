// Jellyfin's DTOs: the status that first run's Jellyfin step and the System
// page read, and the re-run's answer. No DTO holds the API key.
import { z } from 'zod';

import { JellyfinState, SetupStepState } from '../jellyfin.ts';
import { PlayMethod, TranscodeReason } from '../playback.ts';

/** `api.jellyfin.status`: `notSetUp` before `startSetup`. */
export const JellyfinStatus = z
  .object({
    state: z.union([JellyfinState, z.literal('notSetUp')]),
    /** In checklist order, with the running setup job's live progress merged in. */
    steps: z.array(SetupStepState),
    version: z.string().optional(),
    /** Whether `version` is the release the compose file pins. */
    pinned: z.boolean(),
    /** The names of the platform libraries Jellyfin has. */
    libraries: z.array(z.string()),
    lastSetupAt: z.number().optional(),
  })
  .strict();
export type JellyfinStatus = z.infer<typeof JellyfinStatus>;

/** `units.plays(unitId)`: one of the Unit's last 10 plays, for the item page's "Plays". */
export const PlayRow = z
  .object({
    deviceName: z.string(),
    client: z.string(),
    method: PlayMethod,
    reasons: z.array(TranscodeReason),
    startedAt: z.number(),
    endedAt: z.number().optional(),
  })
  .strict();
export type PlayRow = z.infer<typeof PlayRow>;

export const RerunSetupRequest = z.object({ password: z.string() });
export const RerunSetupResponse = z.union([z.object({ ok: z.literal(true) }), z.object({ error: z.enum(['wrongPassword', 'alreadyRunning']) })]);
export type RerunSetupResponse = z.infer<typeof RerunSetupResponse>;
