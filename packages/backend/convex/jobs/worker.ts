// The worker handshake, heartbeat and artifact upload URL, with the storage
// check on both, and `bundleData`, the support bundle's DTOs.
import {
  ArtifactUploadUrlRequest,
  ArtifactUploadUrlResponse,
  BundleDataRequest,
  Capabilities,
  ConnectRequest,
  ConnectResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  ReservePacingRequest,
  ReservePacingResponse,
  type Storage,
  STORAGE_AREAS,
  type StorageArea,
  type StorageSpace,
  SupportBundleData,
} from '@omnarr/contracts';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { systemStatusOf } from '../api/system';
import { clientRow, toDetail } from '../downloadClients/store';
import { toRow } from '../indexers/dto';
import { pacingIntervalOf, reserveSlot } from '../indexers/pacing';
import { issueListOf } from '../issues/rows';
import { workerError, workerMutation, workerQuery } from '../lib/functions';
import { raiseIssue, resolveSystemIssue } from '../lib/issues';
import { limits } from '../lib/limits';
import { leaseForIndexer } from '../sites/lease';
import { leasedJob } from './imports';
import { fenced } from './queue';

/** The session a worker call names, if the handshake accepted it. */
export async function acceptedSession(ctx: QueryCtx, sessionId: Id<'workerSessions'>): Promise<Doc<'workerSessions'>> {
  const session = await ctx.db.get(sessionId);
  if (!session?.accepted) throw workerError('sessionNotAccepted');
  return session;
}

/** The areas that must share one filesystem, so a rename into or out of the library never crosses devices. */
const ONE_DEVICE: StorageArea[] = ['staging', 'originals', 'series', 'movies'];

/** "a", "a and b", "a, b and c". */
const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Whether staging, originals and both libraries are on one device; downloads may be on another. */
export const librarySameDevice = (storage: StorageSpace) => new Set(ONE_DEVICE.map((area) => storage[area].device)).size === 1;

/**
 * Raises `storageUnavailable` when an area isn't writable or the
 * areas that must share a filesystem don't, naming them; resolves it when
 * neither holds. Downloads on another filesystem only make imports copy.
 */
async function checkStorage(ctx: MutationCtx, storage: Storage): Promise<void> {
  const problems: string[] = [];
  const unwritable = STORAGE_AREAS.filter((area) => !storage[area].writable);
  if (unwritable.length) problems.push(`Not writable: ${listOf(unwritable)}.`);
  if (!librarySameDevice(storage)) {
    const byDevice = new Map<string, StorageArea[]>();
    for (const area of ONE_DEVICE) byDevice.set(storage[area].device, [...(byDevice.get(storage[area].device) ?? []), area]);
    const groups = [...byDevice].map(([device, areas]) => `${listOf(areas)} (device ${device})`);
    problems.push(`On different filesystems: ${groups.join('; ')}.`);
  }
  if (!problems.length) return await resolveSystemIssue(ctx, 'storageUnavailable');
  await raiseIssue(ctx, {
    code: 'storageUnavailable',
    detail: `${problems.join(' ')} Put the library, staging and originals on the /data volume, and check the owner set in the compose file.`,
  });
}

export const connect = workerMutation({
  args: ConnectRequest.omit({ protocolVersion: true }).shape,
  returns: ConnectResponse,
  acceptAnyProtocolVersion: true,
  handler: async (ctx, { workerId, capabilities: sent }) => {
    const { protocolVersion } = ctx.worker;
    const now = Date.now();

    if (protocolVersion !== PROTOCOL_VERSION) {
      // The worker retries every 60 s; only its first rejection is written.
      const last = await ctx.db
        .query('workerSessions')
        .withIndex('by_worker', (q) => q.eq('workerId', workerId))
        .order('desc')
        .first();
      if (!(last && !last.accepted && last.protocolVersion === protocolVersion)) {
        await ctx.db.insert('workerSessions', {
          workerId,
          protocolVersion,
          connectedAt: now,
          lastSeenAt: now,
          accepted: false,
          rejectReason: 'protocolMismatch',
        });
        await raiseIssue(ctx, {
          code: 'protocolMismatch',
          detail: `The worker speaks protocol version ${protocolVersion}; this backend expects version ${PROTOCOL_VERSION}.`,
        });
      }
      return { accepted: false as const, expectedVersion: PROTOCOL_VERSION };
    }

    // The version matches, so the capabilities are this release's shape.
    const parsed = Capabilities.safeParse(sent);
    if (!parsed.success) throw workerError('invalidCapabilities');
    const capabilities = parsed.data;
    // Every accepted connect is a new session: leases the previous process
    // held aren't renewed by this one, so they expire and are reclaimed.
    const sessionId = await ctx.db.insert('workerSessions', { workerId, protocolVersion, capabilities, connectedAt: now, lastSeenAt: now, accepted: true });
    await resolveSystemIssue(ctx, 'protocolMismatch');
    await resolveSystemIssue(ctx, 'workerOffline');
    await checkStorage(ctx, capabilities.storage);
    // The site-definitions sync, when the last one is older than 24 hours; scheduled, so the connect itself stays small.
    await ctx.scheduler.runAfter(0, internal.sites.definitions.syncIfStale, {});
    return { accepted: true as const, sessionId };
  },
});

