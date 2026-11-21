// A library's target format: what import, preparation and the
// comparison read. A profile the reference seed hasn't filled yet has no
// `target`; it reads as first run's default devices.
import { DEFAULT_DEVICES, type TargetFormat, targetForDevices } from '@omnarr/contracts';

import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/** The target of the library's playback profile, or the default devices' target for a profile without one. */
export async function targetOf(ctx: QueryCtx, libraryId: Id<'libraries'>): Promise<TargetFormat> {
  const library = await ctx.db.get(libraryId);
  const profile = library && (await ctx.db.get(library.playbackProfileId));
  return profile?.target ?? targetForDevices(DEFAULT_DEVICES);
}
