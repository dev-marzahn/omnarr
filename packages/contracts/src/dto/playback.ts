// Playback-profile DTOs: a library's profile with the
// device table for its cards, the draft the page saves, and the save
// dialog's preview of what the change does.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { DeviceId } from '../devices.ts';
import { Comparison, TargetFormat } from '../playback.ts';
import { LibraryKind } from './library.ts';

/** One device card of the playback settings. */
export const DeviceCard = z
  .object({
    deviceId: DeviceId,
    name: z.string(),
    subtitle: z.string(),
    /** The device's own values, for the card's lines. */
    containers: z.array(z.string()),
    videoCodecs: z.array(z.string()),
    maxHeight: z.number().nullable(),
    audioCodecs: z.array(z.string()),
    maxChannels: z.number(),
  })
  .strict();
export type DeviceCard = z.infer<typeof DeviceCard>;

/** `playback.get(libraryId)`. */
export const PlaybackProfileDetail = z
  .object({
    libraryId: zid('libraries'),
    libraryKind: LibraryKind,
    profileId: zid('playbackProfiles'),
    name: z.string(),
    mode: z.enum(['devices', 'custom']),
    devices: z.array(DeviceId),
    target: TargetFormat,
    /** The user's cap in `devices` mode: a number, null for "no cap", absent for the derived one. */
    maxHeightOverride: z.number().nullable().optional(),
    /** The cap the ticked devices give, for the field's placeholder. */
    derivedMaxHeight: z.number().nullable(),
    keepOriginal: z.boolean(),
    deviceTableVersion: z.number(),
    devicesAvailable: z.array(DeviceCard),
  })
  .strict();
export type PlaybackProfileDetail = z.infer<typeof PlaybackProfileDetail>;

/** What the playback settings save: devices (with an optional cap) or a target edited directly, and "Keep the original". */
export const PlaybackDraft = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('devices'),
      devices: z.array(DeviceId).min(1),
      maxHeightOverride: z.number().nullable().optional(),
      keepOriginal: z.boolean(),
    })
    .strict(),
  z.object({ mode: z.literal('custom'), target: TargetFormat, keepOriginal: z.boolean() }).strict(),
]);
export type PlaybackDraft = z.infer<typeof PlaybackDraft>;

export const PlaybackRequest = z.object({ libraryId: zid('libraries') });
export const PlaybackDraftRequest = z.object({ libraryId: zid('libraries'), draft: PlaybackDraft });
export const SetupDefaultsRequest = z.object({ devices: z.array(DeviceId).min(1) });

/** `playback.previewChange(libraryId, draft)`: counts for the save dialog. */
export const ChangePreview = z
  .object({
    /** Files that stop fitting, by their most expensive step. */
    noLongerFit: z.object({ remux: z.number(), audio: z.number(), subtitle: z.number(), video: z.number() }).strict(),
    /** Downloaded and prepared files that will be prepared. */
    willPrepare: z.number(),
    /** Scanned files that stop fitting and stay as they are until the user prepares them. */
    scannedOnDemand: z.number(),
    nowFit: z.number(),
    /** More than `previewChangeLimit` versions: the counts are a lower bound ("4,000+"). */
    truncated: z.boolean(),
  })
  .strict();
export type ChangePreview = z.infer<typeof ChangePreview>;

/** `units.preparationPlan(unitId)`: the primary's comparison with its library's target. */
export const PreparationPlan = z
  .object({
    fileName: z.string(),
    origin: z.enum(['download', 'scan', 'prepared']),
    comparison: Comparison,
    /** A Rendition is pending: the modal's "already queued" state. */
    queued: z.boolean(),
  })
  .strict();
export type PreparationPlan = z.infer<typeof PreparationPlan>;
