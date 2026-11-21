// The playback-profile functions: the settings page's read, its save
// dialog's preview and its save, and first run's device choice.
import {
  Ack,
  ChangePreview,
  DEFAULT_DEVICES,
  DEVICE_TABLE,
  DEVICE_TABLE_VERSION,
  type DeviceCard,
  DeviceId,
  PlaybackDraftRequest,
  PlaybackProfileDetail,
  PlaybackRequest,
  SetupDefaultsRequest,
  targetForDevices,
} from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { adminMutation, adminQuery } from '../lib/functions';
import { applyDraft, setupDefaults as fillDefaults, previewChange as preview } from '../playback/profiles';

/** The settings page's device cards: each device's own values, from the table. */
const DEVICE_CARDS: DeviceCard[] = DeviceId.options.map((deviceId) => {
  const device = DEVICE_TABLE[deviceId];
  return {
    deviceId,
    name: device.name,
    subtitle: device.subtitle,
    containers: device.containers,
    videoCodecs: device.video.map((video) => `${video.codec} ${video.maxBitDepth}-bit`),
    maxHeight: device.maxHeight,
    audioCodecs: device.audio,
    maxChannels: device.maxChannels,
  };
});

async function libraryOf(ctx: QueryCtx, libraryId: Id<'libraries'>): Promise<{ library: Doc<'libraries'>; profile: Doc<'playbackProfiles'> }> {
  const library = await ctx.db.get(libraryId);
  const profile = library && (await ctx.db.get(library.playbackProfileId));
  if (!library || !profile) throw new ConvexError({ code: 'notFound' });
  return { library, profile };
}

export const get = adminQuery({
  args: PlaybackRequest.shape,
  returns: PlaybackProfileDetail,
  handler: async (ctx, { libraryId }) => {
    const { library, profile } = await libraryOf(ctx, libraryId);
    // The defaults of a row the reference seed hasn't filled.
    const devices = profile.devices ?? DEFAULT_DEVICES;
    return {
      libraryId,
      libraryKind: library.kind,
      profileId: profile._id,
      name: profile.name,
      mode: profile.mode ?? 'devices',
      devices,
      target: profile.target ?? targetForDevices(devices, profile.maxHeightOverride),
      ...(profile.maxHeightOverride === undefined ? {} : { maxHeightOverride: profile.maxHeightOverride }),
      derivedMaxHeight: targetForDevices(devices).video.maxHeight,
      keepOriginal: profile.keepOriginal ?? false,
      deviceTableVersion: profile.deviceTableVersion ?? DEVICE_TABLE_VERSION,
      devicesAvailable: DEVICE_CARDS,
    };
  },
});

/** The settings page's save dialog: what the draft would do to the library's files, without saving it. */
export const previewChange = adminQuery({
  args: PlaybackDraftRequest.shape,
  returns: ChangePreview,
  handler: async (ctx, { libraryId, draft }) => {
    const { profile } = await libraryOf(ctx, libraryId);
    return await preview(ctx, profile._id, draft);
  },
});

/** The settings page's save. A changed target recomputes the library's files (preparation.recomputeFits). */
export const update = adminMutation({
  args: PlaybackDraftRequest.shape,
  returns: Ack,
  handler: async (ctx, { libraryId, draft }) => {
    const { profile } = await libraryOf(ctx, libraryId);
    await applyDraft(ctx, profile._id, draft);
    return null;
  },
});

/** First run's device choice: both libraries' profiles. */
export const setupDefaults = adminMutation({
  args: SetupDefaultsRequest.shape,
  returns: Ack,
  handler: async (ctx, { devices }) => {
    await fillDefaults(ctx, devices);
    return null;
  },
});
