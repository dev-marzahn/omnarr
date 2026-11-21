// The job classes and download client kinds, in a module of their
// own: the DTOs import them, and jobs.ts imports the indexer contracts, which
// import the DTOs (for the indexer job class), so they can't live in jobs.ts.
import { z } from 'zod';

export const JOB_CLASSES = ['download.submit', 'import', 'prepare', 'publish', 'maintenance', 'indexer'] as const;
export const JobClass = z.enum(JOB_CLASSES);
export type JobClass = z.infer<typeof JobClass>;

/** The download client that holds an item (`downloads.clientKind`). */
export const ClientKind = z.enum(['nzbget', 'qbittorrent']);
export type ClientKind = z.infer<typeof ClientKind>;

/** The /data areas the worker checks: `series` and `movies` are the two library roots. */
export const StorageArea = z.enum(['downloads', 'staging', 'originals', 'series', 'movies']);
export type StorageArea = z.infer<typeof StorageArea>;
export const STORAGE_AREAS = StorageArea.options;
