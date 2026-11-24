// Jellyfin's setup and connection: the setup steps and
// their states, the locale the wizard and the libraries take, and what the
// worker reads about the connection. The `setupJellyfin` job's payload and
// result are in jobs.ts.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { JellyfinSetupReason } from './failures.ts';

/** The release the compose file pins; the System page warns about any other. */
export const PINNED_JELLYFIN = '12.4.0';

export const SetupMode = z.enum(['firstRun', 'rerun']);
export type SetupMode = z.infer<typeof SetupMode>;

/** The setup's steps, in run order, which is the checklist's order. */
export const SetupStep = z.enum(['reachable', 'wizard', 'apiKey', 'libraries', 'branding', 'testRefresh']);
export type SetupStep = z.infer<typeof SetupStep>;

export const SetupStepState = z.object({
  step: SetupStep,
  state: z.enum(['pending', 'done', 'failed']),
  reason: JellyfinSetupReason.optional(),
  at: z.number().optional(),
});
export type SetupStepState = z.infer<typeof SetupStepState>;

/** `ready` lets `publish` run; `blocked` while a `jellyfinSetupNeeded` Issue is open. */
export const JellyfinState = z.enum(['settingUp', 'ready', 'blocked']);
export type JellyfinState = z.infer<typeof JellyfinState>;

export const JellyfinLocale = z.object({ uiCulture: z.string(), metadataCountry: z.string(), metadataLanguage: z.string() });
export type JellyfinLocale = z.infer<typeof JellyfinLocale>;

export const JellyfinBranding = z.object({
  serverName: z.string(),
  loginDisclaimer: z.string(),
  customCss: z.string(),
});
export type JellyfinBranding = z.infer<typeof JellyfinBranding>;

export const OmnarrBrandingClaim = JellyfinBranding.partial();
export type OmnarrBrandingClaim = z.infer<typeof OmnarrBrandingClaim>;

/** Jellyfin's library item for a platform library. */
export const JellyfinLibraryItem = z.object({ libraryId: zid('libraries'), itemId: z.string() });
export type JellyfinLibraryItem = z.infer<typeof JellyfinLibraryItem>;

/** What `jellyfin.setup.connection` gives the worker; the one worker answer with a secret, `apiKey`. */
export const JellyfinConnection = z.object({
  state: JellyfinState,
  apiKey: z.string().optional(),
  adminUserId: z.string().optional(),
  libraries: z.array(JellyfinLibraryItem),
});
export type JellyfinConnection = z.infer<typeof JellyfinConnection>;

/**
 * Splits a BCP-47 tag into the wizard's culture and the libraries' metadata
 * language and country. A tag without a region gets Jellyfin's default
 * country, `US`.
 */
export function localeFields(tag: string): JellyfinLocale {
  const [language = 'en', ...rest] = tag.split('-');
  const region = rest.find((part) => /^[A-Za-z]{2}$|^\d{3}$/.test(part));
  return { uiCulture: tag, metadataCountry: region ? region.toUpperCase() : 'US', metadataLanguage: language.toLowerCase() };
}
