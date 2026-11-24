// The update check: a daily request to GitHub's latest
// release in the default runtime, with only `Accept` and `User-Agent`. Its
// result goes into `settings.updateCheck`; a failure writes `failedAt` and is
// never an Issue. `UPDATE_CHECK=off` makes no request.
import type { NewerRelease, UpdateCheck } from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation } from './_generated/server';
import { ensureSettingsRow } from './setup/settings';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/dev-marzahn/omnarr/releases/latest';
const TIMEOUT_MS = 15_000;

/** `1.2.3` or `1.2.3-p1` → its numbers and pre-release tag; undefined for anything else. */
function parse(version: string): { numbers: number[]; pre?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], ...(match[4] ? { pre: match[4] } : {}) };
}

/**
 * Whether `latest` is a release to offer an install on `current`:
 * newer by semantic version, never a pre-release to a release install, and
 * nothing for `0.0.0-dev` or a version that doesn't parse. Pre-release tags
 * compare as text, numbers within them as numbers.
 */
export function offers(current: string, latest: string): boolean {
  if (current === '0.0.0-dev') return false;
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b || (b.pre !== undefined && a.pre === undefined)) return false;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return b.numbers[i]! > a.numbers[i]!;
  if (a.pre === b.pre) return false;
  // A release is newer than its own pre-releases.
  if (b.pre === undefined) return true;
  if (a.pre === undefined) return false;
  return b.pre.localeCompare(a.pre, undefined, { numeric: true }) > 0;
}

type StoredCheck = Doc<'settings'>['updateCheck'];

const checkIsOff = (): boolean => process.env.UPDATE_CHECK === 'off';

function newerRelease(current: string, stored: StoredCheck): NewerRelease | undefined {
  if (!stored?.latestVersion || !stored.releaseUrl || !offers(current, stored.latestVersion)) return undefined;
  return { latest: stored.latestVersion, releaseUrl: stored.releaseUrl };
}

export function updateCheckOf(current: string, stored: StoredCheck): UpdateCheck {
  if (checkIsOff()) return { state: 'off' };
  const newer = newerRelease(current, stored);
  const checkedAt = stored?.checkedAt;
  if (stored?.failedAt !== undefined) {
    return {
      state: 'failed',
      failedAt: stored.failedAt,
      ...(checkedAt !== undefined ? { lastCheckedAt: checkedAt } : {}),
      ...(newer ? { knownNewer: newer } : {}),
    };
  }
  if (checkedAt === undefined) return { state: 'notYet' };
  return newer ? { state: 'available', newer, checkedAt } : { state: 'upToDate', checkedAt };
}

export const check = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (checkIsOff()) return null;
    try {
      const response = await fetch(LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'omnarr' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = response.ok ? ((await response.json()) as { tag_name?: unknown; html_url?: unknown }) : undefined;
      if (typeof body?.tag_name === 'string' && typeof body.html_url === 'string' && parse(body.tag_name)) {
        await ctx.runMutation(internal.updates.record, { latestVersion: body.tag_name.replace(/^v/, ''), releaseUrl: body.html_url });
        return null;
      }
    } catch {
      // Unreachable, timed out, or not JSON: a failure, below.
    }
    await ctx.runMutation(internal.updates.record, {});
    return null;
  },
});

/** A result replaces the stored one; a failure only adds `failedAt`. */
export const record = internalMutation({
  args: { latestVersion: v.optional(v.string()), releaseUrl: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { latestVersion, releaseUrl }) => {
    const row = await ensureSettingsRow(ctx);
    const now = Date.now();
    const updateCheck = latestVersion && releaseUrl ? { latestVersion, releaseUrl, checkedAt: now } : { ...row.updateCheck, failedAt: now };
    await ctx.db.patch(row._id, { updateCheck });
    return null;
  },
});
