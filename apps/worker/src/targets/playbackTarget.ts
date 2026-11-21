// The PlaybackTarget port: what the `publish` job, the
// deletion of library files and the play poller need from a player, in
// platform terms only.
// Jellyfin is v1's only adapter; the platform's own players are a v2 seam.
// Setup and accounts stay in the Jellyfin adapter.
import type { ActivePlay, PublishPayload, TargetReading } from '@omnarr/contracts';

export type WatchStateEntry = {
  /** The player's user, mapped to a platform owner by the caller. */
  user: string;
  path: string;
  positionMs: number;
  playedAt?: number;
};

/** What `publish` makes visible: each Publication's file, in its Work folder and library. */
export type PublishRequest = Pick<PublishPayload, 'items' | 'workFolderPath' | 'library'>;

/**
 * Each Publication's item, what the target read the file as, and the item
 * of the series it is in, or the movie's own item
 * (the Work's "Open in Jellyfin"), where the target has one.
 */
export type Published = { refs: Record<string, string>; readings: Record<string, TargetReading>; seriesRefs?: Record<string, string> };

export interface PlaybackTarget {
  /** Makes the target index the files and waits until it lists each; returns each Publication's item and its reading. */
  publish(request: PublishRequest, signal: AbortSignal): Promise<Published>;
  /** After library files were deleted: lets the target drop the folders' items. */
  forget(libraryId: PublishPayload['library']['libraryId'], folders: string[], signal: AbortSignal): Promise<void>;
  /** The plays running now, for the session poller. */
  observe(signal: AbortSignal): Promise<ActivePlay[]>;
  /** Watch state, for the import before a user switches players (v2). */
  readWatchState(signal: AbortSignal): Promise<WatchStateEntry[]>;
}