/** An upload URL for a job's artifact, only for the job's current lease. The job records the storage ID with its result. */
export const artifactUploadUrl = workerMutation({
  args: ArtifactUploadUrlRequest.shape,
  returns: ArtifactUploadUrlResponse,
  handler: async (ctx, { jobId, leaseEpoch }) => {
    await fenced(ctx, jobId, leaseEpoch);
    return { uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

/** How many of the newest events and jobs the support bundle holds. */
const BUNDLE_EVENTS = 500;
const BUNDLE_JOBS = 200;

/**
 * The support bundle's DTOs, for the holder of a
 * `buildSupportBundle` lease: System's status, the indexer and download
 * client settings, the Issues, and the newest events and jobs. Every part is
 * a DTO, so no secret is in it; a job is a `JobRow`, without its
 * payload.
 */
export const bundleData = workerQuery({
  args: BundleDataRequest.shape,
  returns: SupportBundleData,
  handler: async (ctx, { jobId, leaseEpoch }) => {
    const job = await leasedJob(ctx, jobId, leaseEpoch);
    if (job.payload?.class !== 'maintenance' || job.payload.action !== 'buildSupportBundle') throw workerError('invalidResult', { expected: job.class });
    const now = Date.now();
    const events = await ctx.db.query('events').order('desc').take(BUNDLE_EVENTS);
    const jobs = await ctx.db.query('jobs').order('desc').take(BUNDLE_JOBS);
    return {
      builtAt: now,
      backendProtocolVersion: PROTOCOL_VERSION,
      status: await systemStatusOf(ctx),
      indexers: (await ctx.db.query('indexers').collect()).map((indexer) => toRow(indexer, now)),
      downloadClients: toDetail(await clientRow(ctx, 'nzbget'), await clientRow(ctx, 'qbittorrent')),
      issues: await issueListOf(ctx),
      events: events.map((event) => ({
        at: event.at,
        stage: event.stage,
        kind: event.kind,
        message: event.message,
        ...(event.data?.failureCode ? { failureCode: event.data.failureCode } : {}),
        ...(event.unitId ? { unitId: event.unitId } : {}),
        ...(event.grabId ? { grabId: event.grabId } : {}),
      })),
      jobs: jobs.map((row) => ({
        jobId: row._id,
        class: row.class,
        ...(row.payload?.class === 'maintenance' ? { action: row.payload.action } : {}),
        status: row.status,
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        ...(row.failureCode ? { failureCode: row.failureCode } : {}),
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row._creationTime,
        ...(row.grabId ? { grabId: row.grabId } : {}),
      })),
    };
  },
});

/**
 * `worker.reservePacing`: the engine's slot for a definition indexer,
 * at max(2 s, requestDelay). The interval is the backend's, from the stored
 * definition; an indexer that isn't a definition indexer is refused.
 */
export const reservePacing = workerMutation({
  args: ReservePacingRequest.shape,
  returns: ReservePacingResponse,
  handler: async (ctx, { jobId, leaseEpoch, indexerId }) => {
    await leaseForIndexer(ctx, { jobId, leaseEpoch }, indexerId);
    const indexer = await ctx.db.get(indexerId);
    if (!indexer || indexer.kind !== 'definition') throw workerError('invalidResult', { expected: 'a definition indexer' });
    return await reserveSlot(ctx, indexerId, pacingIntervalOf(indexer)!);
  },
});

export const heartbeat = workerMutation({
  args: HeartbeatRequest.shape,
  returns: HeartbeatResponse,
  handler: async (ctx, { sessionId, storage: space, writable }) => {
    const session = await acceptedSession(ctx, sessionId);
    // An accepted session always has them (connect).
    const capabilities = session.capabilities!;
    const now = Date.now();
    const leaseExpiresAt = now + limits().leaseMs;
    // Each area's write check stays the last one run (at connect, or after a write failure) until the beat carries a new one.
    const storage = Object.fromEntries(
      STORAGE_AREAS.map((area) => [area, { ...space[area], writable: writable?.[area] ?? capabilities.storage[area].writable }]),
    ) as Storage;
    await ctx.db.patch(sessionId, { lastSeenAt: now, capabilities: { ...capabilities, storage } });
    await checkStorage(ctx, storage);

    // A worker holds at most the sum of its class concurrencies, so the
    // leased jobs are few.
    const leased = await ctx.db
      .query('jobs')
      .withIndex('by_lease_owner', (q) => q.eq('leaseOwner', sessionId).eq('status', 'leased'))
      .collect();
    const cancelJobIds: Id<'jobs'>[] = [];
    for (const job of leased) {
      await ctx.db.patch(job._id, { leaseExpiresAt });
      if (job.cancelRequested) cancelJobIds.push(job._id);
    }
    return { cancelJobIds, leaseExpiresAt };
  },
});
