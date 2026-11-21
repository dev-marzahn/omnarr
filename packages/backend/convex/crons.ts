// Scheduled functions: the hourly metadata tick, the RSS dispatch and
// backfill, and supervision, TTL and retention.
import { cronJobs } from 'convex/server';

import { internal } from './_generated/api';

const crons = cronJobs();

crons.hourly('metadata.tick', { minuteUTC: 0 }, internal.metadata.schedule.tick, {});
// Every 5 minutes, fetching the indexers whose effective RSS interval has passed.
crons.interval('rss.dispatch', { minutes: 5 }, internal.pipeline.rss.dispatch, {});
// Lease reclaim, worker liveness and the end of pauses.
crons.interval('supervise', { seconds: 30 }, internal.jobs.queue.supervise, {});
// Wanted Units the other triggers missed, and Units whose air date has passed.
crons.daily('backfill', { hourUTC: 3, minuteUTC: 0 }, internal.pipeline.backfill.runBackfill, {});
// Playable Units whose release misses the cutoff, oldest search first.
crons.weekly('upgradeSearch', { dayOfWeek: 'sunday', hourUTC: 2, minuteUTC: 0 }, internal.pipeline.upgrades.upgradeSearch, {});
// Expired candidates.
crons.hourly('ttl.candidates', { minuteUTC: 30 }, internal.pipeline.retention.expireCandidates, {});
// Job artifacts (ffmpeg logs, support bundles) older than 14 days.
crons.hourly('ttl.artifacts', { minuteUTC: 45 }, internal.jobs.artifacts.expire, {});
// Jobs and workflow records of Grabs finished more than 30 days ago.
crons.daily('retention.runs', { hourUTC: 4, minuteUTC: 0 }, internal.pipeline.retention.cleanUpRuns, {});
// The periodic untracked-media scan, when its schedule is due.
crons.daily('scan.schedule', { hourUTC: 5, minuteUTC: 0 }, internal.scan.start.checkSchedule, {});

// Prowlarr's definitions, once a day.
crons.daily('definitions.sync', { hourUTC: 2, minuteUTC: 30 }, internal.sites.definitions.dailySync, {});

// GitHub's latest release, once a day.
crons.daily('updates.check', { hourUTC: 6, minuteUTC: 0 }, internal.updates.check, {});

export default crons;
