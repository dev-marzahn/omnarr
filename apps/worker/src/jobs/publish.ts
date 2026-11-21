// `publish`: calls PlaybackTarget.publish and
// returns the refs, with what the target read each file as, which the
// backend checks against the Unit. Indexing, the refresh
// scope and the wait until the user can play each file are the adapter's.
import { type JobResult, PublishPayload } from '@omnarr/contracts';

import type { JobHandler } from '../runtime/lease.ts';
import type { PlaybackTarget } from '../targets/playbackTarget.ts';

export type PublishDeps = { target: PlaybackTarget };

export function publishHandler(deps: PublishDeps): JobHandler {
  return async (job, { signal }): Promise<JobResult> => {
    const { items, workFolderPath, library } = PublishPayload.parse(job.payload);
    const { refs, readings, seriesRefs } = await deps.target.publish({ items, workFolderPath, library }, signal);
    return { class: 'publish', targetItemRefs: refs, readings, ...(seriesRefs ? { seriesItemRefs: seriesRefs } : {}) };
  };
}
